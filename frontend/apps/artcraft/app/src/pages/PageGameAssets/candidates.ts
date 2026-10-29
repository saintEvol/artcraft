import type { GameAssetVersionInfo } from "@storyteller/api";

export interface AssetCandidate<T extends GameAssetVersionInfo = GameAssetVersionInfo> {
  key: string;
  number: number;
  version: T;
  files: T[];
}

/** A source, its cutout and its final file are one creative candidate.
 * All immutable versions remain reachable in that candidate's history.
 */
export function assetCandidates<T extends GameAssetVersionInfo>(versions: T[]): AssetCandidate<T>[] {
  const byToken = new Map(versions.map((version) => [version.token, version]));
  const groups = new Map<string, T[]>();
  for (const version of [...versions].sort((a, b) => a.version - b.version)) {
    let identity: GameAssetVersionInfo = version;
    // A mesh realizes the selected concept; it is not a second design.
    if (["mesh", "rig"].includes(String(version.spec_json.operation))) {
      let parent = version.maybe_parent_version_token;
      const visited = new Set<string>([version.token]);
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        const source = byToken.get(parent);
        if (!source || source.asset_token !== version.asset_token) break;
        if (source.spec_json.stage === "concept") { identity = source; break; }
        parent = source.maybe_parent_version_token;
      }
    }
    const step = identity.spec_json.creation_step_token;
    const key = typeof step === "string" && step ? `asset:${version.asset_token}:step:${step}` : `version:${identity.token}`;
    groups.set(key, [...(groups.get(key) ?? []), version]);
  }
  return [...groups.entries()].map(([key, files], index) => ({
    key, number: index + 1,
    version: [...files].sort((a, b) => stageRank(b) - stageRank(a) || b.version - a.version)[0],
    files: [...files].sort((a, b) => b.version - a.version),
  })).reverse();
}

export function candidateLabel(candidate: AssetCandidate<GameAssetVersionInfo & { gate?: { reviewState: string } }>): string {
  const stage = candidate.version.spec_json.stage;
  const review = candidate.version.gate?.reviewState;
  const concept = review === "passed" ? "概念已确认" : review === "rejected" ? "概念需修改" : review ? "概念待确认" : "概念图";
  return `候选 ${candidate.number}${stage === "concept" ? ` · ${concept}` : stage === "source" || stage === "cutout" ? " · 待完成加工" : ""}`;
}

function stageRank(version: GameAssetVersionInfo): number {
  return ({ animation: 6, rigged: 6, mesh: 5, asset: 4, concept: 3, cutout: 2, source: 1 } as Record<string, number>)[String(version.spec_json.stage)] ?? 4;
}
