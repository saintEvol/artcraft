#!/usr/bin/env python3
"""Run the Cocos import lifecycle regression in a real editor (3.8.8).

Covers: journal v2 + managed .meta digests, idempotent re-import (bytes and
mtime untouched), local-modification rejection, retained-rig conflict
rejection (nothing touched), version update with stable asset UUID, and a
manifest 1.x static pack import. Exit summary line mirrors the godot driver
(ARTCRAFT_COCOS_LIFECYCLE_OK / _FAIL).
"""
from pathlib import Path
import hashlib
import json
import shutil
import struct
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cocos_driver import ROOT, create_project, report_summary, run_editor_task

UPDATE_PACKS_DIR = Path(tempfile.mkdtemp(prefix="artcraft-cocos-lifecycle-packs-"))


def sha256(data: bytes) -> str:
  return hashlib.sha256(data).hexdigest()


def repack_glb(data: bytes, marker: str) -> bytes:
  """Rewrite a GLB's JSON chunk with an asset extras marker (new bytes, same rig)."""
  length, chunk_type = struct.unpack("<II", data[12:20])
  assert chunk_type == 0x4E4F534A, "first chunk must be JSON"
  document = json.loads(data[20:20 + length])
  document.setdefault("asset", {"version": "2.0"})["extras"] = {"artcraft_marker": marker}
  text = json.dumps(document, separators=(",", ":")).encode()
  text += b" " * ((4 - len(text) % 4) % 4)
  rest = data[20 + length:]
  total = 20 + len(text) + len(rest)
  return struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text + rest


def clone_pack(name: str, source: Path) -> Path:
  target = UPDATE_PACKS_DIR / name
  if target.exists():
    shutil.rmtree(target)
  shutil.copytree(source, target)
  return target


def build_update_pack(source: Path) -> Path:
  """hero@rig_v2 + spin@clip_v2 with new bytes and a rewired dependency chain."""
  target = clone_pack("update_v2", source)
  manifest = json.loads((target / "manifest.json").read_text())
  hero_bytes = repack_glb((target / "assets/characters/hero/main.glb").read_bytes(), "hero_v2")
  spin_bytes = repack_glb((target / "assets/animations_3d/spin/main.glb").read_bytes(), "spin_v2")
  (target / "assets/characters/hero/main.glb").write_bytes(hero_bytes)
  (target / "assets/animations_3d/spin/main.glb").write_bytes(spin_bytes)
  hero_sha, spin_sha = sha256(hero_bytes), sha256(spin_bytes)
  assets = {asset["asset_id"]: asset for asset in manifest["assets"]}
  hero = assets["hero"]
  hero["version_id"] = "rig_v2"
  hero["spec_hash"] = hashlib.sha256(b"hero-v2-spec").hexdigest()
  hero["rig"]["node_rest_sha256"] = hero_sha
  hero["rig"]["skin_sha256"] = hero_sha
  file_record = hero["files"][0]
  file_record["sha256"], file_record["byte_length"] = hero_sha, len(hero_bytes)
  spin = assets["spin_3d"]
  spin["version_id"] = "clip_v2"
  spin["spec_hash"] = hashlib.sha256(b"spin-v2-spec").hexdigest()
  dependency = spin["dependencies"][0]
  dependency["version_id"], dependency["rig_main_sha256"] = "rig_v2", hero_sha
  file_record = spin["files"][0]
  file_record["sha256"], file_record["byte_length"] = spin_sha, len(spin_bytes)
  skeleton_map = json.loads((target / "assets/animations_3d/spin/skeleton_map.json").read_text())
  skeleton_map["rig_version_token"] = "rig_v2"
  skeleton_map["rig_main_sha256"] = hero_sha
  (target / "assets/animations_3d/spin/skeleton_map.json").write_text(json.dumps(skeleton_map, indent=2))
  map_bytes = (target / "assets/animations_3d/spin/skeleton_map.json").read_bytes()
  map_record = next(f for f in spin["files"] if f["role"] == "skeleton_map")
  map_record["sha256"], map_record["byte_length"] = sha256(map_bytes), len(map_bytes)
  manifest["pack_id"] = "pack_v2_minimal_v2"
  (target / "manifest.json").write_text(json.dumps(manifest, indent=2))
  return target


def build_retained_conflict_pack(update_pack: Path) -> Path:
  """hero@rig_v2 only; the retained spin still depends on rig_v1, so the final
  install graph must reject the whole update."""
  target = clone_pack("conflict_rig_change", update_pack)
  manifest = json.loads((target / "manifest.json").read_text())
  manifest["pack_id"] = "pack_hero_only_v2"
  manifest["assets"] = [asset for asset in manifest["assets"] if asset["asset_id"] == "hero"]
  (target / "manifest.json").write_text(json.dumps(manifest, indent=2))
  shutil.rmtree(target / "assets/animations_2d")
  shutil.rmtree(target / "assets/animations_3d")
  return target


def build_legacy_pack(source: Path) -> Path:
  """manifest 1.0 static sprite pack built from the walk atlas PNG."""
  target = UPDATE_PACKS_DIR / "pack_1x"
  if target.exists():
    shutil.rmtree(target)
  (target / "assets/sprites/walk").mkdir(parents=True)
  png = source / "assets/animations_2d/walk/main.png"
  data = png.read_bytes()
  shutil.copy(png, target / "assets/sprites/walk/main.png")
  manifest = {
      "schema_version": "1.0",
      "pack_id": "pack_1x_fixture",
      "project_id": "game_assets_1x",
      "export_id": "export_1x_fixture",
      "generated_at": "2026-10-29T00:00:00Z",
      "provenance": {
          "license": "CC0-1.0 (fixture)",
          "source_note": "1.x static sprite fixture",
          "provenance_ref": "provenance.json",
      },
      "engine_profiles": [{
          "id": "cocos_fixture", "engine": "cocos", "engine_version": "3.8.8",
          "renderer_backend": "webgl2", "importer_version": "fixture_1",
          "coordinate_conversion": "none", "required_features": [],
          "validation_status": "unverified",
      }],
      "assets": [{
          "asset_id": "fixture_sprite",
          "stable_key": "walk_sprite",
          "version_id": "version_walk_1",
          "kind": "sprite_2d",
          "spec_hash": "b" * 64,
          "files": [{
              "role": "main", "ordinal": 0, "path": "assets/sprites/walk/main.png",
              "sha256": sha256(data), "byte_length": len(data), "mime": "image/png",
          }],
          "image": {
              "width": 20, "height": 10, "alpha_mode": "straight", "color_space": "srgb",
              "anchor": {"origin": "top_left", "x": 0.5, "y": 0.5},
              "pixels_per_world_unit": 100, "sampling": "nearest",
          },
      }],
  }
  (target / "manifest.json").write_text(json.dumps(manifest, indent=2))
  return target


def main() -> int:
  editor = Path("/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator")
  if not editor.is_file():
    print("FAIL Cocos Creator 3.8.8 not found at /Applications/Cocos/Creator/3.8.8")
    return 1
  pack_dir = ROOT / "test_data/game_assets/pack_v2_minimal"
  update_pack = build_update_pack(pack_dir)
  conflict_pack = build_retained_conflict_pack(update_pack)
  legacy_pack = build_legacy_pack(pack_dir)
  project = create_project("artcraft-cocos-lifecycle-")
  result_path, log_path = run_editor_task(project, {
      "kind": "import-lifecycle",
      "packDir": str(pack_dir),
      "packV2Dir": str(UPDATE_PACKS_DIR),
      "pack1xDir": str(legacy_pack),
  }, timeout_s=420)
  print(f"Retained lifecycle project and log: {project}")
  print(f"Editor log: {log_path}")
  print(f"Fixture packs: {UPDATE_PACKS_DIR}")
  return report_summary(result_path, "ARTCRAFT_COCOS_LIFECYCLE_OK")


if __name__ == "__main__":
  raise SystemExit(main())
