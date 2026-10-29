import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi, GameAssetsCapabilities, GameAssetBrief, GameAssetVersionInfo } from "@storyteller/api";
import { AssetThumbnail } from "./AssetThumbnail";
import { KIND_LABELS, settingsSummary, type AssetKind, type OutputSettings } from "./profile";

export interface SetSource { version: GameAssetVersionInfo; kind: AssetKind; name: string }
interface ItemDraft { key: string; name: string; description: string; height: string }
export interface SetDraft {
  id: string; kind: AssetKind; name: string; use: string; style: string;
  inheritStyle: boolean; includeSample?: boolean; count: number; rows: ItemDraft[]; source?: SetSource;
}

export function readSetDrafts(project: string): SetDraft[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`ga_set_drafts:${project}`) ?? "[]");
    return Array.isArray(value) ? value.filter((draft): draft is SetDraft =>
      draft && typeof draft.id === "string" && typeof draft.name === "string" && typeof draft.use === "string" && typeof draft.style === "string"
      && Number.isInteger(draft.count) && draft.count >= 1 && draft.count <= 4 && typeof draft.inheritStyle === "boolean"
      && (!draft.source || typeof draft.source.name === "string" && ["icon_2d", "sprite_2d", "prop_3d"].includes(draft.source.kind) && typeof draft.source.version?.token === "string")
      && ["icon_2d", "sprite_2d", "prop_3d"].includes(draft.kind) && Array.isArray(draft.rows) && draft.rows.length <= 30
      && draft.rows.every((row: ItemDraft) => row && typeof row.key === "string" && typeof row.name === "string" && typeof row.description === "string" && typeof row.height === "string")) : [];
  } catch { return []; }
}

export function AssetSetComposer({ api, project, settings, source, initial, onSaved, onSettings, onClose, capabilities }: {
  capabilities?: GameAssetsCapabilities | null;
  api: GameAssetsApi; project: string; settings: OutputSettings; source?: SetSource; initial?: SetDraft;
  onSaved: (project: string, group: string) => void; onSettings: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const defaultKind = Object.keys(KIND_LABELS).find((kind) => !capabilities || capabilities.asset_kinds.includes(kind)) as AssetKind | undefined;
  const [draft, setDraft] = useState<SetDraft>(() => initial ?? {
    id: crypto.randomUUID(), kind: source?.kind ?? defaultKind ?? "icon_2d", name: source ? `${source.name}风格资产组` : "新的游戏资产组",
    use: typeof source?.version.spec_json.use_case === "string" ? source.version.spec_json.use_case : "森林 RPG 的背包格子，实际显示约 64×64 像素",
    style: typeof source?.version.spec_json.style === "string" ? source.version.spec_json.style : settings.style,
    inheritStyle: true, includeSample: !!source, count: 1, rows: [emptyRow()], source,
  });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [draftWarning, setDraftWarning] = useState("");
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    try {
      const others = readSetDrafts(project).filter((item) => item.id !== draft.id);
      localStorage.setItem(`ga_set_drafts:${project}`, JSON.stringify([draft, ...others])); setDraftWarning("");
    } catch { setDraftWarning("本地草稿尚未保存，请先点击“保存清单到项目”，再离开页面。"); }
  }, [draft, project]);
  const field = <K extends keyof SetDraft>(key: K, value: SetDraft[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const row = (key: string, values: Partial<ItemDraft>) => setDraft((old) => ({ ...old, rows: old.rows.map((item) => item.key === key ? { ...item, ...values } : item) }));
  const example = (kind: AssetKind) => {
    if (capabilities && !capabilities.asset_kinds.includes(kind)) return;
    const entries = kind === "prop_3d" ? [
      ["营地木桶", "一个封闭的旧木桶，圆柱桶身、竖向木板、两道深色金属箍、封闭桶盖，静态整体道具", "1"],
      ["营地路牌", "一根木柱支撑两块箭头形木牌，粗糙木材、简单金属钉，没有任何文字，静态整体道具", "2"],
    ] : [
      ["法力药水", "一小瓶蓝色法力药水，圆润透明玻璃瓶、软木塞、清楚的瓶身轮廓", ""],
      ["解毒药水", "一小瓶绿色解毒药水，矮胖透明玻璃瓶、软木塞，清楚可辨的绿色药液", ""],
      ["银钥匙", "一把银色钥匙，圆环形手柄、短直钥匙柄和两颗清晰的齿，完整单个钥匙", ""],
      ["金币", "一枚厚实的金色游戏金币，简单凸起圆环和菱形图案，没有数字或文字", ""],
      ["铁剑", "一把完整的短铁剑，简洁对称剑刃、十字护手、棕色握柄，不含人物或手", ""],
    ];
    setDraft((old) => ({ ...old, kind, use: kind === "prop_3d" ? "第三人称营地场景中的静态道具，与半米木箱和人物尺度协调" : "森林 RPG 的深色背包格子，实际显示约 64×64 像素", rows: entries.map(([name, description, height]) => ({ key: crypto.randomUUID(), name, description, height })) }));
  };
  const save = async () => {
    if (busy) return;
    const invalid = dialog.current?.querySelector<HTMLInputElement>("input:invalid, textarea:invalid, select:invalid");
    if (invalid) { invalid.reportValidity(); setError("请先修正已标出的数值，再保存需求。"); return; }
    setError("");
    try {
      if (capabilities && !capabilities.asset_kinds.includes(draft.kind)) throw new Error("此类型尚未被当前客户端与服务端共同支持，请选择已支持类型。");
      if (!draft.name.trim() || !draft.use.trim()) throw new Error("请填写资产组名称和游戏用途。");
      const items = draft.rows.map((item): { kind: AssetKind; brief: GameAssetBrief } => {
        if (!item.name.trim() || !item.description.trim()) throw new Error("每项都需要易懂的名称和对象描述。");
        const height = item.height.trim() ? Number(item.height) : undefined;
        if (draft.kind === "prop_3d" && height !== undefined && (!Number.isFinite(height) || height < 0.01 || height > 100)) throw new Error(`${item.name}的高度需要在 0.01–100 米之间。`);
        return { kind: draft.kind, brief: { display_name: item.name.trim(), description: item.description.trim(), use_case: draft.use.trim(), preserve: "", candidate_count: draft.count,
          maybe_style_override: draft.inheritStyle ? null : draft.style.trim(), maybe_style_source_version_token: draft.source?.version.token ?? null,
          maybe_output_overrides: draft.kind === "prop_3d" && height !== undefined ? { target_height_m: height } : null,
          maybe_group_key: draft.id, maybe_group_name: draft.name.trim(), maybe_group_sample_asset_token: draft.includeSample && draft.source?.kind === draft.kind ? draft.source.version.asset_token : null } };
      });
      // The saved draft identity survives a response loss and reload.
      setBusy(true); await api.CreateAssetBriefs(project, items, draft.id);
      try { localStorage.setItem(`ga_set_drafts:${project}`, JSON.stringify(readSetDrafts(project).filter((item) => item.id !== draft.id))); } catch { /* The server copy is already durable. */ }
      onSaved(project, draft.id); onClose();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "清单保存结果尚未确认，请重试同一次保存。"); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="ga-creation-dialog ga-set-composer" aria-label="建立资产需求清单" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><h2>按游戏需求建立一组资产</h2><p>先保存清单，再核对每项说明与费用；保存清单不会开始收费生成。</p></div><button type="button" className="ga-action" disabled={busy} onClick={onClose}>关闭并保留草稿</button></header>
    <div className="ga-creation-scroll"><fieldset disabled={busy}>
      {draft.source && <div className="ga-set-source"><AssetThumbnail api={api} project={project} version={draft.source.version} mesh={draft.source.kind === "prop_3d"} name={draft.source.name} /><p>风格样板：{draft.source.name}<small>保留样板，制作下面的新对象；参考的是画风。</small></p></div>}
      {draft.source && <label className="ga-check"><input type="checkbox" checked={!!draft.includeSample && draft.source.kind === draft.kind} disabled={draft.source.kind !== draft.kind} onChange={(event) => field("includeSample", event.target.checked)} />本组包含这项已有样板；只为下列新需求开始制作</label>}
      <label className="ga-field">资产组名称<input aria-label="资产组名称" maxLength={100} value={draft.name} onChange={(event) => field("name", event.target.value)} /></label>
      <div className="ga-set-shared"><label className="ga-field">资产类别<select aria-label="清单资产类别" value={draft.kind} onChange={(event) => field("kind", event.target.value as AssetKind)}>{capabilities && !capabilities.asset_kinds.includes(draft.kind) && <option value={draft.kind} disabled>{KIND_LABELS[draft.kind]} · 当前服务未交付</option>}{Object.entries(KIND_LABELS).filter(([kind]) => !capabilities || capabilities.asset_kinds.includes(kind)).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label className="ga-field">每项候选数<select value={draft.count} onChange={(event) => field("count", Number(event.target.value))}>{[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} 个</option>)}</select></label></div>
      <label className="ga-field">这些资产在游戏中怎样使用<textarea aria-label="资产组游戏用途" value={draft.use} maxLength={1000} onChange={(event) => field("use", event.target.value)} /></label>
      <label className="ga-check"><input type="checkbox" checked={draft.inheritStyle} onChange={(event) => field("inheritStyle", event.target.checked)} />{draft.source ? "沿用所选样板的外观要求" : "继承报价时的项目风格"}</label>
      {!draft.inheritStyle && <label className="ga-field">这组资产的外观要求<textarea aria-label="资产组画风" maxLength={2000} value={draft.style} onChange={(event) => field("style", event.target.value)} /></label>}
      <div className="ga-info">项目默认：{settingsSummary(settings, draft.kind)}。未单独填写的参数在报价时读取项目设置。<button type="button" className="ga-view-button" onClick={() => { onClose(); onSettings(); }}>先查看或修改项目设置</button></div>
      <div className="ga-inline-controls"><span>试填清单：</span><button type="button" className="ga-action" onClick={() => example("icon_2d")}>补齐背包图标</button><button type="button" className="ga-action" onClick={() => example("prop_3d")}>木桶与路牌</button></div>
      <ol className="ga-set-rows">{draft.rows.map((item, index) => <li key={item.key}><div className="ga-set-row-heading"><strong>第 {index + 1} 项</strong><button type="button" className="ga-view-button" disabled={draft.rows.length === 1} onClick={() => field("rows", draft.rows.filter((row) => row.key !== item.key))}>移除此项草稿</button></div>
        <label className="ga-field">名称<input aria-label={`第 ${index + 1} 项名称`} value={item.name} maxLength={100} onChange={(event) => row(item.key, { name: event.target.value })} /></label>
        <label className="ga-field">对象与差异<textarea aria-label={`第 ${index + 1} 项描述`} rows={2} value={item.description} maxLength={4000} onChange={(event) => row(item.key, { description: event.target.value })} /></label>
        {draft.kind === "prop_3d" && <label className="ga-field">这件道具的高度（米）<input aria-label={`第 ${index + 1} 项高度`} type="number" min={0.01} max={100} step={0.01} value={item.height} placeholder={`继承项目的 ${settings.meshHeight} 米`} onChange={(event) => row(item.key, { height: event.target.value })} /></label>}
      </li>)}</ol><button type="button" className="ga-action" disabled={draft.rows.length >= 30} onClick={() => field("rows", [...draft.rows, emptyRow()])}>再加一项需求</button>
      {draft.kind === "prop_3d" && <p className="ga-help">先制作概念图。每项确认概念后，模型会单独说明费用与目标尺度。</p>}
    </fieldset>{draftWarning && <p role="alert" className="ga-error">{draftWarning}</p>}{error && <p role="alert" className="ga-error">{error}</p>}</div>
    <footer><button type="button" className="ga-action ga-primary" disabled={busy} onClick={() => void save()}>{busy ? "保存需求清单…" : `保存 ${draft.rows.length} 项清单到项目`}</button></footer>
  </dialog>;
}

function emptyRow(): ItemDraft { return { key: crypto.randomUUID(), name: "", description: "", height: "" }; }
