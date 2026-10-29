import { useEffect, useRef, useState } from "react";
import { parseSkeletonMap, type AnimatedAssetKind, type GameAssetsApi, type GameAssetVersionInfo, type GameVersionDetailsV2, type GameVersionFileV2 } from "@storyteller/api";
import { Animation2dPreview } from "./Animation2dPreview";
import { MeshPreview, type MeshAnimationPreview, type MeshPreviewObservation } from "./MeshPreview";
import { AnimatedVersionReview } from "./AnimatedVersionReview";
import { parseRigProbe, type RigProbeSpec } from "./rig-probe";
import { emptyPreviewEvidence, previewIdentity, type PreviewEvidence } from "./preview-evidence";

interface Props {
  api: GameAssetsApi; project: string; version: GameAssetVersionInfo; kind: AnimatedAssetKind;
  supportsDetailsV2?: boolean; supportsReviewV2?: boolean; supportsSelectionV2?: boolean; refreshKey?: number;
  onChanged?: () => void;
}
interface Metadata { identity: string; request: string; detail: GameVersionDetailsV2 }
interface Preview {
  identity: string; view: number; blob: Blob; artifacts: string[];
  output?: Record<string, unknown>; frameTable?: unknown; imageUrl?: string; diagnosticUrl?: string;
  animation?: MeshAnimationPreview; rigProbe?: RigProbeSpec; probeProblem?: string;
  choices?: { name: string; artifact: string; view?: string; direction?: string }[];
}

/** Every observation belongs to this exact version/report/files/rig contract.
 * Production release and server-side review/selection gates remain separate. */
export function AnimatedAssetPreview({ api, project, version, kind, supportsDetailsV2 = false, supportsReviewV2 = false, supportsSelectionV2 = false, refreshKey = 0, onChanged }: Props) {
  const [metadata, setMetadata] = useState<Metadata | null>(null), [loaded, setLoaded] = useState<Preview | null>(null), [error, setError] = useState("");
  const [view, setView] = useState(0), [reload, setReload] = useState(0);
  const [observed, setObserved] = useState<{ identity: string; evidence: PreviewEvidence }>({ identity: "", evidence: emptyPreviewEvidence() });
  const active = useRef<{ metadata: Metadata | null; resource: Preview | null }>({ metadata: null, resource: null });
  const requestKey = JSON.stringify([version.token, version.asset_token, project, kind, supportsDetailsV2, refreshKey, reload]);
  const meta = metadata?.request === requestKey && metadata.detail.version.token === version.token ? metadata : null;
  const current = loaded?.identity === meta?.identity && loaded?.view === view ? loaded : null;
  active.current = { metadata: meta, resource: current };
  const refresh = () => setReload((value) => value + 1);
  useEffect(() => { setView(0); }, [version.token]);
  useEffect(() => {
    let cancelled = false;
    setMetadata(null); setLoaded(null); setError(""); setObserved({ identity: "", evidence: emptyPreviewEvidence() });
    void (async () => {
      try {
        if (!supportsDetailsV2) throw new Error("当前实例尚未提供完整 v2 版本读取，请升级服务并完成迁移后再预览。");
        const detail = await api.GetCompleteGameAssetVersionDetailsV2(version.token, () => cancelled);
        if (cancelled) return;
        if (detail.asset.project_token !== project || detail.version.asset_token !== version.asset_token || detail.asset.kind !== kind) throw new Error("版本身份与当前资产不一致，已停止预览。");
        const identity = previewIdentity(detail);
        setMetadata({ identity, detail, request: requestKey }); setObserved({ identity, evidence: emptyPreviewEvidence() });
      } catch (problem) { if (!cancelled) setError(message(problem)); }
    })();
    return () => { cancelled = true; };
  }, [api, project, version.token, version.asset_token, kind, supportsDetailsV2, refreshKey, reload]);
  useEffect(() => {
    if (!meta) return;
    let cancelled = false; const urls: string[] = [];
    setLoaded(null); setError("");
    const { detail, identity } = meta;
    void (async () => {
      try {
        const artifacts: string[] = [];
        const download = async (file: GameVersionFileV2) => {
          const blob = await api.DownloadVersionFileV2(project, file);
          if (file.artifact_token) artifacts.push(file.artifact_token);
          return blob;
        };
        const output = detail.version.spec_json.output as Record<string, unknown> | undefined;
        if (kind === "anim_3d") {
          const dependency = detail.dependencies.length === 1 ? detail.dependencies[0] : undefined;
          if (!dependency || dependency.role !== "rig" || detail.preview_contract.rig_version_token !== dependency.target_version_token) throw new Error("动作缺少唯一、明确的角色绑定。");
          const rig = detail.preview_files.find((file) => file.version_token === dependency.target_version_token && file.role === "main" && file.ordinal === 0);
          const motion = detail.files.find((file) => file.role === "main" && file.ordinal === 0), mapping = detail.files.find((file) => file.role === "skeleton_map" && file.ordinal === 0);
          if (!rig || !motion || !mapping || rig.sha256_hex !== dependency.rig_main_sha256_hex) throw new Error("角色、动作主文件或 skeleton_map 不完整。");
          if (rig.mime !== "model/gltf-binary" || motion.mime !== "model/gltf-binary" || mapping.mime !== "application/json" || Number(rig.byte_length) > 256 * 1024 * 1024 || Number(motion.byte_length) > 256 * 1024 * 1024 || Number(mapping.byte_length) > 2 * 1024 * 1024) throw new Error("动作文件格式不正确或超出预览预算。");
          const json = await download(mapping), map = parseSkeletonMap(JSON.parse(await json.text()), dependency.target_version_token, dependency.rig_main_sha256_hex);
          const [rigBlob, animationBlob] = await Promise.all([download(rig), download(motion)]);
          const tolerance = output?.tolerances as Record<string, unknown> | undefined;
          const animation: MeshAnimationPreview = { blob: animationBlob, map, stepSeconds: specNumber(output?.bake_step_seconds), tolerances: { rest_matrix: specNumber(tolerance?.rest_matrix), endpoint_seconds: specNumber(tolerance?.endpoint_seconds), quaternion_norm: specNumber(tolerance?.quaternion_norm) } };
          if (!cancelled) setLoaded({ identity, view, blob: rigBlob, artifacts, output, animation });
          return;
        }
        const concept = detail.stage === "concept", sources = concept ? detail.files.filter((file) => file.role === "source").sort((a, b) => a.ordinal - b.ordinal) : [];
        const choices = sources.map((file) => {
          const sourceView = typeof file.maybe_metadata_json?.view === "string" ? file.maybe_metadata_json.view : undefined;
          const direction = typeof file.maybe_metadata_json?.direction === "string" ? file.maybe_metadata_json.direction : undefined;
          return { name: sourceView ?? (direction ? `${direction} · 概念 ${file.ordinal + 1}` : `概念 ${file.ordinal + 1}`), artifact: file.artifact_token ?? `unavailable_${file.ordinal}`, view: sourceView, direction };
        });
        const main = concept ? sources[view] : detail.files.find((file) => file.role === "main" && file.ordinal === 0);
        if (!main) throw new Error("此版本缺少完整的主文件或概念视图。");
        const blob = await download(main);
        let frameTable: unknown, imageUrl: string | undefined, diagnosticUrl: string | undefined, rigProbe: RigProbeSpec | undefined, probeProblem: string | undefined;
        if (kind === "anim_2d" && !concept) {
          const frames = detail.files.find((file) => file.role === "frames" && file.ordinal === 0);
          if (!frames) throw new Error("此动画缺少 frames/0，无法播放。");
          const json = await download(frames);
          if (json.size > 2 * 1024 * 1024) throw new Error("帧表超出预览读取预算。");
          frameTable = JSON.parse(await json.text());
        }
        if (cancelled) return;
        if (concept) { imageUrl = URL.createObjectURL(blob); urls.push(imageUrl); }
        if (kind === "character_3d" && detail.stage === "rigged") {
          try { rigProbe = parseRigProbe(detail.version.spec_json.rig_metadata); } catch (problem) { probeProblem = message(problem); }
          const diagnostic = detail.files.find((file) => file.role === "preview" && file.ordinal === 0);
          if (diagnostic) {
            if (diagnostic.mime !== "image/png" || Number(diagnostic.byte_length) > 32 * 1024 * 1024) throw new Error("角色诊断预览格式或大小不正确。");
            const diagnosticBlob = await download(diagnostic);
            if (cancelled) return;
            diagnosticUrl = URL.createObjectURL(diagnosticBlob); urls.push(diagnosticUrl);
          }
        }
        if (!cancelled) setLoaded({ identity, view, blob, artifacts, frameTable, imageUrl, diagnosticUrl, rigProbe, probeProblem, choices, output });
      } catch (problem) { if (!cancelled) setError(message(problem)); }
    })();
    return () => { cancelled = true; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [api, project, meta, kind, view]);

  const record = (identity: string, update: (old: PreviewEvidence) => PreviewEvidence, resource: Preview) => {
    if (active.current.metadata?.identity !== identity || active.current.resource !== resource) return;
    setObserved((old) => ({ identity, evidence: update(old.identity === identity ? old.evidence : emptyPreviewEvidence()) }));
  };
  const meshObservation = (observation: MeshPreviewObservation) => {
    if (!current) return;
    record(current.identity, (old) => ({ ...old, ...observation, loaded_artifact_tokens: observation.decoded ? current.artifacts : [] }), current);
  };
  const evidence = current && observed.identity === current.identity ? observed.evidence : emptyPreviewEvidence();
  const binding = meta?.detail.dependencies[0], output = current?.output;
  const sourceChoice = current?.choices?.[view];
  let content;
  if (error) content = <div role="alert"><p>{error}</p><button type="button" onClick={refresh}>重试读取</button></div>;
  else if (!current) content = <p role="status">正在读取固定版本的文件…</p>;
  else if (current.imageUrl) content = <section aria-label="概念视图预览"><label>概念视图 <select aria-label="概念视图" value={view} onChange={(event) => setView(Number(event.target.value))}>{current.choices?.map((item, index) => <option key={item.artifact} value={index}>{item.name}</option>)}</select></label>
    <img key={current.imageUrl} src={current.imageUrl} alt={`第 ${version.version} 版概念视图 ${view + 1}`} style={{ maxWidth: "100%", maxHeight: 500 }} onLoad={() => {
      record(current.identity, (old) => ({ ...old, decoded: true, error: null,
        loaded_artifact_tokens: union(old.loaded_artifact_tokens, current.artifacts), checked_views: sourceChoice?.view ? union(old.checked_views, [sourceChoice.view]) : old.checked_views,
        checked_directions: sourceChoice?.direction ? union(old.checked_directions, [sourceChoice.direction]) : old.checked_directions }), current);
    }} onError={() => record(current.identity, () => ({ ...emptyPreviewEvidence(), error: "概念图片未能解码。" }), current)} />
  </section>;
  else if (kind === "character_3d") content = <><p>角色原文件预览。诊断姿势在本实例的真实骨骼上应用；人工确认与引擎验收分别记录。</p>
    {current.probeProblem && <p className="ga-error">诊断姿势不可用：{current.probeProblem}</p>}
    <MeshPreview key={`${current.identity}:${reload}`} blob={current.blob} isCharacter rigProbe={current.rigProbe} onObservation={meshObservation} />
    {current.diagnosticUrl && <details><summary>查看 rest 与诊断姿势的三向几何预览</summary><p>每列为原姿势或一个诊断姿势，三行为正、侧、背面。仅显示线框几何，不代表材质或引擎效果通过。</p><img src={current.diagnosticUrl} alt="角色 rest 与诊断姿势的三向几何预览" style={{ maxWidth: "100%" }} /></details>}</>;
  else if (kind === "anim_3d" && current.animation) content = <section aria-label="绑定角色的 3D 动作预览"><MeshPreview key={`${current.identity}:${reload}`} blob={current.blob} isCharacter animation={current.animation} onObservation={meshObservation} /></section>;
  else content = <Animation2dPreview png={current.blob} frameTable={current.frameTable} contextKey={requestKey} sampling={output?.sampling as "nearest" | "linear"} pixelsPerWorldUnit={output?.pixels_per_world_unit as number}
    onDecoded={(session) => { if (session === requestKey) record(current.identity, (old) => ({ ...old, decoded: true, error: null, loaded_artifact_tokens: current.artifacts }), current); }}
    onError={(session, problem) => { if (session === requestKey) record(current.identity, () => ({ ...emptyPreviewEvidence(), error: problem }), current); }}
    onPlayback={(session, direction, loop) => { if (session === requestKey) record(current.identity, (old) => ({ ...old, playback_observed: true, checked_directions: union(old.checked_directions, [direction]), looped_directions: loop ? union(old.looped_directions, [direction]) : old.looped_directions }), current); }} />;
  return <>
    {binding && <p>绑定角色：{binding.target_display_name} · 第 {binding.target_version_number} 版（{binding.target_version_token}）。{!binding.bound_version_is_current && "当前选定版本已不同，仍使用此动作绑定的角色。"}{binding.target_asset_archived && "来源角色已归档。"}</p>}
    {content}
    <AnimatedVersionReview key={version.token} api={api} version={version.token} sessionKey={`${meta?.identity ?? version.token}:${view}:${reload}:${refreshKey}`} detail={meta?.detail ?? null} evidence={evidence} poseIds={current?.rigProbe?.poses.map((pose) => pose.id) ?? []}
      supportsReview={supportsReviewV2} supportsSelection={supportsSelectionV2} onRefresh={refresh} onChanged={onChanged} />
  </>;
}

function union(old: string[], next: string[]) { return [...new Set([...old, ...next])]; }
function message(problem: unknown) { return problem instanceof Error ? problem.message : "预览读取失败。"; }
function specNumber(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("动作规格缺少有效的时间或绑定容差。"); return value; }
