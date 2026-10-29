import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { GameAssetsApi, GameAssetVersionInfo } from "@storyteller/api";
import { privateGltfLoader } from "./private-gltf-loader";

export function CollectionScene({ api, project, items, fullscreen = false }: {
  api: GameAssetsApi; project: string; items: { name: string; version: GameAssetVersionInfo }[]; fullscreen?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [enlarged, setEnlarged] = useState(false);
  const reset = useRef<() => void>(() => {});
  const collisionGroups = useRef<THREE.Group[]>([]);
  const [collisions, setCollisions] = useState(false);
  const currentCollisionVisibility = useRef(collisions); currentCollisionVisibility.current = collisions;
  const [collisionCount, setCollisionCount] = useState(0);
  const [errors, setErrors] = useState<string[]>([]); const [loaded, setLoaded] = useState(0);
  const [reload, setReload] = useState(0);
  const signature = items.map((item) => `${item.version.token}:${item.name}`).join("|");
  useEffect(() => { collisionGroups.current.forEach((group) => { group.visible = collisions; }); }, [collisions]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    let cancelled = false; let frame = 0;
    setErrors([]); setLoaded(0); setCollisionCount(0); collisionGroups.current = [];
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#202834");
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200);
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setErrors(["当前图形环境无法打开 3D 场景查看器。模型已保留，可继续查看文件检查或在目标引擎中评估。"]); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
    element.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
    const pmrem = new THREE.PMREMGenerator(renderer); const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room); scene.environment = environment.texture; room.dispose(); pmrem.dispose();
    const light = new THREE.HemisphereLight(0xffffff, 0x444b59, 2.2); scene.add(light);
    const grid = new THREE.GridHelper(20, 40, "#647b9a", "#374352"); scene.add(grid);
    const bounds = new THREE.Box3(); let position = 0;
    const fit = () => {
      const box = bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)) : bounds.clone().expandByScalar(0.3);
      const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
      const direction = new THREE.Vector3(0.5, 0.45, 1).normalize();
      const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      let distance = 0.5;
      // Fit each corner against the actual horizontal and vertical
      // frustum. A diagonal-based distance shrinks a wide asset set
      // unnecessarily, especially in short desktop windows.
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const offset = new THREE.Vector3(x, y, z).sub(center);
        distance = Math.max(distance, offset.dot(direction) + Math.max(Math.abs(offset.dot(up)) / tangent, Math.abs(offset.dot(right)) / (tangent * Math.max(camera.aspect, 0.2))));
      }
      distance *= 1.1;
      camera.far = Math.max(200, distance + size.length() * 2); camera.updateProjectionMatrix();
      camera.position.copy(center).add(direction.multiplyScalar(distance));
      controls.target.copy(center); camera.lookAt(center); controls.update();
    }; reset.current = fit;
    const size = () => { const width = element.clientWidth; const height = element.clientHeight; if (!width || !height) return; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); fit(); };
    const observer = new ResizeObserver(size); observer.observe(element); size(); fit();
    const draw = () => { controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(draw); }; draw();
    void (async () => {
      for (const item of items) {
        if (cancelled) break;
        try {
          const detail = await api.GetGameAssetVersion(item.version.token);
          const file = detail.files.find((file) => file.role === "main" && file.ordinal === 0);
          if (!file) throw new Error("尚未提供主模型文件");
          const blob = await api.DownloadGameArtifact(project, file.artifact_token);
          if (blob.type !== "model/gltf-binary") throw new Error("这一版本仍为概念图");
          const gltf = await privateGltfLoader().parseAsync(await blob.arrayBuffer(), "");
          if (cancelled) { dispose(gltf.scene); break; }
          const local = new THREE.Box3().setFromObject(gltf.scene); const dimensions = local.getSize(new THREE.Vector3());
          if (local.isEmpty() || !dimensions.toArray().every(Number.isFinite)) { dispose(gltf.scene); throw new Error("模型没有可评估的有限尺寸"); }
          // Translate whole local scenes without changing scale or origin.
          const lane = new THREE.Group(); lane.position.x = position - local.min.x; lane.add(gltf.scene); scene.add(lane);
          const world = local.clone().translate(lane.position); bounds.union(world);
          const label = makeLabel(`${item.name} · ${dimensions.y.toFixed(2)}m`); label.position.copy(world.getCenter(new THREE.Vector3())); label.position.y = world.max.y + 0.12; scene.add(label);
          const collision = file.maybe_metadata_json?.collision as { kind?: string; center?: number[]; half_extents?: number[] } | undefined;
          if (collision?.kind === "box" && collision.center?.length === 3 && collision.half_extents?.length === 3
            && [...collision.center, ...collision.half_extents].every(Number.isFinite) && collision.half_extents.every((value) => value > 0)) {
            const group = new THREE.Group(); const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(...collision.half_extents.map((value) => value * 2) as [number, number, number])), new THREE.LineBasicMaterial({ color: "#72e7a9" }));
            box.position.fromArray(collision.center); group.add(box); group.visible = currentCollisionVisibility.current; lane.add(group); collisionGroups.current.push(group); setCollisionCount(collisionGroups.current.length);
          }
          position = world.max.x + 0.6; setLoaded((count) => count + 1); fit();
        } catch (problem) { if (!cancelled) setErrors((old) => [...old, `${item.name}：${problem instanceof Error ? problem.message : "模型暂不可用"}`]); }
      }
      if (!cancelled) {
        const reference = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.7, 0.25), new THREE.MeshStandardMaterial({ color: "#8293b1", transparent: true, opacity: 0.55 }));
        reference.position.set(position + 0.2, 0.85, 0); scene.add(reference); bounds.union(new THREE.Box3().setFromObject(reference));
        const label = makeLabel("1.70m 尺度参照"); label.position.set(position + 0.2, 1.85, 0); scene.add(label); fit();
      }
    })();
    return () => { cancelled = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); dispose(scene); environment.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); collisionGroups.current = []; };
    // Files and their visible labels identify the current assessment scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project, signature, reload]);
  return <><section className="ga-collection-scene"><div className="ga-preview-toolbar"><button type="button" className="ga-view-button" onClick={() => reset.current()}>重置整组视角</button><label className="ga-check"><input type="checkbox" checked={collisions} disabled={collisionCount === 0} onChange={(event) => setCollisions(event.target.checked)} />显示已有碰撞描述（{collisionCount} 件）</label><button type="button" className="ga-view-button" onClick={() => setReload((value) => value + 1)}>重新读取整组模型</button><span>{loaded} / {items.length} 件模型 · 保持真实米制</span>{!fullscreen && <button type="button" className="ga-view-button" onClick={() => setEnlarged(true)}>放大整组场景</button>}</div>
    <div ref={host} className="ga-collection-scene-canvas" aria-label="整组 3D 道具尺度与材质评估" />
    <p className="ga-help">所有模型使用同一光照与地面，灰色方柱高 1.7 米。拖动旋转、滚轮缩放；绿色线框来自已生成的箱体碰撞描述，实际物理行为需在目标引擎验证。</p>
    {loaded === items.length && items.length > 0 && collisionCount === 0 && <p className="ga-help">当前模型未附带碰撞描述。如果需要碰撞，可先在项目设置中查看支持的碰撞类型，再重新加工所需模型。</p>}
    {errors.map((error) => <p key={error} role="alert" className="ga-error">{error}</p>)}</section>{enlarged && <EnlargedCollectionScene api={api} project={project} items={items} onClose={() => setEnlarged(false)} />}</>;
}

function EnlargedCollectionScene({ api, project, items, onClose }: {
  api: GameAssetsApi; project: string; items: { name: string; version: GameAssetVersionInfo }[]; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="ga-enlarged-preview" aria-label="整组3D道具放大评估" onClose={(event) => { event.stopPropagation(); onClose(); }}>
    <header><strong>整组道具 · 真实尺度与材质评估</strong><button type="button" className="ga-action" onClick={onClose}>返回资产清单</button></header>
    <CollectionScene api={api} project={project} items={items} fullscreen />
  </dialog>;
}

function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 80;
  const context = canvas.getContext("2d")!; context.fillStyle = "#151a24d0"; context.fillRect(0, 0, 640, 80); context.fillStyle = "#eef1f8"; context.font = "28px sans-serif"; context.textAlign = "center"; context.fillText(text, 320, 51, 620);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })); sprite.scale.set(0.95, 0.12, 1); return sprite;
}

function dispose(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>(); const textures = new Set<THREE.Texture>();
  root.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose(); for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) { if (!material) continue; materials.add(material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value); } });
  textures.forEach((texture) => texture.dispose()); materials.forEach((material) => material.dispose());
}
