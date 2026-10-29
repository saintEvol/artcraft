export interface EngineReportRecord {
  token: string; importer_version: string; trust_level: string;
  report: Record<string, unknown>; created_at: string;
}

export interface PackAsset {
  asset_id: string; stable_key: string; version_id: string; display_name?: string; kind: string;
  files: { path: string; sha256: string }[];
  /** Manifest 2.0 anim_3d entries carry their frozen rig dependency. */
  dependencies?: { asset_id: string }[];
}

export function packAssets(manifest: Record<string, unknown> | null): PackAsset[] {
  return Array.isArray(manifest?.assets) ? manifest.assets as PackAsset[] : [];
}

/** An uploaded local report is evidence supplied by the user, never a platform attestation. */
export function validateEngineReport(value: unknown, manifest: Record<string, unknown>, engine: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("报告需要是 JSON 对象。");
  const report = value as Record<string, unknown>;
  if (report.schema_version !== "game-assets-engine-report.v1") throw new Error("此文件不是支持的引擎报告，请使用工作台提供的集成组件生成报告。");
  if (report.pack_id !== manifest.pack_id || report.engine !== engine) throw new Error("报告属于另一份资源包或引擎，请打开对应的交付记录再上传。");
  if (!["import", "update", "runtime"].includes(String(report.operation)) || !["succeeded", "failed", "conflicts", "partial", "loaded"].includes(String(report.status))) throw new Error("报告缺少可识别的操作或结果。");
  if (typeof report.engine_version !== "string" || !report.engine_version.trim() || typeof report.importer_version !== "string" || !report.importer_version.trim()) throw new Error("报告缺少引擎和集成组件版本。");
  if (report.problems !== undefined && (!Array.isArray(report.problems) || report.problems.some((problem) => typeof problem !== "string"))) throw new Error("报告的问题清单格式无效，应为文字列表。");
  if (!Array.isArray(report.assets)) throw new Error("报告缺少逐项资产结果。");
  const expected = new Map(packAssets(manifest).map((asset) => [asset.asset_id, asset.version_id]));
  const seen = new Set<string>();
  for (const raw of report.assets) {
    const asset = raw as Record<string, unknown>;
    if (!asset || typeof asset !== "object" || Array.isArray(asset) || typeof asset.asset_id !== "string" || seen.has(asset.asset_id) || !expected.has(asset.asset_id)) throw new Error("报告包含重复或不属于这份清单的资产。");
    if (typeof asset.status !== "string" || !["loaded", "imported", "updated", "unchanged", "failed", "kept_local", "missing", "conflict"].includes(asset.status)) throw new Error("报告包含无法识别的逐项结果。");
    if (asset.problems !== undefined && (!Array.isArray(asset.problems) || asset.problems.some((problem) => typeof problem !== "string"))) throw new Error("资产的问题清单格式无效。");
    seen.add(asset.asset_id);
    if (report.status === "succeeded" && !["loaded", "imported", "updated", "unchanged"].includes(String(asset.status))) throw new Error("成功报告仍包含未成功的资产，请查看逐项问题。 ");
    if (report.status === "succeeded" && expected.get(asset.asset_id) !== asset.version_id) throw new Error("成功报告使用了其他制作版本，请重新核对当前资源包。");
    if (report.status === "succeeded" && Array.isArray(asset.problems) && asset.problems.length) throw new Error("成功报告仍包含资产问题，请先处理。");
  }
  if (report.status === "succeeded") {
    if (Array.isArray(report.problems) && report.problems.length) throw new Error("成功报告仍包含未解决问题。 ");
    if (seen.size !== expected.size) throw new Error("成功报告没有覆盖本次全部资产，不能把缺项作为成功。");
    const profiles = manifest.engine_profiles;
    if (!Array.isArray(profiles) || !profiles.some((profile) => profile?.engine === engine && profile?.engine_version === report.engine_version)) throw new Error("报告的引擎版本与本包支持版本不同，请上传失败报告或使用匹配版本重新验证。");
    if (report.operation === "runtime" && report.rendered !== true) throw new Error("此报告没有实际渲染证据；仅加载文件请记录为 loaded。");
  }
  return report;
}

export function comparePacks(previous: PackAsset[], current: PackAsset[]): { name: string; state: string }[] {
  const before = new Map(previous.map((asset) => [asset.asset_id, asset]));
  const after = new Set(current.map((asset) => asset.asset_id));
  return [...current.map((asset) => {
    const old = before.get(asset.asset_id);
    return { name: asset.display_name || asset.stable_key, state: !old ? "新增" : old.version_id !== asset.version_id || JSON.stringify(old.files) !== JSON.stringify(asset.files) ? "更新版本或文件" : "保持原版" };
  }), ...previous.filter((asset) => !after.has(asset.asset_id)).map((asset) => ({ name: asset.display_name || asset.stable_key, state: "本次未包含；不会自动删除" }))];
}

export async function reportOperationKey(exportToken: string, report: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson([exportToken, report])));
  const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
