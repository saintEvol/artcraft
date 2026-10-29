import { Box3, Object3D, Quaternion, SkinnedMesh, Vector3 } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { scenePaths } from "./gltf-node-paths";

export interface RigProbeSpec {
  semanticBones: Record<string, string[]>;
  poses: { id: string; joints: { slot: string; rotation: number[] }[]; min: number[]; max: number[]; maxDisplacement: number }[];
  maxVertices: number;
  tolerance: number;
}
export interface RigProbe {
  apply: (id: string | null) => { bounds: Box3; displacement: number };
  restore: () => void;
}

/** Only extracts executable data from this version's bound rig metadata.
 * Profile registration and technical validation remain server responsibilities. */
export function parseRigProbe(value: unknown): RigProbeSpec {
  const metadata = record(value), profile = record(metadata.rig_profile), tolerance = record(profile.tolerances);
  if (metadata.scene_index !== 0 || profile.unit !== "meter" || profile.up_axis !== "+Y" || profile.visual_forward !== "+Z") throw new Error("角色缺少场景 0、米制或轴向约定。");
  const semantic = record(metadata.semantic_bones), semanticBones: Record<string, string[]> = Object.create(null), uniquePaths = new Set<string>();
  for (const [slot, path] of Object.entries(semantic)) {
    if (!Array.isArray(path) || !path.length || path.length > 128 || path.some((part) => typeof part !== "string" || !part)) throw new Error("角色语义映射缺少完整路径。");
    const identity = JSON.stringify(path);
    if (uniquePaths.has(identity)) throw new Error("不同语义槽不能使用相同的节点路径。");
    uniquePaths.add(identity);
    semanticBones[slot] = path as string[];
  }
  const motionRoot = metadata.motion_root_path;
  if (!Array.isArray(motionRoot) || !motionRoot.length || JSON.stringify(semantic[profile.motion_root_slot as string]) !== JSON.stringify(motionRoot)) throw new Error("角色运动根与语义映射不一致。");
  const qTolerance = nonnegative(tolerance.quaternion_norm), positionTolerance = nonnegative(tolerance.deformation_position_m);
  if (qTolerance >= 1 || !Number.isSafeInteger(profile.max_vertices) || Number(profile.max_vertices) < 1) throw new Error("角色诊断预算或四元数容差不正确。");
  if (!Array.isArray(profile.diagnostic_poses) || !profile.diagnostic_poses.length || profile.diagnostic_poses.length > 32) throw new Error("角色缺少诊断姿势或超出交互预算。");
  const ids = new Set<string>();
  const poses = profile.diagnostic_poses.map((value) => {
    const pose = record(value), envelope = record(pose.deformed_bounds_m);
    if (typeof pose.id !== "string" || !pose.id || ids.has(pose.id) || !Array.isArray(pose.joints) || !pose.joints.length) throw new Error("诊断姿势身份重复或缺少关节。");
    ids.add(pose.id);
    const min = vector(envelope.min, 3), max = vector(envelope.max, 3), slots = new Set<string>();
    if (min.some((n, axis) => n > max[axis])) throw new Error("诊断姿势的包围范围不正确。");
    const joints = pose.joints.map((value) => {
      const joint = record(value), rotation = vector(joint.rotation, 4);
      if (typeof joint.slot !== "string" || !Object.hasOwn(semanticBones, joint.slot) || slots.has(joint.slot) || Math.abs(Math.hypot(...rotation) - 1) > qTolerance) throw new Error("诊断关节缺少唯一映射或合法旋转。");
      slots.add(joint.slot); return { slot: joint.slot, rotation };
    });
    const displacement = nonnegative(pose.max_vertex_displacement_m);
    if (displacement === 0) throw new Error("诊断姿势缺少正数位移预算。");
    return { id: pose.id, joints, min, max, maxDisplacement: displacement };
  });
  return { semanticBones, poses, maxVertices: Number(profile.max_vertices), tolerance: positionTolerance };
}

/** Resolve original paths through GLTFParser and act on this instance only.
 * Rotations are rest * relative-delta, matching the producer's CPU probes. */
export async function bindRigProbe(gltf: GLTF, spec: RigProbeSpec): Promise<RigProbe> {
  const root = gltf.scenes[0], paths = scenePaths(gltf.parser.json);
  if (!root) throw new Error("角色没有场景 0。");
  const objects = new Map<string, Object3D>(), rest = new Map<Object3D, Quaternion>();
  for (const [slot, path] of Object.entries(spec.semanticBones)) {
    const index = paths.get(JSON.stringify(path));
    if (index === undefined) throw new Error(`角色缺少完整语义路径：${slot}。`);
    const object: Object3D = await gltf.parser.getDependency("node", index);
    if (object !== root && !isDescendant(object, root)) throw new Error("语义节点不属于本角色实例。");
    objects.set(slot, object); rest.set(object, object.quaternion.clone());
  }
  const meshes: SkinnedMesh[] = [];
  let vertices = 0;
  root.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isMesh) return;
    if (!mesh.isSkinnedMesh || !mesh.geometry.getAttribute("position")) throw new Error("诊断预览要求实际蒙皮几何体。");
    vertices += mesh.geometry.getAttribute("position").count;
    if (vertices > spec.maxVertices || vertices * 48 > 256 * 1024 * 1024) throw new Error("角色顶点超出诊断交互预算。");
    meshes.push(mesh);
  });
  if (!vertices) throw new Error("角色没有可检查的蒙皮顶点。");
  const restore = () => {
    for (const [object, rotation] of rest) { object.quaternion.copy(rotation); object.updateMatrix(); }
    root.updateMatrixWorld(true); meshes.forEach((mesh) => mesh.skeleton.update());
  };
  restore();
  const baseline = sampleVertices(meshes), position = new Vector3();
  return {
    restore,
    apply: (id) => {
      restore();
      const pose = id === null ? undefined : spec.poses.find((pose) => pose.id === id);
      if (id !== null && !pose) throw new Error("此版本没有所选诊断姿势。");
      if (pose) for (const joint of pose.joints) {
        const object = objects.get(joint.slot)!;
        object.quaternion.copy(rest.get(object)!).multiply(new Quaternion().fromArray(joint.rotation)); object.updateMatrix();
      }
      root.updateMatrixWorld(true); meshes.forEach((mesh) => mesh.skeleton.update());
      const deformed = sampleVertices(meshes), bounds = new Box3(); let displacement = 0;
      for (let index = 0; index < deformed.length; index += 3) {
        position.fromArray(deformed, index); bounds.expandByPoint(position);
        displacement = Math.max(displacement, Math.hypot(deformed[index] - baseline[index], deformed[index + 1] - baseline[index + 1], deformed[index + 2] - baseline[index + 2]));
      }
      if (pose && (displacement > pose.maxDisplacement + spec.tolerance || bounds.min.toArray().some((n, axis) => n < pose.min[axis] - spec.tolerance) || bounds.max.toArray().some((n, axis) => n > pose.max[axis] + spec.tolerance))) {
        restore(); throw new Error("实际蒙皮变形超出此 profile 的诊断范围。");
      }
      return { bounds, displacement };
    },
  };
}

function sampleVertices(meshes: SkinnedMesh[]): Float64Array {
  const result = new Float64Array(meshes.reduce((n, mesh) => n + mesh.geometry.getAttribute("position").count * 3, 0)), vertex = new Vector3();
  let offset = 0;
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute("position");
    for (let index = 0; index < positions.count; index++) {
      vertex.fromBufferAttribute(positions, index); mesh.applyBoneTransform(index, vertex).applyMatrix4(mesh.matrixWorld);
      if (!vertex.toArray().every(Number.isFinite)) throw new Error("实际蒙皮顶点包含无效数值。");
      result.set(vertex.toArray(), offset); offset += 3;
    }
  }
  return result;
}
function isDescendant(object: Object3D, root: Object3D): boolean { for (let parent = object.parent; parent; parent = parent.parent) if (parent === root) return true; return false; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("角色诊断规格不完整。"); return value as Record<string, unknown>; }
function vector(value: unknown, size: number): number[] { if (!Array.isArray(value) || value.length !== size || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("角色诊断向量不正确。"); return value as number[]; }
function nonnegative(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("角色诊断数值不正确。"); return value; }
