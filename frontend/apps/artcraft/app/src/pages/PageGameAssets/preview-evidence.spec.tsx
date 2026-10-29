import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameAssetsApi, type GameVersionDetailsV2 } from "@storyteller/api";
import { AnimatedVersionReview } from "./AnimatedVersionReview";
import { emptyPreviewEvidence, previewForReview, type PreviewEvidence } from "./preview-evidence";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it("requires actual rendering and every probe before enabling a separate human declaration", async () => {
  const api = new GameAssetsApi(), request = vi.spyOn(api, "ReviewGameVersionV2").mockResolvedValue({ success: true, version_token: "version", review_token: "review", decision: "passed", report_token: "report" });
  const detail = rigDetail(), changed = vi.fn(), props = { api, version: "version", sessionKey: "one", detail, evidence: { ...complete(), instantiated: false }, poseIds: ["bend", "twist"], supportsReview: true, supportsSelection: false, onRefresh: changed };
  const view = render(<AnimatedVersionReview {...props} />);
  expect((screen.getByLabelText("确认已实际检查本次预览") as HTMLInputElement).disabled).toBe(true);
  view.rerender(<AnimatedVersionReview {...props} evidence={{ ...complete(), diagnostic_poses: ["bend"] }} />);
  expect((screen.getByRole("button", { name: "记录审核通过" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<AnimatedVersionReview {...props} evidence={complete()} />);
  expect((screen.getByRole("button", { name: "记录审核通过" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("确认已实际检查本次预览"));
  fireEvent.click(screen.getByRole("button", { name: "记录审核通过" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0][1].preview_context).toMatchObject({ human_confirmed: true, instantiated: true, deformation_probe_confirmed: true, report_token: "report", loaded_artifact_tokens: ["main"] });
  expect(changed).toHaveBeenCalledTimes(1);
});

it("invalidates the human checkbox as soon as its report/session changes", () => {
  const api = new GameAssetsApi(), props = { api, version: "version", sessionKey: "one", detail: rigDetail(), evidence: complete(), poseIds: ["bend", "twist"], supportsReview: true, supportsSelection: false, onRefresh: vi.fn() };
  const view = render(<AnimatedVersionReview {...props} />);
  fireEvent.click(screen.getByLabelText("确认已实际检查本次预览"));
  view.rerender(<AnimatedVersionReview {...props} sessionKey="new-report" />);
  expect((screen.getByLabelText("确认已实际检查本次预览") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "记录审核通过" }) as HTMLButtonElement).disabled).toBe(true);
});

it("rejects unreadable assets without fabricating a successful preview", async () => {
  const api = new GameAssetsApi(), request = vi.spyOn(api, "ReviewGameVersionV2").mockResolvedValue({ success: true, version_token: "version", review_token: "review", decision: "rejected", report_token: null });
  render(<AnimatedVersionReview api={api} version="version" sessionKey="failed" detail={null} evidence={emptyPreviewEvidence()} poseIds={[]} supportsReview supportsSelection={false} onRefresh={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("角色与动画审核说明"), { target: { value: "无法解析角色骨架" } });
  fireEvent.click(screen.getByRole("button", { name: "记录需要修改" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0][1]).toMatchObject({ decision: "rejected", maybe_rejection_kind: "technical_quality", maybe_reason: "无法解析角色骨架" });
  expect(request.mock.calls[0][1].preview_context).toBeUndefined();
});

it("recovers the same uncertain review request after unmount without another human declaration", async () => {
  const api = new GameAssetsApi(), request = vi.spyOn(api, "ReviewGameVersionV2").mockRejectedValueOnce(new Error("response unknown")).mockResolvedValueOnce({ success: true, version_token: "version", review_token: "review", decision: "passed", report_token: "report" });
  const props = { api, version: "version", sessionKey: "one", detail: rigDetail(), evidence: complete(), poseIds: ["bend", "twist"], supportsReview: true, supportsSelection: false, onRefresh: vi.fn() };
  const first = render(<AnimatedVersionReview {...props} />);
  fireEvent.click(screen.getByLabelText("确认已实际检查本次预览")); fireEvent.click(screen.getByRole("button", { name: "记录审核通过" }));
  await screen.findByText("response unknown"); const original = JSON.parse(JSON.stringify(request.mock.calls[0][1]));
  first.unmount(); render(<AnimatedVersionReview {...props} evidence={emptyPreviewEvidence()} sessionKey="new-renderer" />);
  fireEvent.click(screen.getByRole("button", { name: "确认原请求结果" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(JSON.parse(JSON.stringify(request.mock.calls[1][1]))).toEqual(original);
  await waitFor(() => expect(localStorage.getItem("ga_pending_version_write:version")).toBeNull());
});

it("requires each direction's natural playback and loop, and never promotes missing render flags", () => {
  const detail = rigDetail(); detail.asset.kind = "anim_2d";
  detail.preview_contract = { ...detail.preview_contract, required_directions: ["front", "back"], requires_deformation_probe: false, requires_instantiation: false, requires_playback: true, requires_loop_check: true };
  const evidence = { ...emptyPreviewEvidence(), decoded: true, playback_observed: true, loaded_artifact_tokens: ["main"], checked_directions: ["front", "back"], looped_directions: ["front"] };
  expect(previewForReview(detail, evidence, []).preview).toBeNull();
  const completed = previewForReview(detail, { ...evidence, looped_directions: ["front", "back"] }, []).preview!;
  expect(completed.loop_checked).toBe(true); expect(completed.human_confirmed).toBe(false); expect(completed.instantiated).toBe(false);
});

function complete(): PreviewEvidence { return { ...emptyPreviewEvidence(), decoded: true, instantiated: true, loaded_artifact_tokens: ["main"], diagnostic_poses: ["bend", "twist"] }; }
function rigDetail(): GameVersionDetailsV2 {
  return { success: true, asset: { token: "asset", project_token: "project", kind: "character_3d", revision: 1, maybe_archived_at: null }, version: { token: "version" }, dependencies: [],
    gate: { technical_state: "passed", file_contract_complete: true, dependencies_valid: true, can_select: false, review_state: "not_reviewed", context: { version_token: "version", artifact_set_hash: "a".repeat(64), spec_hash: "b".repeat(64), profile_hash: "c".repeat(64), dependency_snapshot_hash: "d".repeat(64), validator_version: "rig-check" }, latest_report_token: "report" },
    preview_contract: { version: "rig-preview", artifact_tokens: ["main"], rig_version_token: null, required_directions: [], required_views: [], requires_instantiation: true, requires_animation_binding: false, requires_playback: false, requires_loop_check: false, requires_deformation_probe: true } } as unknown as GameVersionDetailsV2;
}
