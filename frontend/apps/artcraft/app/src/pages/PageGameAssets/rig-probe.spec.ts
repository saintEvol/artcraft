import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { bindRigProbe, parseRigProbe } from "./rig-probe";

const FIXTURE = resolve(__dirname, "../../../../../../../test_data/game_assets/character_animation");

it("applies actual skinned deformation and restores exact rest without changing source bytes", async () => {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURE, "rigged_triangle.glb"))).buffer, original = new Uint8Array(bytes).slice();
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  const spec = parseRigProbe(metadata()), probe = await bindRigProbe(gltf, spec);
  const rest = probe.apply(null);
  const deformed = probe.apply(spec.poses[0].id);
  expect(deformed.displacement).toBeGreaterThan(0.1);
  expect(deformed.bounds.equals(rest.bounds)).toBe(false);
  expect(probe.apply(null).displacement).toBe(0);
  expect(probe.apply(null).bounds.equals(rest.bounds)).toBe(true);
  expect(new Uint8Array(bytes)).toEqual(original);
});

it("keeps two runtime instances independent and refuses leaf-name or foreign paths", async () => {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURE, "rigged_triangle.glb"))).buffer;
  const a = await new GLTFLoader().parseAsync(bytes, ""), b = await new GLTFLoader().parseAsync(bytes, "");
  const spec = parseRigProbe(metadata()), probeA = await bindRigProbe(a, spec), probeB = await bindRigProbe(b, spec);
  probeA.apply(spec.poses[0].id);
  expect(probeB.apply(null).displacement).toBe(0);
  const wrong = parseRigProbe(metadata()); wrong.semanticBones.hips = ["Hip"];
  await expect(bindRigProbe(a, wrong)).rejects.toThrow(/完整语义路径/);
  probeA.restore(); expect(probeA.apply(null).displacement).toBe(0);
});

it("reports an out-of-profile deformation and restores rest instead of correcting the GLB", async () => {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURE, "rigged_triangle.glb"))).buffer;
  const gltf = await new GLTFLoader().parseAsync(bytes, ""), spec = parseRigProbe(metadata());
  spec.poses[0].maxDisplacement = 0.001;
  const probe = await bindRigProbe(gltf, spec);
  expect(() => probe.apply(spec.poses[0].id)).toThrow(/诊断范围/);
  expect(probe.apply(null).displacement).toBe(0);
});

function metadata() { return JSON.parse(readFileSync(resolve(FIXTURE, "rig_probe_metadata.json"), "utf8")); }
