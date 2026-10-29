import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi, GameAssetBrief, GameAssetBriefInfo } from "@storyteller/api";
import { AssetThumbnail } from "./AssetThumbnail";
import { KIND_LABELS, type AssetKind } from "./profile";
import type { SetSource } from "./AssetSetComposer";

export function AssetBriefEditor({ api, item, sources, onSaved, onClose }: {
  api: GameAssetsApi; item: GameAssetBriefInfo; sources: SetSource[];
  onSaved: (project: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cacheKey = `ga_brief_draft:${item.project_token}:${item.asset_token}`;
  const restored = useRef(readDraft(cacheKey));
  const [draft, setDraft] = useState<GameAssetBrief>(restored.current?.brief ?? item.brief);
  const [revision, setRevision] = useState(restored.current?.revision ?? item.revision);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [warning, setWarning] = useState("");
  const mesh = item.kind === "prop_3d";
  const reference = sources.find((source) => source.version.token === draft.maybe_style_source_version_token);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    try { localStorage.setItem(cacheKey, JSON.stringify({ revision, brief: draft })); setWarning(""); }
    catch { setWarning("本地草稿尚未保存，请先把需求保存到项目再离开。"); }
  }, [cacheKey, revision, draft]);
  const field = <K extends keyof GameAssetBrief>(key: K, value: GameAssetBrief[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const output = (key: string, value: number | boolean | null) => setDraft((old) => ({ ...old, maybe_output_overrides: { ...old.maybe_output_overrides, [key]: value } }));
  const save = async () => {
    if (busy) return;
    const invalid = dialog.current?.querySelector<HTMLInputElement>("input:invalid, textarea:invalid, select:invalid");
    if (invalid) { invalid.reportValidity(); setError("请先修正已标出的数值，再保存需求。"); return; }
    setBusy(true); setError("");
    try {
      const result = await api.UpdateAssetBrief(item.project_token, item.asset_token, draft, revision);
      setRevision(result.item.revision);
      try { localStorage.removeItem(cacheKey); } catch { /* The project copy is already durable. */ }
      onSaved(item.project_token); onClose();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "需求保存结果暂未确认；输入已保留，请重试。"); }
    finally { setBusy(false); }
  };
  const numeric = (label: string, key: string, min: number, max: number, step = 1) => <label className="ga-field" key={key}>{label}<input aria-label={`需求${label}`} type="number" min={min} max={max} step={step}
    value={(draft.maybe_output_overrides as Record<string, unknown> | null)?.[key] as number ?? ""} placeholder="留空继承项目设置"
    onChange={(event) => output(key, event.target.value === "" ? null : Number(event.target.value))} /></label>;
  return <dialog ref={dialog} className="ga-creation-dialog" aria-label="编辑已保存的资产需求" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><h2>编辑资产需求</h2><p>{KIND_LABELS[item.kind as AssetKind]} · 已保存需求第 {item.revision} 版</p></div><button type="button" className="ga-action" disabled={busy} onClick={onClose}>关闭并保留输入</button></header>
    <div className="ga-creation-scroll"><fieldset disabled={busy}>
      {revision !== item.revision && <p className="ga-info">当前输入从较早的未保存草稿恢复。保存时会检查并发变更。</p>}
      <label className="ga-field">资产名称<input aria-label="需求资产名称" value={draft.display_name} maxLength={100} onChange={(event) => field("display_name", event.target.value)} /></label>
      <label className="ga-field">要制作的对象<textarea aria-label="需求对象描述" value={draft.description} maxLength={4000} rows={4} onChange={(event) => field("description", event.target.value)} /></label>
      <label className="ga-field">在游戏中怎样使用<textarea aria-label="需求游戏用途" value={draft.use_case} maxLength={1000} onChange={(event) => field("use_case", event.target.value)} /></label>
      <label className="ga-field">风格样板<select aria-label="需求风格样板" value={draft.maybe_style_source_version_token ?? ""} onChange={(event) => field("maybe_style_source_version_token", event.target.value || null)}><option value="">使用项目的文字风格与参考</option>
        {draft.maybe_style_source_version_token && !reference && <option value={draft.maybe_style_source_version_token}>原样板目前不可用，请重新选择</option>}
        {sources.map((source) => <option key={source.version.token} value={source.version.token}>{source.name}</option>)}</select></label>
      {reference && <div className="ga-set-source"><AssetThumbnail api={api} project={item.project_token} version={reference.version} mesh={reference.kind === "prop_3d"} name={reference.name} /><p>新对象参考这份样板的画风。</p></div>}
      <label className="ga-field">这项的外观补充<textarea aria-label="需求外观补充" value={draft.maybe_style_override ?? ""} maxLength={2000} placeholder="留空继承项目或所选样板的外观要求" onChange={(event) => field("maybe_style_override", event.target.value.trim() ? event.target.value : null)} /></label>
      <label className="ga-field">需要保持的特征<input aria-label="需求保留特征" value={draft.preserve} maxLength={1000} onChange={(event) => field("preserve", event.target.value)} /></label>
      <label className="ga-field">每次候选数<select aria-label="需求候选数量" value={draft.candidate_count} onChange={(event) => field("candidate_count", Number(event.target.value))}>{[1,2,3,4].map((count) => <option key={count} value={count}>{count} 个</option>)}</select></label>
      <details><summary>这项的输出条件 · 留空跟随报价时的项目设置</summary><div className="ga-creation-output">{mesh ? <>{numeric("目标高度（米）", "target_height_m", 0.01, 100, 0.01)}{numeric("三角面预算", "max_triangles", 100, 1000000)}{numeric("最大贴图边长", "max_texture_size", 256, 4096)}{numeric("模型转向（度）", "rotation_y_degrees", -360, 360)}</>
        : <>{numeric("画布尺寸（像素）", "canvas", 64, 4096)}{numeric("透明留白（像素）", "content_inset_px", 0, 2047)}</>}</div>
        <button type="button" className="ga-view-button" onClick={() => field("maybe_output_overrides", null)}>清除这项输出覆盖，跟随项目设置</button></details>
      <p className="ga-info">保存后，新的制作会使用这份需求。已有候选和交付选择仍可查看与比较；开始生成前会重新核对条件与费用。</p>
    </fieldset>{warning && <p role="alert" className="ga-error">{warning}</p>}{error && <p role="alert" className="ga-error">{error}</p>}
    {revision !== item.revision && <button type="button" className="ga-action" disabled={busy} onClick={() => { setDraft(item.brief); setRevision(item.revision); }}>用当前已保存需求替换这份本地草稿</button>}</div>
    <footer><button type="button" className="ga-action ga-primary" disabled={busy} onClick={() => void save()}>{busy ? "保存需求…" : "保存需求，用于后续制作"}</button></footer>
  </dialog>;
}

function readDraft(key: string): { revision: number; brief: GameAssetBrief } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as { revision: number; brief: GameAssetBrief } | null;
    return value && Number.isInteger(value.revision) && value.brief && typeof value.brief.display_name === "string" && typeof value.brief.description === "string" && typeof value.brief.use_case === "string" ? value : undefined;
  } catch { return undefined; }
}
