import type { GameAssetKnownKind } from "@storyteller/api";
export type AssetKind = GameAssetKnownKind;
export type EngineTarget = "godot" | "bevy" | "both" | "later";

export interface OutputSettings {
  style: string;
  iconSize: number;
  iconInset: number;
  spriteSize: number;
  spriteInset: number;
  displaySize: number;
  allowUpscale: boolean;
  pixelsPerUnit: number;
  anchorX: number;
  anchorY: number;
  sampling: "linear" | "nearest";
  meshHeight: number;
  maxTriangles: number;
  textureSize: number;
  collision: "none" | "box";
  engine: EngineTarget;
  referenceTokens: string[];
}

export const KIND_LABELS: Record<AssetKind, string> = {
  icon_2d: "UI 图标",
  sprite_2d: "2D 场景物件",
  prop_3d: "3D 静态道具",
};

export function isKnownAssetKind(kind: string): kind is AssetKind {
  return Object.hasOwn(KIND_LABELS, kind);
}

export const RECOMMENDED_SETTINGS: OutputSettings = {
  style: "手绘游戏道具，轮廓清晰，形体简洁，柔和的自然色彩",
  iconSize: 512,
  iconInset: 32,
  spriteSize: 1024,
  spriteInset: 32,
  displaySize: 64,
  allowUpscale: false,
  pixelsPerUnit: 100,
  anchorX: 0.5,
  anchorY: 0.5,
  sampling: "linear",
  meshHeight: 1,
  maxTriangles: 20000,
  textureSize: 2048,
  collision: "none",
  engine: "later",
  referenceTokens: [],
};

export function readSettings(profile: Record<string, unknown>): OutputSettings {
  const specs = record(profile.specs);
  const icon = record(specs.icon_2d);
  const sprite = record(specs.sprite_2d);
  const mesh = record(specs.prop_3d);
  const presentation = record(profile.presentation);
  const anchor = record(icon.anchor);
  const engines = Array.isArray(profile.engines) ? profile.engines : [];
  return {
    ...RECOMMENDED_SETTINGS,
    style: typeof profile.style === "string" ? profile.style : RECOMMENDED_SETTINGS.style,
    iconSize: number(icon.canvas, RECOMMENDED_SETTINGS.iconSize),
    iconInset: number(icon.content_inset_px, RECOMMENDED_SETTINGS.iconInset),
    spriteSize: number(sprite.canvas, RECOMMENDED_SETTINGS.spriteSize),
    spriteInset: number(sprite.content_inset_px, RECOMMENDED_SETTINGS.spriteInset),
    displaySize: number(presentation.display_size_px, RECOMMENDED_SETTINGS.displaySize),
    allowUpscale: icon.allow_upscale === true,
    pixelsPerUnit: number(sprite.pixels_per_world_unit, RECOMMENDED_SETTINGS.pixelsPerUnit),
    anchorX: number(anchor.x, 0.5),
    anchorY: number(anchor.y, 0.5),
    sampling: icon.sampling === "nearest" ? "nearest" : "linear",
    meshHeight: number(mesh.target_height_m, RECOMMENDED_SETTINGS.meshHeight),
    maxTriangles: number(mesh.max_triangles, RECOMMENDED_SETTINGS.maxTriangles),
    textureSize: number(mesh.max_texture_size, RECOMMENDED_SETTINGS.textureSize),
    collision: record(mesh.collision).kind === "box" ? "box" : "none",
    engine: engines.includes("godot") && engines.includes("bevy") ? "both"
      : engines.includes("godot") ? "godot" : engines.includes("bevy") ? "bevy" : "later",
    referenceTokens: Array.isArray(profile.style_reference_artifact_tokens)
      ? profile.style_reference_artifact_tokens.filter((value): value is string => typeof value === "string")
      : [],
  };
}

/** Preserve unrelated project fields when changing the visible settings. */
export function writeSettings(settings: OutputSettings, previous: Record<string, unknown> = {}): Record<string, unknown> {
  const specs = record(previous.specs);
  const image = (old: unknown, canvas: number, inset: number) => ({
    ...record(old),
    canvas,
    content_inset_px: inset,
    allow_upscale: settings.allowUpscale,
    transparent_background: true,
    sampling: settings.sampling,
    pixels_per_world_unit: settings.pixelsPerUnit,
    anchor: { x: settings.anchorX, y: settings.anchorY, origin: "top_left" },
  });
  return {
    ...previous,
    workflow_schema_version: 1,
    style: settings.style.trim(),
    style_reference_artifact_tokens: [...settings.referenceTokens],
    presentation: { ...record(previous.presentation), display_size_px: settings.displaySize },
    specs: {
      ...specs,
      icon_2d: image(specs.icon_2d, settings.iconSize, settings.iconInset),
      sprite_2d: image(specs.sprite_2d, settings.spriteSize, settings.spriteInset),
      prop_3d: {
        ...record(specs.prop_3d),
        up_axis: "y", forward_axis: "z", unit: "meter",
        target_height_m: settings.meshHeight,
        origin: "bottom_center",
        max_triangles: settings.maxTriangles,
        max_texture_size: settings.textureSize,
        collision: { kind: settings.collision, usage: "static" },
      },
    },
    engines: settings.engine === "later" ? [] : settings.engine === "both" ? ["godot", "bevy"] : [settings.engine],
  };
}

export function settingsProblem(settings: OutputSettings): string | null {
  if (!settings.style.trim()) return "请描述想要的风格，或使用推荐风格。";
  for (const [label, value] of [["图标尺寸", settings.iconSize], ["场景图尺寸", settings.spriteSize]] as const) {
    if (!Number.isInteger(value) || value < 64 || value > 4096) return `${label}需要是 64–4096 之间的整数。`;
  }
  for (const [label, inset, canvas] of [["图标留白", settings.iconInset, settings.iconSize], ["场景图留白", settings.spriteInset, settings.spriteSize]] as const) {
    if (!Number.isInteger(inset) || inset < 0 || inset * 2 >= canvas) return `${label}必须小于画布的一半。`;
  }
  if (!Number.isFinite(settings.meshHeight) || settings.meshHeight < 0.01 || settings.meshHeight > 100) return "道具高度需要在 0.01–100 米之间。";
  if (!Number.isInteger(settings.maxTriangles) || settings.maxTriangles < 100 || settings.maxTriangles > 1000000) return "三角面预算需要在 100–1,000,000 之间。";
  if (![256, 512, 1024, 2048, 4096].includes(settings.textureSize)) return "请选择支持的贴图尺寸。";
  if (!Number.isFinite(settings.anchorX) || !Number.isFinite(settings.anchorY)
    || settings.anchorX < 0 || settings.anchorX > 1 || settings.anchorY < 0 || settings.anchorY > 1) return "锚点必须在画布内（0–1）。";
  if (!Number.isFinite(settings.pixelsPerUnit) || settings.pixelsPerUnit <= 0 || settings.pixelsPerUnit > 10000) return "每世界单位像素数需要在 0–10,000 之间。";
  if (!Number.isInteger(settings.displaySize) || settings.displaySize < 16 || settings.displaySize > 512) return "实际显示大小需要在 16–512 像素之间。";
  return null;
}

export function settingsSummary(settings: OutputSettings, kind: AssetKind): string {
  if (kind === "prop_3d") return `${settings.meshHeight} 米高 · ${settings.maxTriangles.toLocaleString()} 三角面预算 · ${settings.textureSize}px 贴图`;
  const size = kind === "icon_2d" ? settings.iconSize : settings.spriteSize;
  const inset = kind === "icon_2d" ? settings.iconInset : settings.spriteInset;
  return `${size}×${size} 透明图 · 留白 ${inset}px · ${settings.sampling === "nearest" ? "最近邻" : "平滑"}显示`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
