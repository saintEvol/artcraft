import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameAssetsApiError, type GameAssetsCapabilities, type PreparedGameExportV2 } from "@storyteller/api";
import { DeliveryDialog, type DeliveryItem } from "./DeliveryDialog";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ITEMS: DeliveryItem[] = [
  { asset: "hero", kindKey: "character_3d", name: "Hero", kind: "角色", candidate: "选定文件", version: "hero-v1", fileVersion: 1 },
  { asset: "spin", kindKey: "anim_3d", name: "Spin", kind: "3D 动画", candidate: "选定文件", version: "spin-v1", fileVersion: 1 },
];

const CAPABILITIES: GameAssetsCapabilities = {
  success: true, api_version: "game_assets.v1", manifest_schema_version: "2.0",
  asset_kinds: [], pipelines: [], export_targets: [], max_page_size: 100,
  supported_manifest_schema_versions: ["1.1", "2.0"],
  kind_capabilities: {
    character_3d: { operations: { export_v2: { enabled: true } } },
    anim_3d: { operations: { export_v2: { enabled: true } } },
  },
};

const PREPARED: PreparedGameExportV2 = {
  success: true, preparation_token: "prep", manifest_schema_version: "2.0", closure_hash: "a".repeat(64), expires_at: "2026-10-29T00:00:00Z",
  explicit_selections: [member("spin", "Spin", "anim_3d", "spin-v1", 1, true)],
  dependency_selections: [member("hero", "Hero", "character_3d", "hero-v1", 1, false, ["spin-v1"])],
  selections: [
    member("hero", "Hero", "character_3d", "hero-v1", 1, false, ["spin-v1"]),
    member("spin", "Spin", "anim_3d", "spin-v1", 1, true),
  ],
};

function member(asset: string, name: string, kind: string, version: string, number: number, explicit: boolean, requiredBy: string[] = []) {
  return { asset_token: asset, stable_key: asset, display_name: name, kind, version_token: version, version: number, explicit, required_by: requiredBy };
}

function acknowledge() {
  fireEvent.click(screen.getByRole("checkbox", { name: "我已核对本次资产、版本、交付目标与未包含项" }));
}

it("prepares the closure, discloses dependencies and content_id, then commits the exact preparation", async () => {
  const onPrepareV2 = vi.fn().mockResolvedValue(PREPARED);
  const onCreateV2 = vi.fn().mockResolvedValue(undefined);
  const onBuild = vi.fn();
  render(<DeliveryDialog items={ITEMS} capabilities={CAPABILITIES} target="generic" onTarget={() => {}} onBuild={onBuild}
    onPrepareV2={onPrepareV2} onCreateV2={onCreateV2} onClose={() => {}} />);
  acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "解析并确认交付闭包" }));
  await waitFor(() => expect(onPrepareV2).toHaveBeenCalledWith(
    [{ asset_token: "hero", version_token: "hero-v1" }, { asset_token: "spin", version_token: "spin-v1" }],
    expect.any(String),
  ));
  await screen.findByText("交付闭包已解析");
  expect(screen.getByText(/依赖引入 1 项/)).toBeTruthy();
  expect(screen.getAllByText(/Hero/).length).toBeGreaterThan(0);
  expect(screen.getByText(/由动画依赖引入：Spin/)).toBeTruthy();
  expect(screen.getByText(/content_id/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "按已解析闭包构建交付包" }));
  await waitFor(() => expect(onCreateV2).toHaveBeenCalledWith(PREPARED, "generic", expect.any(String)));
  expect(onBuild).not.toHaveBeenCalled();
});

it("shows per-character version conflicts with what introduced each version", async () => {
  const onPrepareV2 = vi.fn().mockRejectedValue(new GameAssetsApiError("同一角色被要求两个不同版本", 409, "rig_version_conflict", false, {
    conflicts: [{
      code: "rig_version_conflict", asset_token: "hero", stable_key: "hero", display_name: "Hero",
      requested_versions: [
        { version_token: "hero-v2", version: 2, explicit: true, required_by: [] },
        { version_token: "hero-v1", version: 1, explicit: false, required_by: ["spin-v1"] },
      ],
    }],
  }));
  const onCreateV2 = vi.fn().mockResolvedValue(undefined);
  const onBuild = vi.fn().mockResolvedValue(undefined);
  render(<DeliveryDialog items={ITEMS} capabilities={CAPABILITIES} target="generic" onTarget={() => {}} onBuild={onBuild}
    onPrepareV2={onPrepareV2} onCreateV2={onCreateV2} onClose={() => {}} />);
  acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "解析并确认交付闭包" }));
  await screen.findByRole("alert");
  expect(screen.getByText(/Hero（hero）需要统一版本/)).toBeTruthy();
  expect(screen.getByText(/第 2 版（hero-v2）· 本次显式选择/)).toBeTruthy();
  expect(screen.getByText(/第 1 版（hero-v1）· 由动画依赖引入/)).toBeTruthy();
  expect(onCreateV2).not.toHaveBeenCalled();
});

it("keeps the legacy single-step flow when v2 delivery is not registered", async () => {
  const legacyItems: DeliveryItem[] = [
    { asset: "icon", kindKey: "icon_2d", name: "Icon", kind: "图标", candidate: "选定文件", version: "icon-v1", fileVersion: 1 },
  ];
  const legacyCapabilities: GameAssetsCapabilities = {
    ...CAPABILITIES,
    supported_manifest_schema_versions: ["1.1"],
    asset_kinds: ["icon_2d"],
    kind_capabilities: { icon_2d: { operations: { export: { enabled: true } } } },
  };
  const onBuild = vi.fn().mockResolvedValue(undefined);
  const onPrepareV2 = vi.fn();
  const onCreateV2 = vi.fn().mockResolvedValue(undefined);
  render(<DeliveryDialog items={legacyItems} capabilities={legacyCapabilities}
    target="generic" onTarget={() => { }} onBuild={onBuild} onPrepareV2={onPrepareV2} onCreateV2={onCreateV2} onClose={() => { }} />);
  acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "构建这份交付清单" }));
  await waitFor(() => expect(onBuild).toHaveBeenCalled());
  expect(onPrepareV2).not.toHaveBeenCalled();
  expect(screen.queryByText("解析并确认交付闭包")).toBeNull();
});

it("offers the Cocos Creator delivery target and reports the choice", async () => {
  const onTarget = vi.fn();
  const onBuild = vi.fn().mockResolvedValue(undefined);
  render(<DeliveryDialog items={ITEMS} target="generic" onTarget={onTarget} onBuild={onBuild} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("清单交付目标"), { target: { value: "cocos" } });
  expect(onTarget).toHaveBeenCalledWith("cocos");
  expect(screen.getByRole("option", { name: "导入 Cocos Creator" })).toBeTruthy();
});
