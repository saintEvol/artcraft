import { useEffect, useRef, useState } from "react";
import { GameAssetsApiError, gameAssetOperation, type GameAssetsCapabilities, type GameAssetsApi, type GameAssetBriefInfo, type GameCreationPlan } from "@storyteller/api";
import { inputForBrief, quoteTotals, readableOutput } from "./asset-brief";
import { AssetThumbnail } from "./AssetThumbnail";
import type { SetSource } from "./AssetSetComposer";

interface ApprovedBatch { project: string; key: string; items: GameAssetBriefInfo[]; plans: GameCreationPlan[] }
export function pendingBatch(project: string): ApprovedBatch | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(`ga_approved_batch:${project}`) ?? "null") as ApprovedBatch | null;
    return value?.project === project && typeof value.key === "string" && Array.isArray(value.plans) && Array.isArray(value.items) ? value : undefined;
  } catch { return undefined; }
}

export function AssetBatchLauncher({ api, project, items, sourceFor, onStarted, onClose, capabilities }: {
  capabilities?: GameAssetsCapabilities | null;
  api: GameAssetsApi; project: string; items: GameAssetBriefInfo[]; sourceFor: (token: string) => SetSource | undefined;
  onStarted: (project: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef(pendingBatch(project));
  const [visibleItems, setVisibleItems] = useState(initial.current?.items ?? items);
  const [plans, setPlans] = useState<GameCreationPlan[]>(initial.current?.plans ?? []);
  const [acknowledged, setAcknowledged] = useState<string>();
  const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(!!initial.current);
  const operationKey = useRef(initial.current?.key ?? crypto.randomUUID());
  const prepareKeys = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; dialog.current?.close(); }; }, []);
  const signature = JSON.stringify(plans.map((plan) => [plan.plan_token, plan.plan_hash_hex]));
  const ready = plans.length === visibleItems.length && plans.length > 0;
  const missingPrice = plans.some((plan) => [plan.quote.quote, ...(plan.quote.additional_estimates ?? [])].some((quote) => quote.estimated_amount === null));
  const sources = [...new Set(visibleItems.flatMap((item) => item.brief.maybe_style_source_version_token ? [item.brief.maybe_style_source_version_token] : []))].flatMap((token) => { const source = sourceFor(token); return source ? [source] : []; });
  const unavailable = capabilities ? visibleItems.map((item) => gameAssetOperation(capabilities, item.kind, "generate")).find((value) => !value.enabled) : undefined;
  const prepare = async () => {
    if (busy || uncertain || unavailable) return;
    if (plans.length) prepareKeys.current.clear();
    setBusy("读取已保存的需求与项目设置…"); setError(""); setPlans([]); setAcknowledged(undefined);
    try {
      const current = (await api.GetGameProject(project)).project;
      if (!current.maybe_current_profile_token) throw new Error("先保存项目风格与输出设置，再查看制作费用。");
      const saved: GameAssetBriefInfo[] = []; let cursor: string | undefined;
      do { const page = await api.ListAssetBriefs(project, cursor); saved.push(...page.items); cursor = page.next_cursor ?? undefined; } while (cursor);
      const fresh = items.map((item) => { const found = saved.find((row) => row.asset_token === item.asset_token); if (!found) throw new Error("部分需求已移除或归档，请返回项目核对清单。"); return found; });
      if (!alive.current) return; setVisibleItems(fresh);
      const quoted: GameCreationPlan[] = [];
      for (const [index, item] of fresh.entries()) {
        if (!alive.current) return;
        setBusy(`核对 ${item.brief.display_name}，取得第 ${index + 1}/${fresh.length} 项估算…`);
        const intent = `${item.asset_token}:${item.revision}:${current.maybe_current_profile_token}`;
        if (!prepareKeys.current.has(intent)) prepareKeys.current.set(intent, crypto.randomUUID());
        const plan = await api.PrepareCreation(project, inputForBrief(item, current.maybe_current_profile_token, prepareKeys.current.get(intent)!));
        quoted.push(plan); if (alive.current) setPlans([...quoted]);
      }
      if (alive.current) operationKey.current = crypto.randomUUID();
    } catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : "未取得全部估算，请重试；没有开始生成。"); }
    finally { if (alive.current) setBusy(""); }
  };
  const start = async () => {
    if (!ready || busy || !uncertain && (acknowledged !== signature || unavailable) || missingPrice) return;
    if (!uncertain && plans.some((plan) => Date.parse(plan.expires_at) <= Date.now())) { prepareKeys.current.clear(); setPlans([]); setAcknowledged(undefined); setError("部分报价已过期，请重新核对需求与费用。"); return; }
    setBusy(uncertain ? "确认上次整组提交结果…" : "一次提交全部已确认需求…"); setError("");
    try {
      localStorage.setItem(`ga_approved_batch:${project}`, JSON.stringify({ project, key: operationKey.current, items: visibleItems, plans } satisfies ApprovedBatch));
      await api.StartCreationBatch(project, plans.map((plan) => ({ plan_token: plan.plan_token, plan_hash_hex: plan.plan_hash_hex })), operationKey.current);
      try { localStorage.removeItem(`ga_approved_batch:${project}`); } catch { /* Same submission can still be replayed safely. */ }
      onStarted(project); onClose();
    } catch (problem) {
      const rejected = problem instanceof GameAssetsApiError && problem.status >= 400 && problem.status < 500;
      if (rejected) { try { localStorage.removeItem(`ga_approved_batch:${project}`); } catch {} }
      if (alive.current) { setUncertain(!rejected); setError(problem instanceof Error ? problem.message : "提交结果尚未确认，请核对同一次操作。"); }
    } finally { if (alive.current) setBusy(""); }
  };
  return <dialog ref={dialog} className="ga-creation-dialog ga-set-launcher" aria-label="确认整组制作说明与费用" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><h2>{uncertain ? "确认上次整组提交" : "核对这组资产的制作说明与费用"}</h2><p>{visibleItems.length} 项需求，各项的对象、用途和输出条件分别保存。</p></div><button type="button" className="ga-action" onClick={onClose}>返回项目</button></header>
    <div className="ga-creation-scroll">
      {sources.length > 0 && <section className="ga-batch-sources" aria-label="本组使用的风格参考">{sources.map((source) => <div className="ga-set-source" key={source.version.token}><AssetThumbnail api={api} project={project} version={source.version} mesh={source.kind === "prop_3d"} name={source.name} /><p>风格样板：{source.name}<small>参考画风，制作各项描述的新对象。</small></p></div>)}</section>}
      {visibleItems.map((item, index) => { const plan = plans[index]; return <article className="ga-batch-making" key={item.asset_token}><h3>{item.brief.display_name} · {plan?.making.candidate_count ?? item.brief.candidate_count} 个{plan?.making.stage === "concept" ? "概念候选" : "候选"}</h3>
        <p>{plan?.making.description ?? item.brief.description}</p><p>用途：{plan?.making.use_case ?? item.brief.use_case}</p>
        {plan && <><p>外观：{plan.making.style}</p><p>输出：{readableOutput(plan)}</p><p>这项估算：{quoteTotals([plan])}</p></>}</article>; })}
      {ready && <section className="ga-making-summary"><h3>本次费用合计</h3><p>{quoteTotals(plans)}</p><p className="ga-help">费用由实例配置的供应商账号承担。不同币种分别列出；这是生成、需求整理与所需去背的估算，实际费用可能不同，没有供应商硬上限。{plans.some((plan) => plan.making.kind === "prop_3d") && "3D 本轮先制作概念图，模型将在确认概念后另行报价。"}</p>
        {!uncertain && <label className="ga-check"><input type="checkbox" checked={acknowledged === signature} disabled={!!busy || missingPrice} onChange={(event) => setAcknowledged(event.target.checked ? signature : undefined)} />我已核对以上各项需求、参考、输出条件和费用合计</label>}</section>}
      {uncertain && <p className="ga-info">上次提交可能已经成功。这里只确认原来的计划和提交身份；任务不会因为页面关闭或查询失败被重新制作。</p>}
      {unavailable && !uncertain && <p className="ga-info">{unavailable.reason}</p>}
      {busy && <p role="status">{busy}</p>}{error && <p role="alert" className="ga-error">{error}</p>}
    </div><footer>{ready ? <><button type="button" className="ga-action" disabled={!!busy || uncertain || !!unavailable} onClick={() => void prepare()}>重新核对与估算</button><button type="button" className="ga-action ga-primary" disabled={!!busy || missingPrice || !uncertain && (acknowledged !== signature || !!unavailable)} onClick={() => void start()}>{uncertain ? "确认同一次提交" : `开始这 ${visibleItems.length} 项制作`}</button></> : <button type="button" className="ga-action ga-primary" disabled={!!busy || !visibleItems.length || !!unavailable} onClick={() => void prepare()}>查看各项制作说明与合计费用</button>}</footer>
  </dialog>;
}
