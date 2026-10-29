#!/usr/bin/env python3
"""Manifest 2.0 Godot consumer regression (parse, install graph, journal v2,
animation resources). Builds deterministic fixture packs (real PNG atlases,
rigged GLBs with skin + animation, skeleton maps, frames tables), then runs
the headless GDScript suite in an isolated scratch project."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "test_data/game_assets/contracts/fixtures"
SCHEMAS = ROOT / "test_data/game_assets/contracts/schemas"

GODOT_PROFILE = {
    "id": "ga_profile_godot_4_7_2",
    "engine": "godot",
    "engine_version": "4.7.2",
    "renderer_backend": "forward_plus",
    "importer_version": "game_assets_addon_1",
    "coordinate_conversion": "y_up_z_forward_passthrough",
    "required_features": [
        "game.character3d.rig.v1",
        "game.anim2d.frames.v1",
        "game.anim3d.skeleton_map.v1",
    ],
    "validation_status": "verified",
    "animation_2d_world_unit_scale": 100.0,
}
BEVY_PROFILE = {
    "id": "engineering_bevy",
    "engine": "bevy",
    "engine_version": "0.20.0",
    "renderer_backend": "wgpu",
    "importer_version": "game_assets_bevy_1",
    "coordinate_conversion": "y_up_z_forward_passthrough",
    "required_features": [
        "game.character3d.rig.v1",
        "game.anim2d.frames.v1",
        "game.anim3d.skeleton_map.v1",
    ],
    "validation_status": "verified",
}
RIG_PROFILE = {
    "schema_version": "game.rig_profile.v1",
    "id": "engineering_only",
    "revision": "fixture_1",
    "unit": "meter",
    "up_axis": "+Y",
    "visual_forward": "+Z",
    "pose": "t_pose",
    "motion_root_slot": "root",
    "bones": [
        {
            "slot": "root",
            "allowed_parents": [None],
            "rest_rotation": [0.0, 0.0, 0.0, 1.0],
            "rest_translation_bounds_m": {"min": [0, 0, 0], "max": [0, 0, 0]},
        },
        {
            "slot": "hips",
            "allowed_parents": ["root"],
            "rest_rotation": [0.0, 0.0, 0.0, 1.0],
            "rest_translation_bounds_m": {"min": [0, 0, 0], "max": [0, 1, 0]},
        },
    ],
    "max_bones": 8,
    "max_skins": 4,
    "max_influences_per_vertex": 4,
    "max_nodes": 32,
    "max_accessors": 32,
    "max_vertices": 1000,
    "tolerances": {
        "weight_sum": 0.0001,
        "bind_matrix": 0.0001,
        "rest_pose_radians": 0.001,
        "quaternion_norm": 0.0001,
        "deformation_position_m": 0.001,
    },
    "diagnostic_poses": [
        {
            "id": "engineering_bend",
            "joints": [{"slot": "hips", "rotation": [0.0, 0.0, 0.25881904510252074, 0.9659258262890683]}],
            "deformed_bounds_m": {"min": [-5, -5, -5], "max": [5, 5, 5]},
            "max_vertex_displacement_m": 3.0,
        }
    ],
}
# Hash of the fixture rig profile (canonical, produced by the services
# exporter); the Godot validator checks shape only.
RIG_PROFILE_HASH = "c5361168287f1d8ec75333863a3d5823ddf730045b8c9dd99b7f4961dcae8196"

failures = []


def check(condition: bool, label: str, detail: str = "") -> bool:
  status = "PASS" if condition else "FAIL"
  suffix = f" :: {detail}" if detail and not condition else ""
  print(f"[{status}] {label}{suffix}")
  if not condition:
    failures.append(label)
  return condition


def png(width: int, height: int, paint) -> bytes:
  """Minimal RGBA PNG (color type 6, filter 0 scanlines)."""
  raw = b""
  for y in range(height):
    raw += b"\x00"
    for x in range(width):
      raw += bytes(paint(x, y))
  def chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
  header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
  return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
          + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def glb(document: dict, blob: bytes) -> bytes:
  js = json.dumps(document, separators=(",", ":")).encode()
  js_pad = js + b" " * ((4 - len(js) % 4) % 4)
  bin_pad = blob + b"\0" * ((4 - len(blob) % 4) % 4)
  total = 12 + 8 + len(js_pad) + 8 + len(bin_pad)
  out = struct.pack("<III", 0x46546C67, 2, total)
  out += struct.pack("<I", len(js_pad)) + b"JSON" + js_pad
  out += struct.pack("<I", len(blob)) + b"BIN\x00" + bin_pad
  return out


def float_accessors(items: list) -> tuple:
  """Single-buffer accessor packing: [(bytes, count, component_type, type)]."""
  blob = b""
  accessors = []
  for data, count, ctype, atype in items:
    accessors.append({
      "bufferView": 0, "byteOffset": len(blob),
      "componentType": ctype, "count": count, "type": atype,
    })
    blob += data
  return blob, [{"buffer": 0, "byteOffset": 0, "byteLength": len(blob)}], accessors


def rig_glb(hip_y: float = 1.0) -> bytes:
  """Two-joint skeleton (Hero -> Hip) with a tiny skinned triangle mesh."""
  verts = struct.pack("<9f", -0.5, 0, 0, 0.5, 0, 0, 0, 1, 0)
  weights = struct.pack("<12f", 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)
  joints = bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  ibm = b"".join(struct.pack("<16f", 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) for _ in range(2))
  blob, views, accessors = float_accessors([
    (struct.pack("<3f", 0, 0, 0), 1, 5126, "VEC3"),            # 0 root translation
    (struct.pack("<4f", 0, 0, 0, 1), 1, 5126, "VEC4"),          # 1 root rotation
    (struct.pack("<3f", 0, hip_y, 0), 1, 5126, "VEC3"),         # 2 hip translation
    (verts, 3, 5126, "VEC3"),                                   # 3 positions
    (weights, 3, 5126, "VEC4"),                                 # 4 weights
    (ibm, 2, 5126, "MAT4"),                                     # 5 inverse binds
  ])
  document = {
    "asset": {"version": "2.0", "generator": "artcraft-test"},
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [
      {"name": "Hero", "children": [1], "mesh": 0, "skin": 0, "translation": [0, 0, 0]},
      {"name": "Hip", "translation": [0, hip_y, 0]},
    ],
    "meshes": [{"primitives": [{"attributes": {"POSITION": 3, "JOINTS_0": 6, "WEIGHTS_0": 4}}]}],
    "skins": [{"joints": [0, 1], "inverseBindMatrices": 5}],
    "accessors": accessors + [{"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"}],
    "bufferViews": views + [{"buffer": 0, "byteOffset": len(blob), "byteLength": len(joints)}],
    "buffers": [{"byteLength": len(blob) + len(joints)}],
  }
  return glb(document, blob + joints)


def clip_glb() -> bytes:
  """Clip animating Hip's rotation; the motion root holds its rest TRS."""
  times = struct.pack("<2f", 0.0, 1.0)
  rotations = struct.pack("<8f", 0, 0, 0, 1, 0, 0, 0.3826834, 0.9238795)
  translations = struct.pack("<6f", 0, 0, 0, 0, 0, 0)
  blob, views, accessors = float_accessors([
    (times, 2, 5126, "SCALAR"),
    (rotations, 2, 5126, "VEC4"),
    (translations, 2, 5126, "VEC3"),
  ])
  document = {
    "asset": {"version": "2.0", "generator": "artcraft-test"},
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [
      {"name": "Hero", "children": [1]},
      {"name": "Hip", "translation": [0, 1, 0]},
    ],
    "animations": [{
      "channels": [
        {"sampler": 0, "target": {"node": 1, "path": "rotation"}},
        {"sampler": 1, "target": {"node": 0, "path": "translation"}},
      ],
      "samplers": [
        {"input": 0, "output": 1, "interpolation": "LINEAR"},
        {"input": 0, "output": 2, "interpolation": "LINEAR"},
      ],
    }],
    "accessors": accessors,
    "bufferViews": views,
    "buffers": [{"byteLength": len(blob)}],
  }
  return glb(document, blob)


def frames_table(pixels: dict) -> dict:
  """4-direction (n/e/s/w) frames table over a 32x4 atlas, 2px cells with
  1px extrusion, following Animation2dSpec::plan_geometry layout."""
  directions = []
  for index, name in enumerate(["n", "e", "s", "w"]):
    frames = [
      {"x": 1 + (index * 2 + frame) * 4, "y": 1, "width": 2, "height": 2}
      for frame in range(2)
    ]
    directions.append({"name": name, "frames": frames})
  return {
    "schema_version": "game.anim2d.frames.v1",
    "clip_name": "walk",
    "canvas": {"width": 2, "height": 2},
    "anchor": {"origin": "top_left", "x": 0.5, "y": 0.5},
    "atlas": {"role": "main", "ordinal": 0, "width": 32, "height": 4, "extrude_px": 1},
    "fps": 8,
    "loop": True,
    "directions": directions,
  }


def atlas_png() -> bytes:
  def paint(x: int, y: int):
    if 1 <= y <= 2:
      for start in range(1, 32, 4):
        if start <= x <= start + 2:
          return (32 + start * 6 % 200, 64 + y * 40, 96 + start * 3 % 140, 255)
    return (20, 20, 20, 255)
  return png(32, 4, paint)


def icon_png() -> bytes:
  return png(2, 2, lambda x, y: (255 if x else 40, 40, 255 if y else 40, 255))


def skeleton_map(version: str, rig_sha: str) -> dict:
  return {
    "schema_version": "game.anim3d.skeleton_map.v1",
    "rig_version_token": version,
    "rig_main_sha256": rig_sha,
    "clip": {"animation_index": 0, "name": "walk", "duration_seconds": 1.0, "loop": True, "root_motion": "in_place"},
    "mappings": [
      {"animation_node_path": ["Hero"], "rig_node_path": ["Hero"]},
      {"animation_node_path": ["Hero", "Hip"], "rig_node_path": ["Hero", "Hip"]},
    ],
  }


def quality() -> dict:
  return {
    "technical_check": {"status": "passed", "validator_version": "test_validator_1"},
    "human_review": {"status": "passed"},
  }


def mesh_block(collision_kind: str) -> dict:
  return {
    "scene_index": 0,
    "unit": "meter",
    "up_axis": "+Y",
    "visual_forward": "+Z",
    "origin": "profile_defined",
    "measured_dimensions_m": {"x": 1.0, "y": 2.0, "z": 1.0},
    "triangles": 1,
    "material_workflow": "gltf_metallic_roughness",
    "collision": {
      "kind": collision_kind,
      "unit": "meter",
      "center": [0, 1, 0],
      "radius_m": 0.25,
      "total_height_m": 2.0,
    },
  }


def write_file(path: Path, data: bytes) -> dict:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_bytes(data)
  return {"sha256": hashlib.sha256(data).hexdigest(), "byte_length": len(data)}


def manifest_file(role: str, ordinal: int, path: str, mime: str, record: dict) -> dict:
  return {"role": role, "ordinal": ordinal, "path": path, "mime": mime, **record}


def build_pack(root: Path, hero_version: str, clip_version: str | None, rig_bytes: bytes, pack_id: str) -> dict:
  """One 2.0 pack: hero rig + walk_2d + (optional) walk_3d + hud_icon."""
  manifest = {
    "schema_version": "2.0",
    "pack_id": pack_id,
    "project_id": "engineering_project",
    "export_id": "engineering_export",
    "generated_at": "2026-10-28T00:00:00Z",
    "engine_profiles": [GODOT_PROFILE, BEVY_PROFILE],
    "assets": [],
  }
  hero_main = write_file(root / "assets/characters/hero/main.glb", rig_bytes)
  hero = {
    "asset_id": "hero",
    "stable_key": "hero",
    "display_name": "Hero rig",
    "version_id": hero_version,
    "kind": "character_3d",
    "stage": "rigged",
    "spec_hash": "a" * 64,
    "files": [manifest_file("main", 0, "assets/characters/hero/main.glb", "model/gltf-binary", hero_main)],
    "dependencies": [],
    "quality": quality(),
    "mesh": mesh_block("capsule"),
    "rig": {
      "scene_index": 0,
      "rig_profile": RIG_PROFILE,
      "rig_profile_hash": RIG_PROFILE_HASH,
      "motion_root_path": ["Hero"],
      "semantic_bones": {"root": ["Hero"], "hips": ["Hero", "Hip"]},
      "bone_count": 2,
      "skin_count": 1,
      "max_influences_per_vertex": 1,
      "node_rest_sha256": "b" * 64,
      "skin_sha256": "c" * 64,
    },
  }
  manifest["assets"].append(hero)

  walk_png = write_file(root / "assets/animations_2d/walk/main.png", atlas_png())
  table = frames_table({})
  walk_frames = write_file(root / "assets/animations_2d/walk/frames.json", json.dumps(table).encode())
  manifest["assets"].append({
    "asset_id": "walk_2d",
    "stable_key": "walk",
    "display_name": "Walk frames",
    "version_id": "frames_v1",
    "kind": "anim_2d",
    "stage": "animation",
    "spec_hash": "b" * 64,
    "files": [
      manifest_file("main", 0, "assets/animations_2d/walk/main.png", "image/png", walk_png),
      manifest_file("frames", 0, "assets/animations_2d/walk/frames.json", "application/json", walk_frames),
    ],
    "dependencies": [],
    "quality": quality(),
    "animation_2d": {
      "frames_file": {"role": "frames", "ordinal": 0},
      "pixels_per_world_unit": 50,
      "sampling": "nearest",
      "alpha_mode": "straight",
    },
  })

  if clip_version is not None:
    clip_bytes = clip_glb()
    walk_clip = write_file(root / "assets/animations_3d/walk/main.glb", clip_bytes)
    skeleton = write_file(
      root / "assets/animations_3d/walk/skeleton_map.json",
      json.dumps(skeleton_map(hero_version, hero_main["sha256"])).encode(),
    )
    manifest["assets"].append({
      "asset_id": "walk_3d",
      "stable_key": "walk",
      "display_name": "Walk clip",
      "version_id": clip_version,
      "kind": "anim_3d",
      "stage": "animation",
      "spec_hash": "c" * 64,
      "files": [
        manifest_file("main", 0, "assets/animations_3d/walk/main.glb", "model/gltf-binary", walk_clip),
        manifest_file("skeleton_map", 0, "assets/animations_3d/walk/skeleton_map.json", "application/json", skeleton),
      ],
      "dependencies": [{
        "role": "rig",
        "asset_id": "hero",
        "version_id": hero_version,
        "rig_main_sha256": hero_main["sha256"],
      }],
      "quality": quality(),
      "animation_3d": {"scene_index": 0, "skeleton_map_file": {"role": "skeleton_map", "ordinal": 0}},
    })

  icon = write_file(root / "assets/icons/hud_icon/main.png", icon_png())
  manifest["assets"].append({
    "asset_id": "hud_icon",
    "stable_key": "hud_icon",
    "display_name": "HUD icon",
    "version_id": "icon_v1",
    "kind": "icon_2d",
    "stage": "asset",
    "spec_hash": "d" * 64,
    "files": [manifest_file("main", 0, "assets/icons/hud_icon/main.png", "image/png", icon)],
    "dependencies": [],
    "quality": quality(),
    "image": {
      "width": 2,
      "height": 2,
      "alpha_mode": "straight",
      "color_space": "srgb",
      "anchor": {"origin": "top_left", "x": 0.5, "y": 0.5},
      "pixels_per_world_unit": 100,
      "sampling": "nearest",
    },
  })
  (root / "manifest.json").write_text(json.dumps(manifest, indent=2))
  return manifest


def build_v1_pack(root: Path, pack_id: str) -> None:
  """1.0 static pack sharing the project identity (update-merge case)."""
  icon = write_file(root / "assets/icons/hud_icon/main.png", icon_png())
  manifest = {
    "schema_version": "1.0",
    "pack_id": pack_id,
    "project_id": "engineering_project",
    "export_id": "engineering_export_v1",
    "generated_at": "2026-10-28T00:00:00Z",
    "engine_profiles": [GODOT_PROFILE | {"required_features": []}, BEVY_PROFILE | {"required_features": []}],
    "assets": [{
      "asset_id": "hud_icon",
      "stable_key": "hud_icon",
      "display_name": "HUD icon",
      "version_id": "icon_v2",
      "kind": "icon_2d",
      "spec_hash": "e" * 64,
      "files": [{"role": "main", "path": "assets/icons/hud_icon/main.png", "mime": "image/png", **icon}],
      "quality": quality(),
      "image": {
        "width": 2,
        "height": 2,
        "alpha_mode": "straight",
        "color_space": "srgb",
        "anchor": {"origin": "top_left", "x": 0.5, "y": 0.5},
        "pixels_per_world_unit": 100,
        "sampling": "nearest",
      },
    }],
  }
  (root / "manifest.json").write_text(json.dumps(manifest, indent=2))


def adapt_contract_fixtures(target: Path) -> list:
  """Contract fixtures use a bevy-only profile; the Godot plugin requires a
  godot profile, so inject one and record the expected verdict."""
  cases = []
  source = FIXTURES / "asset_pack_manifest_v2"
  for path in sorted(source.glob("*.json")):
    data = json.loads(path.read_text())
    profiles = data.get("engine_profiles", [])
    if not any(p.get("engine") == "godot" for p in profiles):
      profiles = profiles + [GODOT_PROFILE]
      data["engine_profiles"] = profiles
    adapted = target / path.name
    adapted.parent.mkdir(parents=True, exist_ok=True)
    adapted.write_text(json.dumps(data))
    cases.append((path.name, path.name.startswith("valid_")))
  return cases


def static_fixture_table_check(cases: list) -> None:
  """Static consistency: every contract fixture must appear in the GDScript
  expectation table, so a fixture added without a verdict fails loudly
  instead of silently never running."""
  suite = Path(__file__).with_suffix(".gd").read_text()
  for name, _ in cases:
    check(name in suite, f"fixture {name} covered by the test expectation table")


def schema_static_checks(packs: dict) -> None:
  """Static consistency: generated packs validate against the frozen v2
  JSON Schema (the exporter-side contract)."""
  try:
    from jsonschema import Draft202012Validator
  except ImportError:
    check(False, "jsonschema available for static schema check", "not installed")
    return
  schema = json.loads((SCHEMAS / "asset_pack_manifest_v2.schema.json").read_text())
  validator = Draft202012Validator(schema)
  for name, manifest in packs.items():
    errors = list(validator.iter_errors(manifest))
    check(not errors, f"generated {name} validates against frozen v2 schema",
          "; ".join(e.message for e in errors[:3]))


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--godot", required=True, type=Path, help="Godot 4.7.2 executable")
  args = parser.parse_args()
  executable = args.godot.expanduser().resolve()
  if not executable.is_file():
    parser.error("Godot executable is missing")

  project = Path(tempfile.mkdtemp(prefix="artcraft-godot-manifest-v2-"))
  (project / "project.godot").write_text(
    'config_version=5\n[application]\nconfig/name="Artcraft manifest 2.0 regression"\n')
  shutil.copytree(ROOT / "integrations/godot/game_assets/addons", project / "addons")

  packs = {}
  packs["pack_v2"] = build_pack(project / "packs/pack_v2", "rig_v1", "clip_v1", rig_glb(), "engineering_pack")
  packs["pack_sync"] = build_pack(project / "packs/pack_sync", "rig_v2", "clip_v2", rig_glb(1.5), "engineering_pack_sync")
  packs["pack_rig_only"] = build_pack(project / "packs/pack_rig_only", "rig_v2", None, rig_glb(1.5), "engineering_pack_rig")
  build_v1_pack(project / "packs/pack_v1_static", "engineering_pack_v1_static")
  schema_static_checks({k: v for k, v in packs.items()})

  adapted = adapt_contract_fixtures(project / "fixtures_manifest_v2")
  static_fixture_table_check(adapted)
  shutil.copytree(FIXTURES / "anim2d_frames.v1", project / "fixtures_frames")
  shutil.copytree(FIXTURES / "anim3d_skeleton_map.v1", project / "fixtures_skeleton")

  # One headless editor pass builds .godot (global class_name cache) so the
  # --script run resolves self-referencing class_names like GameAssetLodChain.
  warmup = subprocess.run(
    [str(executable), "--headless", "--editor", "--path", str(project), "--quit"],
    capture_output=True, text=True, timeout=300)
  (project / "warmup.log").write_text(warmup.stdout + warmup.stderr)

  command = [
    str(executable), "--headless", "--path", str(project),
    "--script", str(Path(__file__).with_suffix(".gd")), "--",
    str(project / "packs"), str(adapted),
  ]
  result = subprocess.run(command, capture_output=True, text=True, timeout=600)
  (project / "test.log").write_text(result.stdout + result.stderr)
  print(result.stdout, end="")
  print(result.stderr, end="")
  print(f"Retained isolated project and log: {project}")
  ok = result.returncode == 0 and "ARTCRAFT_MANIFEST_V2_OK" in result.stdout.splitlines()
  raise SystemExit(0 if ok and not failures else (result.returncode or 1))


if __name__ == "__main__":
  main()
