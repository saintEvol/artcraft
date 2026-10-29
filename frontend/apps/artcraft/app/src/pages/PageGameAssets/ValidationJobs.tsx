import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi, GameRunDetailsV2, GameRunInfoV2, GameRunStepV2 } from "@storyteller/api";

const TERMINAL = new Set(["succeeded", "failed", "partial_success", "cancelled", "cancelled_with_results"]);
const LABELS: Record<string, string> = { queued: "等待检查", running: "正在检查", reconciling: "恢复原检查", action_required: "需要处理", succeeded: "检查已结束", failed: "检查未完成", cancelled: "已取消", cancel_requested: "正在取消", cancelled_with_results: "已取消，结果保留", partial_success: "部分完成，结果保留", awaiting_review: "等待审核" };
const CREATION_LABELS: Record<string, string> = { queued: "排队等待制作", running: "正在制作", reconciling: "正在对账", action_required: "需要处理", succeeded: "制作已完成", failed: "制作未完成", cancelled: "已停止", cancel_requested: "正在停止", cancelled_with_results: "已停止，结果保留", partial_success: "部分完成，结果保留", awaiting_review: "等待审核" };
const CHECK_LABELS: Record<string, string> = { passed: "通过", failed: "未通过", needs_recheck: "需重新检查", not_checked: "尚未检查", unavailable: "不可用" };
const STEP_LABELS: Record<string, string> = { character_import_v2: "角色文件与骨架检查", validate_v2: "版本重新检查", character_mesh_v2: "角色模型生成（收费）" };
/** Paid runs walk the crash-window chain; unknown outcomes stay labeled as
 * reconciliation work and never auto-resubmit. */
const SUBMISSION_LABELS: Record<string, string> = {
  queued: "排队等待提交", submitted: "已提交，等待供应商结果", unknown: "提交结果未知，需对账，不自动重发",
  reconciling: "正在对账，不自动重发", collecting: "正在取回结果", succeeded: "已取回并保存", failed: "未完成", cancelled: "已取消",
};
const CREATION_RECIPE = "game_creation.v2";
const RUN_KIND_LABELS: Record<string, string> = { "game_validation.v2": "免费检查", [CREATION_RECIPE]: "模型制作" };

interface Props {
  api: GameAssetsApi; project: string; version?: string; refreshKey: number;
  supportsRuns: boolean; canStart: boolean;
  onVersions: () => void; onPreview: (asset: string, version: string) => void;
}

/** Existing workflow objects remain discoverable after a reload. Local keys
 * only recover uncertain button submissions; they are not a second job store. */
export function ValidationJobs({ api, project, version, refreshKey, supportsRuns, canStart, onVersions, onPreview }: Props) {
  const [runs, setRuns] = useState<GameRunInfoV2[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<GameRunDetailsV2>(), [selected, setSelected] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(""), [reload, setReload] = useState(0);
  const [reportReload, setReportReload] = useState(0);
  const [currentCheck, setCurrentCheck] = useState<{ version: string; status: string; report?: string }>();
  const callbacks = useRef({ onVersions, onPreview }); callbacks.current = { onVersions, onPreview };
  const known = useRef(new Map<string, string>()), mounted = useRef(true);
  const latestRuns = useRef(runs); latestRuns.current = runs;
  const apply = (items: GameRunInfoV2[], append: boolean) => {
    if (items.some((item) => item.project_token !== project)) throw new Error("任务列表不属于当前项目。");
    const accepted = items.filter((item) => item.recipe === "game_validation.v2" || item.recipe === CREATION_RECIPE);
    let changed = false;
    for (const run of accepted) {
      const previous = known.current.get(run.token);
      if (previous && previous !== run.status && TERMINAL.has(run.status)) changed = true;
      known.current.set(run.token, run.status);
    }
    setRuns((old) => append ? [...old.filter((run) => !accepted.some((next) => next.token === run.token)), ...accepted]
      : [...accepted, ...old.filter((run) => !accepted.some((next) => next.token === run.token))]);
    if (changed) { callbacks.current.onVersions(); setReportReload((value) => value + 1); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!supportsRuns) return;
    let cancelled = false, loading = false;
    const read = async () => {
      if (loading) return; loading = true;
      try {
        const page = await api.ListGameRunsV2(project);
        if (cancelled) return;
        if (page.has_more !== (page.next_cursor !== null)) throw new Error("任务列表分页不完整。");
        apply(page.items, false);
        setCursor(page.next_cursor);
        setError("");
      } catch (problem) { if (!cancelled) setError(message(problem)); }
      finally { loading = false; }
    };
    void read();
    return () => { cancelled = true; };
    // The host keys this component by project. Callbacks are read from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project, supportsRuns, refreshKey, reload]);
  useEffect(() => {
    setDetail(undefined);
    if (!selected || !supportsRuns) return;
    let cancelled = false, loading = false;
    const read = async () => {
      if (loading) return; loading = true;
      try {
        const result = await api.GetCompleteGameRunDetailsV2(selected, () => cancelled);
        if (!cancelled) {
          if (result.run.project_token !== project) throw new Error("任务不属于当前项目。");
          setDetail(result); apply([result.run], true); setError("");
        }
      } catch (problem) { if (!cancelled) setError(message(problem)); }
      finally { loading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project, selected, supportsRuns]);
  useEffect(() => {
    setCurrentCheck(undefined);
    if (!version || !supportsRuns) return;
    let cancelled = false;
    void api.GetCompleteGameAssetVersionDetailsV2(version, () => cancelled).then((result) => {
      if (!cancelled && result.asset.project_token === project) setCurrentCheck({ version, status: result.gate.technical_state, report: result.gate.latest_report_token ?? undefined });
    }).catch((problem) => { if (!cancelled) setError(message(problem)); });
    return () => { cancelled = true; };
  }, [api, project, version, supportsRuns, reportReload, refreshKey]);
  useEffect(() => {
    if (!supportsRuns) return;
    let cancelled = false, polling = false;
    const timer = setInterval(async () => {
      if (polling) return; polling = true;
      try {
        const active = latestRuns.current.filter((run) => !TERMINAL.has(run.status));
        for (const run of active) {
          const result = await api.GetGameRunDetailsV2(run.token);
          if (!cancelled) apply([result.run], true);
        }
      } catch (problem) { if (!cancelled) setError(message(problem)); }
      finally { polling = false; }
    }, 2500);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project, supportsRuns]);
  const start = async () => {
    if (!version || busy) return;
    const keyName = `ga_pending_rig_check:${project}:${version}`;
    setBusy("check"); setError("");
    try {
      const key = localStorage.getItem(keyName) ?? crypto.randomUUID(); localStorage.setItem(keyName, key);
      const result = await api.ValidateGameVersionV2(version, key);
      if (result.maybe_version_token !== version || result.supplier_calls !== 0) throw new Error("检查响应与所选版本不一致，请确认原提交。");
      localStorage.removeItem(keyName);
      if (mounted.current) { setSelected(result.run_token); setReload((value) => value + 1); }
    } catch (problem) { if (mounted.current) setError(message(problem)); }
    finally { if (mounted.current) setBusy(""); }
  };
  const control = async (run: GameRunInfoV2, action: "cancel" | "continue") => {
    if (busy) return;
    const keyName = `ga_pending_validation_control:${run.token}:${action}`;
    setBusy(run.token); setError("");
    try {
      const key = localStorage.getItem(keyName) ?? crypto.randomUUID(); localStorage.setItem(keyName, key);
      const result = await api.ControlGameRunV2(run.token, action, key);
      if (result.run.token !== run.token || result.run.project_token !== project) throw new Error("任务控制响应与当前项目不一致。");
      localStorage.removeItem(keyName);
      if (mounted.current) { apply([result.run], true); setSelected(run.token); }
    } catch (problem) { if (mounted.current) setError(message(problem)); }
    finally { if (mounted.current) setBusy(""); }
  };
  const more = async () => {
    if (!cursor || busy) return;
    setBusy("more");
    try {
      const page = await api.ListGameRunsV2(project, cursor);
      if (page.has_more !== (page.next_cursor !== null) || page.next_cursor === cursor) throw new Error("任务列表分页无法继续。");
      if (mounted.current) { apply(page.items, true); setCursor(page.next_cursor); }
    } catch (problem) { if (mounted.current) setError(message(problem)); }
    finally { if (mounted.current) setBusy(""); }
  };
  if (!supportsRuns) return null;
  return <section aria-label="角色检查与制作任务" className="ga-validation-jobs">
    <h3>角色检查与制作任务</h3>
    {version && <><p>固定版本：{version} · {currentCheck?.version === version ? `技术检查：${CHECK_LABELS[currentCheck.status] ?? currentCheck.status}${currentCheck.report ? ` · 报告 ${currentCheck.report}` : ""}` : "读取检查记录…"}</p><button type="button" className="ga-action" disabled={!!busy || !canStart} onClick={() => void start()}>免费重新检查此版本</button></>}
    <button type="button" className="ga-view-button" disabled={!!busy} onClick={() => setReload((value) => value + 1)}>刷新任务列表</button>
    {error && <p role="alert" className="ga-error">{error}</p>}
    {runs.map((run) => <article key={run.token}><button type="button" className="ga-view-button" aria-expanded={selected === run.token} onClick={() => setSelected(selected === run.token ? "" : run.token)}>{RUN_KIND_LABELS[run.recipe] ?? run.recipe} · {runStatusLabel(run)} · {run.token}</button>
      {!TERMINAL.has(run.status) && <button type="button" disabled={!!busy || run.cancel_requested} onClick={() => void control(run, "cancel")}>{run.cancel_requested ? "等待停止确认" : run.recipe === CREATION_RECIPE ? "停止后续操作" : "取消检查"}</button>}
      {run.status === "action_required" && !run.cancel_requested && <button type="button" disabled={!!busy} onClick={() => void control(run, "continue")}>{run.recipe === CREATION_RECIPE ? "继续查询与处理" : "恢复原检查"}</button>}
      {run.recipe === CREATION_RECIPE && run.cancel_requested && !TERMINAL.has(run.status) && <small>已提交的供应商请求继续取回，可能仍产生费用。</small>}
      {selected === run.token && detail?.run.token === run.token && <div>
        {run.recipe === CREATION_RECIPE
          ? <p>此任务按供应商账号计费。每步费用在启动时的分步授权与供应商回执中记录；未知提交状态需对账，不会自动重发。</p>
          : <p>本地检查，不调用收费供应商。</p>}
        {detail.steps.map((step) => {
        const result = step.maybe_latest_attempt?.maybe_result, problem = step.maybe_latest_attempt?.maybe_error;
        const submission = run.recipe === CREATION_RECIPE ? submissionState(step) : null;
        return <div key={step.token}><p>{STEP_LABELS[step.kind] ?? step.kind} · {(run.recipe === CREATION_RECIPE ? CREATION_LABELS : LABELS)[step.status] ?? step.status}{step.maybe_direction && ` · 方向 ${step.maybe_direction}`}{step.maybe_frame_index !== null && ` · 帧 ${step.maybe_frame_index}`}{result && ` · 文件检查：${CHECK_LABELS[String(result.validation_status)] ?? String(result.validation_status)}`}</p>
          {submission && <p className="ga-help">供应商提交：{SUBMISSION_LABELS[submission] ?? submission}</p>}
          {problem && <p className="ga-error">{typeof problem.message === "string" ? problem.message : JSON.stringify(problem)}</p>}
          {typeof result?.version_token === "string" && step.maybe_asset_token && <button type="button" onClick={() => callbacks.current.onPreview(step.maybe_asset_token!, result.version_token as string)}>查看{step.status === "succeeded" ? "已保存结果" : "已保留结果"}</button>}
          {result && <details><summary>结果与回执身份</summary><pre className="ga-diagnostics">{JSON.stringify(result, null, 2)}</pre></details>}
        </div>;
      })}</div>}
    </article>)}
    {cursor && <button type="button" disabled={!!busy} onClick={() => void more()}>更多任务</button>}
    {!runs.length && <p>尚无角色检查与制作任务。</p>}
  </section>;
}

/** Paid steps expose their native submission window; unknown outcomes must
 * stay visible instead of being relabeled as failed or finished. */
function submissionState(step: GameRunStepV2): string {
  if (step.status === "reconciling") return "reconciling";
  const attempt = step.maybe_latest_attempt;
  if (!attempt) return "queued";
  if (attempt.status === "prepared") return "queued";
  if (attempt.status === "submitting") return "unknown";
  if (attempt.status === "collecting" || step.status === "collecting_outputs") return "collecting";
  return attempt.status;
}

function runStatusLabel(run: GameRunInfoV2): string {
  return (run.recipe === CREATION_RECIPE ? CREATION_LABELS : LABELS)[run.status] ?? run.status;
}

function message(problem: unknown) { return problem instanceof Error ? problem.message : "任务状态尚未确认，请刷新原任务。"; }
