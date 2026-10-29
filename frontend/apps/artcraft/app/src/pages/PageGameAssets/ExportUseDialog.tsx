import { useEffect, useRef, useState } from "react";
import { GameAssetsApiError, type GameAssetsApi, type GameExportInfo } from "@storyteller/api";
import { INTEGRATION_COMPONENTS } from "./integration-components";
import { comparePacks, packAssets, reportOperationKey, validateEngineReport, type EngineReportRecord } from "./engine-report";
import { EngineReportSummary } from "./EngineReportSummary";
import { FrozenAssetVersion } from "./FrozenAssetVersion";

const OPERATION_LABELS: Record<string, string> = { import: "初次导入", update: "更新资源", runtime: "实际运行" };
const KIND_LABELS: Record<string, string> = { prop_3d: "3D 道具", icon_2d: "图标", sprite_2d: "精灵图", character_3d: "角色", anim_2d: "2D 动画", anim_3d: "3D 动画" };
const ENGINE_LABELS: Record<string, string> = { godot: "Godot", bevy: "Bevy", cocos: "Cocos Creator" };

type ExportDetail = Awaited<ReturnType<GameAssetsApi["GetGameExport"]>> | Awaited<ReturnType<GameAssetsApi["GetGameExportDetailsV2"]>>;
const RESULT_LABELS: Record<string, string> = { succeeded: "已完成", failed: "未通过，需处理问题", conflicts: "发现本地修改冲突", partial: "部分完成或保留本地版本", loaded: "已加载，尚未验证渲染" };

export function ExportUseDialog({ api, item, exports, onDownload, onClose }: {
  api: GameAssetsApi; item: GameExportInfo; exports: GameExportInfo[];
  onDownload: (token: string) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true); const epoch = useRef(0);
  const [detail, setDetail] = useState<ExportDetail>();
  const [reading, setReading] = useState(false);
  const readingRequest = useRef<number | undefined>(undefined);
  const queuedRead = useRef(false);
  const [reports, setReports] = useState<EngineReportRecord[]>([]);
  const [error, setError] = useState(""); const [reportError, setReportError] = useState("");
  const [readReportError, setReadReportError] = useState("");
  const [comparisonError, setComparisonError] = useState("");
  const [busy, setBusy] = useState(""); const [previous, setPrevious] = useState("");
  const [changes, setChanges] = useState<ReturnType<typeof comparePacks>>();
  const [report, setReport] = useState<Record<string, unknown>>();
  const [usageAcknowledged, setUsageAcknowledged] = useState<string>();
  const uploadKey = useRef<string>(crypto.randomUUID());
  const latestDetail = useRef<ExportDetail | undefined>(undefined); latestDetail.current = detail;
  const fileEpoch = useRef(0); const comparison = useRef("");
  const component = item.export_kind === "godot" || item.export_kind === "bevy" || item.export_kind === "cocos" ? INTEGRATION_COMPONENTS[item.export_kind] : undefined;
  const read = async (queueIfBusy = false) => {
    if (readingRequest.current !== undefined) { if (queueIfBusy) queuedRead.current = true; return; }
    const request = ++epoch.current;
    readingRequest.current = request; setReading(true);
    try {
      try {
        // Manifest-2.0 exports read their fixed snapshot from details_v2;
        // legacy packs keep the v1 read (details_v2 rejects them).
        let current: ExportDetail;
        try {
          current = await api.GetGameExportDetailsV2(item.token);
        } catch (problem) {
          if (problem instanceof GameAssetsApiError && problem.code === "unsupported_operation") {
            current = await api.GetGameExport(item.token);
          } else throw problem;
        }
        if (!alive.current || epoch.current !== request) return;
        setDetail(current); setError("");
      } catch (problem) { if (alive.current && epoch.current === request) setError(problem instanceof Error ? problem.message : "资源包暂时无法读取，请重试。"); }
      try { const result = await api.ListEngineReports(item.token); if (alive.current && epoch.current === request) { setReports(result.items); setReadReportError(""); } }
      catch { if (alive.current && epoch.current === request) setReadReportError("导入报告暂时无法读取，资源包仍保留。"); }
    } finally {
      if (readingRequest.current === request) {
        readingRequest.current = undefined;
        if (alive.current) setReading(false);
        if (queuedRead.current && alive.current) { queuedRead.current = false; void read(); }
      }
    }
  };
  useEffect(() => {
    alive.current = true; dialog.current?.showModal(); void read();
    const timer = setInterval(() => { if (!latestDetail.current || ["pending", "building"].includes(latestDetail.current.export.status)) void read(); }, 3000);
    return () => { alive.current = false; epoch.current++; readingRequest.current = undefined; queuedRead.current = false; clearInterval(timer); dialog.current?.close(); };
    // This dialog is keyed by immutable export token by its parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chooseReport = async (file?: File) => {
    const selectedFile = ++fileEpoch.current;
    setReport(undefined); setReportError(""); uploadKey.current = crypto.randomUUID();
    if (!file || !detail?.maybe_manifest) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("报告不能超过 2 MiB。");
      const value = validateEngineReport(JSON.parse(await file.text()), detail.maybe_manifest, item.export_kind);
      const key = await reportOperationKey(item.token, value);
      if (alive.current && fileEpoch.current === selectedFile) { uploadKey.current = key; setReport(value); }
    }
    catch (problem) { if (alive.current && fileEpoch.current === selectedFile) setReportError(problem instanceof SyntaxError ? "报告不是有效 JSON，请选择组件保存的完整报告文件。" : problem instanceof Error ? problem.message : "报告暂时无法读取，请重新选择。"); }
  };
  const upload = async () => {
    if (!report || busy) return; setBusy("保存这份引擎报告…"); setReportError("");
    try { await api.SubmitEngineReport(item.token, { importer_version: String(report.importer_version), report, trust_level: "self_reported", maybe_idempotency_key: uploadKey.current }); if (alive.current) { setReport(undefined); await read(true); } }
    catch (problem) { if (alive.current) setReportError(problem instanceof Error ? problem.message : "报告保存结果尚未确认，可重试同一次上传。"); }
    finally { if (alive.current) setBusy(""); }
  };
  const compare = async (token: string) => {
    comparison.current = token; setPrevious(token); setChanges(undefined); setComparisonError(""); if (!token || !detail?.maybe_manifest) return;
    try { const old = await api.GetGameExport(token); if (alive.current && comparison.current === token) setChanges(comparePacks(packAssets(old.maybe_manifest), packAssets(detail.maybe_manifest))); }
    catch (problem) { if (alive.current && comparison.current === token) setComparisonError(problem instanceof Error ? problem.message : "旧清单暂时无法读取。"); }
  };
  const manifest = detail?.maybe_manifest;
  const assets = packAssets(manifest ?? null);
  const names = assets.slice(0, 6).map((asset) => asset.display_name || asset.stable_key).join("、");
  const runtime = reports.find((entry) => {
    if (!manifest || entry.report.operation !== "runtime") return false;
    try { validateEngineReport(entry.report, manifest, item.export_kind); return true; } catch { return false; }
  });
  const userConfirmed = (runtime?.report.user_confirmation as { confirmed?: boolean } | undefined)?.confirmed === true;
  const confirmUsage = async () => {
    if (!runtime || busy || usageAcknowledged !== runtime.token || runtime.report.status !== "succeeded" || runtime.report.rendered !== true) return;
    const value: Record<string, unknown> = { ...runtime.report, user_confirmation: { confirmed: true, source_report_token: runtime.token } };
    setBusy("保存游戏内使用确认…"); setReportError("");
    try { const key = await reportOperationKey(item.token, value); await api.SubmitEngineReport(item.token, { importer_version: String(value.importer_version), report: value, trust_level: "self_reported", maybe_idempotency_key: key }); if (alive.current) { setUsageAcknowledged(undefined); await read(true); } }
    catch (problem) { if (alive.current) setReportError(problem instanceof Error ? problem.message : "确认结果尚未保存，可重试同一次操作。"); }
    finally { if (alive.current) setBusy(""); }
  };

  return <dialog ref={dialog} className="ga-creation-dialog ga-engine-use" aria-label="资源包内容、引擎使用与更新" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><h2>{component ? `在 ${ENGINE_LABELS[item.export_kind] ?? item.export_kind} 中使用这份资源包` : "查看这份通用资源包"}</h2><p>{new Date(item.created_at).toLocaleString()} · {manifest ? `${assets.length} 项冻结资产` : "内容尚未读取"}</p></div><button type="button" className="ga-action" onClick={onClose}>返回工作台</button></header>
    <div className="ga-creation-scroll">
      {error && <p role="alert" className="ga-error">{error}<button type="button" className="ga-action" disabled={reading} onClick={() => void read()}>重试读取</button></p>}
      {!manifest && !error && <p role="status">{!detail ? "正在读取这次交付的冻结内容…" : detail.export.status === "failed" ? "本次构建失败，已选版本仍在项目中。" : ["pending", "building"].includes(detail.export.status) ? "资源包正在构建；完成后可下载并继续以下步骤。" : "本包清单暂时不可用，请重新读取。"}{detail && !["pending", "building", "failed"].includes(detail.export.status) && <button type="button" className="ga-action" disabled={reading} onClick={() => void read()}>重新读取内容</button>}</p>}
      {manifest && <section className="ga-engine-contents"><p className="ga-engine-names">{names}{assets.length > 6 ? `等 ${assets.length} 项` : ""}</p><details><summary>查看本包 {assets.length} 项内容与冻结版本</summary><ul className="ga-delivery-items">{assets.map((asset) => <li key={asset.asset_id}><strong>{asset.display_name || asset.stable_key}</strong><span>{KIND_LABELS[String(asset.kind)] ?? "资产"}</span><p>已冻结本次制作版本 · {asset.files.length} 个文件{asset.dependencies?.length ? ` · 依赖绑定角色 ${asset.dependencies[0].asset_id}` : ""}</p><FrozenAssetVersion key={asset.version_id} api={api} asset={asset} /></li>)}</ul></details></section>}
      {component && <section><h3>1. 获取集成组件</h3><p>此组件 {component.version} 支持 {ENGINE_LABELS[item.export_kind] ?? item.export_kind} {component.engineVersion}。组件与资源数据分别下载，资源包中的文件不会作为脚本执行。</p><a className="ga-action" href={component.url} download>下载{component.name}</a></section>}
      <section><h3>{component ? "2. 下载并导入本次数据" : "下载数据"}</h3><button type="button" className="ga-action ga-primary" disabled={!manifest || !!busy} onClick={() => void onDownload(item.token)}>下载这份资源包</button>
        {item.export_kind === "godot" && <ol><li>解压集成组件。可直接打开其中的 project.godot，也可把 addons/game_assets 文件夹放进自己的工程，在项目设置的插件页启用 GameAssets。</li><li>另行解压本次资源包。在 Godot 的 GameAssets 面板选择包含 manifest.json 的目录，先核对清单与更新差异，再导入。</li><li>点击“打开资产预览”，在引擎里检查图标、尺寸、材质与需要的碰撞。生成的资产场景可拖入自己的场景。</li><li>保存导入/运行报告，再回到这里上传。更新时选择同一游戏工程，先处理面板列出的人工修改冲突。</li></ol>}
        {item.export_kind === "bevy" && <ol><li>解压组件，将 game_assets_bevy 放入自己的工程 vendor 目录，依照其中 README 添加 path 依赖，使用匹配的 Bevy 0.20.0。</li><li>解压本次数据，按 README 提供的导入命令核对并写入 assets/game_assets 管理目录。</li><li>运行随附的 preview_pack 示例，或按稳定资产 ID 在自己的游戏中加载。检查加载、实际实例化和渲染，保存报告。</li><li>再次导入新包前查看差异并处理本地改动；基础 crate 提供碰撞描述，实际物理需要明确的物理适配。</li></ol>}
        {item.export_kind === "cocos" && <ol><li>解压集成组件，把解压出的目录放进自己 Cocos Creator 3.8.8 工程的 extensions/ 文件夹（例如 extensions/artcraft-game-assets），扩展加载后菜单出现“Artcraft 资产”。</li><li>另行解压本次资源包。在“Artcraft 资产/导入资产包”选择包含 manifest.json 的目录，先核对清单与更新差异，再导入；文件会安装到 assets/game_assets/ 下的受管目录。</li><li>打开“Artcraft 资产”面板查看已安装资产、依赖与导入报告；2D 帧动画运行时组件随包安装到 runtime/，可挂到节点上播放。</li><li>引擎报告保存在 game_assets_reports/，选择 JSON 报告回到这里上传。更新时选择同一工程，先处理面板列出的人工修改冲突。</li></ol>}
      </section>
      {component && <><section><h3>3. 查看导入或运行报告</h3><p>下载只证明取得了文件。上传的本机报告标为使用者提供；导入、实际渲染和适合自己游戏的判断分别保留。</p><button type="button" className="ga-action" disabled={reading || !!busy} onClick={() => void read()}>{reading ? "正在读取记录…" : "刷新导入与运行记录"}</button><label className="ga-field">选择组件生成的 JSON 报告<input type="file" accept="application/json,.json" disabled={!manifest || !!busy} onChange={(event) => void chooseReport(event.target.files?.[0])} /></label>
        {report && manifest && <><p>将上传：{OPERATION_LABELS[String(report.operation)]} · {RESULT_LABELS[String(report.status)]}</p><EngineReportSummary report={report} manifest={manifest} /><button type="button" className="ga-action" disabled={!!busy} onClick={() => void upload()}>保存这份报告</button></>}
        {reportError && <p role="alert" className="ga-error">{reportError}</p>}{busy && <p role="status">{busy}</p>}
        {readReportError && <p role="alert" className="ga-error">{readReportError}<button type="button" className="ga-action" onClick={() => void read()}>重试读取报告</button></p>}
        {!reports.length && !readReportError && <p className="ga-info">{reading ? "正在读取已有引擎记录…" : "尚未收到这份包的引擎报告，游戏内效果待确认。"}</p>}
        {manifest && reports.map((entry) => <article key={entry.token}><strong>{OPERATION_LABELS[String(entry.report.operation)] ?? "历史记录"} · {RESULT_LABELS[String(entry.report.status)] ?? "结果待核对"}</strong><p>{entry.trust_level === "platform_verified" ? "平台验证记录" : "使用者提供的本机报告"} · {new Date(entry.created_at).toLocaleString()}</p><EngineReportSummary report={entry.report} manifest={manifest} /></article>)}
        {runtime?.report.status === "succeeded" && runtime.report.rendered === true && <section className="ga-making-summary"><h4>在自己的游戏中确认效果</h4>{userConfirmed ? <p>使用者已确认本包适合自己的游戏；这条判断与运行报告分别保留。</p> : <><label className="ga-check"><input type="checkbox" disabled={!!busy} checked={usageAcknowledged === runtime.token} onChange={(event) => setUsageAcknowledged(event.target.checked ? runtime.token : undefined)} />我已在自己的游戏中检查显示、尺寸、材质和实际用途</label><button type="button" className="ga-action" disabled={!!busy || usageAcknowledged !== runtime.token} onClick={() => void confirmUsage()}>保存游戏内使用确认</button></>}</section>}
      </section><section><h3>4. 更新已有资产</h3><p>先比较两份交付清单。实际磁盘冲突由引擎集成在写入前核对；未包含的旧资产不会被自动删除。</p><label className="ga-field">与之前的交付比较<select value={previous} onChange={(event) => void compare(event.target.value)}><option value="">选择之前使用的包</option>{exports.filter((entry) => entry.token !== item.token && entry.export_kind === item.export_kind && entry.status === "succeeded").map((entry) => <option key={entry.token} value={entry.token}>{new Date(entry.created_at).toLocaleString()}</option>)}</select></label>{comparisonError && <p role="alert" className="ga-error">{comparisonError}<button type="button" className="ga-action" onClick={() => void compare(previous)}>重试比较</button></p>}{changes && <ul>{changes.map((entry, index) => <li key={index}>{entry.name} · {entry.state}</li>)}</ul>}</section></>}
    </div>
  </dialog>;
}
