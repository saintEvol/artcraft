import { describe, expect, it } from "vitest";
import { gameAssetOperation, type GameAssetsCapabilities } from "@storyteller/api";

const LEGACY: GameAssetsCapabilities = {
  success: true, api_version: "game_assets.v1", manifest_schema_version: "1.0",
  asset_kinds: ["icon_2d", "sprite_2d", "prop_3d"], pipelines: [], export_targets: ["generic"], max_page_size: 100,
  creation: { contract_version: "game_creation.v1", image_configured: true, mesh_configured: true,
    local_processing_available: true, local_mesh_configured: true, billing_mode: "provider_account", max_candidates: 4 },
};

describe("kind operation disclosure", () => {
  it("keeps known legacy behavior while refusing unknown kinds and new operations", () => {
    for (const kind of LEGACY.asset_kinds) {
      expect(gameAssetOperation(LEGACY, kind, "import").enabled).toBe(true);
      expect(gameAssetOperation(LEGACY, kind, "generate").enabled).toBe(true);
      expect(gameAssetOperation(LEGACY, kind, "export").enabled).toBe(true);
      expect(gameAssetOperation(LEGACY, kind, "future_operation").enabled).toBe(false);
    }
    expect(gameAssetOperation({ ...LEGACY, asset_kinds: ["anim_3d"] }, "anim_3d", "generate").enabled).toBe(false);
    expect(gameAssetOperation(LEGACY, "icon_2d", "erase").enabled).toBe(false);
  });

  it("honors explicit disabled operations and reasons over legacy ready flags", () => {
    const capabilities = { ...LEGACY, kind_capabilities: { icon_2d: { operations: { generate: { enabled: false, reason: "实例停用" } } } } };
    expect(gameAssetOperation(capabilities, "icon_2d", "generate")).toEqual({ enabled: false, reason: "实例停用" });
    expect(gameAssetOperation(capabilities, "icon_2d", "export").enabled).toBe(false);
    expect(gameAssetOperation(capabilities, "sprite_2d", "generate").enabled).toBe(false);
  });

  it("uses a declared cutout capability independently of the older image readiness aggregate", () => {
    const capabilities = { ...LEGACY, creation: undefined, kind_capabilities: { icon_2d: { operations: { cutout: { enabled: true } } } } };
    expect(gameAssetOperation(capabilities, "icon_2d", "cutout").enabled).toBe(true);
    expect(gameAssetOperation(capabilities, "icon_2d", "generate").enabled).toBe(false);
  });
});
