import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GameAssetsApi, type GameVersionDetailsV2, type GameAssetVersionInfo } from "@storyteller/api";
import { AnimatedAssetPreview } from "./AnimatedAssetPreview";

vi.mock("./MeshPreview", () => ({ MeshPreview: () => <div>character mesh</div> }));
beforeEach(() => { vi.stubGlobal("URL", class extends URL { static override createObjectURL = vi.fn(() => "blob:diagnostic"); static override revokeObjectURL = vi.fn(); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("loads the hash-checked diagnostic image separately from the GLB and releases its URL", async () => {
  const api = new GameAssetsApi();
  vi.spyOn(api, "GetCompleteGameAssetVersionDetailsV2").mockResolvedValue(details());
  const download = vi.spyOn(api, "DownloadVersionFileV2").mockResolvedValue(new Blob(["checked private bytes"]));
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagnostic");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const result = render(<AnimatedAssetPreview api={api} project="project" version={version()} kind="character_3d" supportsDetailsV2 />);
  expect(await screen.findByText("character mesh")).toBeTruthy();
  expect((screen.getByAltText("角色 rest 与诊断姿势的三向几何预览") as HTMLImageElement).src).toBe("blob:diagnostic");
  expect(download.mock.calls.map(([, file]) => file.role)).toEqual(["main", "preview"]);
  expect(create).toHaveBeenCalledTimes(1);
  result.unmount(); expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:diagnostic");
});

it("refuses a diagnostic with an unexpected MIME before creating its URL", async () => {
  const api = new GameAssetsApi(), detail = details(); detail.files[1].mime = "text/html";
  vi.spyOn(api, "GetCompleteGameAssetVersionDetailsV2").mockResolvedValue(detail);
  vi.spyOn(api, "DownloadVersionFileV2").mockResolvedValue(new Blob(["GLB"]));
  const create = vi.spyOn(URL, "createObjectURL");
  render(<AnimatedAssetPreview api={api} project="project" version={version()} kind="character_3d" supportsDetailsV2 />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("诊断预览格式"));
  expect(create).not.toHaveBeenCalled();
});

function version(): GameAssetVersionInfo { return { token: "version", asset_token: "asset", version: 1, profile_token: "profile", spec_json: { stage: "rigged" }, maybe_parent_version_token: null, created_by: "owner", created_at: "2026-10-29" }; }
function details(): GameVersionDetailsV2 {
  return { success: true, asset: { token: "asset", project_token: "project", kind: "character_3d" }, version: version(), stage: "rigged", dependencies: [], gate: {}, preview_contract: {}, files: [{ role: "main", ordinal: 0, mime: "model/gltf-binary", artifact_token: "glb" }, { role: "preview", ordinal: 0, mime: "image/png", artifact_token: "diagnostic", byte_length: 1200 }] } as unknown as GameVersionDetailsV2;
}
