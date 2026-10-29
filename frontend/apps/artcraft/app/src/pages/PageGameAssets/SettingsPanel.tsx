import { useEffect, useRef, useState } from "react";
import { X, Save, Info } from "lucide-react";
import type { OutputSettings } from "./profile";
import { settingsProblem, settingsSummary } from "./profile";

interface Props {
  initial: OutputSettings;
  initialAnimationSpecs?: Record<string, unknown>;
  version?: number;
  legacy?: boolean;
  onSave: (settings: OutputSettings, idempotencyKey: string, animationSpecs?: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

export function SettingsPanel({ initial, initialAnimationSpecs, version, legacy, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saveIdentity = useRef<{ signature: string; key: string } | null>(null);
  const [draft, setDraft] = useState(() => ({ ...initial, referenceTokens: [...initial.referenceTokens] }));
  const [tab, setTab] = useState<"style" | "image" | "mesh" | "animation">("style");
  const [animationSpecs, setAnimationSpecs] = useState(initialAnimationSpecs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [specImportProblem, setSpecImportProblem] = useState<string | null>(null);
  const problem = settingsProblem(draft) ?? specImportProblem;
  const insetPreview = Number.isFinite(draft.iconInset / draft.iconSize)
    ? Math.min(49, Math.max(0, draft.iconInset / draft.iconSize * 100)) : 0;
  const set = <K extends keyof OutputSettings>(key: K, value: OutputSettings[K]) => setDraft((old) => ({ ...old, [key]: value }));

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    const signature = JSON.stringify([draft, animationSpecs]);
    if (saveIdentity.current?.signature !== signature) saveIdentity.current = { signature, key: crypto.randomUUID() };
    try { await onSave(draft, saveIdentity.current.key, animationSpecs); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "设置未保存，请重试。"); }
    finally { setBusy(false); }
  };

  return <dialog ref={dialog} className="ga-dialog" aria-labelledby="ga-settings-title"
    onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <div className="ga-dialog-heading">
      <div><p className="ga-eyebrow">{version ? `当前生效 · 第 ${version} 版` : "可编辑的推荐设置"}</p>
        <h2 id="ga-settings-title">项目风格与输出设置</h2></div>
      <button type="button" className="ga-icon-button" onClick={onClose} disabled={busy} aria-label="关闭设置"><X size={19} /></button>
    </div>
    <div className="ga-tabs" role="tablist" aria-label="设置类别" onKeyDown={(event) => {
      const tabs = ["style", "image", "mesh", "animation"] as const;
      const current = tabs.indexOf(tab);
      const index = event.key === "ArrowRight" ? (current + 1) % tabs.length : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (index < 0) return;
      event.preventDefault(); setTab(tabs[index]);
      event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${tabs[index]}"]`)?.focus();
    }}>
      {([['style', '风格与引擎'], ['image', '2D 图像'], ['mesh', '3D 道具'], ['animation', '角色与动画']] as const).map(([value, label]) =>
        <button key={value} id={`ga-tab-${value}`} data-tab={value} type="button" role="tab" aria-controls="ga-settings-panel"
          tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
    </div>
    <div id="ga-settings-panel" className="ga-dialog-body" role="tabpanel" aria-labelledby={`ga-tab-${tab}`}>
      {legacy && <p className="ga-info">旧版设置没有记录全部字段。未记录的字段在这里显示推荐值，保存新修订后才生效，不会改变旧素材。</p>}
      {tab === "style" && <>
        <label className="ga-field">希望资产保持怎样的外观
          <textarea value={draft.style} rows={5} maxLength={3000} onChange={(event) => set("style", event.target.value)}
            placeholder="例如：森林 RPG，暖色手绘，较粗的轮廓；避免照片质感和文字。" />
          <small>描述色彩、轮廓、材质和要避免的元素。实际候选还需要在预览中比较。</small>
        </label>
        <label className="ga-field">用在哪个游戏引擎
          <select value={draft.engine} onChange={(event) => set("engine", event.target.value as OutputSettings['engine'])}>
            <option value="later">还没决定，先制作外观</option><option value="godot">Godot</option><option value="bevy">Bevy</option><option value="both">Godot 与 Bevy 都需要</option>
          </select><small>可以稍后修改；更换交付目标本身不应重新收费生成。</small>
        </label>
        <div className="ga-settings-summary"><strong>当前制作条件</strong>
          <p>图标：{settingsSummary(draft, "icon_2d")}</p><p>场景物件：{settingsSummary(draft, "sprite_2d")}</p>
          <p>3D：{settingsSummary(draft, "prop_3d")}</p>
          <p>风格参考：{draft.referenceTokens.length} 份；此处保存已有引用。</p>
        </div>
      </>}
      {tab === "image" && <>
        <div className="ga-settings-columns">
          <div>
            <h3>最终画布与留白</h3>
            <NumberField label="图标画布边长（像素）" value={draft.iconSize} min={64} max={4096} onChange={(v) => set("iconSize", v)} />
            <NumberField label="图标四周最少留白（像素）" value={draft.iconInset} min={0} max={Math.floor((draft.iconSize - 1) / 2)} onChange={(v) => set("iconInset", v)} />
            <NumberField label="场景图画布边长（像素）" value={draft.spriteSize} min={64} max={4096} onChange={(v) => set("spriteSize", v)} />
            <NumberField label="场景图四周最少留白（像素）" value={draft.spriteInset} min={0} max={Math.floor((draft.spriteSize - 1) / 2)} onChange={(v) => set("spriteInset", v)} />
          </div>
          <div className="ga-layout-explainer">
            <div className="ga-canvas-guide" aria-label={`图标安全区域示意：${draft.iconSize} 像素画布，${draft.iconInset} 像素留白`}>
              <div style={{ inset: `${insetPreview}%` }}>主体安全区</div>
              <span style={{ left: `${draft.anchorX * 100}%`, top: `${draft.anchorY * 100}%` }}>+</span>
            </div>
            <small>排版示意，并非生成结果。虚线外保留透明留白，十字是摆放锚点。</small>
          </div>
        </div>
        <div className="ga-settings-columns">
          <NumberField label="在游戏中的预览大小（像素）" value={draft.displaySize} min={16} max={512} onChange={(v) => set("displaySize", v)} />
          <NumberField label="每世界单位像素数（场景 Sprite）" value={draft.pixelsPerUnit} min={1} max={10000} onChange={(v) => set("pixelsPerUnit", v)} />
        </div>
        <label className="ga-field">锚点位置
          <select value={`${draft.anchorX},${draft.anchorY}`} onChange={(event) => {
            const [x, y] = event.target.value.split(",").map(Number); setDraft((s) => ({ ...s, anchorX: x, anchorY: y }));
          }}>
            <option value={`${draft.anchorX},${draft.anchorY}`}>当前：横向 {draft.anchorX}，纵向 {draft.anchorY}</option>
            <option value="0.5,0.5">中心（图标、一般物件）</option><option value="0.5,1">底部中心（地面物件）</option><option value="0,0">左上角（界面定位）</option>
          </select>
        </label>
        <label className="ga-field">显示采样方式<select value={draft.sampling} onChange={(event) => set("sampling", event.target.value as "linear" | "nearest")}>
          <option value="linear">平滑（插画、一般图标）</option><option value="nearest">最近邻（像素素材）</option>
        </select></label>
        <label className="ga-check"><input type="checkbox" checked={draft.allowUpscale} onChange={(event) => set("allowUpscale", event.target.checked)} />
          允许插值放大主体以填充安全区域</label>
        <p className="ga-help">关闭时，小主体保留原生尺寸，不会因为没有填满画布而被拒绝。最终是否足够清楚，应在游戏实际大小下判断。</p>
      </>}
      {tab === "mesh" && <>
        <div className="ga-settings-columns">
          <NumberField label="目标高度（米）" value={draft.meshHeight} min={0.01} max={100} step={0.01} onChange={(v) => set("meshHeight", v)} />
          <NumberField label="最大三角面数" value={draft.maxTriangles} min={100} max={1000000} step={100} onChange={(v) => set("maxTriangles", v)} />
        </div>
        <p className="ga-help">高度使用等比缩放，原点放在底部中心。面数是交付预算；加工仍需在模型预览中检查轮廓和材质。</p>
        <label className="ga-field">最大贴图边长<select value={draft.textureSize} onChange={(event) => set("textureSize", Number(event.target.value))}>
          {[256, 512, 1024, 2048, 4096].map((n) => <option key={n} value={n}>{n} 像素</option>)}
        </select></label>
        <label className="ga-field">碰撞需求<select value={draft.collision} onChange={(event) => set("collision", event.target.value as "none" | "box")}>
          <option value="none">仅视觉道具</option><option value="box">简单箱体碰撞（实心物件）</option>
        </select><small>有门洞、凹槽或可交互部件的物体通常需要更具体的碰撞和部件设计。</small></label>
        <div className="ga-settings-summary">固定交付约定：米制、Y 轴向上、模型正面 +Z。这里只描述静态道具，不包含角色绑定或开合动作。</div>
      </>}
      {tab === "animation" && <>
        <h3>角色与动画的专用规格</h3>
        <p>导入已经确定的角色骨架规则、尺寸预算、诊断姿势或动画方向与时间规则。保存时由服务端完整校验；不会用静态道具默认值补齐。</p>
        <label className="ga-field">导入规格 JSON<input type="file" accept=".json,application/json" aria-label="角色与动画规格 JSON" disabled={busy} onChange={async (event) => {
          const file = event.target.files?.[0]; if (!file) return;
          setBusy(true); setError(null); setSpecImportProblem(null);
          try {
            if (file.size > 256 * 1024) throw new Error("规格文件不能超过 256 KiB。");
            const value: unknown = JSON.parse(await file.text());
            if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length
              || Object.entries(value).some(([key, block]) => !["character_3d", "anim_2d", "anim_3d"].includes(key) || !block || typeof block !== "object" || Array.isArray(block))) throw new Error("规格 JSON 顶层只接受 character_3d、anim_2d、anim_3d 对象。");
            setAnimationSpecs((old) => ({ ...old, ...value })); setError(null);
          } catch (problem) { setSpecImportProblem(problem instanceof Error ? problem.message : "规格文件无法读取。"); }
          finally { setBusy(false); }
        }} /><small>只替换文件中明确提供的规格块，其他项目设置继续保留。</small></label>
        {animationSpecs && Object.entries(animationSpecs).map(([kind, spec]) => <details key={kind}><summary>{kind} · 已提供专用规格</summary><pre className="ga-diagnostics">{JSON.stringify(spec, null, 2)}</pre></details>)}
        {!animationSpecs || !Object.keys(animationSpecs).length ? <p className="ga-help">当前未配置角色或动画规格，相关制作入口保持关闭。</p> : null}
      </>}
      <div className="ga-info"><Info size={16} /><p>本次保存用于后续制作。已有候选和交付版本保持其原设置；重新加工或重新生成需要单独选择对象并执行。</p></div>
      {(error || problem) && <p role="alert" className="ga-error">{error ?? problem}</p>}
    </div>
    <footer className="ga-dialog-footer"><button type="button" onClick={onClose} disabled={busy}>取消更改</button>
      <button type="button" className="ga-primary" disabled={busy || !!problem} onClick={() => void save()}><Save size={16} />{busy ? "正在保存…" : "保存并用于后续制作"}</button></footer>
  </dialog>;
}

function NumberField({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
}) {
  return <label className="ga-field">{label}<input type="number" min={min} max={max} step={step}
    value={Number.isFinite(value) ? value : ""} onChange={(event) => onChange(event.target.valueAsNumber)} /></label>;
}
