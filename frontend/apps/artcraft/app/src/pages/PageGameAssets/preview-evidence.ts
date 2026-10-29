import type { GamePreviewContextV2, GameVersionDetailsV2 } from "@storyteller/api";

export interface PreviewEvidence {
  decoded: boolean;
  instantiated: boolean;
  animation_bound: boolean;
  playback_observed: boolean;
  loop_checked: boolean;
  checked_directions: string[];
  looped_directions: string[];
  checked_views: string[];
  diagnostic_poses: string[];
  loaded_artifact_tokens: string[];
  error: string | null;
}

export function emptyPreviewEvidence(): PreviewEvidence {
  return { decoded: false, instantiated: false, animation_bound: false, playback_observed: false, loop_checked: false, checked_directions: [], looped_directions: [], checked_views: [], diagnostic_poses: [], loaded_artifact_tokens: [], error: null };
}

export function previewIdentity(detail: GameVersionDetailsV2): string {
  return JSON.stringify([detail.version.token, detail.asset.token, detail.asset.maybe_archived_at,
    detail.artifact_set_hash_hex, detail.dependency_snapshot_hash_hex, detail.gate.context,
    detail.gate.latest_report_token, detail.gate.latest_review_token, detail.preview_contract,
    detail.dependencies.map((dependency) => [dependency.target_version_token, dependency.rig_main_sha256_hex, dependency.target_asset_archived, dependency.current_gate_passed])]);
}

/** The caller supplies observed state; this function never promotes a loaded
 * file or checkbox into a rendering/playback fact. Human confirmation is
 * supplied separately only when submitting an otherwise complete preview. */
export function previewForReview(detail: GameVersionDetailsV2 | null, evidence: PreviewEvidence, poseIds: string[]): { preview: GamePreviewContextV2 | null; missing: string[] } {
  if (!detail) return { preview: null, missing: ["版本详情尚未读取"] };
  const missing: string[] = [], required = detail.preview_contract;
  if (detail.gate.technical_state !== "passed" || !detail.gate.context || !detail.gate.latest_report_token) missing.push("此版本的技术检查尚未通过");
  if (!detail.gate.file_contract_complete || !detail.gate.dependencies_valid) missing.push("文件或绑定角色不完整");
  if (detail.asset.maybe_archived_at || detail.dependencies.some((dependency) => dependency.target_asset_archived || !dependency.current_gate_passed)) missing.push("角色或依赖当前不可用于审核通过");
  if (evidence.error) missing.push(evidence.error);
  if (!evidence.decoded) missing.push("预览尚未实际解码");
  if (!required.artifact_tokens.length || required.artifact_tokens.some((token) => !evidence.loaded_artifact_tokens.includes(token))) missing.push("尚未解码全部要求的预览文件");
  if (required.requires_instantiation && !evidence.instantiated) missing.push("角色尚未实例化并渲染");
  if (required.requires_animation_binding && !evidence.animation_bound) missing.push("动作尚未绑定到本实例");
  if (required.requires_playback && !evidence.playback_observed) missing.push("尚未观察实际播放推进");
  if (required.required_directions.some((direction) => !evidence.checked_directions.includes(direction))) missing.push("尚未查看全部要求方向");
  if (required.required_views.some((view) => !evidence.checked_views.includes(view))) missing.push("尚未查看全部要求视图");
  const loopChecked = detail.asset.kind === "anim_2d" ? required.required_directions.every((direction) => evidence.looped_directions.includes(direction)) : evidence.loop_checked;
  if (required.requires_loop_check && !loopChecked) missing.push("尚未完整播放并观察循环边界");
  const deformation = poseIds.length > 0 && poseIds.every((pose) => evidence.diagnostic_poses.includes(pose));
  if (required.requires_deformation_probe && !deformation) missing.push("尚未在本角色上渲染全部诊断姿势");
  if (missing.length || !detail.gate.context || !detail.gate.latest_report_token) return { preview: null, missing };
  return { missing: [], preview: { check: detail.gate.context, report_token: detail.gate.latest_report_token,
    preview_contract_version: required.version, loaded_artifact_tokens: required.artifact_tokens,
    rig_version_token: required.rig_version_token, decoded: evidence.decoded, instantiated: evidence.instantiated,
    animation_bound: evidence.animation_bound, playback_observed: evidence.playback_observed, human_confirmed: false,
    checked_directions: required.required_directions, checked_views: required.required_views,
    loop_checked: required.requires_loop_check && loopChecked, deformation_probe_confirmed: required.requires_deformation_probe && deformation } };
}
