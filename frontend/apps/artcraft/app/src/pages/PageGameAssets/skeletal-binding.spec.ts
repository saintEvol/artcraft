import { expect, it } from "vitest";
import { AnimationClip, AnimationMixer, Group, Object3D, VectorKeyframeTrack } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { parseSkeletonMap } from "@storyteller/api";
import { bindSkeletalClip } from "./bind-skeletal-clip";

const TOLERANCE = { rest_matrix: 0.0001, endpoint_seconds: 0.0001, quaternion_norm: 0.0001 };

it("requires the exact rig identity and a complete, unique mapping", () => {
  expect(parseSkeletonMap(map(), "rig-v1", "a".repeat(64)).clip.name).toBe("walk");
  expect(() => parseSkeletonMap(map(), "rig-v2", "a".repeat(64))).toThrow(/版本/);
  expect(() => parseSkeletonMap(map(), "rig-v1", "b".repeat(64))).toThrow(/摘要/);
  expect(() => parseSkeletonMap({ ...map(), extra: true }, "rig-v1", "a".repeat(64))).toThrow();
  const duplicate = map(); duplicate.mappings.push(duplicate.mappings[0]);
  expect(() => parseSkeletonMap(duplicate, "rig-v1", "a".repeat(64))).toThrow(/重复/);
});

it("binds a full path to this instance even when other branches have the same leaf name", async () => {
  const rigOne = fixture(false), rigTwo = fixture(false), motion = fixture(true);
  const skeleton = parseSkeletonMap(map(), "rig-v1", "a".repeat(64));
  const first = await bindSkeletalClip(rigOne.gltf, motion.gltf, skeleton, TOLERANCE);
  const second = await bindSkeletalClip(rigTwo.gltf, motion.gltf, skeleton, TOLERANCE);
  const mixerOne = new AnimationMixer(rigOne.gltf.scene), mixerTwo = new AnimationMixer(rigTwo.gltf.scene);
  mixerOne.clipAction(first).play(); mixerTwo.clipAction(second).play();
  mixerOne.setTime(0.5); mixerTwo.setTime(0.25);
  expect(rigOne.nodes[4].position.y).toBeCloseTo(0.5);
  expect(rigTwo.nodes[4].position.y).toBeCloseTo(0.25);
  expect(rigOne.nodes[2].position.y).toBe(0);
  expect(rigTwo.nodes[2].position.y).toBe(0);
  expect(motion.nodes[4].position.y).toBe(0);
  expect(motion.gltf.animations[0].tracks[0].name).toBe("source_4.position");
  mixerOne.stopAllAction(); mixerTwo.stopAllAction();
  expect(rigOne.nodes[4].position.y).toBe(0);
  expect(rigTwo.nodes[4].position.y).toBe(0);
});

it("rejects changed unanimated ancestors and mappings that do not cover actual tracks", async () => {
  const rig = fixture(false), motion = fixture(true);
  const skeleton = parseSkeletonMap(map(), "rig-v1", "a".repeat(64));
  rig.nodes[0].position.x = 2;
  await expect(bindSkeletalClip(rig.gltf, motion.gltf, skeleton, TOLERANCE)).rejects.toThrow(/祖先/);
  const missing = map(); missing.mappings[0] = { animation_node_path: ["Hero", "Left", "Hip"], rig_node_path: ["Hero", "Left", "Hip"] };
  await expect(bindSkeletalClip(fixture(false).gltf, motion.gltf, parseSkeletonMap(missing, "rig-v1", "a".repeat(64)), TOLERANCE)).rejects.toThrow(/映射/);
});

function map() {
  return { schema_version: "game.anim3d.skeleton_map.v1", rig_version_token: "rig-v1", rig_main_sha256: "a".repeat(64),
    clip: { animation_index: 0, name: "walk", duration_seconds: 1, loop: true, root_motion: "in_place" },
    mappings: [{ animation_node_path: ["Hero", "Right", "Hip"], rig_node_path: ["Hero", "Right", "Hip"] }] };
}

/** Headless binding fixture, not GLB decoding, GPU playback or model quality. */
function fixture(animated: boolean) {
  const definitions = [{ name: "Hero", children: [1, 3] }, { name: "Left", children: [2] }, { name: "Hip" }, { name: "Right", children: [4] }, { name: "Hip" }];
  const nodes = definitions.map((_, index) => { const node = new Object3D(); node.name = `${animated ? "source" : "runtime"}_${index}`; return node; });
  for (const [index, definition] of definitions.entries()) for (const child of definition.children ?? []) nodes[index].add(nodes[child]);
  const scene = new Group(); scene.add(nodes[0]);
  const definition = { name: "walk", samplers: [{ interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 4, path: "translation" } }] };
  const json = { scene: 0, scenes: [{ nodes: [0] }], nodes: definitions, ...(animated ? { animations: [definition] } : {}) };
  const animations = animated ? [new AnimationClip("walk", 1, [new VectorKeyframeTrack("source_4.position", [0, 1], [0, 0, 0, 0, 1, 0])])] : [];
  const gltf: GLTF = { scene, scenes: [scene], cameras: [], animations, asset: { version: "2.0" }, userData: {},
    parser: { json, getDependency: async (_type: string, index: number) => nodes[index] } as unknown as GLTF["parser"] };
  return { gltf, nodes };
}
