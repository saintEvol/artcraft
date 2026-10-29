#!/usr/bin/env python3
"""Generate M0 game-assets fixtures: 2D PNG samples, 3D GLB samples and a
minimal double-engine asset pack with a manifest whose hashes match the
real files.

Everything is produced procedurally with the Python standard library only,
so the samples carry no third-party rights (GA-003) and the generator is
deterministic: identical inputs produce identical bytes on a fixed Python
and zlib build (zlib output is not guaranteed byte-stable across zlib
versions; the contract is semantic reproducibility, and files.sha256 pins
the bytes of record). The only
"timestamp" in the pack is the frozen PACK_GENERATED_AT constant, chosen on
purpose so the fixture pack stays byte-reproducible (real exports use real
time; the manifest contract does not promise byte-identical rebuilds).

Usage: python3 generate_m0_fixtures.py <repo_root>
Writes into <repo_root>/test_data/game_assets/.
"""

import hashlib
import json
import os
import struct
import sys
import zlib

PACK_GENERATED_AT = "2026-10-22T00:00:00Z"
GENERATOR_VERSION = "1"
PACK_ID = "pack_m0_minimal_v1"
PROJECT_ID = "game_assets_m0"
EXPORT_ID = "export_m0_minimal_v1"

# ---------------------------------------------------------------------------
# Minimal PNG writer (RGBA8, no interlace)
# ---------------------------------------------------------------------------


def _png_chunk(tag: bytes, data: bytes) -> bytes:
  return (
      struct.pack(">I", len(data))
      + tag
      + data
      + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
  )


def write_png(path: str, width: int, height: int, pixels: bytes) -> None:
  """pixels: RGBA, width*height*4 bytes, row-major starting at the top row."""
  assert len(pixels) == width * height * 4
  raw = bytearray()
  stride = width * 4
  for y in range(height):
    raw.append(0)  # filter type 0 (None) per scanline
    raw.extend(pixels[y * stride:(y + 1) * stride])
  ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
  body = (
      b"\x89PNG\r\n\x1a\n"
      + _png_chunk(b"IHDR", ihdr)
      + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
      + _png_chunk(b"IEND", b"")
  )
  _write_file(path, body)


class Canvas:
  """Top-left origin RGBA canvas with a few deterministic primitives."""

  def __init__(self, width: int, height: int, fill=(0, 0, 0, 0)):
    self.width = width
    self.height = height
    self.pixels = bytearray(bytes(fill) * (width * height))

  def set(self, x: int, y: int, color):
    if 0 <= x < self.width and 0 <= y < self.height:
      i = (y * self.width + x) * 4
      self.pixels[i:i + 4] = bytes(color)

  def fill_rect(self, x0, y0, x1, y1, color):
    for y in range(max(0, y0), min(self.height, y1)):
      for x in range(max(0, x0), min(self.width, x1)):
        self.set(x, y, color)

  def fill_circle(self, cx, cy, radius, color):
    r2 = radius * radius
    for y in range(max(0, cy - radius), min(self.height, cy + radius + 1)):
      for x in range(max(0, cx - radius), min(self.width, cx + radius + 1)):
        if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
          self.set(x, y, color)

  def save(self, path):
    write_png(path, self.width, self.height, bytes(self.pixels))


def make_icon_potion(size=512):
  """icon_2d positive sample: transparent background, centered potion with a
  clear safe-area inset, fully opaque subject, distinct silhouette.

  Geometry is chosen so the whole subject (cork top to flask bottom) stays
  inside the content inset (size//16 = 32 px on a 512 canvas) that the 2D
  spec fixture declares via content_inset_px; the drawn bounds are
  re-verified programmatically before returning."""
  c = Canvas(size, size)
  center_x, center_y = size // 2, size // 2
  inset = size // 16
  glass = (230, 236, 244, 255)
  liquid = (196, 60, 48, 255)
  liquid_dark = (150, 36, 30, 255)
  cork = (150, 108, 62, 255)
  cork_dark = (116, 80, 44, 255)
  body_r = size * 7 // 32        # 112 on a 512 canvas
  neck_w = size // 12            # ~42
  neck_h = size * 19 // 128      # 76
  cork_h = size // 16            # 32
  neck_top = center_y - body_r - neck_h
  # Cork sits on top of the neck.
  c.fill_rect(center_x - neck_w // 2 - 3, neck_top - cork_h, center_x + neck_w // 2 + 3, neck_top, cork_dark)
  c.fill_rect(center_x - neck_w // 2, neck_top - cork_h + 4, center_x + neck_w // 2, neck_top - 4, cork)
  # Round flask body with a two-tone liquid, then the neck drawn over the
  # joint so the silhouette stays connected.
  c.fill_circle(center_x, center_y, body_r, glass)
  c.fill_circle(center_x, center_y, body_r - 6, liquid)
  c.fill_circle(center_x - body_r // 3, center_y + body_r // 4, body_r // 2 - 4, liquid_dark)
  neck_join_y = center_y - body_r + neck_w
  c.fill_rect(center_x - neck_w // 2, neck_top, center_x + neck_w // 2, neck_join_y, glass)
  _assert_subject_within_inset(c, inset)
  return c


def _assert_subject_within_inset(canvas, inset):
  min_x = min_y = None
  max_x = max_y = None
  for y in range(canvas.height):
    for x in range(canvas.width):
      if canvas.pixels[(y * canvas.width + x) * 4 + 3] > 0:
        if min_x is None or x < min_x:
          min_x = x
        if max_x is None or x > max_x:
          max_x = x
        if min_y is None or y < min_y:
          min_y = y
        if max_y is None or y > max_y:
          max_y = y
  limit = canvas.width - inset
  if min_x < inset or min_y < inset or max_x > limit or max_y > limit:
    raise AssertionError(
        f"icon subject bounds ({min_x},{min_y})-({max_x},{max_y}) escape the "
        f"{inset}px content inset (0..{limit}); adjust the drawing geometry"
    )


def make_sprite_thin(size=256, thickness=3):
  """sprite_2d edge case: an extremely thin diagonal subject on a transparent
  canvas. Normalization must not lose it, and atlas packing must respect the
  border rules around such thin content."""
  c = Canvas(size, size)
  color = (72, 170, 220, 255)
  for i in range(size - 40):
    x = 20 + i
    y = 20 + i
    for t in range(thickness):
      c.set(x + t, y, color)
      c.set(x, y + t, color)
  return c


def make_subject_offcenter(size=256):
  """Anchor/normalization counterexample: the only subject is pushed into the
  top-left quadrant with lots of empty space bottom-right. A processor that
  assumes a centered subject, or that computes anchors by canvas center,
  will produce wrong results on this file."""
  c = Canvas(size, size)
  c.fill_circle(size // 5, size // 5, size // 8, (240, 170, 50, 255))
  return c


def make_fully_transparent(size=128):
  """Counterexample: no opaque pixel at all. Subject-bounds detection must
  report an error instead of silently emitting an empty image."""
  return Canvas(size, size, fill=(0, 0, 0, 0))


def make_opaque_no_alpha(size=128):
  """Counterexample for the transparent-background requirement: the whole
  canvas is opaque, including the background around the subject."""
  c = Canvas(size, size, fill=(24, 26, 34, 255))
  c.fill_circle(size // 2, size // 2, size // 4, (240, 170, 50, 255))
  return c


def make_two_subjects(size=256):
  """Counterexample: two disconnected subjects. Single-subject bounds
  detection must flag this instead of cropping a union bbox silently."""
  c = Canvas(size, size)
  c.fill_circle(size // 4, size // 2, size // 8, (240, 170, 50, 255))
  c.fill_circle(3 * size // 4, size // 2, size // 8, (90, 200, 120, 255))
  return c


# ---------------------------------------------------------------------------
# Minimal glTF 2.0 GLB writer
# ---------------------------------------------------------------------------

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
COMPONENT_FLOAT = 5126
COMPONENT_UNSIGNED_SHORT = 5123
TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY_BUFFER = 34963


class GltfBuffer:
  def __init__(self):
    self.data = bytearray()
    self.views = []

  def add_view(self, blob: bytes, target: int) -> int:
    while len(self.data) % 4:
      self.data.append(0)
    offset = len(self.data)
    self.data.extend(blob)
    self.views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": target})
    return len(self.views) - 1


def _vec3_min_max(positions):
  xs = [p[0] for p in positions]
  ys = [p[1] for p in positions]
  zs = [p[2] for p in positions]
  return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]


def box_geometry(cx, cy, cz, hx, hy, hz):
  """Axis-aligned box centered at (cx,cy,cz) with half extents (hx,hy,hz).
  Returns (positions, normals, indices) with 24 unique vertices so every
  face keeps its own normal. Triangles use counter-clockwise winding when
  seen from outside (right-handed, matching glTF)."""
  x0, x1 = cx - hx, cx + hx
  y0, y1 = cy - hy, cy + hy
  z0, z1 = cz - hz, cz + hz
  faces = [
      # (normal, four corners in CCW order seen from outside)
      ((0, 0, 1), [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]),   # +Z front
      ((0, 0, -1), [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)]),  # -Z back
      ((1, 0, 0), [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)]),   # +X right
      ((-1, 0, 0), [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)]),  # -X left
      ((0, 1, 0), [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)]),   # +Y top
      ((0, -1, 0), [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)]),  # -Y bottom
  ]
  positions, normals, indices = [], [], []
  for normal, corners in faces:
    base = len(positions)
    for corner in corners:
      positions.append(corner)
      normals.append(normal)
    indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])
  return positions, normals, indices


def build_glb(model_name, parts, node_transform=None) -> tuple[bytes, dict]:
  """parts: list of {name, positions, normals, indices, material}.

  Produces ONE glTF mesh with one primitive per part, all reachable from
  the scene node. glTF's node.mesh is a single index, so splitting parts
  into separate meshes would leave every mesh after the first unreachable
  (engines would only render the first part).

  node_transform: optional {"scale": [x,y,z]} applied on the scene node.
  Returns (glb_bytes, measured) where measured has triangle counts and the
  POSITION accessor min/max (meters) for the whole model."""
  buffer = GltfBuffer()
  accessors = []
  primitives = []
  triangles_total = 0
  pos_min = [None, None, None]
  pos_max = [None, None, None]
  used_materials = []

  def merge_bounds(lo, hi):
    for axis in range(3):
      if pos_min[axis] is None or lo[axis] < pos_min[axis]:
        pos_min[axis] = lo[axis]
      if pos_max[axis] is None or hi[axis] > pos_max[axis]:
        pos_max[axis] = hi[axis]

  for part in parts:
    pos_blob = b"".join(struct.pack("<3f", *p) for p in part["positions"])
    nrm_blob = b"".join(struct.pack("<3f", *n) for n in part["normals"])
    idx_blob = b"".join(struct.pack("<H", i) for i in part["indices"])
    pos_view = buffer.add_view(pos_blob, TARGET_ARRAY_BUFFER)
    nrm_view = buffer.add_view(nrm_blob, TARGET_ARRAY_BUFFER)
    idx_view = buffer.add_view(idx_blob, TARGET_ELEMENT_ARRAY_BUFFER)
    lo, hi = _vec3_min_max(part["positions"])
    merge_bounds(lo, hi)
    pos_accessor = len(accessors)
    accessors.append({
        "bufferView": pos_view, "componentType": COMPONENT_FLOAT, "count": len(part["positions"]),
        "type": "VEC3", "min": lo, "max": hi,
    })
    nrm_accessor = len(accessors)
    accessors.append({
        "bufferView": nrm_view, "componentType": COMPONENT_FLOAT, "count": len(part["normals"]),
        "type": "VEC3",
    })
    idx_accessor = len(accessors)
    accessors.append({
        "bufferView": idx_view, "componentType": COMPONENT_UNSIGNED_SHORT, "count": len(part["indices"]),
        "type": "SCALAR", "min": [min(part["indices"])], "max": [max(part["indices"])],
    })
    if part["material"] not in used_materials:
      used_materials.append(part["material"])
    primitives.append({
        "attributes": {"POSITION": pos_accessor, "NORMAL": nrm_accessor},
        "indices": idx_accessor,
        "material": used_materials.index(part["material"]),
        "mode": 4,
    })
    triangles_total += len(part["indices"]) // 3

  node = {"mesh": 0, "name": "root"}
  if node_transform:
    node.update(node_transform)
  all_materials = _materials()
  gltf = {
      "asset": {"version": "2.0", "generator": f"artcraft-m0-fixture-gen/{GENERATOR_VERSION}"},
      "scene": 0,
      "scenes": [{"name": "Scene", "nodes": [0]}],
      "nodes": [node],
      "meshes": [{"name": model_name, "primitives": primitives}],
      "materials": [all_materials[index] for index in used_materials],
      "accessors": accessors,
      "bufferViews": buffer.views,
      "buffers": [{"byteLength": len(buffer.data)}],
  }
  glb = _glb_bytes(gltf, bytes(buffer.data))
  measured = {
      "triangles": triangles_total,
      "min": pos_min,
      "max": pos_max,
      "dimensions_m": [round(pos_max[i] - pos_min[i], 6) for i in range(3)],
  }
  return glb, measured


def _materials():
  def mat(name, color, metallic=0.0, roughness=0.9):
    return {
        "name": name,
        "pbrMetallicRoughness": {
            "baseColorFactor": [*color, 1.0],
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        },
    }
  return [
      mat("neutral", (0.72, 0.70, 0.66)),
      mat("front_z_blue", (0.20, 0.42, 0.86)),
      mat("right_x_red", (0.85, 0.26, 0.20)),
      mat("top_y_green", (0.24, 0.68, 0.32)),
      mat("wooden_crate", (0.55, 0.38, 0.20), metallic=0.0, roughness=0.8),
  ]


MATERIAL_NEUTRAL, MATERIAL_FRONT, MATERIAL_RIGHT, MATERIAL_TOP, MATERIAL_CRATE = range(5)


def make_arrow_front_z():
  """Orientation probe model. Standing shaft from y=0 (bottom_center origin)
  to y=1. A nose pointing strictly +Z, a fin only on +X and a green cap on
  +Y. Renders differently from every wrong orientation, so engines and
  processors can detect accidental rotations with the naked eye."""
  def part(name, material, cx, cy, cz, hx, hy, hz):
    positions, normals, indices = box_geometry(cx, cy, cz, hx, hy, hz)
    return dict(name=name, positions=positions, normals=normals, indices=indices, material=material)

  parts = [
      # Shaft: 0.16 x 1.0 x 0.16 standing on y=0, centered on the origin footprint.
      part("shaft", MATERIAL_NEUTRAL, 0.0, 0.5, 0.0, 0.08, 0.5, 0.08),
      # Nose: 0.5 m long, strictly +Z from the shaft, near the top.
      part("nose_front_plus_z", MATERIAL_FRONT, 0.0, 0.9, 0.33, 0.05, 0.05, 0.25),
      # Fin: only on +X, marks the right side.
      part("fin_right_plus_x", MATERIAL_RIGHT, 0.23, 0.75, 0.0, 0.15, 0.10, 0.02),
      # Cap: green marker on +Y.
      part("cap_top_plus_y", MATERIAL_TOP, 0.0, 1.01, 0.0, 0.09, 0.01, 0.09),
  ]
  return build_glb("arrow_front_z", parts)


def make_crate_unit():
  """Positive prop_3d sample: a 1 x 1 x 1 m crate standing on y=0 with its
  footprint centered on the origin (bottom_center), 12 triangles."""
  positions, normals, indices = box_geometry(0.0, 0.5, 0.0, 0.5, 0.5, 0.5)
  part = dict(name="crate", positions=positions, normals=normals, indices=indices, material=MATERIAL_CRATE)
  return build_glb("crate_unit_1m", [part])


def make_l_shape_concave():
  """Collision counterexample: an L-shaped block. A single box collision is a
  poor approximation here; reports must surface the fitting error instead of
  pretending one box is correct."""
  parts = []
  base = box_geometry(0.0, 0.1, 0.0, 0.5, 0.1, 0.5)
  parts.append(dict(name="base", positions=base[0], normals=base[1], indices=base[2], material=MATERIAL_NEUTRAL))
  wall = box_geometry(-0.4, 0.5, 0.0, 0.1, 0.4, 0.5)
  parts.append(dict(name="wall", positions=wall[0], normals=wall[1], indices=wall[2], material=MATERIAL_NEUTRAL))
  return build_glb("l_shape_concave", parts)


def make_dense_plane(cells=120):
  """Budget counterexample: a 1 x 1 m plane with 2*cells^2 triangles
  (28 800 at cells=120), exceeding the M0 sample budget of 12 000."""
  positions, normals, indices = [], [], []
  for j in range(cells + 1):
    for i in range(cells + 1):
      positions.append((i / cells - 0.5, 0.0, j / cells - 0.5))
      normals.append((0.0, 1.0, 0.0))
  for j in range(cells):
    for i in range(cells):
      v0 = j * (cells + 1) + i
      v1 = v0 + 1
      v2 = v0 + cells + 1
      v3 = v2 + 1
      indices.extend([v0, v2, v1, v1, v2, v3])
  part = dict(name="dense_plane", positions=positions, normals=normals, indices=indices, material=MATERIAL_NEUTRAL)
  return build_glb("dense_plane", [part])


def make_negative_scale_node():
  """Processor counterexample: a valid unit cube whose node carries a
  negative X scale. Importers must detect the mirrored winding/normals
  instead of silently rendering an inside-out crate."""
  positions, normals, indices = box_geometry(0.0, 0.5, 0.0, 0.5, 0.5, 0.5)
  part = dict(name="mirrored_cube", positions=positions, normals=normals, indices=indices, material=MATERIAL_NEUTRAL)
  return build_glb("negative_scale_node", [part], node_transform={"scale": [-1.0, 1.0, 1.0]})


def _glb_bytes(gltf: dict, binary: bytes) -> bytes:
  js = json.dumps(gltf, separators=(",", ":"), sort_keys=False).encode("utf-8")
  js += b" " * ((4 - len(js) % 4) % 4)
  binary = binary + b"\x00" * ((4 - len(binary) % 4) % 4)
  total = 12 + 8 + len(js) + 8 + len(binary)
  header = struct.pack("<III", GLB_MAGIC, 2, total)
  json_chunk = struct.pack("<II", len(js), CHUNK_JSON) + js
  bin_chunk = struct.pack("<II", len(binary), CHUNK_BIN) + binary
  return header + json_chunk + bin_chunk


# ---------------------------------------------------------------------------
# Pack assembly
# ---------------------------------------------------------------------------


def _write_file(path: str, data: bytes) -> None:
  os.makedirs(os.path.dirname(path), exist_ok=True)
  with open(path, "wb") as handle:
    handle.write(data)


def _sha256_file(path: str) -> str:
  with open(path, "rb") as handle:
    return hashlib.sha256(handle.read()).hexdigest()


def _canonical_json(obj) -> bytes:
  return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def generate(repo_root: str) -> None:
  base = os.path.join(repo_root, "test_data", "game_assets")
  samples_2d = os.path.join(base, "samples", "2d")
  samples_3d = os.path.join(base, "samples", "3d")
  contracts = os.path.join(base, "contracts", "fixtures")

  # Preconditions first: the pack needs the committed spec fixtures, and a
  # wrong root argument must fail BEFORE any file is written (otherwise a
  # bad invocation leaves a partial tree behind).
  spec_fixture_paths = {
      "2d": os.path.join(contracts, "game_asset_2d_spec", "valid_icon_2d.json"),
      "3d": os.path.join(contracts, "game_asset_3d_spec", "valid_prop_3d.json"),
  }
  for kind, path in spec_fixture_paths.items():
    if not os.path.isfile(path):
      raise SystemExit(
          f"missing spec fixture {path}: run this script from the repository root "
          "so test_data/game_assets/contracts/fixtures/ resolves; it cannot "
          "bootstrap the contract fixtures itself"
      )

  # --- 2D samples -----------------------------------------------------------
  make_icon_potion(512).save(os.path.join(samples_2d, "icon_potion_512.png"))
  make_sprite_thin(256).save(os.path.join(samples_2d, "sprite_thin_diagonal_256.png"))
  make_subject_offcenter(256).save(os.path.join(samples_2d, "counter_subject_offcenter_256.png"))
  make_fully_transparent(128).save(os.path.join(samples_2d, "counter_fully_transparent_128.png"))
  make_opaque_no_alpha(128).save(os.path.join(samples_2d, "counter_opaque_background_128.png"))
  make_two_subjects(256).save(os.path.join(samples_2d, "counter_two_subjects_256.png"))

  # --- 3D samples -----------------------------------------------------------
  measurements = {}
  for name, builder in [
      ("arrow_front_z.glb", make_arrow_front_z),
      ("crate_unit_1m.glb", make_crate_unit),
      ("counter_l_shape_concave.glb", make_l_shape_concave),
      ("counter_dense_plane_28800_tris.glb", make_dense_plane),
      ("counter_negative_scale_node.glb", make_negative_scale_node),
  ]:
    glb, measured = builder()
    _write_file(os.path.join(samples_3d, name), glb)
    measurements[name] = measured

  # --- Double-engine pack fixture (manifest references real files) ---------
  pack = os.path.join(base, "samples", "pack_minimal")
  icon_path = os.path.join(pack, "assets", "icons", "health_potion", "main.png")
  crate_path = os.path.join(pack, "assets", "props", "wooden_crate", "main.glb")
  with open(os.path.join(samples_2d, "icon_potion_512.png"), "rb") as handle:
    _write_file(icon_path, handle.read())
  crate_bytes, _ = make_crate_unit()
  _write_file(crate_path, crate_bytes)
  crate_measured = measurements["crate_unit_1m.glb"]

  with open(spec_fixture_paths["2d"], encoding="utf-8") as handle:
    spec_2d = json.load(handle)
  with open(spec_fixture_paths["3d"], encoding="utf-8") as handle:
    spec_3d = json.load(handle)

  manifest = {
      "schema_version": "1.0",
      "pack_id": PACK_ID,
      "project_id": PROJECT_ID,
      "export_id": EXPORT_ID,
      "generated_at": PACK_GENERATED_AT,
      "provenance": {
          "license": "CC0-1.0 (procedurally generated fixture data)",
          "source_note": "procedurally generated; no third-party or user material",
          "provenance_ref": "provenance.json",
      },
      "engine_profiles": [
          {
              "id": "godot_4_7_2_forward_plus_m0",
              "engine": "godot",
              "engine_version": "4.7.2-stable",
              "renderer_backend": "forward_plus",
              "importer_version": "game_assets_addon/m0",
              "coordinate_conversion": "none; glTF native +Y up / model forward +Z imported as-is",
              "required_features": [],
              "validation_status": "unverified",
          },
          {
              "id": "bevy_0_20_0_wgpu_m0",
              "engine": "bevy",
              "engine_version": "0.20.0",
              "renderer_backend": "wgpu (Metal on macOS)",
              "importer_version": "game_assets_bevy/m0",
              "coordinate_conversion": "none; glTF native +Y up, model forward +Z kept on the spawned entity",
              "required_features": [],
              "validation_status": "unverified",
          },
      ],
      "assets": [
          {
              "asset_id": "asset_health_potion_m0",
              "stable_key": "health_potion",
              "version_id": "version_health_potion_1",
              "kind": "icon_2d",
              "spec_hash": hashlib.sha256(_canonical_json(spec_2d)).hexdigest(),
              "files": [
                  {
                      "role": "main",
                      "path": "assets/icons/health_potion/main.png",
                      "sha256": _sha256_file(icon_path),
                      "byte_length": os.path.getsize(icon_path),
                      "mime": "image/png",
                  }
              ],
              "image": {
                  "width": 512,
                  "height": 512,
                  "alpha_mode": "straight",
                  "color_space": "srgb",
                  "anchor": {"x": 0.5, "y": 0.5, "origin": "top_left"},
                  "pixels_per_world_unit": 100,
                  "sampling": "linear",
              },
              "quality": {
                  "technical_check": {"status": "passed", "validator_version": f"m0-contract-checker/{GENERATOR_VERSION}"},
                  "human_review": {"status": "pending"},
              },
          },
          {
              "asset_id": "asset_wooden_crate_m0",
              "stable_key": "wooden_crate",
              "version_id": "version_wooden_crate_1",
              "kind": "prop_3d",
              "spec_hash": hashlib.sha256(_canonical_json(spec_3d)).hexdigest(),
              "files": [
                  {
                      "role": "main",
                      "path": "assets/props/wooden_crate/main.glb",
                      "sha256": _sha256_file(crate_path),
                      "byte_length": os.path.getsize(crate_path),
                      "mime": "model/gltf-binary",
                  }
              ],
              "mesh": {
                  "scene_index": 0,
                  "unit": "meter",
                  "up_axis": "+Y",
                  "visual_forward": "+Z",
                  "origin": "bottom_center",
                  "measured_dimensions_m": {"x": crate_measured["dimensions_m"][0], "y": crate_measured["dimensions_m"][1], "z": crate_measured["dimensions_m"][2]},
                  "triangles": crate_measured["triangles"],
                  "material_workflow": "gltf_metallic_roughness",
                  "collision": {
                      "kind": "box",
                      "center": [0.0, 0.5, 0.0],
                      "half_extents": [0.5, 0.5, 0.5],
                      "unit": "meter",
                  },
              },
              "quality": {
                  "technical_check": {"status": "passed", "validator_version": f"m0-contract-checker/{GENERATOR_VERSION}"},
                  "human_review": {"status": "pending"},
              },
          },
      ],
  }
  manifest_path = os.path.join(pack, "manifest.json")
  _write_file(manifest_path, json.dumps(manifest, indent=2, sort_keys=False).encode("utf-8") + b"\n")

  # files.sha256 covers manifest.json and the payload files, never itself.
  checksum_lines = []
  for rel in ["manifest.json", "assets/icons/health_potion/main.png", "assets/props/wooden_crate/main.glb"]:
    checksum_lines.append(f"{_sha256_file(os.path.join(pack, rel))}  {rel}")
  _write_file(os.path.join(pack, "files.sha256"), ("\n".join(checksum_lines) + "\n").encode("utf-8"))

  provenance = {
      "generator": "script/artcraft/game-assets/generate_m0_fixtures.py",
      "generator_version": GENERATOR_VERSION,
      "inputs": "procedurally generated; no third-party or user-supplied material",
      "license": "SPDX-License-Identifier: MIT OR Apache-2.0; generated fixture data dedicated to the public domain (CC0-1.0) for reuse in tests",
      "generated_at": PACK_GENERATED_AT,
  }
  _write_file(os.path.join(pack, "provenance.json"), json.dumps(provenance, indent=2, sort_keys=False).encode("utf-8") + b"\n")

  print("fixtures written to", base)
  for name, measured in sorted(measurements.items()):
    print(f"  {name}: triangles={measured['triangles']} dimensions_m={measured['dimensions_m']}")


if __name__ == "__main__":
  if len(sys.argv) > 1 and sys.argv[1] in ("--help", "-h"):
    print(__doc__.strip())
    sys.exit(0)
  root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "..")
  generate(os.path.abspath(root))
