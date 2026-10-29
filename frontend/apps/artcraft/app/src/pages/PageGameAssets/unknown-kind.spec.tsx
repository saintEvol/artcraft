import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameAssetsApi } from "@storyteller/api";
import GameAssets from "./GameAssets";

vi.mock("./AssetPreview", () => ({ AssetPreview: vi.fn(() => <div>decoded preview</div>) }));
vi.mock("./AnimatedAssetPreview", () => ({ AnimatedAssetPreview: vi.fn(() => <div>animation diagnostic</div>) }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens recognized animation versions in a diagnostic panel without borrowing legacy review gates", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network")));
  const project = { token: "project", name: "动画诊断项目", revision: 1, maybe_current_profile_token: null, maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" };
  const asset = { token: "walk", project_token: "project", stable_key: "walk", kind: "anim_2d", revision: 1, tags: [], maybe_current_version_token: "walk-v1", maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" };
  const version = { token: "walk-v1", asset_token: "walk", version: 1, maybe_parent_version_token: null, profile_token: "profile", spec_json: { stage: "animation" }, created_by: "owner", created_at: "2026-10-28" };
  vi.spyOn(GameAssetsApi.prototype, "GetCapabilities").mockResolvedValue({ success: true, api_version: "game_assets.v1", manifest_schema_version: "1.1", asset_kinds: ["icon_2d", "sprite_2d", "prop_3d"], pipelines: [], export_targets: [], max_page_size: 100 });
  vi.spyOn(GameAssetsApi.prototype, "ListProjects").mockResolvedValue({ success: true, items: [project], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "GetGameProject").mockResolvedValue({ project });
  vi.spyOn(GameAssetsApi.prototype, "ListGameAssets").mockResolvedValue({ items: [asset], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListGameAssetVersions").mockResolvedValue({ items: [version], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListProjectExports").mockResolvedValue({ items: [], has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListCreationRuns").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
  const reviews = vi.spyOn(GameAssetsApi.prototype, "ListReviews");
  const validations = vi.spyOn(GameAssetsApi.prototype, "ListValidations");
  render(<GameAssets />);
  fireEvent.click(await screen.findByRole("button", { name: /动画诊断项目/ }));
  fireEvent.click((await screen.findByText("walk")).closest("button")!);
  expect(await screen.findByText("animation diagnostic")).toBeTruthy();
  expect(screen.queryByText("decoded preview")).toBeNull();
  expect(screen.queryByRole("button", { name: "选入交付" })).toBeNull();
  expect(screen.queryByRole("button", { name: "框选局部修改" })).toBeNull();
  expect(reviews).not.toHaveBeenCalled(); expect(validations).not.toHaveBeenCalled();
});

it("shows an unknown kind as read-only without selecting an image decoder or mutation controls", async () => {
  const unexpectedFetch = vi.fn().mockRejectedValue(new Error("Unexpected network in isolated UI test"));
  vi.stubGlobal("fetch", unexpectedFetch);
  const project = { token: "project", name: "未来类型项目", revision: 1, maybe_current_profile_token: null, maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" };
  const asset = { token: "future", project_token: "project", stable_key: "future_key", kind: "future_kind", revision: 1, tags: ["怪物"], maybe_current_version_token: "future-version", maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" };
  vi.spyOn(GameAssetsApi.prototype, "GetCapabilities").mockResolvedValue({ success: true, api_version: "game_assets.v1", manifest_schema_version: "1.1", asset_kinds: ["future_kind"], pipelines: [], export_targets: [], max_page_size: 100, organization: { supports_asset_tags: true } });
  vi.spyOn(GameAssetsApi.prototype, "ListProjects").mockResolvedValue({ success: true, items: [project], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "GetGameProject").mockResolvedValue({ project });
  vi.spyOn(GameAssetsApi.prototype, "ListGameAssets").mockResolvedValue({ items: [asset], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListProjectExports").mockResolvedValue({ items: [], has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListProjectAssetTags").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListCreationRuns").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
  const versions = vi.spyOn(GameAssetsApi.prototype, "ListGameAssetVersions");
  render(<GameAssets />);
  fireEvent.click(await screen.findByRole("button", { name: /未来类型项目/ }));
  fireEvent.click((await screen.findByText("future_key")).closest("button")!);
  expect(await screen.findByText("请升级客户端以查看和操作此类型的资产。")).toBeTruthy();
  expect(screen.getByText("类型：future_kind · 标识：future")).toBeTruthy();
  expect(screen.queryByText("decoded preview")).toBeNull();
  expect(screen.queryByRole("button", { name: "选入交付" })).toBeNull();
  expect(screen.queryByRole("button", { name: "归档资产" })).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑标签：future_key" })).toBeNull();
  expect(versions).not.toHaveBeenCalled();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});

it("refreshes service capabilities with the project so upgrades can enable tags without discarding the page", async () => {
  const unexpectedFetch = vi.fn().mockRejectedValue(new Error("Unexpected network in isolated UI test"));
  vi.stubGlobal("fetch", unexpectedFetch);
  const project = { token: "project", name: "能力刷新项目", revision: 1, maybe_current_profile_token: null, maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" };
  const asset = { token: "asset", project_token: "project", stable_key: "existing_asset", kind: "icon_2d", revision: 1, tags: [], maybe_current_version_token: null, maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" };
  const base = { success: true, api_version: "game_assets.v1", manifest_schema_version: "1.1", asset_kinds: ["icon_2d"], pipelines: [], export_targets: [], max_page_size: 100 };
  const caps = vi.spyOn(GameAssetsApi.prototype, "GetCapabilities").mockResolvedValueOnce(base).mockResolvedValue({ ...base, organization: { supports_asset_tags: true } });
  vi.spyOn(GameAssetsApi.prototype, "ListProjects").mockResolvedValue({ success: true, items: [project], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "GetGameProject").mockResolvedValue({ project });
  vi.spyOn(GameAssetsApi.prototype, "ListGameAssets").mockResolvedValue({ items: [asset], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListGameAssetVersions").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListProjectExports").mockResolvedValue({ items: [], has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListProjectAssetTags").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
  vi.spyOn(GameAssetsApi.prototype, "ListCreationRuns").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
  render(<GameAssets />);
  fireEvent.click(await screen.findByRole("button", { name: /能力刷新项目/ }));
  await screen.findByText("existing_asset");
  expect(screen.queryByRole("button", { name: "编辑标签：existing_asset" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新项目" }));
  expect(await screen.findByRole("button", { name: "编辑标签：existing_asset" })).toBeTruthy();
  await waitFor(() => expect((screen.getByRole("button", { name: "刷新项目" }) as HTMLButtonElement).disabled).toBe(false));
  expect(caps).toHaveBeenCalledTimes(2);
  expect(unexpectedFetch).not.toHaveBeenCalled();
});
