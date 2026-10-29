import { useEffect, useRef, useState } from "react";
import { normalizeGameAssetTags, type GameAssetsApi, type GameAssetInfo } from "@storyteller/api";

export const PRESET_ASSET_TAGS = ["物品", "技能", "货币", "状态", "场景", "怪物", "建筑"];

export function useProjectTagSuggestions(api: GameAssetsApi, project: string, enabled: boolean, revision = 0) {
  const [tags, setTags] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const pending = useRef(false);
  const load = async (next?: string, requestEpoch = epoch.current) => {
    if (pending.current || !enabled) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const page = await api.ListProjectAssetTags(project, { maybe_cursor: next, maybe_limit: 50 });
      if (requestEpoch !== epoch.current) return;
      setTags((old) => [...new Set([...(next ? old : []), ...page.items])]);
      setCursor(page.next_cursor);
    } catch (problem) { if (requestEpoch === epoch.current) setError(problem instanceof Error ? problem.message : "项目标签暂时无法读取。"); }
    finally { if (requestEpoch === epoch.current) { pending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    const current = ++epoch.current;
    pending.current = false; setTags([]); setCursor(null); setError(""); setBusy(false);
    if (enabled) void load(undefined, current);
    return () => { epoch.current++; };
    // Project, capability and successful metadata/lifecycle writes reset paging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project, enabled, revision]);
  return { tags, busy, error, hasMore: cursor !== null, loadMore: () => load(cursor ?? undefined) };
}

export function groupAssetsByTag<T extends Pick<GameAssetInfo, "token" | "tags">>(assets: T[]): { tag: string | null; assets: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const asset of uniqueAssets(assets)) {
    const tags = asset.tags?.length ? asset.tags : [null];
    for (const tag of new Set(tags)) groups.set(tag, [...(groups.get(tag) ?? []), asset]);
  }
  return [...groups].map(([tag, members]) => ({ tag, assets: members }));
}

export function uniqueAssets<T extends { token: string }>(assets: T[]): T[] {
  return [...new Map(assets.map((asset) => [asset.token, asset])).values()];
}

/** A retry retains the exact body and key until content or revision changes. */
export function tagSaveSignature(asset: GameAssetInfo, tags: string[]): string {
  return JSON.stringify([asset.token, asset.revision, normalizeGameAssetTags(tags)]);
}
