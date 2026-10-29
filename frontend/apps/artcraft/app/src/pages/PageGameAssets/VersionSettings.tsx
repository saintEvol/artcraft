import { useEffect, useRef } from "react";
import type { GameAssetVersionInfo } from "@storyteller/api";
import type { OutputSettings, AssetKind } from "./profile";

export function VersionSettings({ version, effective, defaults, profileVersion, legacy, kind, name, onClose, onDownloadMask, downloadError }: {
  version: GameAssetVersionInfo; effective: OutputSettings; defaults: OutputSettings;
  profileVersion: number; legacy: boolean; kind: AssetKind; name: string; onClose: () => void;
  onDownloadMask?: () => Promise<void>; downloadError?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const isProp = kind === "prop_3d";
  const fields: { label: string; value: string; previous: string }[] = isProp ? [
    { label: "目标高度", value: `${effective.meshHeight} 米`, previous: `${defaults.meshHeight} 米` },
    { label: "三角面预算", value: `${effective.maxTriangles.toLocaleString()} 面`, previous: `${defaults.maxTriangles.toLocaleString()} 面` },
    { label: "最大贴图边长", value: `${effective.textureSize}px`, previous: `${defaults.textureSize}px` },
    { label: "碰撞需求", value: effective.collision === "box" ? "简单箱体碰撞描述" : "仅视觉道具", previous: defaults.collision === "box" ? "简单箱体碰撞描述" : "仅视觉道具" },
  ] : [
    { label: "最终画布", value: `${effective.iconSize}×${effective.iconSize}px`, previous: `${(kind === "sprite_2d" ? defaults.spriteSize : defaults.iconSize)}×${(kind === "sprite_2d" ? defaults.spriteSize : defaults.iconSize)}px` },
    { label: "透明留白", value: `${effective.iconInset}px`, previous: `${kind === "sprite_2d" ? defaults.spriteInset : defaults.iconInset}px` },
    { label: "实际大小预览", value: `${effective.displaySize}px`, previous: `${defaults.displaySize}px` },
    { label: "采样", value: effective.sampling === "nearest" ? "最近邻" : "平滑", previous: defaults.sampling === "nearest" ? "最近邻" : "平滑" },
    { label: "锚点（左上为 0,0）", value: `${effective.anchorX}, ${effective.anchorY}`, previous: `${defaults.anchorX}, ${defaults.anchorY}` },
    { label: "每世界单位像素数", value: String(effective.pixelsPerUnit), previous: String(defaults.pixelsPerUnit) },
    { label: "插值放大", value: effective.allowUpscale ? "允许" : "禁止", previous: defaults.allowUpscale ? "允许" : "禁止" },
  ];
  const output = version.spec_json.output as Record<string, unknown> | undefined;
  return <dialog ref={dialog} className="ga-creation-dialog" aria-label={`${name}这个版本的生效设置`} onClose={onClose}>
    <header><div><h2>这个版本实际使用的制作设置</h2><p>{name} · 文件第 {version.version} 版 · 项目设置第 {profileVersion} 版</p></div><button type="button" className="ga-action" onClick={onClose}>返回预览</button></header>
    <div className="ga-creation-scroll">
      {legacy && <p className="ga-info">旧版项目没有记录全部设置。未记录项使用推荐显示值，不能据此认定旧文件已按这些值加工。</p>}
      {typeof version.spec_json.description === "string" && <p className="ga-version-brief"><strong>对象/修改</strong>{version.spec_json.description}</p>}
      {typeof version.spec_json.use_case === "string" && <p className="ga-version-brief"><strong>用途</strong>{version.spec_json.use_case}</p>}
      <p className="ga-version-brief"><strong>外观要求</strong>{typeof version.spec_json.style === "string" ? version.spec_json.style : effective.style}</p>
      <dl className="ga-effective-fields">{fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}<small>{field.value === field.previous ? "与当时的项目设置一致" : `当前版本值；当时的项目默认：${field.previous}`}</small></dd></div>)}</dl>
      {isProp && <p className="ga-help">交付约定：米制、Y 轴向上、正面 +Z、底部中心原点；本次记录的绕竖直轴旋转为 {Number(output?.rotation_y_degrees ?? 0)}°。目标预算与实际文件测量分别查看，实际尺寸和面数显示在模型预览与检查报告中。</p>}
      {onDownloadMask && <div className="ga-info"><p>这次处理保存了实际使用的选区，白色表示处理范围，黑色区域保持原图。</p><button type="button" className="ga-action" onClick={() => void onDownloadMask()}>下载这次使用的选区 PNG</button>{downloadError && <p role="alert">{downloadError}</p>}</div>}
      <p className="ga-info">这份记录属于当前版本。工作区顶部可修改后续制作的项目设置；要改变当前文件，请从“修改、加工与继续制作”选择重新加工或修改，生成可比较的后继版本。</p>
    </div>
  </dialog>;
}
