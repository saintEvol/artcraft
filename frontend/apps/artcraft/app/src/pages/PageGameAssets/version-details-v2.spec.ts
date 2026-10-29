import { afterEach, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { GameAssetsApi, readAllVersionFilesV2, type GameVersionDetailsV2, type GameVersionFileV2 } from "@storyteller/api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reads past 100 source frames and retains the fixed version/context", async () => {
  const files = Array.from({ length: 120 }, (_, i) => file(i));
  const get = vi.fn().mockResolvedValueOnce(page(files.slice(0, 100), "next", 120)).mockResolvedValueOnce(page(files.slice(100), null, 120));
  const detail = await readAllVersionFilesV2("version", get);
  expect(detail.files).toHaveLength(120); expect(detail.files_has_more).toBe(false); expect(get).toHaveBeenNthCalledWith(2, "next");
});
it("rejects repeated cursors, truncated lists, wrong scope and changed reports", async () => {
  const repeated = vi.fn().mockResolvedValueOnce(page([file(0)], "repeat", 3)).mockResolvedValueOnce(page([file(1)], "repeat", 3));
  await expect(readAllVersionFilesV2("version", repeated)).rejects.toThrow(/分页无法继续/);
  await expect(readAllVersionFilesV2("version", async () => page([file(0)], null, 2))).rejects.toThrow(/完整文件集合/);
  const wrong = { ...file(0), version_token: "another" };
  await expect(readAllVersionFilesV2("version", async () => page([wrong], null, 1))).rejects.toThrow(/错误版本/);
  const first = page([file(0)], "next", 2), changed = page([file(1)], null, 2); changed.gate.latest_report_token = "new_report";
  const get = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(changed);
  await expect(readAllVersionFilesV2("version", get)).rejects.toThrow(/检查上下文/);
});
it("verifies exact private bytes and refuses stale hashes or unavailable bindings", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const api = new GameAssetsApi(), blob = new NodeBlob(["data"], { type: "image/png" }) as unknown as Blob;
  const download = vi.spyOn(api, "DownloadGameArtifact").mockResolvedValue(blob);
  const identity = { ...file(0), sha256_hex: createHash("sha256").update("data").digest("hex") };
  expect(await api.DownloadVersionFileV2("project", identity)).toBe(blob);
  await expect(api.DownloadVersionFileV2("project", { ...identity, sha256_hex: "f".repeat(64) })).rejects.toMatchObject({ code: "artifact_integrity_mismatch" });
  await expect(api.DownloadVersionFileV2("project", { ...identity, byte_length: 8 })).rejects.toMatchObject({ code: "artifact_integrity_mismatch" });
  download.mockClear();
  await expect(api.DownloadVersionFileV2("project", { ...identity, available: false })).rejects.toMatchObject({ code: "incomplete_file_set" });
  expect(download).not.toHaveBeenCalled();
});
it("preserves v2 recovery details without treating retryability as charge authorization", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ success: false, error: { code: "read_contract_unavailable", message: "实例尚未升级", retryable: true, details: { recovery: "query_after_instance_upgrade", authorizes_new_submission: false } } }) }));
  const api = new GameAssetsApi();
  await expect(api.GetGameAssetVersionDetailsV2("version")).rejects.toMatchObject({ code: "read_contract_unavailable", retryable: true, details: { authorizes_new_submission: false } });
});

function file(ordinal: number): GameVersionFileV2 {
  return { version_token: "version", artifact_token: `artifact_${ordinal}`, role: "source", ordinal, maybe_metadata_json: null,
    kind: "source_image", sha256_hex: "a".repeat(64), byte_length: 4, mime: "image/png", available: true };
}
function page(files: GameVersionFileV2[], cursor: string | null, total: number): GameVersionDetailsV2 {
  return { success: true, asset: { token: "asset", project_token: "project", stable_key: "walk", kind: "anim_2d", revision: 1, maybe_current_version_token: "version", maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" },
    version: { token: "version", asset_token: "asset", version: 1, maybe_parent_version_token: null, profile_token: "profile", spec_json: { stage: "animation" }, created_by: "actor", created_at: "2026-10-28" }, stage: "animation", files, files_total_count: total, files_has_more: cursor !== null, files_next_cursor: cursor, preview_files: [], dependencies: [], artifact_set_hash_hex: "a".repeat(64), dependency_snapshot_hash_hex: "b".repeat(64),
    gate: { technical_state: "not_checked", review_state: "not_reviewed", stage_eligible: true, file_contract_complete: true, dependencies_valid: true, source_gate_passed: false, delivery_gate_passed: false, can_select: false, reasons: [], context: null, latest_report_token: null, latest_report_status: null, latest_review_token: null, latest_review_decision: null },
    preview_contract: { version: "game.preview.anim2d.animation.v1", artifact_tokens: [], rig_version_token: null, required_directions: ["default"], required_views: [], requires_instantiation: false, requires_animation_binding: false, requires_playback: true, requires_loop_check: true, requires_deformation_probe: false } };
}
