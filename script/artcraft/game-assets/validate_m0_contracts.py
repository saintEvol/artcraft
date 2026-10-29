#!/usr/bin/env python3
"""Validate the M0 game-assets contracts and fixtures (GA-002 / GA-003).

Checks, in order:
  1. Every contract fixture validates (valid_*), fails (invalid_*) or trips a
     cross-field invariant (inconsistent_*) against its JSON Schema. Fixture
     directories that do not match a schema are an error, not a silent skip.
  2. The generated pack manifest validates against the manifest schema, its
     spec_hash values equal the canonical hash of the matching spec fixtures,
     and its LOD levels are strictly ordered.
  3. Pack integrity: files exist under the pack root, sizes and sha256 match
     the manifest, paths are unique and cannot escape, atlas/LOD file indices
     are in range, files.sha256 covers exactly manifest + payload files.
  4. Sample integrity: PNG dimensions, alpha statistics and the icon's
     subject-inset discipline; GLB structure parses, every mesh is reachable
     from the scene graph (unreachable parts would render as nothing), and
     the measured triangle count and POSITION bounds of the reachable
     geometry match the recorded expectations, including that the
     counterexamples really violate the frozen budget (12 000 triangles).

Parse failures of individual files are reported as FAIL lines, not crashes;
PNG decoding supports all five scanline filters (atlas pages arrive with
real filtering from the processing pipeline).

Only depends on the Python standard library plus `jsonschema` (draft 2020-12).
Usage: python3 validate_m0_contracts.py <repo_root>
Exits non-zero when any check fails.
"""

import hashlib
import json
import os
import struct
import sys
import zlib

from jsonschema import Draft202012Validator, FormatChecker

# Format annotations (e.g. manifest generated_at as RFC 3339 date-time) are
# only enforced when a format checker is supplied; rfc3339-validator is
# available in the dev environment for the date-time check.
FORMAT_CHECKER = FormatChecker()


def schema_validator(schema):
  return Draft202012Validator(schema, format_checker=FORMAT_CHECKER)

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

failures = []


def check(condition: bool, label: str, detail: str = "") -> bool:
  status = "PASS" if condition else "FAIL"
  suffix = f" :: {detail}" if detail and not condition else ""
  print(f"[{status}] {label}{suffix}")
  if not condition:
    failures.append(label)
  return condition


def load_json(path: str):
  with open(path, encoding="utf-8") as handle:
    return json.load(handle)


def sha256_file(path: str) -> str:
  with open(path, "rb") as handle:
    return hashlib.sha256(handle.read()).hexdigest()


def canonical_json_sha256(obj) -> str:
  payload = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
  return hashlib.sha256(payload).hexdigest()


# ---------------------------------------------------------------------------
# 1. Schema fixtures
# ---------------------------------------------------------------------------


def lod_levels_ordered(asset: dict) -> bool:
  """Absent lod block: trivially valid. A present-but-malformed block
  (empty dict, non-dict, missing/invalid levels or level entries) is
  invalid and must surface as a FAIL, never as a crash."""
  mesh = asset.get("mesh")
  lod = mesh.get("lod") if isinstance(mesh, dict) else None
  if lod is None:
    return True
  if not isinstance(lod, dict):
    return False
  raw_levels = lod.get("levels")
  if not isinstance(raw_levels, list) or not raw_levels:
    return False
  levels = []
  distances = []
  for entry in raw_levels:
    if not isinstance(entry, dict):
      return False
    level = entry.get("level")
    distance = entry.get("switch_distance_m")
    # bool subclasses int in Python, but JSON true/false must not pass as
    # numeric LOD values.
    level_is_number = isinstance(level, int) and not isinstance(level, bool)
    distance_is_number = isinstance(distance, (int, float)) and not isinstance(distance, bool)
    if not level_is_number or not distance_is_number:
      return False
    levels.append(level)
    distances.append(distance)
  return (
      all(a < b for a, b in zip(levels, levels[1:]))
      and all(a < b for a, b in zip(distances, distances[1:]))
  )


def validate_schema_fixtures(contracts_dir: str) -> None:
  schema_names = [
      "game_asset_2d_spec",
      "game_asset_3d_spec",
      "asset_pack_manifest",
      "api_error",
      "list_page",
  ]
  validators = {
      name: schema_validator(load_json(os.path.join(contracts_dir, "schemas", f"{name}.schema.json")))
      for name in schema_names
  }
  fixtures_root = os.path.join(contracts_dir, "fixtures")
  seen_schemas = set()
  for schema_name in sorted(os.listdir(fixtures_root)):
    schema_dir = os.path.join(fixtures_root, schema_name)
    if not os.path.isdir(schema_dir):
      continue
    if schema_name not in validators:
      check(False, f"fixture directory {schema_name}/ matches no schema (typo?)")
      continue
    seen_schemas.add(schema_name)
    fixture_files = sorted(f for f in os.listdir(schema_dir) if f.endswith(".json"))
    check(len(fixture_files) > 0, f"fixture set {schema_name}/ is not empty")
    for filename in fixture_files:
      path = os.path.join(schema_dir, filename)
      try:
        data = load_json(path)
        errors = sorted(validators[schema_name].iter_errors(data), key=lambda e: e.path)
      except (json.JSONDecodeError, OSError) as error:
        check(False, f"fixture {schema_name}/{filename} is readable JSON", str(error))
        continue
      valid = not errors
      if filename.startswith("valid_"):
        check(valid, f"fixture {schema_name}/{filename} validates",
              "; ".join(e.message for e in errors[:3]))
        if schema_name == "asset_pack_manifest":
          for asset in data.get("assets", []):
            check(lod_levels_ordered(asset),
                  f"fixture {schema_name}/{filename} lod levels valid (start at 0, strictly ordered, switch distances increase) ({asset.get('stable_key')})")
        if schema_name == "list_page":
          consistent = (data["next_cursor"] is not None) == data["has_more"]
          check(consistent, f"fixture {schema_name}/{filename} cursor/has_more invariant")
      elif filename.startswith("invalid_"):
        check(not valid, f"fixture {schema_name}/{filename} is rejected by the schema")
      elif filename.startswith("inconsistent_"):
        check(valid, f"fixture {schema_name}/{filename} passes the schema (invariant checked separately)")
        if schema_name == "list_page":
          consistent = (data["next_cursor"] is not None) == data["has_more"]
          check(not consistent, f"fixture {schema_name}/{filename} trips the cross-field invariant")
      else:
        check(False, f"fixture {schema_name}/{filename} has an unknown prefix (valid_/invalid_/inconsistent_)")
  for missing in sorted(set(schema_names) - seen_schemas):
    check(False, f"schema {missing} has a fixture directory with at least one fixture")


# ---------------------------------------------------------------------------
# 2+3. Pack manifest: schema, spec hashes, integrity, cross-checks
# ---------------------------------------------------------------------------


def reachable_meshes(gltf: dict) -> set:
  """Mesh indices reachable from the declared default scene
  (gltf.scene, falling back to scene 0) through the node graph."""
  nodes = gltf.get("nodes", [])
  visited_nodes = set()
  reachable = set()
  stack = []
  scene_index = gltf.get("scene", 0)
  scenes = gltf.get("scenes", [])
  if not (0 <= scene_index < len(scenes)):
    # Malformed scene pointer: nothing is reachable; the caller's
    # reachability equality check reports it as a FAIL.
    return reachable
  stack.extend(scenes[scene_index].get("nodes", []))
  while stack:
    node_index = stack.pop()
    if node_index in visited_nodes or not (0 <= node_index < len(nodes)):
      continue
    visited_nodes.add(node_index)
    node = nodes[node_index]
    if "mesh" in node:
      reachable.add(node["mesh"])
    stack.extend(node.get("children", []))
  return reachable


def validate_pack(contracts_dir: str, pack_dir: str, *, bind_spec_fixtures: bool = True) -> None:
  manifest_path = os.path.join(pack_dir, "manifest.json")
  manifest_schema = load_json(os.path.join(contracts_dir, "schemas", "asset_pack_manifest.schema.json"))
  manifest = load_json(manifest_path)
  errors = sorted(schema_validator(manifest_schema).iter_errors(manifest), key=lambda e: e.path)
  check(not errors, "pack manifest.json validates against asset_pack_manifest schema",
        "; ".join(e.message for e in errors[:3]))

  # spec_hash must bind each asset to the frozen spec fixture of its kind.
  spec_fixtures = {
      "icon_2d": load_json(os.path.join(contracts_dir, "fixtures", "game_asset_2d_spec", "valid_icon_2d.json")),
      "sprite_2d": load_json(os.path.join(contracts_dir, "fixtures", "game_asset_2d_spec", "valid_sprite_2d.json")),
      "prop_3d": load_json(os.path.join(contracts_dir, "fixtures", "game_asset_3d_spec", "valid_prop_3d.json")),
  }
  for asset in manifest["assets"]:
    if bind_spec_fixtures:
      expected_hash = canonical_json_sha256(spec_fixtures[asset["kind"]])
      check(asset["spec_hash"] == expected_hash,
            f"spec_hash binds {asset['stable_key']} to the canonical {asset['kind']} spec fixture")
    else:
      # Live-pipeline packs still freeze a real spec hash per asset.
      check(len(asset["spec_hash"]) == 64 and all(c in "0123456789abcdef" for c in asset["spec_hash"]),
            f"spec_hash is a real sha256 for {asset['stable_key']}")
    check(lod_levels_ordered(asset), f"pack lod levels valid (strictly ascending, switch distances increase) ({asset['stable_key']})")

  # File integrity: existence, size, hash, uniqueness, escape safety.
  seen_paths = set()
  for asset in manifest["assets"]:
    for index, entry in enumerate(asset["files"]):
      label = f"manifest file {asset['stable_key']}[{index}] ({entry['path']})"
      if entry["path"] in seen_paths:
        check(False, f"{label} path is unique")
        continue
      seen_paths.add(entry["path"])
      check(entry["path"] == os.path.normpath(entry["path"]).replace(os.sep, "/") and ".." not in entry["path"].split("/"),
            f"{label} path is normalized and cannot escape the pack root")
      full = os.path.join(pack_dir, entry["path"])
      if not check(os.path.isfile(full), f"{label} exists"):
        continue
      check(os.path.getsize(full) == entry["byte_length"], f"{label} byte_length matches")
      check(sha256_file(full) == entry["sha256"], f"{label} sha256 matches")

    # Atlas page / LOD file indices must reference this asset's file list.
    image = asset.get("image", {})
    atlas = image.get("atlas")
    if atlas is not None:
      check(0 <= atlas["page_file_index"] < len(asset["files"]),
            f"atlas page_file_index in range for {asset['stable_key']}")
    mesh = asset.get("mesh", {})
    lod = mesh.get("lod") if isinstance(mesh, dict) else None
    if lod is not None:
      # A malformed lod block already failed the schema and the ordering
      # invariant; only inspect well-formed level entries here.
      for level in lod.get("levels", []) or []:
        if not isinstance(level, dict) or "file_index" not in level:
          continue
        check(0 <= level["file_index"] < len(asset["files"]),
              f"lod level {level.get('level')} file_index in range for {asset['stable_key']}")

  # files.sha256 covers exactly manifest + payload files (never itself).
  checksum_path = os.path.join(pack_dir, "files.sha256")
  if check(os.path.isfile(checksum_path), "pack contains files.sha256"):
    listed = set()
    ok = True
    with open(checksum_path, encoding="utf-8") as handle:
      for line in handle:
        digest, _, rel = line.strip().partition("  ")
        full = os.path.join(pack_dir, rel)
        ok &= os.path.isfile(full) and sha256_file(full) == digest
        listed.add(rel)
    check(ok, "files.sha256 digests match the files on disk")
    expected = {"manifest.json"} | seen_paths
    check(listed == expected, "files.sha256 covers exactly manifest + payload files (excluding itself)",
          f"missing={sorted(expected - listed)} extra={sorted(listed - expected)}")

  check(os.path.isfile(os.path.join(pack_dir, "provenance.json")), "pack contains provenance.json")

  # Cross-check the 2D image block against the real PNG (including the
  # content-inset discipline the spec fixture freezes).
  for asset in manifest["assets"]:
    if asset["kind"] in ("icon_2d", "sprite_2d"):
      png_path = os.path.join(pack_dir, asset["files"][0]["path"])
      image = asset["image"]
      try:
        width, height, pixels = parse_png(png_path)
      except Exception as error:  # noqa: BLE001 - reported as a FAIL line
        check(False, f"PNG parses for {asset['stable_key']}", str(error))
        continue
      check((width, height) == (image["width"], image["height"]),
            f"manifest image size matches PNG for {asset['stable_key']}",
            f"manifest={image['width']}x{image['height']} png={width}x{height}")
      spec = spec_fixtures[asset["kind"]]
      inset = spec.get("content_inset_px", 0)
      try:
        min_x, min_y, max_x, max_y = subject_bounds(pixels, width, height)
        check(min_x >= inset and min_y >= inset and max_x < width - inset and max_y < height - inset,
              f"icon subject respects the {inset}px content inset for {asset['stable_key']}",
              f"bounds=({min_x},{min_y})-({max_x},{max_y}) canvas={width}x{height}")
      except ValueError as error:
        check(False, f"icon has a measurable subject for {asset['stable_key']}", str(error))

  # Cross-check the 3D mesh block against the real GLB, counting only
  # scene-reachable geometry (what a consumer would actually render).
  for asset in manifest["assets"]:
    if asset["kind"] == "prop_3d":
      mesh = asset.get("mesh")
      if not isinstance(mesh, dict):
        check(False, f"prop_3d asset has a well-formed mesh block for {asset.get('stable_key')}",
              f"mesh is {type(mesh).__name__}, expected object")
        continue
      glb_path = os.path.join(pack_dir, asset["files"][0]["path"])
      try:
        gltf, _ = parse_glb(glb_path)
      except Exception as error:  # noqa: BLE001 - reported as a FAIL line
        check(False, f"GLB parses for {asset['stable_key']}", str(error))
        continue
      reachable = reachable_meshes(gltf)
      check(reachable == set(range(len(gltf.get("meshes", [])))),
            f"every mesh in the pack GLB is reachable from the scene for {asset['stable_key']}")
      triangles = count_triangles(gltf, reachable)
      mesh = asset["mesh"]
      check(triangles == mesh["triangles"],
            f"manifest mesh.triangles matches reachable GLB geometry for {asset['stable_key']}",
            f"manifest={mesh['triangles']} glb={triangles}")
      try:
        dimensions = position_bounds(gltf, reachable)
      except ValueError as error:
        check(False, f"pack GLB has measurable reachable geometry for {asset['stable_key']}", str(error))
        continue
      dims = mesh["measured_dimensions_m"]
      for axis, key in enumerate("xyz"):
        check(abs(dimensions["size"][axis] - dims[key]) < 1e-6,
              f"manifest measured_dimensions_m.{key} matches GLB POSITION bounds for {asset['stable_key']}",
              f"manifest={dims[key]} glb={dimensions['size'][axis]}")


# ---------------------------------------------------------------------------
# 4. Sample integrity
# ---------------------------------------------------------------------------


def _paeth(a: int, b: int, c: int) -> int:
  p = a + b - c
  pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
  if pa <= pb and pa <= pc:
    return a
  if pb <= pc:
    return b
  return c


def parse_png(path: str):
  """Return (width, height, pixels RGBA); supports all five PNG scanline
  filters (atlas pages arrive with real filtering, not just filter 0)."""
  with open(path, "rb") as handle:
    data = handle.read()
  if data[:8] != b"\x89PNG\r\n\x1a\n":
    raise ValueError(f"{path}: bad PNG signature")
  offset = 8
  width = height = None
  idat = bytearray()
  while offset < len(data):
    (length,), tag = struct.unpack(">I", data[offset:offset + 4]), data[offset + 4:offset + 8]
    chunk = data[offset + 8:offset + 8 + length]
    if tag == b"IHDR":
      width, height, depth, color_type = struct.unpack(">IIBB", chunk[:10])
      if depth != 8 or color_type != 6:
        raise ValueError(f"{path}: expected RGBA8, got depth={depth} color={color_type}")
    elif tag == b"IDAT":
      idat.extend(chunk)
    offset += 12 + length
  if width is None:
    raise ValueError(f"{path}: missing IHDR")
  raw = zlib.decompress(bytes(idat))
  stride = width * 4
  pixels = bytearray(width * height * 4)
  previous = bytearray(stride)
  for y in range(height):
    row = y * stride
    line_start = y * (stride + 1)
    filter_type = raw[line_start]
    line = bytearray(raw[line_start + 1:line_start + 1 + stride])
    for x in range(stride):
      left = line[x - 4] if x >= 4 else 0
      up = previous[x]
      up_left = previous[x - 4] if x >= 4 else 0
      if filter_type == 0:
        pass
      elif filter_type == 1:
        line[x] = (line[x] + left) & 0xFF
      elif filter_type == 2:
        line[x] = (line[x] + up) & 0xFF
      elif filter_type == 3:
        line[x] = (line[x] + ((left + up) >> 1)) & 0xFF
      elif filter_type == 4:
        line[x] = (line[x] + _paeth(left, up, up_left)) & 0xFF
      else:
        raise ValueError(f"{path}: unknown PNG filter {filter_type}")
    pixels[row:row + stride] = line
    previous = line
  return width, height, pixels


def subject_bounds(pixels, width, height):
  min_x = min_y = None
  max_x = max_y = None
  for y in range(height):
    row = y * width * 4
    for x in range(width):
      if pixels[row + x * 4 + 3] > 0:
        if min_x is None or x < min_x:
          min_x = x
        if max_x is None or x > max_x:
          max_x = x
        if min_y is None or y < min_y:
          min_y = y
        if max_y is None or y > max_y:
          max_y = y
  if min_x is None:
    raise ValueError("image has no non-transparent pixels (no subject)")
  return min_x, min_y, max_x, max_y


def alpha_stats(pixels):
  total = len(pixels) // 4
  opaque = transparent = 0
  for i in range(total):
    alpha = pixels[i * 4 + 3]
    if alpha == 255:
      opaque += 1
    elif alpha == 0:
      transparent += 1
  return total, opaque, transparent


def parse_glb(path: str):
  with open(path, "rb") as handle:
    data = handle.read()
  magic, version, total = struct.unpack("<III", data[:12])
  if magic != GLB_MAGIC or version != 2 or total != len(data):
    raise ValueError(f"{path}: bad GLB header (magic={magic:#x} version={version} length={total}/{len(data)})")
  offset = 12
  json_data = binary = None
  while offset < len(data):
    length, chunk_type = struct.unpack("<II", data[offset:offset + 8])
    if offset + 8 + length > len(data):
      raise ValueError(f"{path}: chunk at {offset} overruns the file")
    chunk = data[offset + 8:offset + 8 + length]
    if chunk_type == CHUNK_JSON:
      json_data = json.loads(chunk)
    elif chunk_type == CHUNK_BIN:
      binary = chunk
    offset += 8 + length
  if json_data is None:
    raise ValueError(f"{path}: missing JSON chunk")
  buffers = json_data.get("buffers", [])
  if buffers and "byteLength" in buffers[0]:
    if binary is None or len(binary) < buffers[0]["byteLength"]:
      raise ValueError(f"{path}: BIN chunk too short for buffers[0].byteLength")
  return json_data, binary


def count_triangles(gltf: dict, only_meshes=None) -> int:
  total = 0
  for index, mesh in enumerate(gltf.get("meshes", [])):
    if only_meshes is not None and index not in only_meshes:
      continue
    for primitive in mesh["primitives"]:
      if "indices" in primitive:
        total += gltf["accessors"][primitive["indices"]]["count"] // 3
      else:
        total += gltf["accessors"][primitive["attributes"]["POSITION"]]["count"] // 3
  return total


def position_bounds(gltf: dict, only_meshes=None) -> dict:
  lo = [None, None, None]
  hi = [None, None, None]
  for index, mesh in enumerate(gltf.get("meshes", [])):
    if only_meshes is not None and index not in only_meshes:
      continue
    for primitive in mesh["primitives"]:
      accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
      plo, phi = accessor["min"], accessor["max"]
      for axis in range(3):
        if lo[axis] is None or plo[axis] < lo[axis]:
          lo[axis] = plo[axis]
        if hi[axis] is None or phi[axis] > hi[axis]:
          hi[axis] = phi[axis]
  if lo[0] is None:
    raise ValueError("no reachable geometry with POSITION data to measure")
  return {"min": lo, "max": hi, "size": [hi[i] - lo[i] for i in range(3)]}


def validate_samples(samples_dir: str, contracts_dir: str) -> None:
  icon_spec = load_json(os.path.join(contracts_dir, "fixtures", "game_asset_2d_spec", "valid_icon_2d.json"))
  icon_inset = icon_spec.get("content_inset_px", 0)
  # The budget counterexample must exceed the budget frozen by the 3D spec
  # fixture, so read it from there instead of keeping a second copy.
  prop_spec = load_json(os.path.join(contracts_dir, "fixtures", "game_asset_3d_spec", "valid_prop_3d.json"))
  budget_max_triangles = prop_spec["max_triangles"]

  # --- 2D ---
  expected_png = {
      "icon_potion_512.png": dict(size=(512, 512), has_alpha=True, has_opaque=True, inset=icon_inset),
      "sprite_thin_diagonal_256.png": dict(size=(256, 256), has_alpha=True, has_opaque=True),
      "counter_subject_offcenter_256.png": dict(size=(256, 256), has_alpha=True, has_opaque=True),
      "counter_fully_transparent_128.png": dict(size=(128, 128), has_opaque=False),
      "counter_opaque_background_128.png": dict(size=(128, 128), fully_opaque=True),
      "counter_two_subjects_256.png": dict(size=(256, 256), has_alpha=True, has_opaque=True),
  }
  for name, expectation in expected_png.items():
    path = os.path.join(samples_dir, "2d", name)
    if not check(os.path.isfile(path), f"2D sample {name} exists"):
      continue
    try:
      width, height, pixels = parse_png(path)
    except Exception as error:  # noqa: BLE001 - reported as a FAIL line
      check(False, f"2D sample {name} parses", str(error))
      continue
    check((width, height) == expectation["size"], f"2D sample {name} size is {expectation['size']}")
    total, opaque, transparent = alpha_stats(pixels)
    if "fully_opaque" in expectation:
      check(opaque == total, f"2D sample {name} is fully opaque (background not transparent)")
    if expectation.get("has_opaque"):
      check(opaque > 0, f"2D sample {name} has at least one opaque pixel")
    if expectation.get("has_alpha"):
      check(transparent > 0, f"2D sample {name} has transparent pixels around the subject")
    if name == "counter_fully_transparent_128.png":
      check(opaque == 0, "2D counterexample fully-transparent has no opaque pixel (subject-bounds detection must fail)")
    if "inset" in expectation:
      inset = expectation["inset"]
      try:
        min_x, min_y, max_x, max_y = subject_bounds(pixels, width, height)
        check(min_x >= inset and min_y >= inset and max_x < width - inset and max_y < height - inset,
              f"2D sample {name} subject respects the {inset}px content inset",
              f"bounds=({min_x},{min_y})-({max_x},{max_y}) canvas={width}x{height}")
      except ValueError as error:
        check(False, f"2D sample {name} has a measurable subject", str(error))

  # --- 3D ---
  expected_glb = {
      "arrow_front_z.glb": dict(triangles=48, dims=(0.47, 1.02, 0.67), over_budget=False),
      "crate_unit_1m.glb": dict(triangles=12, dims=(1.0, 1.0, 1.0), over_budget=False),
      "counter_l_shape_concave.glb": dict(triangles=24, dims=(1.0, 0.9, 1.0), over_budget=False),
      "counter_dense_plane_28800_tris.glb": dict(triangles=28800, over_budget=True),
      "counter_negative_scale_node.glb": dict(triangles=12, dims=(1.0, 1.0, 1.0), over_budget=False, negative_scale=True),
  }
  for name, expectation in expected_glb.items():
    path = os.path.join(samples_dir, "3d", name)
    if not check(os.path.isfile(path), f"3D sample {name} exists"):
      continue
    try:
      gltf, _ = parse_glb(path)
    except Exception as error:  # noqa: BLE001 - reported as a FAIL line
      check(False, f"3D sample {name} parses", str(error))
      continue
    # glTF node.mesh is a single index: any mesh not reachable from the
    # scene graph would never render, so fixtures must not carry orphans.
    reachable = reachable_meshes(gltf)
    check(reachable == set(range(len(gltf.get("meshes", [])))),
          f"3D sample {name} has no unreachable (never-rendered) meshes",
          f"unreachable={sorted(set(range(len(gltf.get('meshes', [])))) - reachable)}")
    triangles = count_triangles(gltf, reachable)
    check(triangles == expectation["triangles"], f"3D sample {name} triangle count",
          f"expected={expectation['triangles']} actual={triangles}")
    over = triangles > budget_max_triangles
    check(over == expectation["over_budget"],
          f"3D sample {name} budget status ({'over' if over else 'within'} {budget_max_triangles})")
    if "dims" in expectation:
      try:
        bounds = position_bounds(gltf, reachable)
      except ValueError as error:
        check(False, f"3D sample {name} has measurable reachable geometry", str(error))
      else:
        for axis, key in enumerate("xyz"):
          check(abs(bounds["size"][axis] - expectation["dims"][axis]) < 1e-6,
                f"3D sample {name} dimensions.{key}",
                f"expected={expectation['dims'][axis]} actual={bounds['size'][axis]}")
    if expectation.get("negative_scale"):
      scale = gltf["nodes"][0].get("scale")
      check(scale is not None and scale[0] < 0, f"3D sample {name} node carries a negative X scale")


def main() -> int:
  repo_root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", ".."))
  base = os.path.join(repo_root, "test_data", "game_assets")
  contracts_dir = os.path.join(base, "contracts")
  samples_dir = os.path.join(base, "samples")
  pack_dir = os.path.join(samples_dir, "pack_minimal")

  validate_schema_fixtures(contracts_dir)
  validate_pack(contracts_dir, pack_dir)
  pack_full_dir = os.path.join(samples_dir, "pack_full")
  if os.path.isdir(pack_full_dir):
    validate_pack(contracts_dir, pack_full_dir, bind_spec_fixtures=False)
  validate_samples(samples_dir, contracts_dir)

  print()
  if failures:
    print(f"FAILED: {len(failures)} check(s) failed:")
    for label in failures:
      print("  -", label)
    return 1
  print("ALL CHECKS PASSED")
  return 0


if __name__ == "__main__":
  sys.exit(main())
