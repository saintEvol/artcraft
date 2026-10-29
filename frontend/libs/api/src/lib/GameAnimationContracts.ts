/** Wire contracts for isolated animation preview. These types do not enable
 * production; capabilities must explicitly advertise each v2 operation. */
export const ANIMATED_ASSET_KINDS = ["character_3d", "anim_2d", "anim_3d"] as const;
export type AnimatedAssetKind = (typeof ANIMATED_ASSET_KINDS)[number];
export const ANIMATED_KIND_LABELS: Record<AnimatedAssetKind, string> = {
  character_3d: "3D 角色", anim_2d: "2D 动画", anim_3d: "3D 动作",
};
export function isAnimatedAssetKind(kind: string): kind is AnimatedAssetKind {
  return ANIMATED_ASSET_KINDS.some((value) => value === kind);
}

export interface AnimationFrameTable {
  schema_version: "game.anim2d.frames.v1";
  clip_name: string;
  canvas: { width: number; height: number };
  anchor: { origin: "top_left"; x: number; y: number };
  atlas: { role: "main"; ordinal: 0; width: number; height: number; extrude_px: 1 };
  fps: number;
  loop: boolean;
  directions: { name: string; frames: { x: number; y: number; width: number; height: number }[] }[];
}

export interface AnimationSkeletonMap {
  schema_version: "game.anim3d.skeleton_map.v1";
  rig_version_token: string;
  rig_main_sha256: string;
  clip: { animation_index: 0; name: string; duration_seconds: number; loop: boolean; root_motion: "in_place" };
  mappings: { animation_node_path: string[]; rig_node_path: string[] }[];
}

/** Bind only the exact rig named by the file and the owned dependency. */
export function parseSkeletonMap(value: unknown, rigVersion: string, rigSha256: string): AnimationSkeletonMap {
  const map = object(value, ["schema_version", "rig_version_token", "rig_main_sha256", "clip", "mappings"]);
  if (map.schema_version !== "game.anim3d.skeleton_map.v1" || typeof map.rig_version_token !== "string" || !map.rig_version_token
    || new TextEncoder().encode(map.rig_version_token).length > 32 || typeof map.rig_main_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(map.rig_main_sha256)) throw new Error("骨架映射身份不完整。");
  if (map.rig_version_token !== rigVersion || map.rig_main_sha256 !== rigSha256) throw new Error("动作绑定的角色版本或主文件摘要不一致。");
  const clip = object(map.clip, ["animation_index", "name", "duration_seconds", "loop", "root_motion"]);
  if (clip.animation_index !== 0 || typeof clip.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(clip.name)
    || typeof clip.duration_seconds !== "number" || !Number.isFinite(clip.duration_seconds) || clip.duration_seconds <= 0 || typeof clip.loop !== "boolean" || clip.root_motion !== "in_place") throw new Error("动作名称、时长或播放合同不正确。");
  if (!Array.isArray(map.mappings) || !map.mappings.length || map.mappings.length > 4096) throw new Error("骨架映射为空或超出预览预算。");
  const paths = new Set<string>();
  for (const raw of map.mappings) {
    const mapping = object(raw, ["animation_node_path", "rig_node_path"]);
    for (const path of [mapping.animation_node_path, mapping.rig_node_path]) {
      if (!Array.isArray(path) || !path.length || path.length > 128 || path.some((part) => typeof part !== "string" || !part || /[/\\:.%\u0000-\u001f\u007f-\u009f]/u.test(part))) throw new Error("节点路径不完整或有歧义。");
    }
    const identity = JSON.stringify(mapping.rig_node_path);
    if (JSON.stringify(mapping.animation_node_path) !== identity || paths.has(identity)) throw new Error("骨架映射重复或没有使用已烘焙到目标角色的完整路径。");
    paths.add(identity);
  }
  return value as AnimationSkeletonMap;
}

export function frameAt(time: number, fps: number, count: number, looping: boolean): number {
  if (!Number.isFinite(time) || time < 0 || !Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(count) || count < 1) throw new Error("播放时间或帧参数不正确。");
  const duration = count / fps;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("动画时长无效。");
  return Math.min(Math.floor((looping ? time % duration : Math.min(time, duration)) * fps), count - 1);
}

/** Strict shape plus semantic geometry; do this before image decoding. The
 * resource ceilings are caller limits, not production quality thresholds. */
export function parseFrameTable(value: unknown, maxEdge = 16384, maxTotalFrames = 4096): AnimationFrameTable {
  const table = object(value, ["schema_version", "clip_name", "canvas", "anchor", "atlas", "fps", "loop", "directions"]);
  if (table.schema_version !== "game.anim2d.frames.v1" || typeof table.clip_name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(table.clip_name) || typeof table.loop !== "boolean") throw new Error("帧表合同不受支持。");
  const canvas = object(table.canvas, ["width", "height"]), anchor = object(table.anchor, ["origin", "x", "y"]), atlas = object(table.atlas, ["role", "ordinal", "width", "height", "extrude_px"]);
  positive(canvas.width); positive(canvas.height); positive(atlas.width, maxEdge); positive(atlas.height, maxEdge);
  if (Number(atlas.width) * Number(atlas.height) * 4 > 256 * 1024 * 1024) throw new Error("图集超出解码内存预算。");
  if (anchor.origin !== "top_left" || ![anchor.x, anchor.y].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error("锚点无效。");
  if (atlas.role !== "main" || atlas.ordinal !== 0 || atlas.extrude_px !== 1 || typeof table.fps !== "number" || !Number.isFinite(table.fps) || table.fps <= 0) throw new Error("图集或帧率无效。");
  if (!Array.isArray(table.directions)) throw new Error("缺少动画方向。");
  const names = ({ 1: ["default"], 4: ["n", "e", "s", "w"], 8: ["n", "ne", "e", "se", "s", "sw", "w", "nw"] } as Record<number, string[]>)[table.directions.length];
  if (!names) throw new Error("方向必须为 1、4 或 8 向。");
  let count: number | undefined;
  const occupied: number[][] = [];
  for (const [index, rawDirection] of table.directions.entries()) {
    const direction = object(rawDirection, ["name", "frames"]);
    if (direction.name !== names[index] || !Array.isArray(direction.frames) || !direction.frames.length || direction.frames.length * names.length > maxTotalFrames || (count !== undefined && direction.frames.length !== count)) throw new Error("方向顺序或帧集合不完整。");
    count = direction.frames.length;
    for (const rawRect of direction.frames) {
      const rect = object(rawRect, ["x", "y", "width", "height"]);
      positive(rect.x); positive(rect.y); positive(rect.width); positive(rect.height);
      const { x, y, width, height } = rect as Record<string, number>;
      const right = x + width + 1, bottom = y + height + 1, left = x - 1, top = y - 1;
      if (!Number.isSafeInteger(right) || !Number.isSafeInteger(bottom) || width !== canvas.width || height !== canvas.height || right > Number(atlas.width) || bottom > Number(atlas.height)) throw new Error("帧矩形越界或尺寸与固定画布不同。");
      if (occupied.some(([x, y, r, b]) => left < r && right > x && top < b && bottom > y)) throw new Error("动画帧包含重叠的 extrusion 区域。");
      occupied.push([left, top, right, bottom]);
    }
  }
  if (!Number.isFinite(Number(count) / table.fps)) throw new Error("动画时长超出数值范围。");
  return value as AnimationFrameTable;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error("动画文件包含缺失或未知字段。");
  return value as Record<string, unknown>;
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("动画尺寸或预算无效。");
}
