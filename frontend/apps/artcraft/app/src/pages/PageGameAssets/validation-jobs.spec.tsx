import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameAssetsApi, GameAssetsApiError, type GameRunInfoV2, type GameVersionDetailsV2 } from "@storyteller/api";
import { ValidationJobs } from "./ValidationJobs";
import { SettingsPanel } from "./SettingsPanel";
import { RECOMMENDED_SETTINGS } from "./profile";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it("discovers server jobs, follows opaque pages and displays every returned direction/frame", async () => {
  const api = new GameAssetsApi(), first = run("first"), second = run("second");
  const list = vi.spyOn(api, "ListGameRunsV2").mockResolvedValueOnce({ success: true, items: [first], next_cursor: "runs.v2:project:9007199254740999", has_more: true })
    .mockResolvedValueOnce({ success: true, items: [second], next_cursor: null, has_more: false });
  vi.spyOn(api, "GetCompleteGameRunDetailsV2").mockResolvedValue({ success: true, run: first, steps: Array.from({ length: 120 }, (_, index) => ({ token: `step_${index}`, maybe_asset_token: "asset", kind: "validate_v2", status: "succeeded", step_key: `frame_${index}`, maybe_direction: "front", maybe_frame_index: index, maybe_latest_attempt: null })), steps_next_cursor: null, steps_has_more: false });
  render(<ValidationJobs api={api} project="project" refreshKey={0} supportsRuns canStart={false} onVersions={vi.fn()} onPreview={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /first/ }));
  expect(await screen.findByText(/方向 front · 帧 119/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "更多任务" }));
  expect(await screen.findByRole("button", { name: /second/ })).toBeTruthy();
  expect(list).toHaveBeenNthCalledWith(2, "project", "runs.v2:project:9007199254740999");
  expect(screen.queryByRole("button", { name: "更多任务" })).toBeNull();
});

it("retains a required key across an uncertain recheck and never retries the mutation automatically", async () => {
  const api = new GameAssetsApi();
  vi.spyOn(api, "ListGameRunsV2").mockResolvedValue({ success: true, items: [], next_cursor: null, has_more: false });
  vi.spyOn(api, "GetCompleteGameAssetVersionDetailsV2").mockResolvedValue({ asset: { project_token: "project" }, gate: { technical_state: "passed", latest_report_token: "old-report" } } as GameVersionDetailsV2);
  const start = vi.spyOn(api, "ValidateGameVersionV2").mockRejectedValueOnce(new Error("unknown response")).mockResolvedValueOnce({ success: true, run_token: "run", asset_token: "asset", maybe_version_token: "version", supplier_calls: 0 });
  vi.spyOn(api, "GetCompleteGameRunDetailsV2").mockResolvedValue({ success: true, run: run("run"), steps: [], steps_next_cursor: null, steps_has_more: false });
  render(<ValidationJobs api={api} project="project" version="version" refreshKey={0} supportsRuns canStart onVersions={vi.fn()} onPreview={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "免费重新检查此版本" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "unknown response");
  expect(start).toHaveBeenCalledTimes(1);
  const key = start.mock.calls[0][1];
  expect(localStorage.getItem("ga_pending_rig_check:project:version")).toBe(key);
  fireEvent.click(screen.getByRole("button", { name: "免费重新检查此版本" }));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(start.mock.calls[1]).toEqual(["version", key]);
  await waitFor(() => expect(localStorage.getItem("ga_pending_rig_check:project:version")).toBeNull());
});

it("does not guess a run API when the server lacks its read capability", () => {
  const api = new GameAssetsApi(), list = vi.spyOn(api, "ListGameRunsV2");
  render(<ValidationJobs api={api} project="project" refreshKey={0} supportsRuns={false} canStart={false} onVersions={vi.fn()} onPreview={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "角色检查与制作任务" })).toBeNull();
  expect(list).not.toHaveBeenCalled();
});

it("imports explicit animation spec blocks and preserves unrelated blocks on save", async () => {
  const save = vi.fn().mockResolvedValue(undefined), previous = { anim_2d: { canvas: 64 } }, imported = { character_3d: { target_height_m: 1.8, rig_profile: { id: "chosen_rig" } } };
  render(<SettingsPanel initial={RECOMMENDED_SETTINGS} initialAnimationSpecs={previous} onSave={save} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "角色与动画" }));
  const file = new File([JSON.stringify(imported)], "profile.json"); Object.defineProperty(file, "text", { value: async () => JSON.stringify(imported) });
  fireEvent.change(screen.getByLabelText("角色与动画规格 JSON"), { target: { files: [file] } });
  await screen.findByText(/character_3d · 已提供专用规格/);
  fireEvent.click(screen.getByRole("button", { name: "保存并用于后续制作" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][2]).toEqual({ ...previous, ...imported });
});

it("does not save an invalid spec file while silently keeping older settings", async () => {
  const save = vi.fn();
  render(<SettingsPanel initial={RECOMMENDED_SETTINGS} onSave={save} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "角色与动画" }));
  const file = new File(['{"wrong":{}}'], "wrong.json"); Object.defineProperty(file, "text", { value: async () => '{"wrong":{}}' });
  fireEvent.change(screen.getByLabelText("角色与动画规格 JSON"), { target: { files: [file] } });
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "保存并用于后续制作" }) as HTMLButtonElement).disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

it("presents paid creation steps with submission states and preserved results", async () => {
  const api = new GameAssetsApi(), run = creationRun("paid", "partial_success");
  vi.spyOn(api, "ListGameRunsV2").mockResolvedValue({ success: true, items: [run], next_cursor: null, has_more: false });
  vi.spyOn(api, "GetCompleteGameRunDetailsV2").mockResolvedValue({ success: true, run, steps: [
    { token: "mesh_done", maybe_asset_token: "asset", kind: "character_mesh_v2", status: "succeeded", step_key: "character:asset:candidate:0:mesh", maybe_direction: null, maybe_frame_index: null,
      maybe_latest_attempt: { token: "attempt", execution_token: "execution", status: "succeeded", submission_phase: "submitted", maybe_result: { version_token: "mesh_version" }, maybe_error: null } },
    { token: "mesh_unknown", maybe_asset_token: null, kind: "character_mesh_v2", status: "running", step_key: "character:asset:candidate:0:mesh", maybe_direction: null, maybe_frame_index: null,
      maybe_latest_attempt: { token: "attempt2", execution_token: "execution2", status: "submitting", submission_phase: "submitting", maybe_result: null, maybe_error: null } },
    { token: "mesh_reconciling", maybe_asset_token: null, kind: "character_mesh_v2", status: "reconciling", step_key: "character:asset:candidate:0:mesh", maybe_direction: null, maybe_frame_index: null,
      maybe_latest_attempt: { token: "attempt3", execution_token: "execution3", status: "submitting", submission_phase: "submitting", maybe_result: null, maybe_error: null } },
    { token: "mesh_queued", maybe_asset_token: null, kind: "character_mesh_v2", status: "queued", step_key: "character:asset:candidate:0:mesh", maybe_direction: null, maybe_frame_index: null, maybe_latest_attempt: null },
  ], steps_next_cursor: null, steps_has_more: false });
  render(<ValidationJobs api={api} project="project" refreshKey={0} supportsRuns canStart={false} onVersions={vi.fn()} onPreview={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /paid/ }));
  expect(await screen.findByText(/供应商提交：提交结果未知，需对账，不自动重发/)).toBeTruthy();
  expect(screen.getByText(/供应商提交：正在对账，不自动重发/)).toBeTruthy();
  expect(screen.getByText(/供应商提交：排队等待提交/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "查看已保存结果" })).toBeTruthy();
  expect(screen.getByText(/此任务按供应商账号计费/)).toBeTruthy();
});

it("surfaces the server refusal for paid-run control without swallowing it", async () => {
  const api = new GameAssetsApi(), run = creationRun("paid", "action_required");
  vi.spyOn(api, "ListGameRunsV2").mockResolvedValue({ success: true, items: [run], next_cursor: null, has_more: false });
  vi.spyOn(api, "GetCompleteGameRunDetailsV2").mockResolvedValue({ success: true, run, steps: [], steps_next_cursor: null, steps_has_more: false });
  const control = vi.spyOn(api, "ControlGameRunV2").mockRejectedValue(new GameAssetsApiError("此控制入口当前支持免费的 game_validation.v2 任务；不能用它重新提交收费请求。", 422, "unsupported_operation"));
  render(<ValidationJobs api={api} project="project" refreshKey={0} supportsRuns canStart={false} onVersions={vi.fn()} onPreview={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /paid/ }));
  fireEvent.click(await screen.findByRole("button", { name: "继续查询与处理" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "此控制入口当前支持免费的 game_validation.v2 任务；不能用它重新提交收费请求。");
  expect(control).toHaveBeenCalledTimes(1);
});

function run(token: string): GameRunInfoV2 { return { token, project_token: "project", recipe: "game_validation.v2", status: "succeeded", revision: 1, cancel_requested: false, budget_limit: 0, reserved_cost: 0, settled_cost: 0 }; }
function creationRun(token: string, status: string): GameRunInfoV2 { return { ...run(token), recipe: "game_creation.v2", status }; }
