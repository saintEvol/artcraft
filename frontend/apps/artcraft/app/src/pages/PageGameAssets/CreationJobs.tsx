import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi, GameCreationRun } from "@storyteller/api";

const TERMINAL = new Set(["succeeded", "failed", "partial_success", "cancelled", "cancelled_with_results"]);
const STATES: Record<string, string> = { queued: "等待制作", running: "正在制作", reconciling: "正在等待或取回生成结果", action_required: "需要处理后继续", succeeded: "候选已保存", partial_success: "部分候选已完成", failed: "本次未完成，已有产物保留", cancelled: "已停止后续操作", cancelled_with_results: "已停止，已有产物保留", cancel_requested: "正在停止未提交的操作" };
const STAGES: Record<string, string> = { compile_prompt:"整理生成说明",generate: "生成外观", remove_background: "去除背景", processing: "加工与文件检查", ready: "可预览候选", concept_ready: "概念图待选择" };

export function CreationJobs({ api, project, refreshKey, onVersions, onPreview,onRevise,onRuns }: {
  api: GameAssetsApi; project: string; refreshKey: number;
  onVersions: (project: string) => void;
  onPreview: (asset: string, version: string) => void;
  onRevise:(run:GameCreationRun)=>void;
  onRuns?: (project: string, runs: GameCreationRun[]) => void;
}) {
  const [runs, setRuns] = useState<GameCreationRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(""); const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const needsListRefresh = useRef(true);
  const loadedProject = useRef<string | undefined>(undefined);
  const autoExpandedRuns = useRef(new Set<string>());
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [expanded]);
  const signatures = useRef(new Map<string, string>());
  const callbacks = useRef({ onVersions, onPreview, onRuns }); callbacks.current = { onVersions, onPreview, onRuns };
  const currentRuns = useRef(runs); currentRuns.current = runs;
  const activeProject = useRef(project); activeProject.current = project;
  const showNewWork = (items: GameCreationRun[]) => {
    const unseen = items.some((run) => !TERMINAL.has(run.status) && !autoExpandedRuns.current.has(run.token));
    for (const run of items) autoExpandedRuns.current.add(run.token);
    if (unseen) setExpanded(true);
  };
  const apply = (items: GameCreationRun[], append: boolean) => {
    if (activeProject.current !== project) return;
    let changed = false;
    for (const run of items) {
      const signature = run.steps.flatMap((step) => step.version_tokens).join("|");
      const previous = signatures.current.get(run.token);
      if (signature && previous !== signature) changed = true;
      signatures.current.set(run.token, signature);
    }
    const merged = (append ? [...currentRuns.current.filter((run) => !items.some((next) => next.token === run.token)), ...items]
      : [...items, ...currentRuns.current.filter((run) => !items.some((next) => next.token === run.token))]).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.token.localeCompare(b.token));
    currentRuns.current = merged; setRuns(merged); callbacks.current.onRuns?.(project, merged);
    if (changed) callbacks.current.onVersions(project);
    try {
      const pending = JSON.parse(localStorage.getItem(`ga_pending_creation:${project}`) ?? "null") as { plan?: string } | null;
      if (pending?.plan && items.some((run) => run.maybe_plan_token === pending.plan)) localStorage.removeItem(`ga_pending_creation:${project}`);
    } catch { /* A malformed marker must not discard server results. */ }
  };
  useEffect(() => {
    let cancelled = false;
    if (loadedProject.current !== project) { currentRuns.current = []; setRuns([]); callbacks.current.onRuns?.(project, []); setCursor(null); signatures.current.clear(); autoExpandedRuns.current.clear(); setExpanded(false); loadedProject.current = project; }
    needsListRefresh.current = true; setLoading(true); setError("");
    void api.ListCreationRuns(project).then((page) => { if (!cancelled) { apply(page.items, false); setCursor(page.next_cursor); needsListRefresh.current = false; showNewWork(page.items); } }).catch((problem) => { if (!cancelled) setError(problem.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project, refreshKey, reload]);
  useEffect(() => {
    let cancelled = false; let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      const active = currentRuns.current.filter((run) => !TERMINAL.has(run.status));
      if (!active.length && !needsListRefresh.current && !localStorage.getItem(`ga_pending_creation:${project}`)) return;
      polling = true;
      try {
        if (!active.length || needsListRefresh.current) {
          const page = await api.ListCreationRuns(project);
          if (!cancelled) { apply(page.items, false); setCursor(page.next_cursor); needsListRefresh.current = false; showNewWork(page.items); }
        } else {
          const items = await Promise.all(active.map((run) => api.GetCreationRun(run.token).then((result) => result.run)));
          if (!cancelled) apply(items, false);
        }
        if (!cancelled) setError("");
      } catch { if (!cancelled) setError("制作状态暂时无法刷新。"); }
      finally { polling = false; }
    }, 2500);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project]);
  const control = async (run: GameCreationRun, action: "cancel" | "continue") => {
    setBusy(run.token); setError("");
    try { const result = await api.ControlCreation(run.token, action); apply([result.run], false); }
    catch (problem) { if (activeProject.current === project) setError(problem instanceof Error ? problem.message : "操作暂未确认，请刷新状态。"); }
    finally { setBusy(""); }
  };
  if (!runs.length && !error && !loading) return null;
  return <section ref={panel} className="ga-creation-jobs" aria-label="制作进度与候选">
    <header><button type="button" className="ga-action" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{error ? "制作进度暂无法刷新" : loading ? "正在读取制作进度…" : `制作进度与候选 · ${runs.filter((run) => !TERMINAL.has(run.status)).length} 项进行中`}{expanded ? " · 收起" : " · 展开"}</button><small>源图、去背结果和完成版本都会保留在项目中。</small></header>
    {error && <div role="alert" className="ga-error"><span>{error} 已提交任务保留，读取重试不会重新制作。</span><button type="button" className="ga-action" onClick={() => setReload((value) => value + 1)}>重试读取进度</button></div>}
    {expanded && <div className="ga-job-list">{runs.map((run) => <article key={run.token} className="ga-job-card">
      <div><strong>{run.display_name}</strong><span>{STATES[run.status] ?? "状态更新中"}</span></div>
      <ul>{run.steps.map((step) => <li key={step.candidate}><span>候选 {step.candidate + 1} · {step.status === "cancelled" ? "已停止" : step.stage === "generate" && run.operation === "mesh" ? "生成 3D 模型" : STAGES[step.stage] ?? "准备中"}</span>
        {step.version_tokens[0] && <button type="button" className="ga-action" onClick={() => {setExpanded(false);callbacks.current.onPreview(run.asset_token, step.version_tokens[0]);}}>查看{step.stage === "concept_ready" ? "概念" : step.stage === "ready" ? "候选" : "已保留产物"}</button>}
        {step.maybe_problem && <p className="ga-help">{step.maybe_problem}</p>}</li>)}</ul>
      {!TERMINAL.has(run.status) && <div className="ga-inline-controls">
        {!run.cancel_requested && <button type="button" className="ga-action" disabled={!!busy} onClick={() => void control(run, "cancel")}>停止后续操作</button>}
        {run.status === "action_required" && <button type="button" className="ga-action" disabled={!!busy} onClick={() => void control(run, "continue")}>继续查询与处理</button>}
        {run.cancel_requested && <small>已提交的生成继续取回，可能仍产生供应商费用。</small>}
      </div>}
      {run.making&&<button type="button" className="ga-action" onClick={()=>onRevise(run)}>调整需求后另行报价</button>}
    </article>)}{cursor && <button type="button" className="ga-action" onClick={() => { void api.ListCreationRuns(project, cursor).then((page) => { apply(page.items, true); setCursor(page.next_cursor); }).catch((problem) => setError(problem.message)); }}>加载较早的制作记录</button>}</div>}
  </section>;
}
