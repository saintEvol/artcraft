import { describe, expect, it } from "vitest";
import type { GameAssetBriefInfo, GameCreationPlan } from "@storyteller/api";
import { inputForBrief, quoteTotals } from "./asset-brief";

describe("saved requirement production contract", () => {
  it("creates the requested new object on its stable identity using the selected sample only as style", () => {
    const item: GameAssetBriefInfo = { asset_token: "target_key", project_token: "project", kind: "icon_2d", revision: 2, updated_at: "2026-10-27",
      brief: { display_name: "银钥匙", description: "一把银色钥匙", use_case: "背包 64px", preserve: "简洁轮廓", candidate_count: 1,
        maybe_style_source_version_token: "potion_sample", maybe_style_override: null, maybe_output_overrides: null, maybe_group_key: "group", maybe_group_name: "背包" } };
    const input = inputForBrief(item, "current_profile", "same_operation");
    expect(input.maybe_target_asset_token).toBe("target_key"); expect(input.description).toBe("一把银色钥匙");
    expect(input.maybe_source_version_token).toBe("potion_sample"); expect(input.maybe_reference_purpose).toBe("style");
    expect(input.profile_token).toBe("current_profile"); expect(input.maybe_output_overrides).toBeUndefined();
    expect(input.maybe_style_override).toBeUndefined(); expect(input.candidate_count).toBe(1);
  });

  it("keeps explicit physical size while leaving unspecified budgets to the project", () => {
    const input = inputForBrief({ asset_token: "barrel", project_token: "project", kind: "prop_3d", revision: 1, updated_at: "2026-10-27",
      brief: { display_name: "木桶", description: "封闭木桶", use_case: "营地", preserve: "", candidate_count: 1, maybe_output_overrides: { target_height_m: 1 } } }, "profile", "key");
    expect(input.maybe_output_overrides).toEqual({ target_height_m: 1 }); expect(input.operation).toBe("generate");
  });

  it("keeps currencies separate and exposes any unknown amount", () => {
    const plan = (amount: number | null): GameCreationPlan => ({ quote: { quote: { unit: "usd_micro", estimated_amount: amount, maybe_max_chargeable: null }, additional_estimates: [{ unit: "cny_micro", estimated_amount: 4000, maybe_max_chargeable: null }] } } as GameCreationPlan);
    expect(quoteTotals([plan(50000), plan(50000)])).toBe("USD 0.100000；CNY 0.008000");
    expect(quoteTotals([plan(null)])).toContain("尚未取得有效估算");
  });
});
