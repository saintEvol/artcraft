import type { GameCheckContextV2 } from "./GameVersionDetailsV2.js";

export interface GameCharacterMeshParametersV2 {
  model: "Tripo/Tripo-P1.0" | "Tripo/Tripo-H3.1";
  side_orientation: "left" | "right";
  texture_quality: "standard" | "detailed" | "extreme";
  face_limit: number;
  geometry_quality?: "standard" | "ultra" | null;
}

/** Free preparation only; this request does not authorize paid submission. */
export interface PrepareCharacterMeshV2 {
  kind: "character_3d";
  operation: "mesh";
  candidate_count: 1;
  profile_token: string;
  maybe_target_asset_token: string;
  expected_revision: number;
  maybe_source_version_token: string;
  maybe_parent_version_token: string;
  connector_token: string;
  mesh_parameters: GameCharacterMeshParametersV2;
  idempotency_key: string;
}

export interface GameCreationMaterialV2 {
  artifact_token: string;
  sha256: string;
  byte_length: number;
  mime: string;
}

export interface PreparedCharacterMeshV2 {
  success: boolean;
  plan_token: string;
  plan_hash_hex: string;
  expires_at: string;
  making: Record<string, unknown>;
  quote: {
    billing_mode: "provider_account";
    unit: "bailian_tripo_credit";
    maximum_supplier_calls: 1;
    maybe_max_chargeable: null;
    authorizes_submission: false;
    delivery_urls: "resolved_at_execution_from_same_artifacts";
    limitation: string;
    steps: Array<{
      key: string;
      model: string;
      maximum_calls: 1;
      quote_hash: string;
      quote: { unit: string; estimated_amount: number | null; maybe_max_chargeable: number | null; maybe_pricing_source: string | null };
      after: string | null;
      native_request_template: Record<string, unknown>;
    }>;
  };
  resolved_inputs: {
    source_version_token: string;
    check: GameCheckContextV2;
    report_token: string;
    review_token: string;
    provider_contract: string;
    views: Array<{ view: "front" | "side" | "back"; role: "source"; ordinal: number; material: GameCreationMaterialV2; width: number; height: number }>;
  };
}

/** One independent authorization for every paid native step in the quote. */
export interface GameStepFeeAuthorizationV2 {
  step_key: string;
  quote_hash: string;
  /** A verified hard cap the caller accepts; null when the provider cannot guarantee one. */
  maximum_amount: number | null;
  /** Required for this native provider when it cannot guarantee a hard cap. */
  accepts_uncapped_estimate: boolean;
}

/** POST /v1/game_assets/projects/{project}/creations/start_v2 request.
 * Enqueues the exact prepared plan; a retry with the same key and identical
 * authorization returns the original run and never creates another paid execution. */
export interface StartCharacterMeshV2 {
  plan_token: string;
  plan_hash_hex: string;
  acknowledge_fees: boolean;
  fee_authorizations: GameStepFeeAuthorizationV2[];
  idempotency_key: string;
}

export interface StartedGameCreationV2 {
  success: boolean;
  run_token: string;
  asset_token: string;
}
