import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { privateGltfLoader } from "./private-gltf-loader";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AnimationSkeletonMap } from "@storyteller/api";
import { bindSkeletalClip, type AnimationBindingTolerances } from "./bind-skeletal-clip";
import { bindRigProbe, type RigProbe, type RigProbeSpec } from "./rig-probe";
import { previewVisible } from "./preview-visible";

interface MeshInfo {
  triangles: number;
  materials: number;
  dimensions: THREE.Vector3;
}

export interface MeshAnimationPreview {
  blob: Blob;
  map: AnimationSkeletonMap;
  tolerances: AnimationBindingTolerances;
  stepSeconds: number;
}
export interface MeshPreviewObservation {
  decoded: boolean;
  instantiated: boolean;
  animation_bound: boolean;
  playback_observed: boolean;
  loop_checked: boolean;
  checked_views: string[];
  diagnostic_poses: string[];
  error: string | null;
}
interface AnimationPlayback {
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  elapsed: number;
  playing: boolean;
  lastTick: number;
  lastReport: number;
  visibleSeconds: number;
}

export function MeshPreview({ blob, onReady, onReload, onExpand, onDownload, animation, rigProbe, onObservation, isCharacter = false }: { blob: Blob; onReady?: () => void; onReload?: () => void; onExpand?: () => void; onDownload?: () => void; animation?: MeshAnimationPreview; rigProbe?: RigProbeSpec; onObservation?: (observation: MeshPreviewObservation) => void; isCharacter?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const model = useRef<THREE.Object3D | null>(null);
  const reference = useRef<THREE.Group | null>(null);
  const cameraControls = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls; bounds: THREE.Box3; referenceBounds: THREE.Box3 } | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [showReference, setShowReference] = useState(true);
  const [info, setInfo] = useState<MeshInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playback = useRef<AnimationPlayback | null>(null);
  const [animationTime, setAnimationTime] = useState(0), [animationPlaying, setAnimationPlaying] = useState(false), [animationTracks, setAnimationTracks] = useState(0);
  const [embeddedAnimations, setEmbeddedAnimations] = useState(0);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const observationCallback = useRef(onObservation); observationCallback.current = onObservation;
  const probeFailure = useRef<((message: string) => void) | null>(null);
  const probe = useRef<RigProbe | null>(null), pendingPose = useRef<string | null>(null), pendingView = useRef<string | null>(null), selectedView = useRef("reset");
  const [pose, setPose] = useState(""), [poseDisplacement, setPoseDisplacement] = useState(0);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    model.current?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material && "wireframe" in material) material.wireframe = wireframe;
      }
    });
  }, [wireframe, info]);

  useEffect(() => { if (reference.current) reference.current.visible = showReference; }, [showReference, info]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let frame = 0;
    let readyToObserve = false;
    let previouslyVisible = false;
    let observation: MeshPreviewObservation = { decoded: false, instantiated: false, animation_bound: false, playback_observed: false, loop_checked: false, checked_views: [], diagnostic_poses: [], error: null };
    const observe = (change: Partial<MeshPreviewObservation>) => {
      if (cancelled) return;
      const next = { ...observation, ...change };
      if (JSON.stringify(next) !== JSON.stringify(observation)) { observation = next; observationCallback.current?.(next); }
    };
    const fail = (message: string) => {
      if (cancelled) return;
      setError(message); readyToObserve = false;
      observe({ decoded: false, instantiated: false, animation_bound: false, playback_observed: false, loop_checked: false, checked_views: [], diagnostic_poses: [], error: message });
    };
    const failProbe = (message: string) => {
      if (cancelled) return;
      probe.current?.restore(); pendingPose.current = null; setPose(""); setPoseDisplacement(0); setProbeError(message);
      observe({ diagnostic_poses: [], error: message });
    };
    probeFailure.current = failProbe;
    observationCallback.current?.(observation);
    setPose(""); setPoseDisplacement(0); setProbeError(null); pendingPose.current = null; pendingView.current = null; selectedView.current = "reset"; probe.current = null;
    setError(null); setInfo(null); setAnimationTime(0); setAnimationPlaying(false); setAnimationTracks(0); setEmbeddedAnimations(0); playback.current = null;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch {
      fail("此环境无法启用 3D 预览。请检查图形加速设置；这不代表模型已经通过视觉检查。");
      return () => { cancelled = true; if (probeFailure.current === failProbe) probeFailure.current = null; };
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#202733");
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.addEventListener("start", () => { pendingView.current = null; selectedView.current = "reset"; });
    controls.enableDamping = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    element.appendChild(renderer.domElement);
    const contextLost = () => fail("3D 图形上下文已丢失，请重新加载此版本预览。");
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x344358, 2));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(3, 5, 4);
    scene.add(key);
    const grid = new THREE.GridHelper(10, 10, 0x67768c, 0x384557);
    scene.add(grid);
    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const render = () => {
      frame = requestAnimationFrame(render);
      const current = playback.current, now = performance.now();
      const visible = previewVisible(element);
      let advanced = false, loopCrossed = false;
      if (current) {
        if (current.playing) {
          const before = current.elapsed, delta = Math.max(0, now - current.lastTick) / 1000;
          const at = evaluateAnimation(current, current.elapsed + delta);
          if (visible && previouslyVisible && delta <= Math.max(1, (animation?.stepSeconds ?? 0.05) * 2)) {
            current.visibleSeconds += current.elapsed - before;
            advanced = current.visibleSeconds >= Math.min(animation?.stepSeconds ?? 0.01, current.action.getClip().duration);
            loopCrossed = current.action.loop === THREE.LoopRepeat && current.visibleSeconds >= current.action.getClip().duration && Math.floor(current.elapsed / current.action.getClip().duration) - Math.floor(before / current.action.getClip().duration) === 1;
          } else current.visibleSeconds = 0;
          if (current.action.loop === THREE.LoopOnce && current.elapsed >= current.action.getClip().duration) { current.playing = false; setAnimationPlaying(false); }
          if (now - current.lastReport >= 100 || !current.playing) { setAnimationTime(at); current.lastReport = now; }
        }
        current.lastTick = now;
      }
      controls.update();
      try { renderer.render(scene, camera); }
      catch (problem) { fail(problem instanceof Error ? problem.message : "3D 渲染失败。"); cancelAnimationFrame(frame); return; }
      if (readyToObserve && visible) {
        const views = pendingView.current && !observation.checked_views.includes(pendingView.current) ? [...observation.checked_views, pendingView.current] : observation.checked_views;
        const poses = pendingPose.current && !observation.diagnostic_poses.includes(pendingPose.current) ? [...observation.diagnostic_poses, pendingPose.current] : observation.diagnostic_poses;
        if (!observation.instantiated || advanced && !observation.playback_observed || loopCrossed && !observation.loop_checked || views !== observation.checked_views || poses !== observation.diagnostic_poses) {
          observe({ instantiated: true, playback_observed: observation.playback_observed || advanced, loop_checked: observation.loop_checked || loopCrossed, checked_views: views, diagnostic_poses: poses });
        }
        pendingView.current = null; pendingPose.current = null;
      }
      previouslyVisible = visible;
    };
    render();

    const readModel = blob.size > 256 * 1024 * 1024 ? Promise.reject(new Error("模型超出预览读取预算。"))
      : blob.arrayBuffer().then((bytes) => privateGltfLoader().parseAsync(bytes, ""));
    void readModel.then(async (gltf) => {
      if (cancelled) { disposeTree(gltf.scene); return; }
      const root = isCharacter || animation ? gltf.scenes[0] : gltf.scene;
      if (!root) throw new Error("角色缺少约定的 scene 0。");
      model.current = root;
      scene.add(root);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) throw new Error("模型没有可见几何体。");
      const center = box.getCenter(new THREE.Vector3());
      const dimensions = box.getSize(new THREE.Vector3());
      if (![...dimensions.toArray(), ...center.toArray()].every(Number.isFinite)) throw new Error("模型尺寸包含无效数据。");
      grid.position.y = box.min.y;
      const scaleReference = makeReference();
      scaleReference.position.set(box.max.x + Math.max(0.4, dimensions.x * 0.2), box.min.y, center.z);
      scene.add(scaleReference);
      reference.current = scaleReference;
      const origin = new THREE.AxesHelper(Math.min(Math.max(dimensions.length() / 3, 0.15), 1));
      for (const material of Array.isArray(origin.material) ? origin.material : [origin.material]) {
        material.depthTest = false;
      }
      origin.renderOrder = 10;
      scene.add(origin);
      const referenceBounds = new THREE.Box3().setFromObject(scaleReference);
      frameCamera(camera, controls, box.clone().union(referenceBounds), "reset");
      cameraControls.current = { camera, controls, bounds: box, referenceBounds };
      let triangles = 0;
      const materials = new Set<THREE.Material>();
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if ((animation || rigProbe) && (mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
        const copies = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
        triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3 * copies;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (material) materials.add(material);
      });
      if (animation) {
        if (rigProbe) throw new Error("独立动作播放与角色诊断姿势不能同时应用。");
        if (!Number.isFinite(animation.stepSeconds) || animation.stepSeconds <= 0 || animation.blob.size > 256 * 1024 * 1024) throw new Error("动作缺少有效步长或超出预览预算。");
        const motion = await privateGltfLoader().parseAsync(await animation.blob.arrayBuffer(), "");
        try {
          if (cancelled) return;
          const clip = await bindSkeletalClip(gltf, motion, animation.map, animation.tolerances);
          if (cancelled) return;
          const mixer = new THREE.AnimationMixer(root), action = mixer.clipAction(clip);
          action.setLoop(animation.map.clip.loop ? THREE.LoopRepeat : THREE.LoopOnce, animation.map.clip.loop ? Infinity : 1);
          action.clampWhenFinished = true;
          playback.current = { mixer, action, elapsed: 0, playing: false, lastTick: performance.now(), lastReport: 0, visibleSeconds: 0 };
          setAnimationTracks(clip.tracks.length);
          observe({ animation_bound: true });
        } finally { motion.scenes.forEach(disposeTree); }
      }
      if (rigProbe) {
        try {
          const bound = await bindRigProbe(gltf, rigProbe);
          if (cancelled) { bound.restore(); return; }
          probe.current = bound;
        } catch (problem) { failProbe(problem instanceof Error ? problem.message : "角色诊断姿势未能绑定。"); }
      }
      if (cancelled) return;
      setEmbeddedAnimations(gltf.animations.length);
      setInfo({ triangles: Math.round(triangles), materials: materials.size, dimensions });
      observe({ decoded: true }); readyToObserve = true;
      readyCallback.current?.();
    }).catch((problem: unknown) => {
      fail(problem instanceof Error ? problem.message : "模型预览未加载。");
    });

    return () => {
      cancelled = true;
      if (probeFailure.current === failProbe) probeFailure.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      probe.current?.restore(); probe.current = null;
      playback.current?.mixer.stopAllAction();
      if (model.current) playback.current?.mixer.uncacheRoot(model.current);
      playback.current = null;
      disposeTree(scene);
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      model.current = null;
      reference.current = null;
      cameraControls.current = null;
    };
  }, [blob, animation, rigProbe, isCharacter]);

  const seekAnimation = (seconds: number) => {
    const current = playback.current;
    if (!current || !Number.isFinite(seconds)) return;
    current.playing = false; current.lastTick = performance.now(); setAnimationPlaying(false);
    current.visibleSeconds = 0;
    setAnimationTime(evaluateAnimation(current, seconds));
  };
  const stepAnimation = (direction: number) => {
    const current = playback.current;
    if (current && animation) seekAnimation(sampleAnimationTime(current) + direction * animation.stepSeconds);
  };

  return <>
    {rigProbe && <div className="ga-preview-toolbar" aria-label="角色诊断姿势">
      <label>诊断姿势<select aria-label="诊断姿势" value={pose} disabled={!info || !probe.current || !!probeError || !!error} onChange={(event) => {
        const current = probe.current, state = cameraControls.current;
        if (!current || !state) return;
        try {
          const next = event.target.value, result = current.apply(next || null);
          setPose(next); setPoseDisplacement(result.displacement); pendingPose.current = next || null;
          state.bounds = result.bounds;
          const bounds = result.bounds.clone(); if (showReference) bounds.union(state.referenceBounds);
          frameCamera(state.camera, state.controls, bounds, selectedView.current);
        } catch (problem) { probeFailure.current?.(problem instanceof Error ? problem.message : "诊断姿势未应用。"); }
      }}><option value="">原始 rest 姿势</option>{rigProbe.poses.map((pose) => <option key={pose.id} value={pose.id}>{pose.id}</option>)}</select></label>
      <span>实际蒙皮顶点最大位移：{poseDisplacement.toFixed(4)} 米</span>
    </div>}
    {probeError && <p className="ga-error">诊断姿势无法应用：{probeError}。原文件仍可用于诊断预览。</p>}
    {animation && <div className="ga-preview-toolbar" aria-label="3D 动作播放控制">
      <strong>{animation.map.clip.name}</strong>
      <button type="button" className="ga-view-button" disabled={!animationTracks || !!error} onClick={() => {
        const current = playback.current;
        if (!current) return;
        if (!current.playing && current.elapsed >= current.action.getClip().duration && current.action.loop === THREE.LoopOnce) current.elapsed = 0;
        current.playing = !current.playing; current.lastTick = performance.now();
        if (current.playing) evaluateAnimation(current, current.elapsed);
        else setAnimationTime(sampleAnimationTime(current));
        setAnimationPlaying(current.playing);
      }}>{animationPlaying ? "暂停动作" : "播放动作"}</button>
      <button type="button" className="ga-view-button" disabled={!animationTracks || !!error} onClick={() => {
        const current = playback.current;
        if (!current) return;
        current.playing = false; current.elapsed = 0; current.visibleSeconds = 0; current.mixer.stopAllAction();
        setAnimationPlaying(false); setAnimationTime(0);
      }}>停止并复位</button>
      <button type="button" className="ga-view-button" disabled={!animationTracks || !!error} onClick={() => stepAnimation(-1)}>上一帧</button>
      <button type="button" className="ga-view-button" disabled={!animationTracks || !!error} onClick={() => stepAnimation(1)}>下一帧</button>
      <input type="range" aria-label="动作时间" min={0} max={animation.map.clip.duration_seconds} step="any" value={animationTime} disabled={!animationTracks || !!error} onChange={(event) => seekAnimation(event.currentTarget.valueAsNumber)} />
      <span>{animationTime.toFixed(2)} / {animation.map.clip.duration_seconds.toFixed(2)} 秒 · {animation.map.clip.loop ? "循环" : "单次"} · {animationTracks} 条轨道</span>
    </div>}
    {isCharacter && embeddedAnimations > 0 && <p className="ga-help">角色文件自带 {embeddedAnimations} 个动作，当前不自动播放或登记为独立动作。</p>}
    <div className="ga-preview-toolbar">
      <select aria-label="跳转模型视角" className="ga-view-button" defaultValue="" disabled={!info || !!error} onChange={(event) => {
          const state = cameraControls.current;
          if (!state) return;
          const bounds = state.bounds.clone();
          if (showReference) bounds.union(state.referenceBounds);
          frameCamera(state.camera, state.controls, bounds, event.currentTarget.value);
          selectedView.current = event.currentTarget.value; pendingView.current = event.currentTarget.value;
          event.currentTarget.value = "";
        }}><option value="" disabled>跳转视角</option>{([['front', '正面'], ['back', '背面'], ['side', '+X 侧面'], ['top', '俯视'], ['bottom', '底面']] as const).map(([view, label]) => <option key={view} value={view}>{label}</option>)}</select>
      <button type="button" className="ga-view-button" disabled={!info || !!error} onClick={() => {
        const state = cameraControls.current;
        if (state) frameCamera(state.camera, state.controls, showReference ? state.bounds.clone().union(state.referenceBounds) : state.bounds, "reset"); selectedView.current = "reset"; pendingView.current = null;
      }}>重置视角</button>
      <label className="ga-check" style={{ margin: 0 }}><input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />检查线框</label>
      <label className="ga-check" style={{ margin: 0 }}><input type="checkbox" checked={showReference} onChange={(e) => setShowReference(e.target.checked)} />显示 1.7 米参照物</label>
      {info && <span style={{ marginLeft: "auto" }}>{info.triangles.toLocaleString()} 三角面 · {info.materials} 个材质</span>}
      {onReload && <button type="button" className="ga-view-button" onClick={onReload} aria-label="重新加载预览">重新加载</button>}
      {onExpand && <button type="button" className="ga-view-button" onClick={onExpand}>放大预览</button>}
      {onDownload && <button type="button" className="ga-view-button" onClick={onDownload}>下载当前文件</button>}
    </div>
    <div className="ga-model-viewport" ref={host} aria-label={`${isCharacter || animation ? "3D 角色" : "3D 道具"}查看器，可以拖动旋转，滚轮缩放`}>
      {error && <div className="ga-preview-empty ga-error" role="alert" style={{ position: "absolute", inset: 24, zIndex: 1 }}>{error}</div>}
      {!info && !error && <div className="ga-model-label" role="status">正在解析模型…</div>}
      {info && <div className="ga-model-label">尺寸 {info.dimensions.toArray().map((n) => n.toFixed(3)).join(" × ")} 米 · 蓝轴 +Z 为正面，绿轴 +Y 向上 · 拖动旋转 / 滚轮缩放</div>}
    </div>
  </>;
}

function evaluateAnimation(current: AnimationPlayback, seconds: number): number {
  const duration = current.action.getClip().duration;
  current.elapsed = current.action.loop === THREE.LoopOnce ? Math.max(0, Math.min(seconds, duration)) : Math.max(0, seconds);
  const at = sampleAnimationTime(current);
  current.action.enabled = true; current.action.paused = false; current.action.play();
  current.mixer.setTime(at);
  return at;
}

function sampleAnimationTime(current: AnimationPlayback): number {
  return current.action.loop === THREE.LoopOnce ? current.elapsed : current.elapsed % current.action.getClip().duration;
}

function frameCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, bounds: THREE.Box3, view: string) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const radius = Math.max(size.x, size.y, size.z, 0.01) / Math.min(halfFov, halfFov * camera.aspect) * 0.6 + size.length() / 2;
  const direction = view === "front" ? new THREE.Vector3(0, 0, 1) : view === "back" ? new THREE.Vector3(0, 0, -1) : view === "side" ? new THREE.Vector3(1, 0, 0)
    : view === "top" ? new THREE.Vector3(0, 1, 0) : view === "bottom" ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(1, 0.6, 1).normalize();
  camera.up.set(0, 1, 0);
  if (view === "top") camera.up.set(0, 0, -1);
  if (view === "bottom") camera.up.set(0, 0, 1);
  camera.position.copy(center).addScaledVector(direction, radius);
  camera.near = Math.max(0.001, radius / 1000); camera.far = Math.max(100, radius * 100);
  camera.updateProjectionMatrix(); controls.target.copy(center); camera.lookAt(center); controls.update();
}

function makeReference(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x8293b1, transparent: true, opacity: 0.55, roughness: 1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.4, 0.25), material);
  body.position.y = 0.7;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), material);
  head.position.y = 1.55;
  group.add(body, head);
  return group;
}

function disposeTree(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) (object as THREE.SkinnedMesh).skeleton.dispose();
    mesh.geometry?.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
}
