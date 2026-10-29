// Exports v2 (manifest 2.0 delivery closure) wire types and pure
// helpers. Server contract authority: artcraft-services
// `artcraft_api_defs::game_assets::exports_v2` on the game-assets v2
// path. Field names are exact serde wire names.

import type { GameAssetsCapabilities } from "./GameAssetsApi.js";

/** Explicit (asset, exact version) pick; current versions are never read. */
export interface GameExportSelectionItemV2 {
  asset_token: string;
  version_token: string;
}

/** One resolved member of the delivery closure. */
export interface GameExportClosureMemberV2 {
  asset_token: string;
  stable_key: string;
  display_name: string;
  kind: string;
  version_token: string;
  /** File version number of the selected version. */
  version: number;
  /** True when the user picked this pair explicitly. */
  explicit: boolean;
  /** Animations whose recorded rig dependency pulled this member in. */
  required_by: string[];
}

/** Dependency disclosure: same shape without the explicit flag. */
export interface GameExportDependencySelectionV2 {
  asset_token: string;
  stable_key: string;
  display_name: string;
  kind: string;
  version_token: string;
  version: number;
  required_by: string[];
}

/** One character demanded at two versions inside one closure. */
export interface GameExportRigConflictV2 {
  code: "rig_version_conflict";
  asset_token: string;
  stable_key: string;
  display_name: string;
  requested_versions: Array<{
    version_token: string;
    version: number;
    /** True when the user selected this version explicitly. */
    explicit: boolean;
    /** Animations whose recorded rig dependency points here. */
    required_by: string[];
  }>;
}

/** POST /v1/game_assets/projects/{project}/exports/prepare_v2 response. */
export interface PreparedGameExportV2 {
  success: boolean;
  preparation_token: string;
  manifest_schema_version: string;
  explicit_selections: GameExportClosureMemberV2[];
  dependency_selections: GameExportDependencySelectionV2[];
  /** Ordered complete closure (explicit + dependency members). */
  selections: GameExportClosureMemberV2[];
  /** SHA-256 hex over the canonical asset -> version closure identity. */
  closure_hash: string;
  expires_at: string;
}

/** POST /v1/game_assets/projects/{project}/exports/create_v2 request. */
export interface CreateGameExportV2Request {
  idempotency_key: string;
  preparation_token: string;
  /** Target engines: generic, godot, bevy. */
  export_kinds: string[];
}

/** GET /v1/game_assets/exports/{export}/details_v2 response. */
export interface GameExportDetailsV2 {
  success: boolean;
  export: {
    token: string;
    export_kind: string;
    status: string;
    maybe_content_id: string | null;
    maybe_error: Record<string, unknown> | null;
    created_at: string;
  };
  manifest_schema_version: string;
  /** The frozen closure; never re-resolved from current selections. */
  selection: {
    assets: Array<{
      asset_token: string;
      stable_key: string;
      version_token: string;
      kind: string;
      explicit: boolean;
      required_by: string[];
    }>;
  };
  engine_profiles: Record<string, unknown>;
  maybe_gating: Record<string, unknown> | null;
  maybe_manifest: Record<string, unknown> | null;
}

/** The new entry appears only when the server registers v2 delivery. */
export function exportsV2Available(capabilities: GameAssetsCapabilities | null | undefined): boolean {
  return !!capabilities?.supported_manifest_schema_versions?.includes("2.0");
}

/** Per-kind exports-v2 registration (default off server-side). */
export function kindExportsV2Enabled(
  capabilities: GameAssetsCapabilities | null | undefined,
  kindKey: string,
): boolean {
  return !!capabilities?.kind_capabilities?.[kindKey]?.operations?.export_v2?.enabled;
}

/** Rig conflicts ride on the error envelope's details.conflicts array. */
export function parseRigConflicts(details: Record<string, unknown> | undefined): GameExportRigConflictV2[] {
  const conflicts = details?.["conflicts"];
  if (!Array.isArray(conflicts)) return [];
  return conflicts.filter((entry): entry is GameExportRigConflictV2 =>
    !!entry && typeof entry === "object" && (entry as { code?: unknown }).code === "rig_version_conflict");
}

/** One display line per demanded version of a conflicted character. */
export function conflictLines(conflict: GameExportRigConflictV2): string[] {
  return conflict.requested_versions.map((demand) => {
    const source = demand.explicit
      ? "本次显式选择"
      : `由动画依赖引入${demand.required_by.length > 1 ? `（${demand.required_by.length} 个动画）` : ""}`;
    return `第 ${demand.version} 版（${demand.version_token}）· ${source}`;
  });
}

/** Stable copy for the pre-create disclosure. */
export const CONTENT_ID_EXPLANATION =
  "content_id 由闭包内容（资产版本、文件摘要与元数据）规范计算；同一份冻结闭包重新构建会得到相同的 content_id，与下载时间无关。";
