#!/usr/bin/env python3
"""Generate the manifest 2.0 pack fixture `pack_v2_minimal` (GA plan 11.2/12).

Produces a byte-intact 2.0 pack under <repo_root>/test_data/game_assets/pack_v2_minimal:
  * character_3d `hero` — main.glb is the rigged_triangle probe GLB, with a
    full rig block (motion_root_path/semantic_bones per rig_probe_metadata)
  * anim_2d `walk` — 20x10 atlas PNG (two 8x8 frames, 1px extrusion) plus
    its game.anim2d.frames.v1 frames.json
  * anim_3d `spin` — minimal animation GLB (Hero/Hip node track) plus its
    game.anim3d.skeleton_map.v1 skeleton_map.json

Everything is written with the Python standard library only and is
deterministic (frozen GENERATED_AT, content-derived hashes). Usage:
  python3 generate_pack_v2_fixtures.py <repo_root>
"""

import hashlib
import json
import os
import struct
import sys
import zlib

GENERATED_AT = "2026-10-29T00:00:00Z"
PACK_ID = "pack_v2_minimal_v1"
PROJECT_ID = "game_assets_v2"
EXPORT_ID = "export_v2_minimal_v1"
ANIMATION_FPS = 4.0
FRAME_W, FRAME_H = 8, 8

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
            "rest_translation_bounds_m": {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]},
        },
        {
            "slot": "hips",
            "allowed_parents": ["root"],
            "rest_rotation": [0.0, 0.0, 0.0, 1.0],
            "rest_translation_bounds_m": {"min": [0.0, 0.0, 0.0], "max": [0.0, 1.0, 0.0]},
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
            "deformed_bounds_m": {"min": [-5.0, -5.0, -5.0], "max": [5.0, 5.0, 5.0]},
            "max_vertex_displacement_m": 3.0,
        }
    ],
}


def _png_chunk(tag: bytes, data: bytes) -> bytes:
  return (
      struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
  )


def write_png(width: int, height: int, pixels: bytes) -> bytes:
  """RGBA8 PNG; pixels are width*height*4 bytes, top row first."""
  assert len(pixels) == width * height * 4
  raw = bytearray()
  stride = width * 4
  for y in range(height):
    raw.append(0)  # filter type 0 (None)
    raw.extend(pixels[y * stride:(y + 1) * stride])
  return (
      b"\x89PNG\r\n\x1a\n"
      + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
      + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
      + _png_chunk(b"IEND", b"")
  )


def animation_atlas_png() -> bytes:
  """Two 8x8 frames in a 20x10 canvas: 1px transparent margin + 1px extrusion.

  Layout per the frozen grid algorithm: cell = frame + 2px extrusion, so
  frame 0 occupies (1,1)-(8,8) and frame 1 (11,1)-(18,8); frame pixels
  differ so playback visibly changes frames.
  """
  width, height = 2 * (FRAME_W + 2), FRAME_H + 2
  pixels = bytearray(width * height * 4)

  def paint(x0, y0, color):
    for y in range(y0, y0 + FRAME_H):
      for x in range(x0, x0 + FRAME_W):
        offset = (y * width + x) * 4
        pixels[offset:offset + 4] = bytes(color)

  paint(1, 1, (255, 60, 60, 255))
  paint(11, 1, (60, 90, 255, 255))
  return write_png(width, height, bytes(pixels))


def frames_json() -> dict:
  return {
      "schema_version": "game.anim2d.frames.v1",
      "clip_name": "walk",
      "canvas": {"width": FRAME_W, "height": FRAME_H},
      "anchor": {"origin": "top_left", "x": 0.5, "y": 1.0},
      "atlas": {"role": "main", "ordinal": 0, "width": 2 * (FRAME_W + 2), "height": FRAME_H + 2, "extrude_px": 1},
      "fps": ANIMATION_FPS,
      "loop": True,
      "directions": [
          {
              "name": "default",
              "frames": [
                  {"x": 1, "y": 1, "width": FRAME_W, "height": FRAME_H},
                  {"x": FRAME_W + 3, "y": 1, "width": FRAME_W, "height": FRAME_H},
              ],
          }
      ],
  }


def animation_glb() -> bytes:
  """Minimal glTF: scene 0 -> Hero -> Hip; one clip rotating Hip over 1s.

  Track mirrors the rig paths (Hero/Hip) so Bevy's AnimationTargetId from
  the animation matches the character's semantic bone path.
  """
  # keyframes: times 0..1, quaternion z-rotations of Hip.
  times = [0.0, 0.5, 1.0]
  quats = [
      [0.0, 0.0, 0.0, 1.0],
      [0.0, 0.0, 0.3826834323650898, 0.9238795325112867],
      [0.0, 0.0, 0.0, 1.0],
  ]
  binary = bytearray()
  binary += b"\0" * ((4 - len(binary) % 4) % 4)
  time_offset = 0
  binary += struct.pack("<%df" % len(times), *times)
  time_length = len(times) * 4
  binary += b"\0" * ((4 - len(binary) % 4) % 4)
  quat_offset = len(binary)
  binary += struct.pack("<%df" % (len(quats) * 4), *[v for q in quats for v in q])
  quat_length = len(quats) * 16

  document = {
      "asset": {"version": "2.0"},
      "scene": 0,
      "scenes": [{"nodes": [0]}],
      "nodes": [{"name": "Hero", "children": [1]}, {"name": "Hip"}],
      "animations": [
          {
              "channels": [{"sampler": 0, "target": {"node": 1, "path": "rotation"}}],
              "samplers": [{"input": 0, "output": 1, "interpolation": "LINEAR"}],
          }
      ],
      "buffers": [{"byteLength": len(binary)}],
      "bufferViews": [
          {"buffer": 0, "byteOffset": time_offset, "byteLength": time_length},
          {"buffer": 0, "byteOffset": quat_offset, "byteLength": quat_length},
      ],
      "accessors": [
          {"bufferView": 0, "componentType": 5126, "count": len(times), "type": "SCALAR", "min": [0.0], "max": [1.0]},
          {"bufferView": 1, "componentType": 5126, "count": len(quats), "type": "VEC4"},
      ],
  }
  json_text = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()
  while len(json_text) % 4:
    json_text += b" "
  total = 12 + 8 + len(json_text) + 8 + len(binary)
  out = bytearray()
  out += b"glTF" + struct.pack("<II", 2, total)
  out += struct.pack("<II", len(json_text), 0x4E4F534A) + json_text
  out += struct.pack("<II", len(binary), 0x004E4942) + binary
  return bytes(out)


def skeleton_map(rig_main_sha: str) -> dict:
  return {
      "schema_version": "game.anim3d.skeleton_map.v1",
      "rig_version_token": "rig_v1",
      "rig_main_sha256": rig_main_sha,
      "clip": {"animation_index": 0, "name": "spin", "duration_seconds": 1.0, "loop": True, "root_motion": "in_place"},
      "mappings": [
          {"animation_node_path": ["Hero", "Hip"], "rig_node_path": ["Hero", "Hip"]},
      ],
  }


def quality() -> dict:
  return {
      "technical_check": {"status": "pending", "validator_version": "engineering_fixture_only"},
      "human_review": {"status": "pending"},
  }


def main(repo_root: str) -> int:
  pack = os.path.join(repo_root, "test_data", "game_assets", "pack_v2_minimal")
  hero_src = os.path.join(repo_root, "test_data", "game_assets", "character_animation", "rigged_triangle.glb")
  hero_glb = open(hero_src, "rb").read()
  atlas = animation_atlas_png()
  spin = animation_glb()

  def write(rel: str, data: bytes) -> dict:
    path = os.path.join(pack, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
      handle.write(data)
    return {
        "role": rel.rsplit("/", 1)[1].split(".")[0],
        "ordinal": 0,
        "path": rel,
        "sha256": hashlib.sha256(data).hexdigest(),
        "byte_length": len(data),
        "mime": {"png": "image/png", "glb": "model/gltf-binary", "json": "application/json"}[rel.rsplit(".", 1)[1]],
    }

  hero_file = write("assets/characters/hero/main.glb", hero_glb)
  walk_main = write("assets/animations_2d/walk/main.png", atlas)
  frames_file = write("assets/animations_2d/walk/frames.json", json.dumps(frames_json(), indent=2).encode())
  spin_main = write("assets/animations_3d/spin/main.glb", spin)
  map_file = write(
      "assets/animations_3d/spin/skeleton_map.json",
      json.dumps(skeleton_map(hero_file["sha256"]), indent=2).encode(),
  )

  rig_profile_hash = hashlib.sha256(
      json.dumps(RIG_PROFILE, sort_keys=True, separators=(",", ":")).encode()
  ).hexdigest()
  manifest = {
      "schema_version": "2.0",
      "pack_id": PACK_ID,
      "project_id": PROJECT_ID,
      "export_id": EXPORT_ID,
      "generated_at": GENERATED_AT,
      "engine_profiles": [
          {
              "id": "bevy_0200",
              "engine": "bevy",
              "engine_version": "0.20.0",
              "renderer_backend": "wgpu",
              "importer_version": "pack_v2_fixture_1",
              "coordinate_conversion": "y_up_z_forward_passthrough",
              "required_features": [
                  "game.character3d.rig.v1",
                  "game.anim2d.frames.v1",
                  "game.anim3d.skeleton_map.v1",
              ],
              "validation_status": "unverified",
          }
      ],
      "assets": [
          {
              "asset_id": "hero",
              "stable_key": "hero",
              "display_name": "Hero (rigged triangle)",
              "version_id": "rig_v1",
              "kind": "character_3d",
              "stage": "rigged",
              "spec_hash": hashlib.sha256(b"hero_spec").hexdigest(),
              "files": [hero_file],
              "dependencies": [],
              "quality": quality(),
              "mesh": {
                  "scene_index": 0,
                  "unit": "meter",
                  "up_axis": "+Y",
                  "visual_forward": "+Z",
                  "origin": "profile_defined",
                  "measured_dimensions_m": {"x": 1.0, "y": 1.0, "z": 0.0},
                  "triangles": 1,
                  "material_workflow": "gltf_metallic_roughness",
                  "collision": {
                      "kind": "capsule",
                      "unit": "meter",
                      "center": [0, 1, 0],
                      "radius_m": 0.25,
                      "total_height_m": 2,
                  },
              },
              "rig": {
                  "scene_index": 0,
                  "rig_profile": RIG_PROFILE,
                  "rig_profile_hash": rig_profile_hash,
                  "motion_root_path": ["Hero"],
                  "semantic_bones": {"root": ["Hero"], "hips": ["Hero", "Hip"]},
                  "bone_count": 1,
                  "skin_count": 1,
                  "max_influences_per_vertex": 1,
                  "node_rest_sha256": hashlib.sha256(hero_glb).hexdigest(),
                  "skin_sha256": hashlib.sha256(hero_glb).hexdigest(),
              },
          },
          {
              "asset_id": "walk_2d",
              "stable_key": "walk",
              "display_name": "Walk (2 frames)",
              "version_id": "frames_v1",
              "kind": "anim_2d",
              "stage": "animation",
              "spec_hash": hashlib.sha256(b"walk_spec").hexdigest(),
              "files": [walk_main, frames_file],
              "dependencies": [],
              "quality": quality(),
              "animation_2d": {
                  "frames_file": {"role": "frames", "ordinal": 0},
                  "pixels_per_world_unit": 100,
                  "sampling": "nearest",
                  "alpha_mode": "straight",
              },
          },
          {
              "asset_id": "spin_3d",
              "stable_key": "spin",
              "display_name": "Spin clip",
              "version_id": "clip_v1",
              "kind": "anim_3d",
              "stage": "animation",
              "spec_hash": hashlib.sha256(b"spin_spec").hexdigest(),
              "files": [spin_main, map_file],
              "dependencies": [
                  {
                      "role": "rig",
                      "asset_id": "hero",
                      "version_id": "rig_v1",
                      "rig_main_sha256": hero_file["sha256"],
                  }
              ],
              "quality": quality(),
              "animation_3d": {
                  "scene_index": 0,
                  "skeleton_map_file": {"role": "skeleton_map", "ordinal": 0},
              },
          },
      ],
  }
  with open(os.path.join(pack, "manifest.json"), "w") as handle:
    handle.write(json.dumps(manifest, indent=2) + "\n")
  print("wrote", pack)
  return 0


if __name__ == "__main__":
  if len(sys.argv) != 2:
    print("usage: generate_pack_v2_fixtures.py <repo_root>")
    sys.exit(2)
  sys.exit(main(sys.argv[1]))
