import { afterEach, expect, it, vi } from "vitest";
import { GameAssetsApi, readAllRunStepsV2, type GameRunDetailsV2, type GameRunStepV2 } from "@storyteller/api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reads all 120 steps using opaque cursors and retains an honest status projection", async () => {
  const steps = Array.from({ length: 120 }, (_, index) => step(index));
  const cursor = "steps.v2:run:9007199254740999";
  const get = vi.fn().mockResolvedValueOnce(page(steps.slice(0, 100), cursor))
    .mockResolvedValueOnce({ ...page(steps.slice(100), null), run: { ...page([], null).run, status: "succeeded" } });
  const all = await readAllRunStepsV2("run", get);
  expect(all.steps).toHaveLength(120);
  expect(all.run.status).toBe("running");
  expect(all.steps_has_more).toBe(false);
  expect(get).toHaveBeenNthCalledWith(2, cursor);
});

it("rejects duplicate steps, wrong task scope and repeated pagination without returning partial success", async () => {
  const duplicate = vi.fn().mockResolvedValueOnce(page([step(0)], "next")).mockResolvedValueOnce(page([step(0)], null));
  await expect(readAllRunStepsV2("run", duplicate)).rejects.toThrow(/重复/);
  const wrong = page([step(0)], null); wrong.run.token = "other";
  await expect(readAllRunStepsV2("run", async () => wrong)).rejects.toThrow(/同一任务/);
  const repeated = vi.fn().mockResolvedValueOnce(page([step(0)], "next")).mockResolvedValueOnce(page([step(1)], "next"));
  await expect(readAllRunStepsV2("run", repeated)).rejects.toThrow(/无法继续/);
  await expect(readAllRunStepsV2("run", async () => page([], "next"))).rejects.toThrow(/无法继续/);
  await expect(readAllRunStepsV2("run", async () => page([step(0)], null), () => true)).rejects.toThrow(/取消/);
});

it("calls the explicit v2 operations with exact mapping and required idempotency keys", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ success: true }));
  vi.stubGlobal("fetch", fetch);
  const api = new GameAssetsApi();
  await api.CreateGameAssetV2("project", { kind: "character_3d", stable_key: "hero", idempotency_key: "create-key" });
  const input = { upload_token: "upload", profile_token: "profile", expected_revision: 7, semantic_bones: { hips: ["Hero", "Left", "Hip"] }, motion_root_path: ["Hero"], idempotency_key: "import-key" };
  await api.ImportRiggedCharacterV2("asset", input);
  await api.ControlGameRunV2("run", "cancel", "cancel-key");
  await api.ControlGameRunV2("run", "continue", "continue-key");
  await api.ValidateGameVersionV2("version", "check-key");
  expect(String(fetch.mock.calls[0][0])).toContain("/projects/project/assets/create_v2");
  expect(String(fetch.mock.calls[1][0])).toContain("/assets/asset/versions/from-upload_v2");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(input);
  expect(String(fetch.mock.calls[2][0])).toContain("/runs/run/cancel_v2");
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ idempotency_key: "cancel-key" });
  expect(String(fetch.mock.calls[3][0])).toContain("/creations/run/continue_v2");
  expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ idempotency_key: "continue-key" });
  expect(String(fetch.mock.calls[4][0])).toContain("/versions/version/validations_v2");
  expect(JSON.parse(fetch.mock.calls[4][1].body)).toEqual({ idempotency_key: "check-key" });
});

it("preserves recovery errors and never retries an uncertain mutation automatically", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ success: false, error: { code: "run_changed", message: "请查询原任务", retryable: true, details: { authorizes_new_submission: false } } }, 409));
  vi.stubGlobal("fetch", fetch);
  await expect(new GameAssetsApi().ControlGameRunV2("run", "continue", "key")).rejects.toMatchObject({ code: "run_changed", details: { authorizes_new_submission: false } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

function step(index: number): GameRunStepV2 {
  return { token: `step_${index}`, maybe_asset_token: "asset", kind: "character_import_v2", status: "running", step_key: `frame_${index}`, maybe_direction: null, maybe_frame_index: index, maybe_latest_attempt: null };
}
function page(steps: GameRunStepV2[], cursor: string | null): GameRunDetailsV2 {
  return { success: true, run: { token: "run", project_token: "project", status: "running", recipe: "game_validation.v2", revision: 1, cancel_requested: false, budget_limit: 0, reserved_cost: 0, settled_cost: 0 }, steps, steps_next_cursor: cursor, steps_has_more: cursor !== null };
}
function response(payload: unknown, status = 200) { return { ok: status === 200, status, json: async () => payload }; }
