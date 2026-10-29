import { describe, expect, it } from "vitest";
import type { GameAssetVersionInfo } from "@storyteller/api";
import { assetCandidates } from "./candidates";

describe("creative candidates", () => {
  it("keeps different paid candidates distinct while folding their processing files", () => {
    const versions = [v(6, "asset", "b"), v(5, "cutout", "b"), v(4, "asset", "a"),
      v(3, "cutout", "a"), v(2, "source", "b"), v(1, "source", "a")];
    const groups = assetCandidates(versions);
    expect(groups.map((group) => [group.number, group.version.version, group.files.length])).toEqual([[2, 6, 3], [1, 4, 3]]);
    expect(groups.flatMap((group) => group.files).map((version) => version.token).sort()).toEqual(versions.map((version) => version.token).sort());
  });

  it("retains an unfinished candidate, and realizes a concept as the same design", () => {
    const concept = v(1, "concept", "concept");
    const source = { ...v(2, "source", "mesh"), maybe_parent_version_token: concept.token, spec_json: { ...v(2, "source", "mesh").spec_json, operation: "mesh" } };
    const model = { ...v(3, "asset", "mesh"), maybe_parent_version_token: source.token, spec_json: { ...v(3, "asset", "mesh").spec_json, operation: "mesh" } };
    const groups = assetCandidates([model, source, concept, v(4, "source", "new")]);
    expect(groups.map((group) => [group.version.version, group.files.length])).toEqual([[4, 1], [3, 3]]);
  });
});

function v(version: number, stage: string, step: string): GameAssetVersionInfo {
  return { token: `version_${version}`, asset_token: "asset", version, maybe_parent_version_token: null,
    profile_token: "profile", spec_json: { stage, creation_step_token: step }, created_by: "owner", created_at: "2026-10-27" };
}
