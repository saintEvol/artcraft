import { useEffect, useRef, useState } from "react";
import { GameAssetsApiError, type GameAssetsApi, type GameReviewV2Request, type GameSelectionV2Request, type GameVersionDetailsV2 } from "@storyteller/api";
import { previewForReview, type PreviewEvidence } from "./preview-evidence";

const REVIEW_LABELS: Record<string, string> = { passed: "通过", rejected: "需修改", revoked: "已撤回", not_reviewed: "尚未审核", needs_recheck: "需要更新预览与确认" };

type PendingWrite = { kind: "review"; request: GameReviewV2Request } | { kind: "selection"; request: GameSelectionV2Request; asset: string };
interface Props {
  api: GameAssetsApi; version: string; sessionKey: string;
  detail: GameVersionDetailsV2 | null; evidence: PreviewEvidence; poseIds: string[];
  supportsReview: boolean; supportsSelection: boolean; onRefresh: () => void; onChanged?: () => void;
}

/** Only explicit user actions send mutations. Rendering observations and the
 * human declaration remain separate; uncertain writes retain their exact key. */
export function AnimatedVersionReview({ api, version, sessionKey, detail, evidence, poseIds, supportsReview, supportsSelection, onRefresh, onChanged }: Props) {
  const pendingKey = `ga_pending_version_write:${version}`, mounted = useRef(true);
  const [pending, setPending] = useState<PendingWrite | null>(() => readPending(pendingKey, version));
  const [confirmation, setConfirmation] = useState({ session: sessionKey, value: false }), [reason, setReason] = useState(""), [category, setCategory] = useState<NonNullable<GameReviewV2Request["maybe_rejection_kind"]>>("technical_quality");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [canRevise, setCanRevise] = useState(false);
  const available = supportsReview ? previewForReview(detail, evidence, poseIds) : { preview: null, missing: [] }, ready = available.preview !== null;
  const confirmed = confirmation.session === sessionKey && confirmation.value && ready;
  const setConfirmed = (value: boolean) => setConfirmation({ session: sessionKey, value });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setConfirmed(false); }, [sessionKey, ready]);
  const clear = (operation: PendingWrite) => {
    if (readPending(pendingKey, version)?.request.idempotency_key === operation.request.idempotency_key) localStorage.removeItem(pendingKey);
  };
  const send = async (operation: PendingWrite) => {
    if (busy) return;
    setBusy(true); setError(""); setCanRevise(false);
    try {
      localStorage.setItem(pendingKey, JSON.stringify(operation)); setPending(operation);
      if (operation.kind === "review") {
        const result = await api.ReviewGameVersionV2(version, operation.request);
        if (!result.success || !result.review_token || result.version_token !== version || result.decision !== operation.request.decision) throw new Error("审核响应与本次固定版本不一致，请确认原请求。");
      } else {
        const result = await api.SelectGameVersionV2(operation.asset, operation.request);
        if (!result.success || !result.asset || result.asset.token !== operation.asset || result.asset.maybe_current_version_token !== version) throw new Error("交付选择响应与本次版本不一致，请确认原请求。");
      }
      clear(operation);
      if (mounted.current) { setPending(null); setConfirmed(false); (onChanged ?? onRefresh)(); }
    } catch (problem) {
      if (mounted.current) {
        setError(problem instanceof Error ? problem.message : "请求尚未确认，请查询或继续原请求。");
        setCanRevise(problem instanceof GameAssetsApiError && [400, 404, 409, 422].includes(problem.status) && problem.code !== "idempotency_conflict");
      }
    } finally { if (mounted.current) setBusy(false); }
  };
  const review = (decision: GameReviewV2Request["decision"]) => {
    if (pending || busy || !supportsReview || decision === "passed" && (!available.preview || !confirmed) || decision === "rejected" && !reason.trim()) return;
    const request: GameReviewV2Request = { idempotency_key: crypto.randomUUID(), decision,
      maybe_reason: reason.trim() || undefined, maybe_rejection_kind: decision === "rejected" ? category : undefined,
      preview_context: decision === "passed" && available.preview ? { ...available.preview, human_confirmed: true } : undefined };
    void send({ kind: "review", request });
  };
  const select = () => {
    if (!detail || pending || busy || !supportsSelection || !detail.gate.can_select || !detail.gate.context || !detail.gate.latest_report_token || !detail.gate.latest_review_token) return;
    void send({ kind: "selection", asset: detail.asset.token, request: { idempotency_key: crypto.randomUUID(), expected_revision: detail.asset.revision,
      version_token: version, check: detail.gate.context, report_token: detail.gate.latest_report_token, review_token: detail.gate.latest_review_token } });
  };
  if (!supportsReview && !pending) return null;
  return <section aria-label="角色与动画审核" className="ga-version-review">
    <h3>这个固定版本的审核</h3>
    <p>当前记录：{detail ? REVIEW_LABELS[detail.gate.review_state] ?? detail.gate.review_state : "版本详情暂不可读，仍可记录问题或撤回通过"}。审核通过只保存判断，交付版本单独选择。</p>
    <button type="button" className="ga-action" disabled={busy} onClick={onRefresh}>刷新检查与预览</button>
    {pending ? <div className="ga-info"><p>上次{pending.kind === "selection" ? "交付选择" : "审核"}请求尚未确认。继续时保留原版本、上下文和提交键。</p><button type="button" disabled={busy} onClick={() => void send(pending)}>确认原请求结果</button>
      {canRevise && <button type="button" disabled={busy} onClick={() => { clear(pending); setPending(null); setError(""); setConfirmed(false); onRefresh(); }}>返回预览并修正</button>}</div>
      : <>
        <div className="ga-review-observations"><p>实际观察：{evidence.decoded ? "已解码" : "尚未解码"}{evidence.instantiated ? " · 已实例化并渲染" : ""}{evidence.animation_bound ? " · 动作已绑定" : ""}{evidence.playback_observed ? " · 已播放推进" : ""}</p>
          {poseIds.length > 0 && <p>诊断姿势：{poseIds.filter((id) => evidence.diagnostic_poses.includes(id)).length} / {poseIds.length} 已实际渲染</p>}
          {available.missing.length > 0 && <ul>{available.missing.map((missing) => <li key={missing}>{missing}</li>)}</ul>}
        </div>
        <label className="ga-check"><input type="checkbox" aria-label="确认已实际检查本次预览" checked={confirmed} disabled={busy || !ready || !supportsReview} onChange={(event) => setConfirmed(event.target.checked)} />我已检查本次预览的外观、所需视图、变形或播放效果</label>
        <button type="button" className="ga-action ga-primary" disabled={busy || !ready || !confirmed || !supportsReview} onClick={() => review("passed")}>记录审核通过</button>
        <div className="ga-problem-tools"><label className="ga-field">希望修改的问题<textarea aria-label="角色与动画审核说明" value={reason} maxLength={4000} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
          <label className="ga-field">问题分类<select aria-label="角色与动画问题分类" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="technical_quality">技术或变形问题</option><option value="style_mismatch">风格不符</option><option value="subject_wrong">主体不符</option><option value="other">其他</option></select></label>
          <button type="button" className="ga-action" disabled={busy || !reason.trim() || !supportsReview} onClick={() => review("rejected")}>记录需要修改</button>
          <button type="button" className="ga-action" disabled={busy || !supportsReview} onClick={() => review("revoked")}>撤回审核通过</button>
        </div>
        <button type="button" className="ga-action" disabled={busy || !supportsSelection || !detail?.gate.can_select} onClick={select}>选定此版本用于交付</button>
        {(!supportsSelection || !detail?.gate.can_select) && <p className="ga-help">当前类型或版本的交付条件尚未满足，不能选入交付。</p>}
      </>}
    {error && <p role="alert" className="ga-error">{error}</p>}{busy && <p role="status">正在确认原请求…</p>}
  </section>;
}

function readPending(key: string, version: string): PendingWrite | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PendingWrite | null;
    if (!value || !["review", "selection"].includes(value.kind) || typeof value.request?.idempotency_key !== "string") return null;
    if (value.kind === "selection") return value.request.version_token === version && typeof value.asset === "string" ? value : null;
    return ["passed", "rejected", "revoked"].includes(value.request.decision) && (value.request.decision !== "passed" || value.request.preview_context?.check.version_token === version) ? value : null;
  } catch { return null; }
}
