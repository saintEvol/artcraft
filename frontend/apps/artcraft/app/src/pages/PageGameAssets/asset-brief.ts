import type { GameAssetBriefInfo, GameCreationInput, GameCreationPlan } from "@storyteller/api";

export function inputForBrief(item: GameAssetBriefInfo, profile: string, key: string): GameCreationInput {
  const brief = item.brief;
  return { profile_token: profile, kind: item.kind, operation: "generate", display_name: brief.display_name,
    description: brief.description, use_case: brief.use_case, preserve: brief.preserve, candidate_count: brief.candidate_count,
    maybe_target_asset_token: item.asset_token, maybe_idempotency_key: key,
    ...(brief.maybe_style_override ? { maybe_style_override: brief.maybe_style_override } : {}),
    ...(brief.maybe_style_source_version_token ? { maybe_source_version_token: brief.maybe_style_source_version_token,
      maybe_reference_purpose: "style", maybe_override_project_reference: true } : {}),
    ...(brief.maybe_output_overrides ? { maybe_output_overrides: brief.maybe_output_overrides } : {}),
  };
}

export function quoteTotals(plans: GameCreationPlan[]): string {
  const amounts = new Map<string, number>(); let unknown = false;
  for (const plan of plans) for (const quote of [plan.quote.quote, ...(plan.quote.additional_estimates ?? [])]) {
    if (quote.estimated_amount === null) unknown = true;
    else amounts.set(quote.unit, (amounts.get(quote.unit) ?? 0) + quote.estimated_amount);
  }
  const money = [...amounts.entries()].map(([unit, amount]) => `${unit === "cny_micro" ? "CNY" : unit === "usd_micro" ? "USD" : unit} ${(amount / 1_000_000).toFixed(6)}`).join("；");
  return `${money}${unknown ? "；部分费用尚未取得有效估算" : ""}`;
}

export function readableOutput(plan: GameCreationPlan): string {
  const output = plan.making.output;
  return plan.making.kind === "prop_3d"
    ? `${plan.making.stage === "concept" ? "本轮先制作概念图；模型目标为" : "模型目标"} ${output.target_height_m} 米高，${output.max_triangles} 三角面，${output.max_texture_size}px 贴图`
    : `${output.canvas}×${output.canvas} 透明图，${output.content_inset_px}px 留白`;
}
