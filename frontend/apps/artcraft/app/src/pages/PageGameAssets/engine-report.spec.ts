import { describe, expect, it } from "vitest";
import { comparePacks, reportOperationKey, validateEngineReport } from "./engine-report";

const ASSET = { asset_id: "a", stable_key: "key", version_id: "v1", kind: "icon_2d", files: [{ path: "main.png", sha256: "hash" }] };
const MANIFEST = { pack_id: "p", engine_profiles: [{ engine: "godot", engine_version: "4.7.2" }], assets: [ASSET] };
const REPORT = { schema_version: "game-assets-engine-report.v1", pack_id: "p", engine: "godot", engine_version: "4.7.2", importer_version: "0.2.0", operation: "runtime", status: "succeeded", rendered: true, problems: [], assets: [{ asset_id: "a", version_id: "v1", status: "loaded" }] };

describe("engine evidence", () => {
  it("binds a local report to the exact pack, engine and versions", () => {
    expect(validateEngineReport(REPORT, MANIFEST, "godot")).toBe(REPORT);
    for (const value of [{ ...REPORT, pack_id: "other" }, { ...REPORT, engine: "bevy" }, { ...REPORT, assets: [{ asset_id: "a", version_id: "old" }] }]) expect(() => validateEngineReport(value, MANIFEST, "godot")).toThrow();
  });
  it("accepts a Cocos Creator report only against the matching cocos profile", () => {
    const manifest = { ...MANIFEST, engine_profiles: [{ engine: "cocos", engine_version: "3.8.8" }] };
    const report = { ...REPORT, engine: "cocos", engine_version: "3.8.8", importer_version: "game_assets_cocos_1@0.1.0" };
    expect(validateEngineReport(report, manifest, "cocos")).toBe(report);
    expect(() => validateEngineReport(report, manifest, "godot")).toThrow();
    expect(() => validateEngineReport({ ...report, engine_version: "3.8.7" }, manifest, "cocos")).toThrow();
  });
  it("does not accept missing or failed resources as success", () => {
    for (const value of [{ ...REPORT, assets: [] }, { ...REPORT, assets: [{ asset_id: "a", version_id: "v1", status: "failed" }] }, { ...REPORT, problems: ["texture missing"] }]) expect(() => validateEngineReport(value, MANIFEST, "godot")).toThrow();
  });
  it("does not upgrade a headless load into a rendered runtime", () => {
    expect(() => validateEngineReport({ ...REPORT, rendered: false }, MANIFEST, "godot")).toThrow();
    expect(validateEngineReport({ ...REPORT, status: "loaded", rendered: false }, MANIFEST, "godot")).toBeTruthy();
  });
  it("keeps partial and failed reports readable without claiming full coverage", () => {
    expect(validateEngineReport({ ...REPORT, status: "failed", rendered: false, assets: [] }, MANIFEST, "godot")).toBeTruthy();
    expect(() => validateEngineReport({ ...REPORT, status: "partial", assets: [{ asset_id: "foreign", version_id: "v1" }] }, MANIFEST, "godot")).toThrow();
  });
  it("rejects malformed problem lists and hidden per-asset failures", () => {
    for (const value of [
      { ...REPORT, engine_version: "" },
      { ...REPORT, problems: "texture missing" },
      { ...REPORT, problems: [null] },
      { ...REPORT, assets: [{ ...REPORT.assets[0], problems: ["texture missing"] }] },
      { ...REPORT, status: "partial", assets: [{ asset_id: "a", status: "imagined" }] },
    ]) expect(() => validateEngineReport(value, MANIFEST, "godot")).toThrow();
  });
  it("reuses an upload identity when only JSON object key order changes", async () => {
    const first = await reportOperationKey("export", { status: "failed", detail: { b: 2, a: 1 } });
    const reordered = await reportOperationKey("export", { detail: { a: 1, b: 2 }, status: "failed" });
    expect(first).toBe(reordered);
    expect(await reportOperationKey("other-export", { detail: { a: 1, b: 2 }, status: "failed" })).not.toBe(first);
  });
  it("reports absent assets as retained rather than a deletion request", () => {
    expect(comparePacks([ASSET], [])[0].state).toContain("不会自动删除");
    expect(comparePacks([ASSET], [{ ...ASSET, version_id: "v2" }])[0].state).toContain("更新");
  });
});
