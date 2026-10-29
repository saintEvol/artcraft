import { packAssets } from "./engine-report";

const ASSET_RESULTS: Record<string, string> = {
  imported: "已导入", updated: "已更新", unchanged: "保持原版", loaded: "已加载",
  failed: "未通过", kept_local: "保留本地版本", missing: "缺少文件", conflict: "本地修改待处理",
};

const ENGINE_LABELS: Record<string, string> = { godot: "Godot", bevy: "Bevy", cocos: "Cocos Creator" };

export function EngineReportSummary({ report, manifest }: {
  report: Record<string, unknown>; manifest: Record<string, unknown>;
}) {
  const expected = packAssets(manifest);
  const names = new Map(expected.map((asset) => [asset.asset_id, asset.display_name || asset.stable_key]));
  const rows = Array.isArray(report.assets) ? report.assets.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry)) : [];
  const seen = new Set(rows.map((row) => row.asset_id));
  const missing = expected.filter((asset) => !seen.has(asset.asset_id));
  const detail = report.detail && typeof report.detail === "object" && !Array.isArray(report.detail) ? report.detail as Record<string, unknown> : {};
  const problems = Array.isArray(report.problems) ? report.problems.filter((entry): entry is string => typeof entry === "string") : [];
  const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts.filter((entry): entry is string => typeof entry === "string") : [];
  return <div className="ga-engine-result">
    <p>{ENGINE_LABELS[String(report.engine)] ?? "引擎"} {String(report.engine_version ?? "版本未记录")} · {report.rendered === true ? "报告记录了实际渲染" : "此报告未确认实际渲染"}</p>
    {typeof detail.message === "string" && <p>{detail.message}</p>}
    {!!problems.length && <ul aria-label="需要处理的问题">{problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>}
    {!!conflicts.length && <><p>以下文件有本地修改，请回到引擎选择保留、副本或备份替换：</p><ul>{conflicts.map((path) => <li key={path}>{path}</li>)}</ul></>}
    {!!rows.length && <ul aria-label="逐项引擎结果">{rows.map((row, index) => <li key={index}><strong>{names.get(String(row.asset_id)) || "清单之外的资产"}</strong> · {ASSET_RESULTS[String(row.status)] ?? "结果格式待核对"}{Array.isArray(row.problems) && row.problems.length > 0 && <p>{row.problems.filter((entry) => typeof entry === "string").join("；")}</p>}</li>)}</ul>}
    {!!missing.length && <p>本报告未确认：{missing.map((asset) => asset.display_name || asset.stable_key).join("、")}。</p>}
    {report.status === "succeeded" && report.operation !== "runtime" && <p>下一步：在引擎运行资产预览或自己的场景，检查显示与用途，再保存运行报告。</p>}
    {["failed", "partial", "conflicts"].includes(String(report.status)) && <p>下一步：回到引擎处理上述问题。保留现有文件，完成后保存新的结果报告；无需重新生成满意的资产。</p>}
    <details><summary>技术详情与原始报告</summary><pre className="ga-diagnostics">{JSON.stringify(report, null, 2)}</pre></details>
  </div>;
}
