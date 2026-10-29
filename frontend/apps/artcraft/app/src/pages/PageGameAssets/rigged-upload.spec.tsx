import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { GameAssetsApi, type GameAssetInfo, type GameProjectProfileInfo } from "@storyteller/api";
import { rigNodePaths, submitRiggedUpload, type RigUploadOperation } from "./rigged-upload";
import { RiggedCharacterUpload } from "./RiggedCharacterUpload";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("maps exact scene-0 paths, keeps repeated leaf names distinct and rejects ambiguous or cyclic nodes", () => {
  const paths = rigNodePaths(glb({ nodes: [{ name: "Hero", children: [1, 3] }, { name: "Left", children: [2] }, { name: "Joint" }, { name: "Right", children: [4] }, { name: "Joint" }, { name: "OtherScene" }], scenes: [{ nodes: [0] }, { nodes: [5] }], scene: 1 }));
  expect(paths).toContainEqual(["Hero", "Left", "Joint"]);
  expect(paths).toContainEqual(["Hero", "Right", "Joint"]);
  expect(paths).not.toContainEqual(["OtherScene"]);
  expect(() => rigNodePaths(glb({ nodes: [{ name: "Same" }, { name: "Same" }], scenes: [{ nodes: [0, 1] }] }))).toThrow(/重名/);
  expect(() => rigNodePaths(glb({ nodes: [{ name: "Loop", children: [0] }], scenes: [{ nodes: [0] }] }))).toThrow(/循环/);
  expect(() => rigNodePaths(glb({ nodes: [{}], scenes: [{ nodes: [0] }] }))).toThrow(/名称/);
  expect(() => rigNodePaths(glb({ nodes: [{ name: "ambiguous:joint" }], scenes: [{ nodes: [0] }] }))).toThrow(/分隔符/);
});

it("retries the same sealed upload and exact import request after an uncertain response", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const api = new GameAssetsApi(), mocks = mockUpload(api);
  mocks.import.mockRejectedValueOnce(new Error("network lost"));
  const original = fixture(), operation: RigUploadOperation = { key: "same-key", project: "project", stableKey: "hero", profile: "profile", bytes: original, mapping: { root: ["Hero"], hips: ["Hero", "Hip"] }, motionRoot: ["Hero"] };
  await expect(submitRiggedUpload(api, operation, () => {})).rejects.toThrow("network lost");
  const first = structuredClone(mocks.import.mock.calls[0][1]);
  operation.bytes = undefined;
  expect(await submitRiggedUpload(api, operation, () => {})).toBe("run");
  expect(mocks.put).toHaveBeenCalledExactlyOnceWith("/v1/game_assets/uploads/upload/content", original);
  expect(mocks.createAsset).toHaveBeenCalledTimes(1); expect(mocks.complete).toHaveBeenCalledTimes(1);
  expect(mocks.import.mock.calls[1][1]).toEqual(first);
  expect(first.expected_revision).toBe(7);
});

it("rejects a different reselected file before changing the sealed upload body", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const api = new GameAssetsApi(), mocks = mockUpload(api);
  const operation: RigUploadOperation = { key: "same", project: "project", stableKey: "hero", profile: "profile", bytes: fixture(), expectedSha: "0".repeat(64), upload: "upload", mapping: { root: ["Hero"] }, motionRoot: ["Hero"] };
  await expect(submitRiggedUpload(api, operation, () => {})).rejects.toThrow(/原上传不同/);
  expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled();
});

it("does not require or borrow the current parent when uploading to an existing character", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const api = new GameAssetsApi(), mocks = mockUpload(api);
  const operation: RigUploadOperation = { key: "same", project: "project", stableKey: "hero", profile: "profile", bytes: fixture(), mapping: { root: ["Hero"] }, motionRoot: ["Hero"], asset: { token: "asset", revision: 7, stable_key: "hero" } };
  await submitRiggedUpload(api, operation, () => {});
  expect(mocks.createAsset).not.toHaveBeenCalled();
  expect(mocks.import.mock.calls[0][1].maybe_parent_version_token).toBeUndefined();
  const explicit = { ...operation, key: "new-import-key", run: undefined, request: undefined, parent: "explicit-old-version" };
  await submitRiggedUpload(api, explicit, () => {});
  expect(mocks.import.mock.calls[1][1].maybe_parent_version_token).toBe("explicit-old-version");
});

it("keeps an uncertain UI submission across closing and resumes without reselecting sealed bytes", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const api = new GameAssetsApi(), mocks = mockUpload(api);
  mocks.import.mockRejectedValueOnce(new Error("response unknown"));
  const onRun = vi.fn(), onClose = vi.fn();
  const initial = render(<RiggedCharacterUpload api={api} project="project" profile={profile()} assets={[]} onRun={onRun} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("新角色标识"), { target: { value: "hero" } });
  const file = new File([new Uint8Array(fixture())], "hero.glb");
  Object.defineProperty(file, "arrayBuffer", { value: async () => fixture() });
  fireEvent.change(screen.getByLabelText("已绑骨角色原 GLB"), { target: { files: [file] } });
  fireEvent.change(await screen.findByLabelText("骨骼映射 root"), { target: { value: '["Hero"]' } });
  fireEvent.change(screen.getByLabelText("骨骼映射 hips"), { target: { value: '["Hero","Hip"]' } });
  fireEvent.click(screen.getByRole("button", { name: "上传并免费检查" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "response unknown");
  const stored = JSON.parse(localStorage.getItem("ga_pending_rig_upload:project")!);
  expect(stored.bytes).toBeUndefined(); expect(stored.sealed).toBe(true);
  initial.unmount();
  render(<RiggedCharacterUpload api={api} project="project" profile={profile()} assets={[]} onRun={onRun} onClose={onClose} />);
  expect(screen.queryByLabelText("已绑骨角色原 GLB")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "继续原上传与检查" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledWith("run", "asset"));
  expect(mocks.import.mock.calls[1][1]).toEqual(mocks.import.mock.calls[0][1]);
  expect(mocks.put).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("ga_pending_rig_upload:project")).toBeNull();
});

function glb(value: unknown): ArrayBuffer {
  const raw = new TextEncoder().encode(JSON.stringify(value)), length = Math.ceil(raw.length / 4) * 4;
  const bytes = new Uint8Array(20 + length); bytes.fill(32, 20); bytes.set(raw, 20);
  const view = new DataView(bytes.buffer); view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true); view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true);
  return bytes.buffer;
}
function fixture() { return glb({ nodes: [{ name: "Hero", children: [1] }, { name: "Hip" }], scenes: [{ nodes: [0] }] }); }
function profile(): GameProjectProfileInfo { return { token: "profile", project_token: "project", version: 1, schema_version: 2, profile_json: { specs: { character_3d: { rig_profile: { motion_root_slot: "root", bones: [{ slot: "root" }, { slot: "hips" }] } } } }, sha256_hex: "a".repeat(64), created_by: "owner", created_at: "2026-10-29" }; }
function mockUpload(api: GameAssetsApi) {
  return {
    createAsset: vi.spyOn(api, "CreateGameAssetV2").mockResolvedValue({ success: true, asset: { token: "asset", stable_key: "hero", revision: 7 } as GameAssetInfo }),
    create: vi.spyOn(api, "CreateGameUpload").mockResolvedValue({ success: true, content_path: "/v1/game_assets/uploads/upload/content", upload: { token: "upload" } as any }),
    put: vi.spyOn(api, "PutGameUploadContent").mockResolvedValue(undefined),
    complete: vi.spyOn(api, "CompleteGameUpload").mockResolvedValue({ success: true, upload: { token: "upload", status: "sealed", maybe_artifact_token: "artifact" } as any }),
    import: vi.spyOn(api, "ImportRiggedCharacterV2").mockResolvedValue({ success: true, run_token: "run", asset_token: "asset", maybe_version_token: null, supplier_calls: 0 }),
  };
}
