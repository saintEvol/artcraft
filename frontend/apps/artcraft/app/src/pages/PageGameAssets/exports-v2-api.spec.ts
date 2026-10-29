import { afterEach, expect, it, vi } from "vitest";
import {
  conflictLines,
  exportsV2Available,
  GameAssetsApi,
  GameAssetsApiError,
  kindExportsV2Enabled,
  parseRigConflicts,
  type GameAssetsCapabilities,
} from "@storyteller/api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("prepares, commits and reads the exports-v2 closure over the new routes", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(response({ success: true, preparation_token: "prep", selections: [], closure_hash: "a".repeat(64) }))
    .mockResolvedValueOnce(response({ success: true, exports: [{ token: "exp", status: "pending" }], manifest_schema_version: "2.0", closure_hash: "a".repeat(64) }))
    .mockResolvedValueOnce(response({ success: true, export: { token: "exp", status: "succeeded" }, manifest_schema_version: "2.0", selection: { assets: [] } }));
  vi.stubGlobal("fetch", fetch);
  const api = new GameAssetsApi();
  await api.PrepareGameExportV2("project", { idempotency_key: "key", selections: [{ asset_token: "asset", version_token: "version" }] });
  await api.CreateGameExportV2("project", { idempotency_key: "key", preparation_token: "prep", export_kinds: ["generic"] });
  await api.GetGameExportDetailsV2("exp");
  expect(String(fetch.mock.calls[0][0])).toContain("/projects/project/exports/prepare_v2");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ idempotency_key: "key", selections: [{ asset_token: "asset", version_token: "version" }] });
  expect(String(fetch.mock.calls[1][0])).toContain("/projects/project/exports/create_v2");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ idempotency_key: "key", preparation_token: "prep", export_kinds: ["generic"] });
  expect(String(fetch.mock.calls[2][0])).toContain("/exports/exp/details_v2");
});

it("exposes rig conflicts and their introducers from the error envelope", () => {
  const error = new GameAssetsApiError("同一角色被要求两个不同版本", 409, "rig_version_conflict", false, {
    conflicts: [
      {
        code: "rig_version_conflict", asset_token: "hero", stable_key: "hero", display_name: "Hero",
        requested_versions: [
          { version_token: "v2", version: 2, explicit: true, required_by: [] },
          { version_token: "v1", version: 1, explicit: false, required_by: ["spin"] },
        ],
      },
      { code: "other" },
    ],
  });
  const conflicts = parseRigConflicts(error.details);
  expect(conflicts).toHaveLength(1);
  const lines = conflictLines(conflicts[0]);
  expect(lines[0]).toContain("第 2 版");
  expect(lines[0]).toContain("本次显式选择");
  expect(lines[1]).toContain("第 1 版");
  expect(lines[1]).toContain("由动画依赖引入");
  expect(parseRigConflicts(undefined)).toEqual([]);
});

it("gates the v2 entry on the delivered manifest schema versions and per-kind registration", () => {
  const closed: GameAssetsCapabilities = { ...baseCapabilities(), supported_manifest_schema_versions: ["1.1"] };
  const open: GameAssetsCapabilities = {
    ...baseCapabilities(),
    supported_manifest_schema_versions: ["1.1", "2.0"],
    kind_capabilities: { anim_3d: { operations: { export_v2: { enabled: true } } } },
  };
  expect(exportsV2Available(closed)).toBe(false);
  expect(exportsV2Available(open)).toBe(true);
  expect(exportsV2Available(null)).toBe(false);
  expect(kindExportsV2Enabled(open, "anim_3d")).toBe(true);
  expect(kindExportsV2Enabled(open, "character_3d")).toBe(false);
  expect(kindExportsV2Enabled(closed, "anim_3d")).toBe(false);
});

function baseCapabilities(): GameAssetsCapabilities {
  return {
    success: true, api_version: "game_assets.v1", manifest_schema_version: "1.1",
    asset_kinds: [], pipelines: [], export_targets: [], max_page_size: 100,
  };
}
function response(payload: unknown, status = 200) { return { ok: status === 200, status, json: async () => payload }; }
