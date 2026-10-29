import type { GameAssetInfo, GameAssetVersionInfo, GameVersionFileInfo } from "./GameAssetsApi.js";

export interface GameCheckContextV2 {
  version_token: string; artifact_set_hash: string; spec_hash: string;
  profile_hash: string; dependency_snapshot_hash: string; validator_version: string;
}
export interface GamePreviewContextV2 {
  check: GameCheckContextV2;
  report_token: string;
  preview_contract_version: string;
  loaded_artifact_tokens: string[];
  rig_version_token: string | null;
  decoded: boolean;
  instantiated: boolean;
  animation_bound: boolean;
  playback_observed: boolean;
  human_confirmed: boolean;
  checked_directions: string[];
  checked_views: string[];
  loop_checked: boolean;
  deformation_probe_confirmed: boolean;
}

export interface GameReviewV2Request {
  idempotency_key: string;
  decision: "passed" | "rejected" | "revoked";
  maybe_rejection_kind?: "style_mismatch" | "subject_wrong" | "technical_quality" | "other";
  maybe_reason?: string;
  preview_context?: GamePreviewContextV2;
}
export interface GameReviewV2Response {
  success: boolean; version_token: string; review_token: string;
  decision: "passed" | "rejected" | "revoked"; report_token: string | null;
}
export interface GameSelectionV2Request {
  idempotency_key: string; expected_revision: number; version_token: string;
  check: GameCheckContextV2; report_token: string; review_token: string;
}
export interface GameVersionFileV2 extends Omit<GameVersionFileInfo, "artifact_token"> {
  version_token: string; artifact_token: string | null; kind: string | null;
  sha256_hex: string | null; byte_length: number | null; mime: string | null; available: boolean;
}
export interface GameVersionDependencyV2 {
  role: "rig"; target_asset_token: string; target_version_token: string;
  target_asset_stable_key: string; target_display_name: string; target_version_number: number;
  target_artifact_set_hash_hex: string; rig_main_sha256_hex: string;
  target_asset_current_version_token: string | null; target_asset_archived: boolean;
  bound_version_is_current: boolean; current_gate_passed: boolean;
}
export interface GamePreviewContractV2 {
  version: string; artifact_tokens: string[]; rig_version_token: string | null;
  required_directions: string[]; required_views: string[]; requires_instantiation: boolean;
  requires_animation_binding: boolean; requires_playback: boolean; requires_loop_check: boolean;
  requires_deformation_probe: boolean;
}
export interface GameVersionGateV2 {
  technical_state: string; review_state: string; stage_eligible: boolean; file_contract_complete: boolean;
  dependencies_valid: boolean; source_gate_passed: boolean; delivery_gate_passed: boolean;
  can_select: boolean; reasons: string[]; context: GameCheckContextV2 | null;
  latest_report_token: string | null; latest_report_status: string | null;
  latest_review_token: string | null; latest_review_decision: string | null;
}
export interface GameVersionDetailsV2 {
  success: boolean; asset: GameAssetInfo; version: GameAssetVersionInfo; stage: string;
  files: GameVersionFileV2[]; files_next_cursor: string | null; files_has_more: boolean;
  files_total_count: number;
  preview_files: GameVersionFileV2[]; dependencies: GameVersionDependencyV2[];
  artifact_set_hash_hex: string | null; dependency_snapshot_hash_hex: string | null;
  gate: GameVersionGateV2; preview_contract: GamePreviewContractV2;
}

/** Completes the advertised list; invalid/repeated cursors and changed context
 * fail explicitly rather than returning an apparently complete first page. */
export async function readAllVersionFilesV2(
  version: string,
  getPage: (cursor?: string) => Promise<GameVersionDetailsV2>,
  cancelled: () => boolean = () => false,
): Promise<GameVersionDetailsV2> {
  const first = await getPage();
  if (!Number.isSafeInteger(first.files_total_count) || first.files_total_count < 0 || first.files_total_count > 10000) throw new Error("此版本超出自动完整读取预算，请按分页检查文件。");
  const identity = pageIdentity(first);
  const files: GameVersionFileV2[] = [];
  const cursors = new Set<string>(), bindings = new Set<string>();
  let page = first;
  for (;;) {
    if (cancelled()) throw new Error("版本读取已取消。");
    if (page.version.token !== version || page.asset.token !== first.asset.token || pageIdentity(page) !== identity) throw new Error("版本文件或检查上下文在分页读取中改变，请刷新后重新读取。");
    if (page.files_has_more !== (page.files_next_cursor !== null) || page.files.length > 100 || (page !== first && page.files.length === 0)) throw new Error("服务端文件分页合同不完整。");
    for (const file of page.files) {
      const key = `${file.role}:${file.ordinal}`;
      if (file.version_token !== version || bindings.has(key)) throw new Error("文件分页包含错误版本或重复的绑定。");
      bindings.add(key); files.push(file);
    }
    if (files.length > 10000) throw new Error("此版本超出自动完整读取预算。");
    if (!page.files_has_more) break;
    const cursor = page.files_next_cursor!;
    if (!cursor || cursors.has(cursor) || page.files.length === 0 || files.length > 10000) throw new Error("文件分页无法继续；结果未被当作完整集合。");
    cursors.add(cursor);
    page = await getPage(cursor);
  }
  if (files.length !== first.files_total_count) throw new Error("服务端未返回声明的完整文件集合，请刷新后重新读取。");
  return { ...first, files, files_next_cursor: null, files_has_more: false };
}

function pageIdentity(page: GameVersionDetailsV2): string {
  return JSON.stringify([page.files_total_count, page.artifact_set_hash_hex, page.dependency_snapshot_hash_hex,
    page.gate, page.dependencies, page.preview_contract]);
}
