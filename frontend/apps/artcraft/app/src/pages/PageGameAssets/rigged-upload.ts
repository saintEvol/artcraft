import type { GameAssetsApi, GameAssetInfo, RiggedCharacterImportV2 } from "@storyteller/api";

const MAX_GLB_BYTES = 256 * 1024 * 1024;

export interface RigUploadOperation {
  key: string;
  project: string;
  stableKey: string;
  profile: string;
  bytes?: ArrayBuffer;
  expectedSha?: string;
  mapping: Record<string, string[]>;
  motionRoot: string[];
  asset?: Pick<GameAssetInfo, "token" | "revision" | "stable_key">;
  parent?: string;
  upload?: string;
  uploaded?: boolean;
  sealed?: boolean;
  request?: RiggedCharacterImportV2;
  run?: string;
}

/** Inspect names only, without decoding meshes or changing the uploaded GLB. */
export function rigNodePaths(bytes: ArrayBuffer): string[][] {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_GLB_BYTES) throw new Error("GLB 文件必须完整且不超过 256 MiB。");
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength
    || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("请选择包含完整场景的 glTF 2 GLB 文件。");
  const jsonLength = view.getUint32(12, true);
  if (jsonLength > 16 * 1024 * 1024 || jsonLength % 4 !== 0 || jsonLength > bytes.byteLength - 20) throw new Error("GLB 场景描述不完整或超出读取预算。");
  const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes, 20, jsonLength))) as Record<string, any>;
  if (!Array.isArray(json.nodes) || json.nodes.length > 4096 || !Array.isArray(json.scenes?.[0]?.nodes)) throw new Error("GLB 必须提供场景 0 和不超过 4096 个节点。");
  const paths: string[][] = [], seen = new Set<number>(), names = new Set<string>();
  let pathCharacters = 0;
  const visit = (index: unknown, parent: string[]) => {
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= json.nodes.length || seen.has(Number(index)) || parent.length >= 128) throw new Error("GLB 节点引用重复、循环或过深。");
    seen.add(Number(index));
    const node = json.nodes[Number(index)];
    if (!node || typeof node.name !== "string" || !node.name.trim()) throw new Error("角色节点必须有明确名称；上传时不会自动改名。");
    if (/[/\\:.%\u0000-\u001f\u007f-\u009f]/u.test(node.name)) throw new Error("角色节点名包含引擎路径分隔符或控制字符；请修正源 GLB，不会自动改名。");
    const path = [...parent, node.name], key = JSON.stringify(path);
    pathCharacters += key.length;
    if (pathCharacters > 2 * 1024 * 1024) throw new Error("节点路径超出交互读取预算，请简化源 GLB 的命名或层级。");
    if (names.has(key)) throw new Error("同一层级存在重名节点，无法确定完整骨骼路径。");
    names.add(key); paths.push(path);
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error("GLB 子节点列表不正确。");
    for (const child of node.children ?? []) visit(child, path);
  };
  for (const root of json.scenes[0].nodes) visit(root, []);
  if (!paths.length) throw new Error("GLB 的场景 0 没有可映射节点。");
  return paths;
}

/** The operation object survives an uncertain response; each retry uses the
 * same sealed bytes, mapping, asset revision and required idempotency key. */
export async function submitRiggedUpload(api: GameAssetsApi, operation: RigUploadOperation, progress: (message: string) => void, changed: () => void = () => {}): Promise<string> {
  if (operation.run) return operation.run;
  const bytes = operation.bytes;
  if (!operation.upload) {
    progress("准备角色原文件上传…");
    if (!bytes) throw new Error("请重新选择同一份原 GLB，继续上传。");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (operation.expectedSha && operation.expectedSha !== sha) throw new Error("所选文件与原上传不同，请选择原 GLB。");
    operation.expectedSha = sha; changed();
    const created = await api.CreateGameUpload(operation.project, { expected_size: bytes.byteLength, expected_sha256_hex: sha, expected_mime: "model/gltf-binary", maybe_idempotency_key: operation.key });
    operation.upload = created.upload.token; changed();
  }
  if (!operation.uploaded) {
    progress("上传原 GLB…");
    if (!bytes) throw new Error("请重新选择同一份原 GLB，继续上传。");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (operation.expectedSha && hash !== operation.expectedSha) throw new Error("所选文件与原上传不同，请选择原 GLB。");
    await api.PutGameUploadContent(`/v1/game_assets/uploads/${operation.upload}/content`, bytes);
    operation.uploaded = true; changed();
  }
  if (!operation.sealed) {
    progress("封存并核对原文件…");
    const result = await api.CompleteGameUpload(operation.upload);
    if (result.upload.status !== "sealed" || !result.upload.maybe_artifact_token) throw new Error("角色上传尚未封存，请继续同一上传。");
    operation.sealed = true; changed();
  }
  if (!operation.asset) {
    progress("创建角色身份…");
    const asset = (await api.CreateGameAssetV2(operation.project, { idempotency_key: operation.key, kind: "character_3d", stable_key: operation.stableKey })).asset;
    operation.asset = { token: asset.token, stable_key: asset.stable_key, revision: asset.revision }; changed();
  }
  if (!operation.request) operation.request = {
    idempotency_key: operation.key, upload_token: operation.upload, profile_token: operation.profile,
    expected_revision: operation.asset.revision, maybe_parent_version_token: operation.parent,
    semantic_bones: operation.mapping, motion_root_path: operation.motionRoot,
  };
  changed();
  progress("提交免费角色检查…");
  const result = await api.ImportRiggedCharacterV2(operation.asset.token, operation.request);
  if (result.asset_token !== operation.asset.token || !result.run_token || result.supplier_calls !== 0) throw new Error("检查响应身份不正确，请用同一提交键查询原任务。");
  operation.run = result.run_token; changed();
  return result.run_token;
}
