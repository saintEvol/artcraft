import {
  conflictLines,
  CONTENT_ID_EXPLANATION,
  exportsV2Available,
  gameAssetOperation,
  kindExportsV2Enabled,
  parseRigConflicts,
  type GameAssetsCapabilities,
  type GameExportClosureMemberV2,
  type PreparedGameExportV2,
} from "@storyteller/api";
import { useEffect, useRef, useState } from "react";

export interface DeliveryItem {
  tags?: string[]; kindKey?: string;
  asset: string; name: string; kind: string; candidate: string;
  version?: string; fileVersion?: number; problem?: string;
}

const KIND_V2_LABELS: Record<string, string> = { character_3d: "角色", anim_2d: "2D 动画", anim_3d: "3D 动画" };

/** Map closure member version tokens to display names for disclosures. */
function memberLabels(members: GameExportClosureMemberV2[]): Map<string, string> {
  return new Map(members.map((member) => [member.version_token, member.display_name]));
}

export function DeliveryDialog({ items, target, onTarget, onBuild, onPrepareV2, onCreateV2, onClose, supportsTags, capabilities }: {
  capabilities?: GameAssetsCapabilities | null;
  supportsTags?: boolean;
  items: DeliveryItem[];
  target: string; onTarget: (target: string) => void;
  onBuild: (selections: { asset_token: string; version_token: string }[], key: string) => Promise<void>;
  /** Exports v2 preparation; only used when the server registers v2 delivery. */
  onPrepareV2?: (selections: { asset_token: string; version_token: string }[], key: string) => Promise<PreparedGameExportV2>;
  /** Exports v2 commit; the preparation shown must be the one confirmed. */
  onCreateV2?: (preparation: PreparedGameExportV2, target: string, key: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<{ signature: string; key: string } | undefined>(undefined);
  const [tagFilter, setTagFilter] = useState("");
  const [acknowledged, setAcknowledged] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflictReport, setConflictReport] = useState<string[]>();
  const [prepared, setPrepared] = useState<PreparedGameExportV2>();
  const [included, setIncluded] = useState(() => new Set(items.filter((item) => item.version).map((item) => item.asset)));
  const signature = JSON.stringify([target, items.map((item) => [item.asset, item.version, item.problem, included.has(item.asset)])]);
  const uniqueItems = [...new Map(items.map((item) => [item.asset, item])).values()];
  const visible = uniqueItems.filter((item) => !supportsTags || !tagFilter || item.tags?.includes(tagFilter));
  const selected = uniqueItems.filter((item) => item.version && included.has(item.asset));
  const v2Enabled = exportsV2Available(capabilities) && !!onPrepareV2 && !!onCreateV2 && selected.every((item) => kindExportsV2Enabled(capabilities, item.kindKey ?? ""));
  const unavailableOperation = capabilities && !v2Enabled ? selected.map((item) => gameAssetOperation(capabilities, item.kindKey ?? "", "export")).find((value) => !value.enabled) : undefined;
  const visibleSelected = selected.filter((item) => visible.includes(item)).length;
  const hiddenSelected = selected.length - visibleSelected;
  const unavailable = uniqueItems.filter((item) => !item.version).length;
  const deferred = uniqueItems.length - unavailable - selected.length;
  const missing = uniqueItems.length - selected.length;
  const choose = (next: Set<string>) => { setIncluded(next); setAcknowledged(undefined); setError(""); setPrepared(undefined); setConflictReport(undefined); };
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { setPrepared(undefined); setConflictReport(undefined); }, [signature]);
  const selections = selected.map((item) => ({ asset_token: item.asset, version_token: item.version! }));
  const prepareV2 = async () => {
    if (busy || acknowledged !== signature || !selected.length || !onPrepareV2) return;
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError(""); setConflictReport(undefined);
    try {
      const result = await onPrepareV2(selections, request.current.key);
      setPrepared(result);
    } catch (problem) {
      const details = problem instanceof Error && "details" in problem ? (problem as { details?: Record<string, unknown> }).details : undefined;
      const conflicts = parseRigConflicts(details);
      if (conflicts.length) setConflictReport(conflicts.map((conflict) => `${conflict.display_name}（${conflict.stable_key}）需要统一版本：\n${conflictLines(conflict).join("\n")}`));
      else if (problem instanceof Error && "code" in problem && (problem as { code?: unknown }).code === "kind_not_delivered") setError("此类型的交付链路尚未开放，请稍后重试或联系服务方。");
      else setError(problem instanceof Error ? problem.message : "准备结果尚未确认，请重试同一清单。");
    } finally { setBusy(false); }
  };
  const commitV2 = async () => {
    if (busy || !prepared || acknowledged !== signature || !onCreateV2) return;
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await onCreateV2(prepared, target, request.current.key);
      onClose();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "构建结果尚未确认，请重试同一清单。"); }
    finally { setBusy(false); }
  };
  const build = async () => {
    if (busy || acknowledged !== signature || !selected.length || unavailableOperation) return;
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await onBuild(selections, request.current.key);
      onClose();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "构建结果尚未确认，请重试同一清单。"); }
    finally { setBusy(false); }
  };
  const dependencyCount = prepared?.dependency_selections.length ?? 0;
  return <dialog ref={dialog} className="ga-creation-dialog" aria-label="确认交付清单" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><h2>确认交付清单</h2><p>{uniqueItems.length} 项资产 · 本次交付 {selected.length} 项{missing ? ` · ${missing} 项未包含` : ""}</p></div><button type="button" className="ga-action" disabled={busy} onClick={onClose}>返回工作台</button></header>
    <div className="ga-creation-scroll">
      <label className="ga-field">交付目标<select aria-label="清单交付目标" value={target} disabled={busy} onChange={(event) => { onTarget(event.target.value); setAcknowledged(undefined); setError(""); setPrepared(undefined); }}><option value="generic">下载通用文件</option><option value="godot">导入 Godot</option><option value="bevy">用于 Bevy 项目</option><option value="cocos">导入 Cocos Creator</option></select></label>
      <p className="ga-help">勾选本次需要的资产。这里只调整本次清单，项目中的选定版本会保留；更新资源时可以只勾选需要更新的项。</p>
      <div className="ga-actions"><button type="button" className="ga-action" disabled={busy} onClick={() => choose(new Set(items.filter((item) => item.version).map((item) => item.asset)))}>全选可交付资产</button><button type="button" className="ga-action" disabled={busy} onClick={() => choose(new Set())}>清空本次选择</button></div>
      {supportsTags && <label className="ga-field">清单显示标签<select aria-label="交付清单标签过滤" value={tagFilter} disabled={busy} onChange={(event) => setTagFilter(event.target.value)}><option value="">显示全部标签</option>{[...new Set(uniqueItems.flatMap((item) => item.tags ?? []))].map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>}
      <p className="ga-info" aria-live="polite">可见已选 {visibleSelected} 项 / 隐藏已选 {hiddenSelected} 项 / 导出总数 {selected.length} 项</p>
      <ul className="ga-delivery-items">{visible.map((item) => <li key={item.asset}><label className="ga-check"><input type="checkbox" aria-label={`本次交付：${item.name}`} disabled={busy || !item.version} checked={!!item.version && included.has(item.asset)} onChange={(event) => { const next = new Set(included); if (event.target.checked) next.add(item.asset); else next.delete(item.asset); choose(next); }} /><strong>{item.name}</strong><span>{item.kind}</span></label><p>{item.version ? `${included.has(item.asset) ? "" : "本次未包含 · "}${item.candidate} · 文件第 ${item.fileVersion} 版` : item.problem ?? "还没有选定版本，本次不包含"}</p>{item.version && item.problem && <p className="ga-info">{item.problem}</p>}</li>)}</ul>
      {deferred > 0 && <p className="ga-info">{deferred} 项本次未勾选，项目中的选定版本仍会保留。</p>}
      {unavailable > 0 && <p className="ga-info">另有 {unavailable} 项尚未选定或未通过检查，仍留在项目中，整套制作尚未完成。</p>}
      {!selected.length && <p role="status" className="ga-info">至少勾选一项已有交付版本的资产。</p>}
      <p className="ga-help">交付使用清单中的准确版本。构建成功后可下载，仍需在目标游戏中检查显示、尺度、材质和交互；引擎实际使用与更新单独记录。</p>
      <label className="ga-check"><input type="checkbox" checked={acknowledged === signature} disabled={busy || !selected.length} onChange={(event) => setAcknowledged(event.target.checked ? signature : undefined)} />我已核对本次资产、版本、交付目标与未包含项</label>
      {v2Enabled && !prepared && <p className="ga-info">本次将解析完整交付闭包：3D 动画会自动带入其绑定的角色版本，解析后先确认再提交。</p>}
      {prepared && <section aria-label="解析后的交付闭包">
        <h3>交付闭包已解析</h3>
        <p className="ga-info">{prepared.selections.length} 项资产将进入本次交付包（显式 {prepared.explicit_selections.length} 项{dependencyCount ? `，依赖引入 ${dependencyCount} 项` : ""}）· 闭包摘要 {prepared.closure_hash.slice(0, 12)}…</p>
        <ul className="ga-delivery-items">{prepared.selections.map((member) => <li key={member.asset_token}><strong>{member.display_name}</strong><span>{KIND_V2_LABELS[member.kind] ?? member.kind}</span><p>第 {member.version} 版 · {member.explicit ? "本次显式选择" : `由动画依赖引入${member.required_by.length ? `：${member.required_by.map((token) => memberLabels(prepared.selections).get(token) ?? token).join("、")}` : ""}`}</p></li>)}</ul>
        <p className="ga-help">{CONTENT_ID_EXPLANATION}</p>
      </section>}
      {conflictReport?.length && <div role="alert" className="ga-error">{conflictReport.map((line, index) => <p key={index} style={{ whiteSpace: "pre-line" }}>{line}</p>)}<p>同一角色被要求两个不同版本。请取消其中一个动画或统一角色版本后重新准备。</p></div>}
      {unavailableOperation && <p className="ga-info">{unavailableOperation.reason}</p>}
      {error && <p role="alert" className="ga-error">{error}</p>}
    </div>
    <footer>{v2Enabled
      ? prepared
        ? <button type="button" className="ga-action ga-primary" disabled={busy || acknowledged !== signature || !selected.length} onClick={() => void commitV2()}>{busy ? "提交交付构建…" : "按已解析闭包构建交付包"}</button>
        : <button type="button" className="ga-action ga-primary" disabled={busy || acknowledged !== signature || !selected.length} onClick={() => void prepareV2()}>{busy ? "正在解析交付闭包…" : "解析并确认交付闭包"}</button>
      : <button type="button" className="ga-action ga-primary" disabled={busy || acknowledged !== signature || !selected.length || !!unavailableOperation} onClick={() => void build()}>{busy ? "提交交付构建…" : "构建这份交付清单"}</button>}</footer>
  </dialog>;
}
