import { useEffect, useRef, useState } from "react";
import { gameAssetOperation, type GameAssetsCapabilities, type GameAssetsApi, type GameAssetInfo, type GameAssetVersionInfo, type GameAssetBriefInfo, type GameCreationRun } from "@storyteller/api";
import { assetCandidates } from "./candidates";
import { KIND_LABELS, isKnownAssetKind, type AssetKind } from "./profile";
import { groupAssetsByTag, uniqueAssets } from "./asset-tags";
import { CollectionScene } from "./CollectionScene";

export interface CollectionAsset extends GameAssetInfo {
  versions: (GameAssetVersionInfo & { gate: { reviewPassed: boolean; validationPassed: boolean; reviewState?: string } })[];
  brief?: GameAssetBriefInfo; briefOrder?: number;
}
const TERMINAL = new Set(["succeeded", "partial_success", "failed", "cancelled", "cancelled_with_results"]);

export function AssetCollection({ api, project, assets, runs, group, onGroup, onNew, onEdit, onMake, onBatch, onView, onDeliver, onClose, loading, onChanged, supportsTags, onTags, capabilities }: {
  api: GameAssetsApi; project: string; assets: CollectionAsset[]; runs: GameCreationRun[]; group: string;
  capabilities?: GameAssetsCapabilities | null;
  supportsTags?: boolean; onTags: (asset: GameAssetInfo) => void;
  loading?: boolean; onChanged: (project: string) => void;
  onGroup: (group: string) => void; onNew: () => void; onEdit: (brief: GameAssetBriefInfo) => void;
  onMake: (brief: GameAssetBriefInfo) => void; onBatch: (briefs: GameAssetBriefInfo[]) => void;
  onView: (asset: string, version: string) => void; onDeliver: (assets: string[]) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState("all"); const [size, setSize] = useState(64); const [background, setBackground] = useState("dark");
  const [mode, setMode] = useState("list");
  const [byTags, setByTags] = useState(false);
  const [controlBusy, setControlBusy] = useState(""); const [controlError, setControlError] = useState("");
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { setKind("all"); setMode("list"); }, [group]);
  const groups = new Map<string, string>();
  assets.forEach((asset) => { if (asset.brief?.brief.maybe_group_key) groups.set(asset.brief.brief.maybe_group_key, asset.brief.brief.maybe_group_name ?? "资产组"); });
  const members = assets.filter((asset) => !group || asset.brief?.brief.maybe_group_key === group);
  const sampleAssets = new Set(members.flatMap((asset) => asset.brief?.brief.maybe_group_sample_asset_token ? [asset.brief.brief.maybe_group_sample_asset_token] : []));
  const missingSamples = group ? [...sampleAssets].filter((token) => !assets.some((asset) => asset.token === token)) : [];
  const withSamples = group ? assets.filter((asset) => members.includes(asset) || sampleAssets.has(asset.token)) : assets;
  const visible = uniqueAssets(withSamples).filter((asset) => kind === "all" || asset.kind === kind).sort((a,b) => (a.briefOrder ?? -1) - (b.briefOrder ?? -1));
  const states = visible.map((asset) => ({ asset, version: chosenOrLatest(asset), run: runs.find((run) => run.asset_token === asset.token) }));
  const selected = states.filter(({ asset }) => asset.versions.some((version) => version.token === asset.maybe_current_version_token && version.gate.reviewPassed && version.gate.validationPassed));
  const unstarted = states.filter(({ asset, run }) => isKnownAssetKind(asset.kind) && asset.brief && !asset.versions.length && !run).map(({ asset }) => asset.brief!);
  const making = states.filter(({ run }) => run && !TERMINAL.has(run.status) && run.status !== "action_required");
  const needsAttention = states.filter(({ asset, version, run }) => run?.status === "action_required" || !selected.some((item) => item.asset.token === asset.token) && (!run || TERMINAL.has(run.status)) && (run?.status === "failed" || version?.gate.reviewState === "rejected" || version && ["source", "cutout"].includes(String(version.spec_json.stage))));
  const awaiting = states.filter(({ asset, version, run }) => version && (!run || TERMINAL.has(run.status)) && !selected.some((item) => item.asset.token === asset.token) && !needsAttention.some((item) => item.asset.token === asset.token));
  const models = states.filter(({ asset, version }) => asset.kind === "prop_3d" && version && !["concept", "source", "input"].includes(String(version.spec_json.stage))).map(({ asset, version }) => ({ name: assetLabel(asset), version: version! }));
  const displayGroups = supportsTags && byTags ? groupAssetsByTag(visible) : [{ tag: undefined, assets: visible }];
  const control = async (run: GameCreationRun, action: "cancel" | "continue") => {
    setControlBusy(run.token); setControlError("");
    try { await api.ControlCreation(run.token, action); onChanged(project); }
    catch (problem) { setControlError(problem instanceof Error ? problem.message : "操作尚未确认，请查看原任务进度。"); }
    finally { setControlBusy(""); }
  };
  return <dialog ref={dialog} className="ga-enlarged-preview ga-collection-dialog" aria-label="项目资产清单与整体评估" onClose={onClose}>
    <header><div><strong>资产清单与整体评估</strong><p>{loading ? "正在读取项目中已保存的清单与结果…" : `${visible.length + missingSamples.length} 项需求 · ${selected.length} 项已选定 · ${making.length} 项制作中 · ${awaiting.length} 项待评估 · ${unstarted.length} 项未开始${needsAttention.length ? ` · ${needsAttention.length} 项需要处理` : ""}`}</p></div><button type="button" className="ga-action" onClick={onClose}>返回工作台</button></header>
    <div className="ga-collection-controls"><label>资产组<select aria-label="评估资产组" value={group} onChange={(event) => onGroup(event.target.value)}><option value="">本项目全部资产</option>{[...groups].map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>类别<select aria-label="评估资产类别" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">全部类别</option>{Object.entries(KIND_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <button type="button" className="ga-action" onClick={onNew}>再补一组需求</button><button type="button" className="ga-action ga-primary" disabled={loading || !unstarted.length || !!capabilities && unstarted.some((item) => !gameAssetOperation(capabilities, item.kind, "generate").enabled)} onClick={() => onBatch(unstarted)}>制作未开始的 {unstarted.length} 项</button>
      <button type="button" className="ga-action" disabled={!selected.length} onClick={() => onDeliver(visible.map((asset) => asset.token))}>查看本组交付清单</button></div>
    {supportsTags && <label className="ga-check"><input type="checkbox" checked={byTags} onChange={(event) => setByTags(event.target.checked)} />按标签分组（同一资产可出现在多个组，汇总按资产去重）</label>}
    <div className="ga-collection-controls"><button type="button" className="ga-view-button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>清单与 2D 格子预览</button><button type="button" className="ga-view-button" disabled={!models.length} aria-pressed={mode === "scene"} onClick={() => setMode("scene")}>3D 同场景尺度评估</button>
      {mode === "list" && <><label>背景<select aria-label="整组预览背景" value={background} onChange={(event) => setBackground(event.target.value)}><option value="dark">深色背包</option><option value="light">浅色界面</option><option value="checker">透明棋盘</option></select></label><label>图标格子大小<select aria-label="整组图标显示大小" value={size} onChange={(event) => setSize(Number(event.target.value))}>{[32,64,128,256].map((size) => <option key={size} value={size}>{size}px</option>)}</select></label></>}
    </div>
    {mode === "scene" ? <><p className="ga-help">准备评估 {models.length} 件模型，加载结果见场景；其余需求仍在下方保留。只有概念图的对象需要先确认并生成模型。</p><CollectionScene api={api} project={project} items={models} /></> : null}
    {controlError && <p role="alert" className="ga-error">{controlError}</p>}
    {missingSamples.length > 0 && <p className="ga-error">本组还有 {missingSamples.length} 项已有样板未出现在可用列表中，可能已归档。本次不是完整组交付。</p>}
    {displayGroups.map((tagGroup) => <section className="ga-tag-group" key={tagGroup.tag == null ? "untagged-assets" : `tag:${tagGroup.tag}`}>
    {supportsTags && byTags && <h3>{tagGroup.tag ?? "未打标签"} · {tagGroup.assets.length} 项</h3>}
    <div style={{ gridTemplateColumns: `repeat(auto-fill,minmax(${Math.max(225, size + 48)}px,1fr))` }} className={`ga-collection-grid ${mode === "scene" ? "ga-collection-compact" : ""}`} data-background={background}>{states.filter(({ asset }) => tagGroup.assets.some((member) => member.token === asset.token)).map(({ asset, version, run }) => {
      const active = run && !TERMINAL.has(run.status);
      const adopted = selected.some((item) => item.asset.token === asset.token);
      const status = active ? run.status === "action_required" ? "需要处理" : "制作中，结果继续保留" : adopted ? "已选定交付" : version ? version.gate.reviewState === "rejected" ? "已记录问题，待修正" : version.spec_json.stage === "concept" ? "概念已生成，待确认模型" : ["source", "cutout"].includes(String(version.spec_json.stage)) ? "源文件已保留，待完成加工" : "候选待评估" : run?.status === "failed" ? "上次未完成，可调整需求继续" : run && TERMINAL.has(run.status) ? "上次制作已停止，可调整需求继续" : "未开始制作";
      return <article key={asset.token} className="ga-collection-item"><div className="ga-collection-item-heading"><strong>{assetLabel(asset)}</strong><small>{KIND_LABELS[asset.kind as AssetKind] ?? asset.kind}</small></div>
        {!isKnownAssetKind(asset.kind) && <p className="ga-info">请升级客户端以查看和操作此类型的资产。标识：{asset.token}</p>}
        {mode === "list" && isKnownAssetKind(asset.kind) && <CollectionImage api={api} project={project} asset={asset} version={version} size={size} />}
        <p className={adopted ? "ga-selected-label" : "ga-help"}>{status}</p>
        {asset.tags?.length ? <p className="ga-help">标签：{asset.tags.join("、")}</p> : null}
        {asset.brief && <p className="ga-collection-description">{asset.brief.brief.description}</p>}
        {run?.status === "action_required" && run.steps.filter((step) => step.maybe_problem).map((step) => <p key={step.candidate} className="ga-error">{step.maybe_problem}</p>)}
        <div className="ga-inline-controls">{active && <><button type="button" className="ga-view-button" disabled={!!controlBusy || run.cancel_requested} onClick={() => void control(run, "cancel")}>{run.cancel_requested ? "正在取回已提交结果" : "停止未提交步骤"}</button>{run.status === "action_required" && <button type="button" className="ga-view-button" disabled={!!controlBusy} onClick={() => void control(run, "continue")}>继续查询已有任务</button>}</>}{version && <button type="button" className="ga-view-button" onClick={() => onView(asset.token, version.token)}>打开候选查看与修改</button>}
          {supportsTags && isKnownAssetKind(asset.kind) && <button type="button" className="ga-view-button" onClick={() => onTags(asset)}>编辑标签</button>}
          {asset.brief && isKnownAssetKind(asset.kind) && <><button type="button" className="ga-view-button" onClick={() => onEdit(asset.brief!)}>编辑需求</button><button type="button" className="ga-view-button" title={capabilities ? gameAssetOperation(capabilities, asset.kind, "generate").reason : undefined} disabled={!!active || !!capabilities && !gameAssetOperation(capabilities, asset.kind, "generate").enabled} onClick={() => onMake(asset.brief!)}>{version ? "另做候选并报价" : "制作这一项"}</button></>}</div>
      </article>;
    })}</div></section>)}
    {visible.length === 0 && <p className="ga-help">这里还没有需求。先建立清单，或选择另一个类别。</p>}
  </dialog>;
}

function CollectionImage({ api, project, asset, version, size }: { api: GameAssetsApi; project: string; asset: CollectionAsset; version?: GameAssetVersionInfo; size: number }) {
  const [loaded, setLoaded] = useState<{ token: string; url: string }>(); const [error, setError] = useState("");
  const imageVersion = asset.kind === "prop_3d" ? asset.versions.find((version) => version.spec_json.stage === "concept") : version;
  useEffect(() => {
    let cancelled = false; let url: string | undefined; setError("");
    if (!imageVersion) return;
    void (async () => {
      try {
        const detail = await api.GetGameAssetVersion(imageVersion.token);
        const file = detail.files.find((file) => file.role === "main" && file.ordinal === 0) ?? detail.files.find((file) => file.role === "preview" && file.ordinal === 0);
        if (!file) return;
        const blob = await api.DownloadGameArtifact(project, file.artifact_token);
        if (cancelled || !blob.type.startsWith("image/")) return;
        url = URL.createObjectURL(blob); setLoaded({ token: imageVersion.token, url });
      } catch { if (!cancelled) setError("预览暂不可读，可打开候选重试"); }
    })(); return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [api, project, imageVersion?.token]);
  return <div className="ga-inventory-frame"><div className="ga-inventory-cell" style={{ width: size, height: size }}>{loaded && imageVersion && loaded.token === imageVersion.token ? <img src={loaded?.url} style={{ imageRendering: (imageVersion.spec_json.output as Record<string, unknown> | undefined)?.sampling === "nearest" ? "pixelated" : "auto" }} alt={`${assetLabel(asset)}${asset.kind === "prop_3d" ? "概念参考" : "实际格子预览"}`} /> : <span>{error || (version ? "读取预览…" : "等待制作")}</span>}</div>{asset.kind === "prop_3d" && <small>概念参考；实际模型请切换 3D 评估</small>}</div>;
}

export function chosenOrLatest(asset: CollectionAsset): CollectionAsset["versions"][number] | undefined {
  return asset.versions.find((version) => version.token === asset.maybe_current_version_token) ?? assetCandidates(asset.versions)[0]?.version;
}
export function assetLabel(asset: CollectionAsset): string {
  const name = asset.brief?.brief.display_name ?? chosenOrLatest(asset)?.spec_json.display_name;
  return typeof name === "string" ? name : asset.stable_key;
}
