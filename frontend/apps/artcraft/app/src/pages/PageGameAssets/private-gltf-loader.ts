import { LoadingManager } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Game deliverables are self-contained; previewing one must not fetch
 * arbitrary material or buffer URLs declared inside an uploaded file. */
export function privateGltfLoader(): GLTFLoader {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("blob:") || /^data:image\/(png|jpeg|webp);base64,/i.test(url)) return url;
    throw new Error("模型引用了外部文件。请提供包含全部贴图与几何的 GLB 后再预览。");
  });
  return new GLTFLoader(manager);
}
