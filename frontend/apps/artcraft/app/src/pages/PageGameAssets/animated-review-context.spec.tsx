import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GameAssetsApi, type GameVersionDetailsV2 } from "@storyteller/api";
import { AnimatedAssetPreview } from "./AnimatedAssetPreview";
import type { MeshPreviewObservation } from "./MeshPreview";

const callbacks = vi.hoisted(() => [] as ((observation: MeshPreviewObservation) => void)[]);
vi.mock("./MeshPreview", () => ({ MeshPreview: ({ onObservation }: { onObservation: (value: MeshPreviewObservation) => void }) => {
  callbacks.push(onObservation);
  return <button type="button" onClick={() => onObservation({ decoded: true, instantiated: true, animation_bound: false, playback_observed: false, loop_checked: false, checked_views: [], diagnostic_poses: ["engineering_bend"], error: null })}>模拟渲染事件</button>;
} }));
beforeEach(() => { callbacks.length = 0; });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it("drops old-renderer observations after a new report even when all file IDs stay unchanged", async () => {
  const api = new GameAssetsApi(), a = detail("report-a"), b = detail("report-b");
  const read = vi.spyOn(api, "GetCompleteGameAssetVersionDetailsV2").mockResolvedValueOnce(a).mockResolvedValueOnce(b);
  vi.spyOn(api, "DownloadVersionFileV2").mockResolvedValue(new Blob(["verified file"]));
  const write = vi.spyOn(api, "ReviewGameVersionV2").mockResolvedValue({ success: true, version_token: "version", review_token: "review", decision: "passed", report_token: "report-b" });
  const props = { api, project: "project", version: a.version, kind: "character_3d" as const, supportsDetailsV2: true, supportsReviewV2: true, onChanged: vi.fn() };
  const view = render(<AnimatedAssetPreview {...props} refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: "模拟渲染事件" }));
  fireEvent.click(screen.getByLabelText("确认已实际检查本次预览"));
  const old = callbacks.at(-1)!;
  view.rerender(<AnimatedAssetPreview {...props} refreshKey={1} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2)); await screen.findByRole("button", { name: "模拟渲染事件" });
  await act(async () => old({ decoded: true, instantiated: true, animation_bound: false, playback_observed: false, loop_checked: false, checked_views: [], diagnostic_poses: ["engineering_bend"], error: null }));
  expect((screen.getByLabelText("确认已实际检查本次预览") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "模拟渲染事件" }));
  expect((screen.getByLabelText("确认已实际检查本次预览") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText("确认已实际检查本次预览")); fireEvent.click(screen.getByRole("button", { name: "记录审核通过" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(write.mock.calls[0][1].preview_context?.report_token).toBe("report-b");
});

function detail(report: string): GameVersionDetailsV2 {
  const metadata = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../../test_data/game_assets/character_animation/rig_probe_metadata.json"), "utf8"));
  return { success: true, asset: { token: "asset", project_token: "project", kind: "character_3d", revision: 1, maybe_archived_at: null }, version: { token: "version", asset_token: "asset", version: 1, spec_json: { stage: "rigged", rig_metadata: metadata } }, stage: "rigged", dependencies: [], files: [{ role: "main", ordinal: 0, artifact_token: "main" }],
    gate: { technical_state: "passed", file_contract_complete: true, dependencies_valid: true, review_state: "not_reviewed", can_select: false, context: { version_token: "version", artifact_set_hash: "a".repeat(64), spec_hash: "b".repeat(64), profile_hash: "c".repeat(64), dependency_snapshot_hash: "d".repeat(64), validator_version: "rig-check" }, latest_report_token: report },
    preview_contract: { version: "rig-preview", artifact_tokens: ["main"], rig_version_token: null, required_directions: [], required_views: [], requires_instantiation: true, requires_animation_binding: false, requires_playback: false, requires_loop_check: false, requires_deformation_probe: true } } as unknown as GameVersionDetailsV2;
}
