import type { GameAssetsApi } from "@storyteller/api";

export interface CreationUpload {
  key: string; project: string; upload?: string; uploaded?: boolean; artifact?: string;
}

export async function uploadCreationImage(api: GameAssetsApi, blob: Blob, operation: CreationUpload): Promise<string> {
  if (operation.artifact) return operation.artifact;
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!operation.upload) {
    const created = await api.CreateGameUpload(operation.project, {
      expected_size: bytes.byteLength, expected_mime: "image/png", expected_sha256_hex: hex,
      maybe_idempotency_key: operation.key,
    });
    operation.upload = created.upload.token;
  }
  if (!operation.uploaded) {
    await api.PutGameUploadContent(`/v1/game_assets/uploads/${operation.upload}/content`, bytes);
    operation.uploaded = true;
  }
  const sealed = await api.CompleteGameUpload(operation.upload);
  operation.artifact = sealed.upload.maybe_artifact_token ?? undefined;
  if (!operation.artifact) throw new Error("参考文件尚未封存，请重试同一上传。");
  return operation.artifact;
}

/** A visible working copy is converted once; the user's original file is preserved. */
export async function prepareReference(file: File): Promise<Blob> {
  if (file.size > 10 * 1024 * 1024) throw new Error("参考图请控制在 10 MiB 以内。");
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法准备参考图，请尝试 PNG 格式。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("参考图转换失败。")), "image/png"));
  } finally { image.close(); }
}
