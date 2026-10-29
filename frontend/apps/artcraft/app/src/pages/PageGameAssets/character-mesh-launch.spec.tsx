import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  GameAssetsApi,
  GameAssetsApiError,
  GenerationConnectorsApi,
  type GameAssetsCapabilities,
  type GameAssetInfo,
  type GameAssetVersionInfo,
  type GameProjectProfileInfo,
  type GameVersionDetailsV2,
  type GenerationConnector,
  type PreparedCharacterMeshV2,
} from "@storyteller/api";
import { CharacterMeshLaunch } from "./CharacterMeshLaunch";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it("renders nothing while the instance has not enabled character mesh preparation", () => {
  const api = new GameAssetsApi();
  render(launch(api, { kind_capabilities: { character_3d: { operations: { prepare_mesh_v2: { enabled: false, reason: "此实例尚未开放角色 mesh 计划准备。" } } } } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(vi.spyOn(api, "PrepareCharacterMeshV2")).not.toHaveBeenCalled();
});

it("requires an explicitly approved concept and prepares with that exact version as source and parent", async () => {
  const api = new GameAssetsApi();
  const prepare = vi.spyOn(api, "PrepareCharacterMeshV2").mockResolvedValue(prepared());
  render(launch(api));
  await screen.findByRole("option", { name: /第 2 版概念 · 可制作/ });
  expect(screen.getByRole("option", { name: /第 1 版概念/ })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("概念版本来源"), { target: { value: "concept_ok" } });
  fireEvent.click(screen.getByRole("button", { name: "查看制作说明与费用" }));
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  const input = prepare.mock.calls[0][1];
  expect(input.maybe_source_version_token).toBe("concept_ok");
  expect(input.maybe_parent_version_token).toBe("concept_ok");
  expect(input.maybe_target_asset_token).toBe("asset");
  expect(input.expected_revision).toBe(7);
  expect(input.connector_token).toBe("conn");
  expect(input.kind).toBe("character_3d");
  expect(input.operation).toBe("mesh");
  expect(input.candidate_count).toBe(1);
  expect(input.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

it("shows per-step estimates as non-binding, explains unknown estimates and blocks start until every paid step is confirmed", async () => {
  const api = new GameAssetsApi();
  vi.spyOn(api, "PrepareCharacterMeshV2").mockResolvedValue(prepared([
    ["mesh", "Tripo/Tripo-P1.0", 50, null, "h_mesh"],
    ["rig", "Tripo/Tripo-AutoRig", null, null, "h_rig"],
    ["rig_check", "Tripo/Tripo-RigCheck", 0, 0, "h_check"],
  ]));
  const start = vi.spyOn(api, "StartCharacterMeshV2");
  render(launch(api));
  await screen.findByRole("option", { name: /第 2 版概念 · 可制作/ });
  fireEvent.change(screen.getByLabelText("概念版本来源"), { target: { value: "concept_ok" } });
  fireEvent.click(screen.getByRole("button", { name: "查看制作说明与费用" }));
  expect(await screen.findByText(/预计 50 bailian_tripo_credit（估计值，非供应商保证的硬上限）/)).toBeTruthy();
  expect(screen.getByText(/费用未知：供应商尚未给出此步骤的估算；未知不等于免费，需先对账确认。/)).toBeTruthy();
  expect(screen.getByText(/此步骤不产生供应商费用。/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "确认费用并开始制作" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /我确认授权“生成模型”/ }));
  expect((screen.getByRole("button", { name: "确认费用并开始制作" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /我确认授权“自动绑骨”/ }));
  expect((screen.getByRole("button", { name: "确认费用并开始制作" }) as HTMLButtonElement).disabled).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

it("keeps the same idempotency key when the paid start response stays uncertain", async () => {
  const api = new GameAssetsApi();
  vi.spyOn(api, "PrepareCharacterMeshV2").mockResolvedValue(prepared());
  const start = vi.spyOn(api, "StartCharacterMeshV2")
    .mockRejectedValueOnce(new GameAssetsApiError("素材服务返回错误（HTTP 503），请求结果暂未确认。", 503, "processing_unavailable"))
    .mockResolvedValueOnce({ success: true, run_token: "run", asset_token: "asset" });
  const onStarted = vi.fn();
  render(launch(api, {}, onStarted));
  await screen.findByRole("option", { name: /第 2 版概念 · 可制作/ });
  fireEvent.change(screen.getByLabelText("概念版本来源"), { target: { value: "concept_ok" } });
  fireEvent.click(screen.getByRole("button", { name: "查看制作说明与费用" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /我确认授权“生成模型”/ }));
  fireEvent.click(screen.getByRole("button", { name: "确认费用并开始制作" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "素材服务返回错误（HTTP 503），请求结果暂未确认。");
  const pendingKey = "ga_pending_character_mesh_start:project:plan";
  const firstRequest = start.mock.calls[0][1];
  expect(JSON.parse(localStorage.getItem(pendingKey) ?? "null")).toEqual({ key: firstRequest.idempotency_key });
  fireEvent.click(screen.getByRole("button", { name: "重试同一提交，确认结果" }));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(start.mock.calls[1][1]).toEqual(firstRequest);
  await waitFor(() => expect(localStorage.getItem(pendingKey)).toBeNull());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("project", "run", "asset"));
  expect(await screen.findByText("制作任务已提交")).toBeTruthy();
});

function launch(api: GameAssetsApi, capabilityOverrides: Partial<GameAssetsCapabilities> = {}, onStarted: ReturnType<typeof vi.fn> = vi.fn()) {
  const connectors: GenerationConnector[] = [{ token: "conn", provider: "bailian_tripo", display_name: "百炼项目账号", enabled: true, archived: false, configuration: {}, has_credential: true, credential_state: "configured" }];
  vi.spyOn(GenerationConnectorsApi.prototype, "ListAll").mockResolvedValue(connectors);
  vi.spyOn(api, "GetGameAssetVersionDetailsV2").mockImplementation(async (version) => ({
    gate: version === "concept_ok" ? { source_gate_passed: true } : { source_gate_passed: false },
  }) as GameVersionDetailsV2);
  const capabilities: GameAssetsCapabilities = {
    success: true, api_version: "game_assets.v1", manifest_schema_version: "1", asset_kinds: ["icon_2d", "sprite_2d", "prop_3d"], pipelines: [], export_targets: [], max_page_size: 100,
    kind_capabilities: { character_3d: { operations: { prepare_mesh_v2: { enabled: true }, start_v2: { enabled: true } } } },
    ...capabilityOverrides,
  };
  return <CharacterMeshLaunch api={api} project="project" profile={profile()} capabilities={capabilities} assets={[asset()]}
    initialAsset="asset" onStarted={onStarted} onClose={vi.fn()} />;
}

function asset(): GameAssetInfo & { versions: GameAssetVersionInfo[] } {
  return {
    token: "asset", project_token: "project", stable_key: "hero_knight", kind: "character_3d", tags: [], maybe_current_version_token: "concept_pending",
    revision: 7, maybe_archived_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    versions: [
      { token: "concept_pending", asset_token: "asset", version: 1, maybe_parent_version_token: null, profile_token: "profile", spec_json: { stage: "concept" }, created_by: "user", created_at: "2026-01-01T00:00:00Z" },
      { token: "concept_ok", asset_token: "asset", version: 2, maybe_parent_version_token: "concept_pending", profile_token: "profile", spec_json: { stage: "concept" }, created_by: "user", created_at: "2026-01-02T00:00:00Z" },
    ],
  };
}

function profile(): GameProjectProfileInfo {
  return { token: "profile", project_token: "project", version: 1, schema_version: 2, profile_json: {}, sha256_hex: "", created_by: "user", created_at: "2026-01-01T00:00:00Z" };
}

function prepared(stepSpecs: Array<[key: string, model: string, estimated: number | null, max: number | null, quoteHash: string]> = [["mesh", "Tripo/Tripo-P1.0", 50, null, "h_mesh"]]): PreparedCharacterMeshV2 {
  return {
    success: true, plan_token: "plan", plan_hash_hex: "a".repeat(64), expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), making: {},
    quote: {
      billing_mode: "provider_account", unit: "bailian_tripo_credit", maximum_supplier_calls: 1, maybe_max_chargeable: null, authorizes_submission: false,
      delivery_urls: "resolved_at_execution_from_same_artifacts",
      limitation: "估计不是供应商保证的费用硬上限；此准备请求不授权提交或额外重试。",
      steps: stepSpecs.map(([key, model, estimated, max, quoteHash]) => ({ key, model, maximum_calls: 1 as const, quote_hash: quoteHash,
        quote: { unit: "bailian_tripo_credit", estimated_amount: estimated, maybe_max_chargeable: max, maybe_pricing_source: null }, after: null, native_request_template: {} })),
    },
    resolved_inputs: {
      source_version_token: "concept_ok",
      check: { version_token: "concept_ok", artifact_set_hash: "1".repeat(64), spec_hash: "2".repeat(64), profile_hash: "3".repeat(64), dependency_snapshot_hash: "4".repeat(64), validator_version: "game.validate.character3d.concept.v1" },
      report_token: "report", review_token: "review", provider_contract: "bailian_tripo_v1",
      views: [{ view: "front", role: "source", ordinal: 0, material: { artifact_token: "a1", sha256: "1", byte_length: 1, mime: "image/png" }, width: 512, height: 512 },
        { view: "side", role: "source", ordinal: 1, material: { artifact_token: "a2", sha256: "2", byte_length: 1, mime: "image/png" }, width: 512, height: 512 },
        { view: "back", role: "source", ordinal: 2, material: { artifact_token: "a3", sha256: "3", byte_length: 1, mime: "image/png" }, width: 512, height: 512 }],
    },
  };
}
