import { afterEach, expect, it, vi } from "vitest";
import { GameAssetsApi, type StartCharacterMeshV2 } from "@storyteller/api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("posts start_v2 with one explicit authorization per paid native step", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ success: true, run_token: "run", asset_token: "asset" }));
  vi.stubGlobal("fetch", fetch);
  const input: StartCharacterMeshV2 = {
    plan_token: "plan", plan_hash_hex: "a".repeat(64), acknowledge_fees: true,
    fee_authorizations: [{ step_key: "mesh", quote_hash: "b".repeat(64), maximum_amount: null, accepts_uncapped_estimate: true }],
    idempotency_key: crypto.randomUUID(),
  };
  await expect(new GameAssetsApi().StartCharacterMeshV2("project", input)).resolves.toEqual({ success: true, run_token: "run", asset_token: "asset" });
  expect(String(fetch.mock.calls[0][0])).toContain("/v1/game_assets/projects/project/creations/start_v2");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
});

it("preserves the server rejection when fees were not acknowledged, without retrying", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ error: { code: "fee_authorization_required", message: "请明确确认每一步的费用范围与上限限制。" } }, 400));
  vi.stubGlobal("fetch", fetch);
  const input: StartCharacterMeshV2 = {
    plan_token: "plan", plan_hash_hex: "a".repeat(64), acknowledge_fees: false, fee_authorizations: [], idempotency_key: crypto.randomUUID(),
  };
  await expect(new GameAssetsApi().StartCharacterMeshV2("project", input)).rejects.toMatchObject({ code: "fee_authorization_required", status: 400 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

function response(payload: unknown, status = 200) { return { ok: status === 200, status, json: async () => payload }; }
