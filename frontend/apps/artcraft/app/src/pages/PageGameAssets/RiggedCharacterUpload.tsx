import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi, GameAssetInfo, GameProjectProfileInfo, GameAssetVersionInfo } from "@storyteller/api";
import { GameAssetsApiError } from "@storyteller/api";
import { rigNodePaths, submitRiggedUpload, type RigUploadOperation } from "./rigged-upload";

interface Props {
  api: GameAssetsApi;
  project: string;
  profile: GameProjectProfileInfo | null;
  assets: (GameAssetInfo & { versions: GameAssetVersionInfo[] })[];
  onRun: (run: string, asset: string) => void;
  onClose: () => void;
}

export function RiggedCharacterUpload({ api, project, profile, assets, onRun, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), readEpoch = useRef(0), mounted = useRef(true);
  const pendingKey = `ga_pending_rig_upload:${project}`;
  const operation = useRef<RigUploadOperation | undefined>(readPending(pendingKey, project));
  const [stableKey, setStableKey] = useState(operation.current?.stableKey ?? "");
  const [target, setTarget] = useState(operation.current?.asset?.token ?? "");
  const [parent, setParent] = useState(operation.current?.parent ?? "");
  const [bytes, setBytes] = useState<ArrayBuffer>();
  const [paths, setPaths] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(operation.current?.mapping ?? {}).map(([slot, path]) => [slot, JSON.stringify(path)])));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [progress, setProgress] = useState("");
  const [canDiscard, setCanDiscard] = useState(false);
  const saved = operation.current;
  const spec = (profile?.profile_json.specs as Record<string, unknown> | undefined)?.character_3d as Record<string, unknown> | undefined;
  const rig = spec?.rig_profile as { bones?: { slot: string }[]; motion_root_slot?: string } | undefined;
  const slots = Array.isArray(rig?.bones) ? rig.bones.map((bone) => bone.slot).filter((slot) => typeof slot === "string") : [];
  const character = assets.find((asset) => asset.token === target && asset.kind === "character_3d");

  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    return () => { mounted.current = false; readEpoch.current++; dialog.current?.close(); };
  }, []);
  const readFile = async (file?: File) => {
    const epoch = ++readEpoch.current; setError(""); setPaths([]); setBytes(undefined);
    if (!file) return;
    try {
      if (file.size > 256 * 1024 * 1024) throw new Error("GLB 文件不能超过 256 MiB。");
      const next = await file.arrayBuffer(), nodes = rigNodePaths(next);
      if (!mounted.current || epoch !== readEpoch.current) return;
      setBytes(next); setPaths(nodes);
      if (operation.current) operation.current.bytes = next;
    } catch (problem) { if (mounted.current && epoch === readEpoch.current) setError(message(problem)); }
  };
  const persist = () => {
    const current = operation.current;
    if (!current) return;
    localStorage.setItem(pendingKey, JSON.stringify({ ...current, bytes: undefined }));
  };
  const submit = async () => {
    if (busy) return;
    setError(""); setCanDiscard(false);
    try {
      if (!operation.current) {
        if (!profile || !slots.length || !rig?.motion_root_slot) throw new Error("请先在项目设置中保存完整的角色规格和骨架规则。");
        if (!bytes || !paths.length) throw new Error("请先选择原 GLB 文件。");
        if (!target && !/^[a-z][a-z0-9_]{0,99}$/.test(stableKey)) throw new Error("角色标识请使用小写字母开头、最多 100 位的字母、数字和下划线。");
        if (target && !character) throw new Error("所选角色已不可用，请刷新项目。");
        const available = new Set(paths.map((path) => JSON.stringify(path))), selected: Record<string, string[]> = {};
        for (const slot of slots) {
          let path: string[];
          try { path = JSON.parse(mapping[slot] ?? "null") as string[]; } catch { throw new Error(`请为 ${slot} 选择完整节点路径。`); }
          if (!available.has(JSON.stringify(path))) throw new Error(`请为 ${slot} 选择场景 0 中的完整节点路径。`);
          selected[slot] = path;
        }
        if (new Set(Object.values(selected).map((path) => JSON.stringify(path))).size !== slots.length) throw new Error("不同语义骨骼不能映射到同一个节点。");
        if (!selected[rig.motion_root_slot]) throw new Error("角色规格缺少运动根语义槽位。请修正项目设置。");
        operation.current = { key: crypto.randomUUID(), project, stableKey: character?.stable_key ?? stableKey, profile: profile.token,
          bytes, mapping: selected, motionRoot: selected[rig.motion_root_slot], asset: character ? { token: character.token, revision: character.revision, stable_key: character.stable_key } : undefined, parent: parent || undefined };
        persist();
      }
      setBusy(true);
      const run = await submitRiggedUpload(api, operation.current, (value) => { if (mounted.current) setProgress(value); }, persist);
      if (mounted.current) { onRun(run, operation.current.asset!.token); localStorage.removeItem(pendingKey); onClose(); }
    } catch (problem) { if (mounted.current) {
      setError(message(problem));
      setCanDiscard(problem instanceof GameAssetsApiError && [400, 404, 409, 422].includes(problem.status) && problem.code !== "idempotency_conflict");
    } }
    finally { if (mounted.current) { setBusy(false); setProgress(""); } }
  };
  return <dialog ref={dialog} className="ga-dialog" aria-labelledby="ga-rig-upload-title" onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <header className="ga-dialog-heading"><div><h2 id="ga-rig-upload-title">上传已绑骨角色</h2><p>免费检查原文件、骨架和诊断姿势；检查后查看候选，不自动选入交付。</p></div><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
    <div className="ga-dialog-body">
      {saved && <p className="ga-info">继续上次未确认的上传。仍使用原提交键、项目规格与骨骼映射；封存完成后无需再次选择文件。</p>}
      {!saved && <>
        <label className="ga-field">角色<select aria-label="上传目标角色" value={target} onChange={(event) => { setTarget(event.target.value); setParent(""); setError(""); }}><option value="">创建新角色</option>{assets.filter((asset) => asset.kind === "character_3d" && !asset.maybe_archived_at).map((asset) => <option key={asset.token} value={asset.token}>{asset.stable_key}</option>)}</select></label>
        {!target ? <label className="ga-field">角色标识<input aria-label="新角色标识" value={stableKey} maxLength={100} onChange={(event) => { setStableKey(event.target.value); setError(""); }} placeholder="hero_knight" /></label>
          : <label className="ga-field">基础版本（可选）<select aria-label="上传角色的基础版本" value={parent} onChange={(event) => { setParent(event.target.value); setError(""); }}><option value="">{character?.versions.length ? "不关联基础版本（独立上传候选）" : "空角色，没有基础版本"}</option>{character?.versions.map((version) => <option key={version.token} value={version.token}>第 {version.version} 版 · {String(version.spec_json.stage)}</option>)}</select></label>}
        <p>使用项目设置：{profile ? `第 ${profile.version} 版` : "尚未保存"}。{!slots.length && "请先在设置中导入完整角色规格。"}</p>
      </>}
      {(!saved?.sealed && !saved?.uploaded) && <label className="ga-field">角色 GLB<input type="file" accept=".glb" aria-label="已绑骨角色原 GLB" disabled={busy} onChange={(event) => void readFile(event.target.files?.[0])} /><small>保留原字节、骨骼名称、尺寸与坐标；不执行静态道具缩放或改造。</small></label>}
      {!saved && paths.length > 0 && <fieldset><legend>骨架语义映射</legend><p>路径从场景 0 开始。选择每个槽位的实际节点，运动根使用 {rig?.motion_root_slot} 槽位。</p>
        <datalist id="ga-rig-node-paths">{paths.map((path) => <option key={JSON.stringify(path)} value={JSON.stringify(path)} />)}</datalist>
        {slots.map((slot) => <label key={slot} className="ga-field">{slot}<input aria-label={`骨骼映射 ${slot}`} list="ga-rig-node-paths" value={mapping[slot] ?? ""} onChange={(event) => { setMapping((old) => ({ ...old, [slot]: event.target.value })); setError(""); }} /></label>)}
      </fieldset>}
      {saved && <details><summary>本次上传的固定输入</summary><p>角色：{saved.asset?.stable_key ?? saved.stableKey} · 项目规格：{saved.profile}</p><pre className="ga-diagnostics">{JSON.stringify(saved.mapping, null, 2)}</pre></details>}
      {error && <p role="alert" className="ga-error">{error}</p>}{progress && <p role="status">{progress}</p>}
      {canDiscard && <button type="button" disabled={busy} onClick={() => { localStorage.removeItem(pendingKey); onClose(); }}>放弃此次未提交检查，返回项目修正</button>}
    </div>
    <footer className="ga-dialog-footer"><button type="button" disabled={busy} onClick={onClose}>{saved ? "稍后继续" : "取消上传"}</button><button type="button" className="ga-primary" disabled={busy || !saved && (!bytes || !slots.length || !profile)} onClick={() => void submit()}>{busy ? "正在提交…" : saved ? "继续原上传与检查" : "上传并免费检查"}</button></footer>
  </dialog>;
}

function readPending(key: string, project: string): RigUploadOperation | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as RigUploadOperation | null;
    return value?.project === project && typeof value.key === "string" && value.mapping && typeof value.profile === "string" ? value : undefined;
  } catch { return undefined; }
}
function message(problem: unknown) { return problem instanceof Error ? problem.message : "角色上传尚未确认，请继续同一提交。"; }
