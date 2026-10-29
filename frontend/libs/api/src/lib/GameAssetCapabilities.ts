import type { GameAssetsCapabilities } from "./GameAssetsApi.js";

export const GAME_ASSET_KINDS = ["icon_2d", "sprite_2d", "prop_3d"] as const;
export type GameAssetKnownKind = (typeof GAME_ASSET_KINDS)[number];

/** New write operations require explicit disclosure and never inherit legacy
 * import availability or a provider key's presence. */
export function characterValidationOperation(capabilities: GameAssetsCapabilities | null | undefined, operation: "create_v2" | "import_rigged_v2" | "validate_rig_v2"): { enabled: boolean; reason?: string } {
  const value = capabilities?.kind_capabilities?.character_3d?.operations?.[operation];
  return value?.enabled === true ? { enabled: true } : { enabled: false, reason: value?.reason ?? "此实例尚未开放角色 GLB 上传与免费检查。" };
}

/** Paid character creation discloses its prepare and start gates separately;
 * neither inherits free validation availability. */
export function characterCreationV2Operation(capabilities: GameAssetsCapabilities | null | undefined, operation: "prepare_mesh_v2" | "start_v2"): { enabled: boolean; reason?: string } {
  const value = capabilities?.kind_capabilities?.character_3d?.operations?.[operation];
  return value?.enabled === true ? { enabled: true } : { enabled: false, reason: value?.reason ?? "此实例尚未开放角色 mesh 收费制作。" };
}

export function gameAssetOperation(capabilities: GameAssetsCapabilities | null | undefined, kind: string, operation: string): { enabled: boolean; reason?: string } {
  if (!capabilities || !GAME_ASSET_KINDS.some((known) => known === kind) || !capabilities.asset_kinds.includes(kind)) {
    return { enabled: false, reason: "此类型尚未被当前客户端与服务端共同支持，请升级客户端或选择已支持类型。" };
  }
  if (capabilities.kind_capabilities !== undefined) {
    const value = capabilities.kind_capabilities?.[kind]?.operations?.[operation];
    return value?.enabled === true ? { enabled: true } : { enabled: false, reason: value?.reason ?? "服务端尚未启用或声明此操作。" };
  }
  // Older servers retain only their three known kinds and existing operations.
  // A new operation never inherits a permissive default from enum recognition.
  const config = capabilities.creation;
  let enabled = false;
  switch (operation) {
    case "import": enabled = true; break;
    case "export": enabled = capabilities.export_targets.length > 0; break;
    case "generate": case "edit": enabled = config?.image_configured === true; break;
    case "inpaint": enabled = config?.image_configured === true && (kind !== "prop_3d" || config.supports_concept_masking === true); break;
    case "erase": enabled = config?.local_processing_available === true && (kind === "prop_3d" ? config.supports_concept_masking === true : config.supports_mask_erase === true); break;
    case "cutout": enabled = kind !== "prop_3d" && config?.image_configured === true; break;
    case "mesh": enabled = kind === "prop_3d" && config?.mesh_configured === true; break;
    case "reprocess": enabled = config?.local_processing_available === true && (kind !== "prop_3d" || config.local_mesh_configured === true); break;
  }
  return enabled ? { enabled } : { enabled: false, reason: "当前服务尚未提供此操作，或实例尚未配置所需服务。" };
}
