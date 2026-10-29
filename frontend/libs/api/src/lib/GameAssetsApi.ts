export { frameAt, parseFrameTable, parseSkeletonMap, isAnimatedAssetKind, ANIMATED_ASSET_KINDS, ANIMATED_KIND_LABELS, type AnimatedAssetKind, type AnimationFrameTable, type AnimationSkeletonMap } from "./GameAnimationContracts.js";
import { normalizeGameAssetTag, normalizeGameAssetTags } from "./GameAssetTags.js";
import { readAllVersionFilesV2, type GameVersionDetailsV2 } from "./GameVersionDetailsV2.js";
import type {
  CreateGameExportV2Request,
  GameExportDetailsV2,
  GameExportSelectionItemV2,
  PreparedGameExportV2,
} from "./GameExportsV2.js";
import type { GameVersionFileV2 } from "./GameVersionDetailsV2.js";
import type { GameReviewV2Request, GameReviewV2Response, GameSelectionV2Request } from "./GameVersionDetailsV2.js";
export * from "./GameVersionDetailsV2.js";
export * from "./GameRunDetailsV2.js";
export * from "./GameCreationV2.js";
export * from "./GameExportsV2.js";
import type { PrepareCharacterMeshV2, PreparedCharacterMeshV2, StartCharacterMeshV2, StartedGameCreationV2 } from "./GameCreationV2.js";
import { readAllRunStepsV2, type GameRunDetailsV2, type GameRunControlV2, type GameValidationRunV2, type RiggedCharacterImportV2 } from "./GameRunDetailsV2.js";
export { normalizeGameAssetTag, normalizeGameAssetTags } from "./GameAssetTags.js";
export { GAME_ASSET_KINDS, gameAssetOperation, characterValidationOperation, characterCreationV2Operation, type GameAssetKnownKind } from "./GameAssetCapabilities.js";
import { ApiManager, buildSessionHeaders } from "./ApiManager.js";
import { FetchProxy } from "@storyteller/tauri-utils";

// ─── Types ─────────────────────────────────────────────────────────────────
//
// Wire types for /v1/game_assets (server contract authority: the
// artcraft-services `artcraft_api_defs::game_assets` module on the
// game-assets-gen branch). Field names are exact serde wire names; keep
// them in sync with the server types and the JSON Schemas in
// test_data/game_assets/contracts/schemas/.

/** GET /v1/game_assets/capabilities response body. */
export interface GameAssetsCapabilities {
  success: boolean;
  /** Dotted API contract version, e.g. "game_assets.v1". */
  api_version: string;
  /** Manifest schema major.minor the server can export. */
  manifest_schema_version: string;
  /** Asset kinds accepted by asset creation. */
  asset_kinds: string[];
  /** Pipeline recipe ids (empty until the M3 worker ships). */
  pipelines: string[];
  /** Export targets (empty until M6). */
  export_targets: string[];
  /** Maximum page size accepted by list endpoints. */
  max_page_size: number;
  /** Absent on older servers; do not infer that old checks cover new rules. */
  validation_version?: string;
  organization?: { supports_asset_tags?: boolean };
  supported_manifest_schema_versions?: string[];
  reading?: { supports_run_details_v2?: boolean; default_step_page_size?: number; max_step_page_size?: number; supports_version_details_v2: boolean; version_details_v2_kinds: string[]; supports_exact_rig_dependencies: boolean; default_file_page_size: number; max_file_page_size: number };
  kind_capabilities?: Record<string, { operations: Record<string, { enabled: boolean; reason?: string }> }>;
  creation?: {
    contract_version: string; image_configured: boolean; mesh_configured: boolean;
    local_processing_available: boolean; local_mesh_configured: boolean;
    billing_mode: string; max_candidates: number;
    supports_asset_briefs?: boolean; supports_batch_start?: boolean; supports_mask_erase?: boolean; supports_delivery_unselect?: boolean; supports_concept_masking?: boolean;
  };
}

export type GameCreationOperation = "generate" | "edit" | "inpaint" | "erase" | "cutout" | "mesh" | "reprocess";
export interface GameCreationInput {
  profile_token: string; kind: string; operation: GameCreationOperation;
  display_name: string; description: string; use_case: string; preserve: string;
  candidate_count: number; maybe_style_override?: string;
  maybe_source_version_token?: string; maybe_reference_artifact_token?: string;
  maybe_target_asset_token?:string;
  maybe_reference_purpose?: "style" | "subject" | "both";
  maybe_override_project_reference?: boolean; maybe_mask_artifact_token?: string;
  maybe_output_overrides?: { canvas?: number | null; content_inset_px?: number | null; allow_upscale?: boolean | null;
    target_height_m?: number | null; max_triangles?: number | null; max_texture_size?: number | null; rotation_y_degrees?: number | null };
  maybe_idempotency_key?: string;
}
export interface GameCreationPlan {
  success: boolean; plan_token: string; plan_hash_hex: string; expires_at: string;
  quote: { quote: { unit: string; estimated_amount: number | null; maybe_max_chargeable: number | null;
    maybe_pricing_source?: string | null }; method: string; billing_mode: string; expected_calls: Record<string, number>;
    additional_estimates?:{unit:string;estimated_amount:number|null;maybe_max_chargeable:number|null}[] };
  making: { display_name: string; description: string; use_case: string; style: string; preserve: string;
    kind: string; operation: GameCreationOperation; stage: string; candidate_count: number;
    output: Record<string, unknown>; reference_purpose: string; has_reference: boolean; has_mask: boolean; style_scope: string };
}
export interface GameCreationRun {
  token: string; maybe_plan_token: string | null; status: string; asset_token: string;
  display_name: string; kind: string; operation: GameCreationOperation; cancel_requested: boolean; created_at: string;
  making?:{description:string;use_case:string;style:string;preserve:string;output:Record<string,unknown>;
    reference_purpose:"style"|"subject"|"both";maybe_source_artifact_token?:string|null;maybe_parent_version_token?:string|null};
  steps: { status: string; candidate: number; stage: string; version_tokens: string[]; maybe_problem: string | null }[];
}

export interface GameAssetBrief {
  display_name: string; description: string; use_case: string; preserve: string; candidate_count: number;
  maybe_style_override?: string | null; maybe_style_source_version_token?: string | null;
  maybe_output_overrides?: GameCreationInput["maybe_output_overrides"] | null;
  maybe_group_key?: string | null; maybe_group_name?: string | null; maybe_group_sample_asset_token?: string | null;
}
export interface GameAssetBriefInfo {
  asset_token: string; project_token: string; kind: string; revision: number;
  brief: GameAssetBrief; updated_at: string;
}

/** Project projection shared by all project endpoints. */
export interface GameProjectInfo {
  token: string;
  name: string;
  /** Current profile revision token; null until the first publish. */
  maybe_current_profile_token: string | null;
  /** Optimistic-concurrency revision echoed by PATCH. */
  revision: number;
  maybe_archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateGameProjectResponse {
  success: boolean;
  project: GameProjectInfo;
}

export interface ListGameProjectsResponse {
  success: boolean;
  items: GameProjectInfo[];
  /** Keyset cursor for the next page; null when the page is the last. */
  next_cursor: string | null;
  /** Invariant: has_more is true exactly when next_cursor is non-null. */
  has_more: boolean;
}

export interface CreateGameProjectInput {
  name: string;
  /** Optional lowercase-hyphenated UUID idempotency key. */
  maybe_idempotency_key?: string;
}

/** Asset projection (stable identity per project + kind). */
export interface GameAssetInfo {
  token: string;
  project_token: string;
  stable_key: string;
  kind: string;
  /** Absent on legacy responses; the transport supplies an empty array. */
  tags?: string[];
  maybe_current_version_token: string | null;
  revision: number;
  maybe_archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Version projection (immutable; files come from the version detail). */
export interface GameAssetVersionInfo {
  token: string;
  asset_token: string;
  version: number;
  maybe_parent_version_token: string | null;
  profile_token: string;
  spec_json: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface GameProjectProfileInfo {
  token: string;
  project_token: string;
  version: number;
  schema_version: number;
  profile_json: Record<string, unknown>;
  sha256_hex: string;
  created_by: string;
  created_at: string;
}

export interface GameVersionFileInfo {
  artifact_token: string;
  role: string;
  ordinal: number;
  maybe_metadata_json: Record<string, unknown> | null;
}

export interface GamePage<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export class GameAssetsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Status query/protocol continuation only; never authorizes a new charge. */
    readonly retryable?: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GameAssetsApiError";
  }
}

/** Sealed upload session (three-step: create → raw PUT → complete). */
export interface GameUploadInfo {
  token: string;
  project_token: string;
  expected_size: number;
  expected_mime: string;
  status: string;
  expires_at: string;
  maybe_artifact_token: string | null;
}

/** Human-review event; the newest event IS the current verdict. */
export interface ReviewEventInfo {
  token: string;
  decision: string;
  maybe_rejection_kind: string | null;
  reviewer_token: string;
  maybe_reason: string | null;
  created_at: string;
}

/** Server-computed technical validation report (list projection). */
export interface ValidationReportInfo {
  token: string;
  status: string;
  validator_version: string;
  report: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

/** Export row; status walks pending → building → succeeded/failed. */
export interface GameExportInfo {
  token: string;
  export_kind: string;
  status: string;
  maybe_content_id: string | null;
  maybe_error: Record<string, unknown> | null;
  created_at: string;
}

export interface GameEngineReportInfo {
  token: string; importer_version: string; trust_level: string;
  report: Record<string, unknown>; created_at: string;
}

export interface ListGameAssetsOptions {
  maybe_cursor?: string;
  maybe_limit?: number;
  maybe_kind?: string;
  maybe_include_archived?: boolean;
  maybe_tag?: string;
}

export interface ListGameProjectsQuery {
  maybe_cursor?: string;
  maybe_limit?: number;
  maybe_include_archived?: boolean;
}

// ─── API ───────────────────────────────────────────────────────────────────

/**
 * Client for the game-assets workbench endpoints (`/v1/game_assets/...`).
 *
 * Uses the same session and desktop HTTP proxy for JSON, uploads and
 * private previews. Structured failures retain their status/code;
 * interrupted mutations never imply that the server rejected the work.
 */
export class GameAssetsApi extends ApiManager {
  public async PrepareCharacterMeshV2(project: string, input: PrepareCharacterMeshV2): Promise<PreparedCharacterMeshV2> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/creations/prepare_v2`, body: input });
  }
  /** Paid submission of the exact prepared plan. The key survives uncertain
   * responses; a replay with identical authorization returns its original run. */
  public async StartCharacterMeshV2(project: string, input: StartCharacterMeshV2): Promise<StartedGameCreationV2> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/creations/start_v2`, body: input });
  }
  public async ReviewGameVersionV2(version: string, input: GameReviewV2Request): Promise<GameReviewV2Response> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${version}/reviews_v2`, body: input });
  }
  public async SelectGameVersionV2(asset: string, input: GameSelectionV2Request): Promise<{ success: boolean; asset: GameAssetInfo }> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/assets/${asset}/selection_v2`, body: input });
  }
  public async CreateGameAssetV2(project: string, input: { idempotency_key: string; kind: "character_3d" | "anim_2d" | "anim_3d"; stable_key: string }): Promise<{ success: boolean; asset: GameAssetInfo }> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/assets/create_v2`, body: input });
  }
  public async ImportRiggedCharacterV2(asset: string, input: RiggedCharacterImportV2): Promise<GameValidationRunV2> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/assets/${asset}/versions/from-upload_v2`, body: input });
  }
  public async ValidateGameVersionV2(version: string, key: string): Promise<GameValidationRunV2> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${version}/validations_v2`, body: { idempotency_key: key } });
  }
  public async ListGameRunsV2(project: string, cursor?: string): Promise<{ success: boolean; items: import("./GameRunDetailsV2.js").GameRunInfoV2[]; next_cursor: string | null; has_more: boolean }> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/runs/list_v2`, query: { cursor, limit: 50 } });
  }
  public async GetGameRunDetailsV2(run: string, cursor?: string): Promise<GameRunDetailsV2> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/runs/${run}/details_v2`, query: { steps_cursor: cursor, steps_limit: 100 } });
  }
  public async GetCompleteGameRunDetailsV2(run: string, cancelled?: () => boolean): Promise<GameRunDetailsV2> {
    return readAllRunStepsV2(run, (cursor) => this.GetGameRunDetailsV2(run, cursor), cancelled);
  }
  /** Persist the same key after an uncertain response. This call never retries
   * or authorizes supplier submission on the caller's behalf. */
  public async ControlGameRunV2(run: string, action: "cancel" | "continue", key: string): Promise<GameRunControlV2> {
    const path = action === "cancel" ? `runs/${run}/cancel_v2` : `creations/${run}/continue_v2`;
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/${path}`, body: { idempotency_key: key } });
  }
  public async GetGameAssetVersionDetailsV2(version: string, cursor?: string): Promise<GameVersionDetailsV2> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${version}/details_v2`, query: { files_cursor: cursor, files_limit: 100 } });
  }
  public async GetCompleteGameAssetVersionDetailsV2(version: string, cancelled?: () => boolean): Promise<GameVersionDetailsV2> {
    return readAllVersionFilesV2(version, (cursor) => this.GetGameAssetVersionDetailsV2(version, cursor), cancelled);
  }
  public async DownloadVersionFileV2(project: string, file: GameVersionFileV2): Promise<Blob> {
    if (!file.available || !file.artifact_token || !file.sha256_hex || !/^[0-9a-f]{64}$/.test(file.sha256_hex)
      || !Number.isSafeInteger(file.byte_length) || Number(file.byte_length) <= 0) throw new GameAssetsApiError("此文件身份不完整或已不可用，请重新检查版本。", 409, "incomplete_file_set");
    const blob = await this.DownloadGameArtifact(project, file.artifact_token);
    if (blob.size !== file.byte_length) throw new GameAssetsApiError("文件大小与冻结版本不符，已停止预览。", 409, "artifact_integrity_mismatch");
    if (!globalThis.crypto?.subtle) throw new GameAssetsApiError("当前环境不能验证私有文件摘要，已停止预览。", 0, "integrity_check_unavailable");
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const hash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    if (hash !== file.sha256_hex) throw new GameAssetsApiError("文件摘要与冻结版本不符，已停止预览并清除确认。", 409, "artifact_integrity_mismatch");
    return blob;
  }
  public async ListAssetBriefs(project: string, cursor?: string): Promise<GamePage<GameAssetBriefInfo>> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/asset_briefs`, query: { maybe_cursor: cursor, maybe_limit: 100 } });
  }
  public async CreateAssetBriefs(project: string, items: { kind: string; brief: GameAssetBrief }[], key: string): Promise<GamePage<GameAssetBriefInfo>> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/asset_briefs`, body: { items, maybe_idempotency_key: key } });
  }
  public async UpdateAssetBrief(project: string, asset: string, brief: GameAssetBrief, revision: number): Promise<{ item: GameAssetBriefInfo }> {
    return this.fetch(`${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/asset_briefs/${asset}`, { method: "PUT", body: { expected_revision: revision, brief } });
  }
  public async StartCreationBatch(project: string, plans: { plan_token: string; plan_hash_hex: string }[], key: string): Promise<{ starts: { run_token: string; asset_token: string }[] }> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/creation_batches`, body: { plans, acknowledge_estimate: true, maybe_idempotency_key: key } });
  }
  public async PrepareCreation(project: string, input: GameCreationInput): Promise<GameCreationPlan> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/creation_plans`, body: input });
  }
  public async StartCreation(project: string, plan: GameCreationPlan, key: string): Promise<{ run_token: string; asset_token: string }> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/creations`, body: {
      plan_token: plan.plan_token, plan_hash_hex: plan.plan_hash_hex, acknowledge_estimate: true, maybe_idempotency_key: key,
    } });
  }
  public async ListCreationRuns(project: string, cursor?: string): Promise<GamePage<GameCreationRun>> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/creations`, query: { maybe_cursor: cursor, maybe_limit: 30 } });
  }
  public async GetCreationRun(token: string): Promise<{ run: GameCreationRun }> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/creation_runs/${token}` });
  }
  public async ControlCreation(token: string, action: "cancel" | "continue"): Promise<{ run: GameCreationRun }> {
    return this.post({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/creation_runs/${token}/${action}`, body: {} });
  }
  /** Preserve structured errors and false/zero query values for this API. */
  public override async fetch<B, T>(
    endpoint: string,
    { method, query, body }: {
      method: string;
      query?: Record<string, string | boolean | number | undefined>;
      body?: B;
    },
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : "";
    const response = await this.send(`${endpoint}${suffix}`, {
      method,
      headers: buildSessionHeaders({ Accept: "application/json", "Content-Type": "application/json" }),
      credentials: "include",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    await this.ensureSuccess(response, !["GET", "HEAD"].includes(method.toUpperCase()));
    try { return normalizeAssetPayload(await response.json()) as T; }
    catch { throw new GameAssetsApiError("素材服务返回了无法读取的结果。请先刷新状态，再重试当前操作。", response.status, "invalid_response"); }
  }

  public async GetGameProject(projectToken: string): Promise<{ project: GameProjectInfo }> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}` });
  }

  public async RenameGameProject(projectToken: string, name: string, expectedRevision: number): Promise<{ project: GameProjectInfo }> {
    return this.fetch(`${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}`, {
      method: "PATCH", body: { expected_revision: expectedRevision, maybe_name: name },
    });
  }

  public async GetGameProjectProfile(profileToken: string): Promise<{ profile: GameProjectProfileInfo }> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/profiles/${profileToken}` });
  }

  public async ListGameProjectProfiles(
    projectToken: string,
    cursor?: string,
  ): Promise<GamePage<GameProjectProfileInfo>> {
    return this.get({
      endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/profiles`,
      query: { maybe_limit: 50, maybe_cursor: cursor },
    });
  }

  /** GET /v1/game_assets/capabilities — call before anything else. */
  public async GetCapabilities(): Promise<GameAssetsCapabilities> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/capabilities`;
    return this.get<GameAssetsCapabilities>({ endpoint });
  }

  /** POST /v1/game_assets/projects — create a project (idempotent). */
  public async CreateGameProject(
    input: CreateGameProjectInput,
  ): Promise<CreateGameProjectResponse> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects`;
    return this.post<CreateGameProjectInput, CreateGameProjectResponse>({
      endpoint,
      body: input,
    });
  }

  /**
   * GET /v1/game_assets/projects — keyset-paginated owned projects.
   *
   * NB: the shared ApiManager transport drops falsy query values, so
   * `maybe_include_archived: false` is equivalent to omitting it (the
   * server default). Only send it as `true`.
   */
  public async ListProjects(
    query: ListGameProjectsQuery = {},
  ): Promise<ListGameProjectsResponse> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects`;
    return this.get<ListGameProjectsResponse>({
      endpoint,
      query: {
        maybe_cursor: query.maybe_cursor,
        maybe_limit: query.maybe_limit,
        maybe_include_archived: query.maybe_include_archived,
      },
    });
  }

  // ── Profiles (freeze the per-kind specs a version is produced under) ──

  public async PublishGameProjectProfile(
    projectToken: string,
    input: {
      schema_version: number;
      profile_json: Record<string, unknown>;
      references: unknown[];
      maybe_expected_revision?: number;
      maybe_idempotency_key?: string;
    },
  ): Promise<{ success: boolean; profile: GameProjectProfileInfo }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/profiles`;
    return this.post<typeof input, { success: boolean; profile: GameProjectProfileInfo }>({ endpoint, body: input });
  }

  // ── Assets & versions ──

  public async CreateGameAsset(
    projectToken: string,
    input: { stable_key: string; kind: string; maybe_idempotency_key?: string },
  ): Promise<{ success: boolean; asset: GameAssetInfo }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/assets`;
    return this.post<typeof input, { success: boolean; asset: GameAssetInfo }>({
      endpoint,
      body: input,
    });
  }

  public async ListGameAssets(
    projectToken: string,
    options: string | ListGameAssetsOptions = {},
  ): Promise<GamePage<GameAssetInfo>> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/assets`;
    const query = typeof options === "string" ? { maybe_cursor: options } : options;
    return this.get({ endpoint, query: { ...query, maybe_limit: query.maybe_limit ?? 100,
      maybe_tag: query.maybe_tag === undefined ? undefined : normalizeGameAssetTag(query.maybe_tag) } });
  }

  public async GetGameAsset(asset: string): Promise<{ asset: GameAssetInfo }> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/assets/${asset}` });
  }

  public async ReplaceGameAssetTags(asset: string, tags: string[], expectedRevision: number, key?: string): Promise<{ success: boolean; asset: GameAssetInfo }> {
    return this.fetch(`${this.getApiSchemeAndHost()}/v1/game_assets/assets/${asset}/tags`, {
      method: "PUT", body: { tags: normalizeGameAssetTags(tags), expected_revision: expectedRevision, maybe_idempotency_key: key },
    });
  }

  public async ListProjectAssetTags(project: string, options: { maybe_cursor?: string; maybe_limit?: number } = {}): Promise<GamePage<string>> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${project}/asset-tags`, query: options });
  }

  public async ArchiveGameAsset(asset: GameAssetInfo, archived: boolean): Promise<{ asset: GameAssetInfo }> {
    return this.fetch(`${this.getApiSchemeAndHost()}/v1/game_assets/assets/${asset.token}`, {
      method: "PATCH", body: { expected_revision: asset.revision, maybe_archived: archived },
    });
  }

  public async ListGameAssetVersions(
    assetToken: string,
    cursor?: string,
  ): Promise<GamePage<GameAssetVersionInfo>> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/assets/${assetToken}/versions`;
    return this.get({ endpoint, query: { maybe_limit: 50, maybe_cursor: cursor } });
  }

  public async GetGameAssetVersion(versionToken: string): Promise<{
    version: GameAssetVersionInfo;
    files: GameVersionFileInfo[];
  }> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${versionToken}` });
  }

  public async AdoptGameAssetVersion(
    asset: GameAssetInfo,
    versionToken: string,
  ): Promise<{ asset: GameAssetInfo }> {
    return this.fetch(`${this.getApiSchemeAndHost()}/v1/game_assets/assets/${asset.token}`, {
      method: "PATCH",
      body: { expected_revision: asset.revision, maybe_current_version_token: versionToken },
    });
  }

  public async ClearGameAssetSelection(asset: GameAssetInfo, key: string): Promise<{ asset: GameAssetInfo }> {
    if (!asset.maybe_current_version_token) throw new Error("这个资产还没有交付选择。");
    return this.post({
      endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/assets/${asset.token}/delivery_selection/clear`,
      body: { expected_revision: asset.revision, expected_version_token: asset.maybe_current_version_token, maybe_idempotency_key: key },
    });
  }

  public async DownloadGameArtifact(projectToken: string, artifactToken: string): Promise<Blob> {
    const response = await this.send(
      `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/artifacts/${artifactToken}/content`,
      { headers: buildSessionHeaders({}), credentials: "include" },
    );
    await this.ensureSuccess(response);
    return response.blob();
  }

  // ── Uploads (three-step sealed session: create → raw PUT → complete) ──

  public async CreateGameUpload(
    projectToken: string,
    input: {
      expected_size: number;
      expected_sha256_hex: string;
      expected_mime: string;
      maybe_idempotency_key?: string;
    },
  ): Promise<{ success: boolean; upload: GameUploadInfo; content_path: string }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/uploads`;
    return this.post<typeof input, { success: boolean; upload: GameUploadInfo; content_path: string }>({
      endpoint,
      body: input,
    });
  }

  /** Raw-binary PUT of the upload body (NOT JSON — bypasses fetch()). */
  public async PutGameUploadContent(contentPath: string, bytes: ArrayBuffer): Promise<void> {
    if (!/^\/v1\/game_assets\/uploads\/[a-zA-Z0-9_]+\/content$/.test(contentPath)) {
      throw new Error("上传地址不属于当前素材服务，请刷新后重试。");
    }
    const response = await this.send(`${this.getApiSchemeAndHost()}${contentPath}`, {
      method: "PUT",
      headers: buildSessionHeaders({ "Content-Type": "application/octet-stream" }),
      credentials: "include",
      body: bytes,
    });
    await this.ensureSuccess(response, true);
  }

  public async CompleteGameUpload(
    uploadToken: string,
  ): Promise<{ success: boolean; upload: GameUploadInfo }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/uploads/${uploadToken}/complete`;
    return this.post<Record<string, never>, { success: boolean; upload: GameUploadInfo }>({
      endpoint,
      body: {},
    });
  }

  public async CreateGameAssetVersionFromUpload(
    assetToken: string,
    input: { game_upload_token: string; maybe_display_name?: string; maybe_profile_token?: string; maybe_idempotency_key?: string },
  ): Promise<{ success: boolean; version: GameAssetVersionInfo; files: unknown[] }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/assets/${assetToken}/versions/from-upload`;
    return this.post<typeof input, { success: boolean; version: GameAssetVersionInfo; files: unknown[] }>({
      endpoint,
      body: input,
    });
  }

  // ── Review gate & technical validation ──

  public async ListReviews(
    versionToken: string,
  ): Promise<{ success: boolean; events: ReviewEventInfo[] }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${versionToken}/reviews`;
    return this.get({ endpoint, query: { maybe_limit: 20 } });
  }

  public async SubmitReview(
    versionToken: string,
    input: {
      decision: string;
      maybe_rejection_kind?: string;
      maybe_reason?: string;
      maybe_idempotency_key?: string;
    },
  ): Promise<{ success: boolean; review: ReviewEventInfo }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${versionToken}/reviews`;
    return this.post<typeof input, { success: boolean; review: ReviewEventInfo }>({
      endpoint,
      body: input,
    });
  }

  public async CreateValidation(
    versionToken: string,
    input: { maybe_idempotency_key?: string },
  ): Promise<{ success: boolean; report: ValidationReportInfo }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${versionToken}/validations`;
    return this.post<typeof input, { success: boolean; report: ValidationReportInfo }>({
      endpoint,
      body: input,
    });
  }

  public async ListValidations(
    versionToken: string,
  ): Promise<{ items: ValidationReportInfo[]; has_more: boolean }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/versions/${versionToken}/validations`;
    return this.get({ endpoint, query: { maybe_limit: 20 } });
  }

  // ── Exports (gate runs server-side at create; ZIP download on success) ──

  public async CreateGameExport(
    projectToken: string,
    input: {
      selections: { asset_token: string; version_token: string }[];
      export_kinds: string[];
      maybe_idempotency_key?: string;
    },
  ): Promise<{ success: boolean; exports: GameExportInfo[] }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/exports`;
    return this.post<typeof input, { success: boolean; exports: GameExportInfo[] }>({
      endpoint,
      body: input,
    });
  }

  public async GetGameExport(
    exportToken: string,
  ): Promise<{
    success: boolean;
    export: GameExportInfo;
    selection: unknown;
    maybe_manifest: Record<string, unknown> | null;
    maybe_gating: Record<string, unknown> | null;
  }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/exports/${exportToken}`;
    return this.get({ endpoint });
  }

  public async ListProjectExports(
    projectToken: string,
  ): Promise<{ items: GameExportInfo[]; has_more: boolean }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/exports`;
    return this.get({ endpoint, query: { maybe_limit: 20 } });
  }

  public async ListEngineReports(exportToken: string): Promise<{ items: GameEngineReportInfo[]; has_more: boolean }> {
    return this.get({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/exports/${exportToken}/engine-reports`, query: { maybe_limit: 50 } });
  }

  public async SubmitEngineReport(exportToken: string, input: {
    importer_version: string; report: Record<string, unknown>; trust_level: "self_reported"; maybe_idempotency_key: string;
  }): Promise<{ success: boolean; report: GameEngineReportInfo }> {
    return this.post<typeof input, { success: boolean; report: GameEngineReportInfo }>({ endpoint: `${this.getApiSchemeAndHost()}/v1/game_assets/exports/${exportToken}/engine-reports`, body: input });
  }

  // ── Exports v2 (manifest 2.0 delivery closure) ──

  /** Resolves the exact-version delivery closure; conflicts ride on the
   * error envelope (code rig_version_conflict, details.conflicts). */
  public async PrepareGameExportV2(
    projectToken: string,
    input: { idempotency_key: string; selections: GameExportSelectionItemV2[] },
  ): Promise<PreparedGameExportV2> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/exports/prepare_v2`;
    return this.post<typeof input, PreparedGameExportV2>({ endpoint, body: input });
  }

  /** Commits a prepared closure as one frozen export per target engine. */
  public async CreateGameExportV2(
    projectToken: string,
    input: CreateGameExportV2Request,
  ): Promise<{ success: boolean; exports: GameExportInfo[]; manifest_schema_version: string; closure_hash: string }> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/projects/${projectToken}/exports/create_v2`;
    return this.post<typeof input, { success: boolean; exports: GameExportInfo[]; manifest_schema_version: string; closure_hash: string }>({
      endpoint,
      body: input,
    });
  }

  /** Reads the fixed exports-v2 snapshot (frozen selection, gating,
   * schema, manifest, build status and errors). */
  public async GetGameExportDetailsV2(exportToken: string): Promise<GameExportDetailsV2> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/exports/${exportToken}/details_v2`;
    return this.get({ endpoint });
  }

  /** Streams the built pack ZIP as a blob (session cookie auth). */
  public async DownloadGameExport(exportToken: string): Promise<Blob> {
    const endpoint = `${this.getApiSchemeAndHost()}/v1/game_assets/exports/${exportToken}/download`;
    const response = await this.send(endpoint, {
      headers: buildSessionHeaders({ Accept: "application/zip" }),
      credentials: "include",
    });
    await this.ensureSuccess(response);
    return response.blob();
  }

  private async send(endpoint: string, options: RequestInit): Promise<Response> {
    try { return await FetchProxy(endpoint, options); }
    catch {
      const mutating = options.method && !["GET", "HEAD"].includes(options.method);
      throw new GameAssetsApiError(
        mutating ? "素材服务连接中断，请求结果暂未确认。请刷新状态，或重试当前操作以继续。" : "素材服务暂时无法连接，请检查服务状态后重试。",
        0,
        "connection_failed",
      );
    }
  }

  private async ensureSuccess(response: Response, mutation = false): Promise<void> {
    if (response.ok) return;
    let payload: Record<string, unknown> = {};
    try { payload = await response.json(); } catch { /* A proxy may return HTML instead of JSON. */ }
    const detail = typeof payload.error === "object" && payload.error !== null
      ? payload.error as Record<string, unknown> : payload;
    const message = detail.message ?? payload.error_message ?? payload.message;
    const code = typeof detail.code === "string" ? detail.code : undefined;
    const uncertain = mutation && response.status >= 500;
    const fallback = uncertain
      ? `素材服务返回错误（HTTP ${response.status}），请求结果暂未确认。请刷新状态或重试当前请求。`
      : `请求未完成（HTTP ${response.status}），请重试。`;
    throw new GameAssetsApiError(
      typeof message === "string" ? `${message}${uncertain ? " 请求结果暂未确认，请刷新状态或重试当前请求。" : ""}` : fallback,
      response.status,
      code,
      typeof detail.retryable === "boolean" ? detail.retryable : undefined,
      typeof detail.details === "object" && detail.details !== null && !Array.isArray(detail.details) ? detail.details as Record<string, unknown> : undefined,
    );
  }
}

/** Only hydrate asset projections. Frozen profiles/plans and replay bodies remain data. */
function normalizeAssetPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const result = payload as Record<string, unknown>;
  const asset = (value: unknown) => {
    if (!value || typeof value !== "object" || !("stable_key" in value) || !("project_token" in value)) return value;
    const row = value as GameAssetInfo;
    return { ...row, tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [] };
  };
  return { ...result, ...(result.asset ? { asset: asset(result.asset) } : {}),
    ...(Array.isArray(result.items) ? { items: result.items.map(asset) } : {}) };
}
export * from "./GenerationConnectorsApi.js";
