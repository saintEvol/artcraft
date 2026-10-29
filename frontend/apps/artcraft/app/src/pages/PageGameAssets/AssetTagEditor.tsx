import { useEffect, useRef, useState } from "react";
import { GameAssetsApiError, normalizeGameAssetTag, normalizeGameAssetTags, type GameAssetsApi, type GameAssetInfo } from "@storyteller/api";
import { PRESET_ASSET_TAGS, tagSaveSignature, useProjectTagSuggestions } from "./asset-tags";

export function AssetTagEditor({ api, asset, name, onSaved, onClose, projectArchived }: {
  projectArchived?: boolean;
  api: GameAssetsApi; asset: GameAssetInfo; name: string;
  onSaved: (asset: GameAssetInfo) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState(asset);
  const [tags, setTags] = useState(asset.tags ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latestLoaded, setLatestLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const request = useRef<{ signature: string; tags: string[]; revision: number; key: string } | undefined>(undefined);
  const suggestions = useProjectTagSuggestions(api, asset.project_token, true);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    let cancelled = false; setLoading(true); setLoadError(false);
    void api.GetGameAsset(asset.token).then(({ asset: current }) => {
      if (cancelled) return;
      setBase(current); setTags(current.tags ?? []); setError("");
    }).catch((problem) => { if (!cancelled) { setError(problem.message); setLoadError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, asset.token, readAttempt]);
  const add = (value: string) => {
    try { setTags(normalizeGameAssetTags([...tags, value])); setInput(""); setError(""); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "标签不合法。"); }
  };
  const readLatest = async () => {
    setBusy(true);
    try { setBase((await api.GetGameAsset(asset.token)).asset); setLatestLoaded(true); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "最新值暂时无法读取，请重试。"); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (busy || loading || loadError || projectArchived || base.maybe_archived_at || conflict && !latestLoaded) return;
    let next: string[];
    try { next = normalizeGameAssetTags(input ? [...tags, input] : tags); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "标签不合法。"); return; }
    const signature = tagSaveSignature(base, next);
    if (request.current?.signature !== signature) request.current = { signature, tags: next, revision: base.revision, key: crypto.randomUUID() };
    const pending = request.current;
    setBusy(true); setError("");
    try {
      await api.ReplaceGameAssetTags(asset.token, pending.tags, pending.revision, pending.key);
      // Idempotency may return a historical snapshot. Always fetch the current asset.
      const fresh = (await api.GetGameAsset(asset.token)).asset;
      onSaved(fresh); onClose();
    } catch (problem) {
      if (problem instanceof GameAssetsApiError && problem.status === 409) {
        request.current = undefined; setTags(next); setInput(""); setConflict(true); setLatestLoaded(false);
        setError(`${problem.message} 草稿已保留。核对最新标签后，点击重新保存才会提交草稿。`);
        try { setBase((await api.GetGameAsset(asset.token)).asset); setLatestLoaded(true); }
        catch { setError("保存发生冲突，草稿已保留。最新标签读取失败，请重试读取后再保存。"); }
      } else setError(problem instanceof Error ? problem.message : "保存结果尚未确认，请重试同一请求。");
    } finally { setBusy(false); }
  };
  const choices = [...new Set([...PRESET_ASSET_TAGS, ...suggestions.tags])].filter((tag) => !tags.includes(tag));
  const archived = projectArchived || !!base.maybe_archived_at;
  return <dialog ref={dialog} className="ga-creation-dialog ga-tag-dialog" aria-label="编辑资产标签" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><h2>{name} · 标签</h2><p>用于浏览与分组，最多 20 个；大小写不同的标签分别保留。</p></div><button type="button" className="ga-action" disabled={busy} onClick={onClose}>取消</button></header>
    <div className="ga-creation-scroll">
      {loading ? <p role="status">正在读取最新标签…</p> : loadError ? <button type="button" className="ga-action" onClick={() => setReadAttempt((value) => value + 1)}>重试读取标签</button> : <>
        {archived && <p className="ga-info">请先恢复归档项目或资产，再修改标签。</p>}
        <div className="ga-tag-chips">{tags.map((tag) => <button type="button" className="ga-tag-chip" key={tag} disabled={busy || archived} aria-label={`移除标签：${tag}`} onClick={() => setTags(tags.filter((value) => value !== tag))}>{tag} ×</button>)}{!tags.length && <span>未打标签</span>}</div>
        <form className="ga-inline-controls" onSubmit={(event) => { event.preventDefault(); add(input); }}><label className="ga-field">自定义标签<textarea rows={1} className="ga-tag-input" aria-label="自定义资产标签" value={input} disabled={busy || archived} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); add(input); } }} /></label><button type="submit" className="ga-action" disabled={busy || archived || !input}>添加标签</button></form>
        <div className="ga-tag-chips" aria-label="标签建议">{choices.map((tag) => <button type="button" key={tag} className="ga-tag-chip" disabled={busy || archived} onClick={() => add(normalizeGameAssetTag(tag))}>+ {tag}</button>)}</div>
        {(suggestions.hasMore || suggestions.error) && <button type="button" className="ga-action" disabled={suggestions.busy} onClick={() => void suggestions.loadMore()}>{suggestions.error ? "重试读取建议" : "加载更多项目标签"}</button>}
        <p className="ga-help">输入框中的文字也会随保存添加；清空会移除本资产全部标签。</p>
        <button type="button" className="ga-action" disabled={busy || archived} onClick={() => { setTags([]); setInput(""); setError(""); }}>清空全部标签</button>
        {conflict && <div className="ga-info"><p>你的草稿：{tags.join("、") || "未打标签"}</p><p>最新标签：{latestLoaded ? base.tags?.join("、") || "未打标签" : "尚未读取"}</p><button type="button" className="ga-action" disabled={busy} onClick={() => void readLatest()}>重新读取最新标签</button><button type="button" className="ga-action" disabled={busy || !latestLoaded} onClick={() => { setTags(base.tags ?? []); setInput(""); setConflict(false); request.current = undefined; }}>采用最新标签</button></div>}
      </>}
      {error && <p role="alert" className="ga-error">{error}</p>}
    </div>
    <footer><button type="button" className="ga-action ga-primary" disabled={busy || loading || loadError || archived || conflict && !latestLoaded} onClick={() => void save()}>{busy ? "正在保存…" : conflict ? "核对后重新保存草稿" : "保存标签"}</button></footer>
  </dialog>;
}
