import { AnimationClip, Object3D } from "three";
import { scenePaths, type GltfSceneNodes } from "./gltf-node-paths";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AnimationSkeletonMap } from "@storyteller/api";

interface SceneDocument extends GltfSceneNodes {
  meshes?: unknown[]; skins?: unknown[]; images?: unknown[]; materials?: unknown[];
  animations?: { name?: string; samplers: { interpolation?: string }[]; channels: { sampler: number; target: { node: number; path: string } }[] }[];
}
export interface AnimationBindingTolerances { rest_matrix: number; endpoint_seconds: number; quaternion_norm: number }

/** Source JSON paths choose node indices, parser dependencies choose actual
 * objects, and UUID tracks bind this rig instance. No leaf-name matching. */
export async function bindSkeletalClip(rig: GLTF, animation: GLTF, map: AnimationSkeletonMap, tolerance: AnimationBindingTolerances): Promise<AnimationClip> {
  if (![tolerance.rest_matrix, tolerance.endpoint_seconds, tolerance.quaternion_norm].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("动作规格缺少有效的绑定容差。");
  const source = animation.parser.json as SceneDocument, target = rig.parser.json as SceneDocument;
  if ([source.meshes, source.skins, source.images, source.materials].some((items) => items?.length) || source.animations?.length !== 1 || animation.animations.length !== 1) throw new Error("独立动作必须为不含几何体和蒙皮的单 clip GLB。");
  const sourcePaths = scenePaths(source), rigPaths = scenePaths(target);
  const clip = animation.animations[0], definition = source.animations[0];
  if (definition.name !== map.clip.name || Math.abs(clip.duration - map.clip.duration_seconds) > tolerance.endpoint_seconds) throw new Error("动作名称或时长与 skeleton_map 不一致。");
  if (!definition.channels.length || definition.channels.length > 4096 || clip.tracks.length !== definition.channels.length) throw new Error("动作轨道不完整或超出预览预算。");
  const sourceObjects = new Map<string, Object3D>(), rigObjects = new Map<string, Object3D>();
  for (const [path, sourceIndex] of sourcePaths) {
    const rigIndex = rigPaths.get(path);
    if (rigIndex === undefined) throw new Error("动作节点不在绑定角色的完整层级中。");
    const from: Object3D = await animation.parser.getDependency("node", sourceIndex);
    const to: Object3D = await rig.parser.getDependency("node", rigIndex);
    from.updateMatrix(); to.updateMatrix();
    if (!from.matrix.elements.every((value, index) => Number.isFinite(value) && Number.isFinite(to.matrix.elements[index]) && Math.abs(value - to.matrix.elements[index]) <= tolerance.rest_matrix)) throw new Error("动作与绑定角色的 rest 或祖先变换不一致。");
    sourceObjects.set(path, from); rigObjects.set(path, to);
  }
  const mappings = new Map(map.mappings.map((entry) => [JSON.stringify(entry.animation_node_path), JSON.stringify(entry.rig_node_path)]));
  const sourceByIndex = new Map([...sourcePaths].map(([path, index]) => [index, path]));
  const driven = new Set<string>(), properties = new Set<string>(), usedTracks = new Set<string>();
  let keyframes = 0;
  const tracks = definition.channels.map((channel) => {
    const path = sourceByIndex.get(channel.target.node), targetPath = path && mappings.get(path);
    const from = path && sourceObjects.get(path), to = targetPath && rigObjects.get(targetPath);
    const property = channel.target.path === "translation" ? "position" : channel.target.path === "rotation" ? "quaternion" : channel.target.path === "scale" ? "scale" : undefined;
    const sampler = definition.samplers[channel.sampler];
    if (!path || !targetPath || !from || !to || !property || !sampler || !["LINEAR", "STEP", "CUBICSPLINE"].includes(sampler.interpolation ?? "LINEAR")) throw new Error("动作轨道缺少精确映射或使用了不支持的属性。");
    const trackName = `${from.name || from.uuid}.${property}`;
    const original = clip.tracks.find((track) => track.name === trackName);
    const destination = `${to.uuid}.${property}`;
    if (!original || usedTracks.has(trackName) || properties.has(destination)) throw new Error("轨道未命中唯一节点或重复驱动同一属性。");
    usedTracks.add(trackName); properties.add(destination); driven.add(path);
    keyframes += original.times.length;
    const dimensions = property === "quaternion" ? 4 : 3, cubic = sampler.interpolation === "CUBICSPLINE";
    if (!original.times.length || keyframes > 1_000_000 || original.values.length !== original.times.length * dimensions * (cubic ? 3 : 1)) throw new Error("动作关键帧数量或向量长度不正确。");
    let previous = -1;
    for (const time of original.times) {
      if (!Number.isFinite(time) || time < 0 || time <= previous || time > map.clip.duration_seconds + tolerance.endpoint_seconds) throw new Error("动作时间必须有限、非负且严格递增。");
      previous = time;
    }
    if (Math.abs(original.times[0]) > tolerance.endpoint_seconds || !original.values.every(Number.isFinite)) throw new Error("动作首帧或数值不正确。");
    if (property === "quaternion") for (let frame = 0; frame < original.times.length; frame++) {
      const offset = (frame * (cubic ? 3 : 1) + (cubic ? 1 : 0)) * 4;
      const norm = Math.hypot(...Array.from(original.values.slice(offset, offset + 4)));
      if (Math.abs(norm - 1) > tolerance.quaternion_norm) throw new Error("动作含未归一化的四元数。");
    }
    // clone preserves GLTFLoader's cubic-spline interpolant factory.
    const track = original.clone(); track.name = destination;
    return track;
  });
  if (driven.size !== mappings.size || [...mappings.keys()].some((path) => !driven.has(path))) throw new Error("骨架映射必须恰好覆盖实际驱动节点。");
  return new AnimationClip(map.clip.name, map.clip.duration_seconds, tracks);
}

