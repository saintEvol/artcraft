import { useRef, useState } from "react";
import { GameAssetsApiError, normalizeGameAssetTags, type GameAssetsApi, type GameAssetInfo } from "@storyteller/api";
import { tagSaveSignature } from "./asset-tags";

interface Props {
  api: GameAssetsApi;
  asset: GameAssetInfo;
  name: string;
  projectArchived: boolean;
  onSaved: (asset: GameAssetInfo) => void;
}

/** Name-derived tag suggestions for character assets. Saving reuses the
 * existing tags write with its signature-keyed retry; failures are shown
 * inline and never block the surrounding page. */
export function CharacterTagSuggest({ api, asset, name, projectArchived, onSaved }: Props) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ signature: string; tags: string[]; revision: number; key: string } | undefined>(undefined);
  const suggestions = characterTagNameSuggestions(asset);
  const save = async () => {
    if (busy || !suggestions.length) return;
    setError("");
    let next: string[];
    try { next = normalizeGameAssetTags([...(asset.tags ?? []), ...picked]); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "标签不合法。"); return; }
    const signature = tagSaveSignature(asset, next);
    if (request.current?.signature !== signature) request.current = { signature, tags: next, revision: asset.revision, key: crypto.randomUUID() };
    setBusy(true);
    try {
      await api.ReplaceGameAssetTags(asset.token, request.current.tags, request.current.revision, request.current.key);
      // Idempotency may return a historical snapshot. Always fetch the current asset.
      const fresh = (await api.GetGameAsset(asset.token)).asset;
      request.current = undefined; setPicked([]);
      onSaved(fresh);
    } catch (problem) {
      if (problem instanceof GameAssetsApiError && problem.status === 409) request.current = undefined;
      setError(problem instanceof Error ? problem.message : "保存结果尚未确认，请重试同一请求。");
    } finally { setBusy(false); }
  };
  if (!suggestions.length) return null;
  return <section className="ga-tag-suggest" aria-label="名称标签建议">
    <h3>名称标签建议</h3>
    <p className="ga-help">按“{name}”的名称给出可选标签；保存只是写标签，不影响制作与交付。</p>
    <div className="ga-tag-chips">{suggestions.map((tag) => <button type="button" key={tag} className="ga-tag-chip" disabled={busy || projectArchived}
      aria-pressed={picked.includes(tag)} onClick={() => setPicked((old) => old.includes(tag) ? old.filter((value) => value !== tag) : [...old, tag])}>
      {picked.includes(tag) ? `${tag} ✓` : `+ ${tag}`}</button>)}</div>
    <button type="button" className="ga-action" disabled={busy || projectArchived || !picked.length} onClick={() => void save()}>{busy ? "正在保存…" : "保存所选标签"}</button>
    {error && <p role="alert" className="ga-error">{error}</p>}
  </section>;
}

/** Deterministic, client-only suggestions: the character preset plus the
 * meaningful name words. Existing tags are never re-suggested. */
export function characterTagNameSuggestions(asset: Pick<GameAssetInfo, "stable_key" | "tags">): string[] {
  const existing = new Set(asset.tags ?? []);
  const words = asset.stable_key.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((word) => word.length >= 2 && word.length <= 24);
  return [...new Set(["角色", ...words])].filter((tag) => !existing.has(tag)).slice(0, 6);
}
