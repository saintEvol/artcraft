import { afterEach, expect, it, vi } from "vitest";
import { GameAssetsApi, type GamePreviewContextV2 } from "@storyteller/api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("sends explicit preview observations without turning load into human or deformation confirmation", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ success: true })); vi.stubGlobal("fetch", fetch);
  const preview = context();
  const input = { idempotency_key: "same-key", decision: "passed" as const, preview_context: preview };
  await new GameAssetsApi().ReviewGameVersionV2("version", input);
  expect(String(fetch.mock.calls[0][0])).toContain("/versions/version/reviews_v2");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
  expect(preview.human_confirmed).toBe(false); expect(preview.deformation_probe_confirmed).toBe(false);
});

it("keeps report/review/check/revision identities on the selection_v2 route", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ success: true })); vi.stubGlobal("fetch", fetch);
  const input = { idempotency_key: "key", expected_revision: 12, version_token: "old-version", check: { ...context().check, version_token: "old-version" }, report_token: "report", review_token: "review" };
  await new GameAssetsApi().SelectGameVersionV2("asset", input);
  expect(String(fetch.mock.calls[0][0])).toContain("/assets/asset/selection_v2");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
});

it("records rejection without successful preview and preserves a conflict without retrying", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ success: true }))
    .mockResolvedValueOnce(response({ success: false, error: { code: "preview_context_mismatch", message: "请刷新固定版本", retryable: false, details: { latest_report_token: "new-report" } } }, 409));
  vi.stubGlobal("fetch", fetch);
  const api = new GameAssetsApi();
  await api.ReviewGameVersionV2("version", { idempotency_key: "reject", decision: "rejected", maybe_rejection_kind: "technical_quality", maybe_reason: "蒙皮不正确" });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("preview_context");
  await expect(api.ReviewGameVersionV2("version", { idempotency_key: "pass", decision: "passed", preview_context: context() })).rejects.toMatchObject({ code: "preview_context_mismatch", details: { latest_report_token: "new-report" } });
  expect(fetch).toHaveBeenCalledTimes(2);
});

function context(): GamePreviewContextV2 {
  return { check: { version_token: "version", artifact_set_hash: "a".repeat(64), spec_hash: "b".repeat(64), profile_hash: "c".repeat(64), dependency_snapshot_hash: "d".repeat(64), validator_version: "game.validate.character3d.rig.v1" }, report_token: "report", preview_contract_version: "game.preview.character3d.rig.v1", loaded_artifact_tokens: ["main"], rig_version_token: null, decoded: true, instantiated: false, animation_bound: false, playback_observed: false, human_confirmed: false, checked_directions: [], checked_views: [], loop_checked: false, deformation_probe_confirmed: false };
}
function response(payload: unknown, status = 200) { return { ok: status === 200, status, json: async () => payload }; }
