import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi, GameAssetsCapabilities, GameProjectInfo, GameProjectProfileInfo, GameAssetVersionInfo, GameCreationInput, GameCreationOperation, GameCreationPlan,GameCreationRun } from "@storyteller/api";
import { readSettings, RECOMMENDED_SETTINGS, KIND_LABELS, type AssetKind } from "./profile";
import { uploadCreationImage, prepareReference, type CreationUpload } from "./creation-upload";
import { MaskEditor } from "./MaskEditor";
import { GameAssetsApiError, gameAssetOperation } from "@storyteller/api";

export interface CreationSeed {
  key: string; operation: GameCreationOperation;
  source?: { version: GameAssetVersionInfo; kind: AssetKind; name: string };
  useAsStyle?: boolean; initialChange?: string;
  restore?:GameCreationRun;
}
export type CreationProjectChoice = { mode: "new"; name: string } | { mode: "existing"; token: string };
type Context = { project: GameProjectInfo; profile: GameProjectProfileInfo };
interface Props {
  api: GameAssetsApi; open: boolean; seed: CreationSeed; capabilities: GameAssetsCapabilities | null;
  project: GameProjectInfo | null; profile: GameProjectProfileInfo | null; projects: GameProjectInfo[];
  ensureProject: (choice?: CreationProjectChoice) => Promise<Context>;
  onStarted: (project: string, asset: string, run: string) => void;
  onUnconfirmed: (project: string) => void;
  onDraftChanged:(active:boolean,project?:string)=>void;
  onClose: () => void;
}
const OP_LABELS: Record<GameCreationOperation, string> = { generate: "制作新资产", edit: "修改外观", inpaint: "局部修改", mesh: "从概念图生成模型", reprocess: "重新加工", cutout: "去除背景", erase: "清除选区为透明" };

export function CreationComposer({ api, open, seed, capabilities, project, profile, projects, ensureProject, onStarted, onUnconfirmed, onDraftChanged, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<AssetKind>("icon_2d");
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [use, setUse] = useState("背包界面，深色格子中显示约 64×64 像素");
  const [preserve, setPreserve] = useState(""); const [style, setStyle] = useState(RECOMMENDED_SETTINGS.style);
  const [count, setCount] = useState(2); const [height, setHeight] = useState(1);
  const [canvas, setCanvas] = useState(512); const [inset, setInset] = useState(32);
  const [upscale, setUpscale] = useState(false); const [triangles, setTriangles] = useState(20000);
  const [texture, setTexture] = useState(2048); const [rotation, setRotation] = useState(0);
  const [purpose, setPurpose] = useState<"style" | "subject" | "both">("subject");
  const [reference, setReference] = useState<Blob | null>(null); const [referenceUrl, setReferenceUrl] = useState<string>();
  const [source, setSource] = useState<Blob | null>(null); const [mask, setMask] = useState<Blob | null>(null); const [maskUrl,setMaskUrl]=useState<string>();
  const [projectChoice, setProjectChoice] = useState<string>("new"); const [newProjectName, setNewProjectName] = useState("");
  const [plan, setPlan] = useState<GameCreationPlan | null>(null); const [context, setContext] = useState<Context | null>(null);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false); const [uncertain, setUncertain] = useState(false);
  const [initializedSeed, setInitializedSeed] = useState<string>();
  const operation = seed.operation;
  const requestEpoch = useRef(0); const prepareKey = useRef(crypto.randomUUID()); const startKey = useRef(crypto.randomUUID());
  const refUpload = useRef<CreationUpload | undefined>(undefined); const maskUpload = useRef<CreationUpload | undefined>(undefined);
  const restoredReference=useRef<string|undefined>(undefined);
  const pureProcessing = ["mesh", "reprocess", "cutout", "erase"].includes(operation);
  const seedProject=useRef(project?.token);
  const notifyDraft=useRef(onDraftChanged);notifyDraft.current=onDraftChanged;
  useEffect(()=>{notifyDraft.current(!submitted&&!!(name.trim()||description.trim()||reference||plan),context?.project.token??seedProject.current);},[name,description,reference,plan,submitted,context?.project.token]);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open) dialog.current?.close(); }, [open]);
  useEffect(() => {
    requestEpoch.current++;
    seedProject.current=project?.token;
    const settings = profile ? readSettings(profile.profile_json) : RECOMMENDED_SETTINGS;
    const version = seed.source?.version;
    const saved=seed.restore?.making;
    const output = saved?.output ?? version?.spec_json.output as Record<string, unknown> | undefined;
    const defaultKind = Object.keys(KIND_LABELS).find((kind) => capabilities?.asset_kinds.includes(kind)) as AssetKind | undefined;
    const sourceKind = (seed.restore?.kind as AssetKind | undefined) ?? seed.source?.kind ?? defaultKind ?? "icon_2d";
    setKind(sourceKind); setName(seed.restore?.display_name??(operation === "generate" ? "" : seed.source?.name ?? ""));
    setDescription(saved?.description??seed.initialChange ?? (typeof version?.spec_json.description === "string" ? version.spec_json.description : operation === "generate" ? "" : seed.source?.name ?? ""));
    setUse(saved?.use_case??(typeof version?.spec_json.use_case === "string" ? version.spec_json.use_case : sourceKind === "prop_3d" ? "第三人称游戏场景中的静态道具" : "背包界面，深色格子中显示约 64×64 像素"));
    setPreserve(saved?.preserve??(operation === "generate" ? "" : "保留主体轮廓、比例和未要求改变的细节"));
    setStyle(saved?.style??(typeof version?.spec_json.style === "string" ? version.spec_json.style : settings.style));
    setCount(["mesh", "reprocess", "cutout", "erase"].includes(operation) ? 1 : 2);
    setHeight(Number(output?.target_height_m ?? settings.meshHeight)); setTriangles(Number(output?.max_triangles ?? settings.maxTriangles));
    setTexture(Number(output?.max_texture_size ?? settings.textureSize)); setRotation(0);
    setCanvas(Number(output?.canvas ?? (sourceKind === "sprite_2d" ? settings.spriteSize : settings.iconSize)));
    setInset(Number(output?.content_inset_px ?? (sourceKind === "sprite_2d" ? settings.spriteInset : settings.iconInset)));
    setUpscale(output?.allow_upscale === true || settings.allowUpscale);
    setReference(null); setSource(null); setMask(null); setPlan(null); setContext(null); setSubmitted(false); setUncertain(false); setBusy(""); setError(""); setAcknowledged(false);
    setProjectChoice(project?.token ?? "new"); setNewProjectName("");
    setPurpose(saved?.reference_purpose??(seed.useAsStyle ? "style" : "subject")); refUpload.current = undefined; maskUpload.current = undefined;
    restoredReference.current=!seed.source?saved?.maybe_source_artifact_token??undefined:undefined;
    prepareKey.current = crypto.randomUUID(); startKey.current = crypto.randomUUID();
    setInitializedSeed(seed.key);
    // An explicit new intent resets the composer. Closing preserves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed.key]);
  useEffect(() => {
    const blob = reference ?? source; if (!blob || !blob.type.startsWith("image/")) { setReferenceUrl(undefined); return; }
    const url = URL.createObjectURL(blob); setReferenceUrl(url); return () => URL.revokeObjectURL(url);
  }, [reference, source]);
  useEffect(()=>{if(!mask){setMaskUrl(undefined);return;}const url=URL.createObjectURL(mask);setMaskUrl(url);return()=>URL.revokeObjectURL(url);},[mask]);
  useEffect(() => {
    if (!project?.token || !open) return;
    let cancelled = false;
    if(!seed.source&&restoredReference.current){void api.DownloadGameArtifact(project.token,restoredReference.current).then((blob)=>{if(!cancelled)setSource(blob);}).catch((problem)=>{if(!cancelled)setError(problem.message);});return()=>{cancelled=true;};}
    if(!seed.source)return;
    void api.GetGameAssetVersion(seed.source.version.token).then(async (detail) => {
      const file = detail.files.find((entry) => entry.role === "main" && entry.ordinal === 0) ?? detail.files.find((entry) => entry.role === "preview" && entry.ordinal === 0);
      if (!file) throw new Error("选中的版本没有可读取的素材。");
      const blob = await api.DownloadGameArtifact(project.token, file.artifact_token);
      if (!cancelled) setSource(blob);
    }).catch((problem) => { if (!cancelled) setError(problem instanceof Error ? problem.message : "原图读取失败。"); });
    return () => { cancelled = true; };
  }, [api, seed.key, seed.source, project?.token, open]);
  const invalidate = () => { setPlan(null); setAcknowledged(false); setError(""); prepareKey.current = crypto.randomUUID(); };
  const prepare = async () => {
    if (busy || initializedSeed !== seed.key || !gameAssetOperation(capabilities, kind, operation).enabled) return;
    const epoch = requestEpoch.current;
    setError(""); setBusy("整理需求与输出条件…");
    try {
      if (!name.trim() || !description.trim() || !use.trim()) throw new Error("请填写资产名称、想要的对象和用途。");
      if (["inpaint", "erase"].includes(operation) && !mask) throw new Error("请先在原图上标记要修改的区域。");
      let projectChoiceValue: CreationProjectChoice | undefined;
      if (!project) {
        if (projectChoice === "new") {
          if (!newProjectName.trim()) throw new Error("请输入新项目名称，或选择一个已有项目。");
          projectChoiceValue = { mode: "new", name: newProjectName };
        } else projectChoiceValue = { mode: "existing", token: projectChoice };
      }
      const ctx = await ensureProject(projectChoiceValue);
      if (epoch !== requestEpoch.current) return;
      setContext(ctx);
      let referenceToken: string | undefined=restoredReference.current; let maskToken: string | undefined;
      if (reference) {
        setBusy("保存本次私有参考图…");
        if (!refUpload.current || refUpload.current.project !== ctx.project.token) refUpload.current = { key: crypto.randomUUID(), project: ctx.project.token };
        referenceToken = await uploadCreationImage(api, reference, refUpload.current);
      }
      if (mask) {
        setBusy("保存修改选区…");
        if (!maskUpload.current || maskUpload.current.project !== ctx.project.token) maskUpload.current = { key: crypto.randomUUID(), project: ctx.project.token };
        maskToken = await uploadCreationImage(api, mask, maskUpload.current);
      }
      const input: GameCreationInput = {
        profile_token: ctx.profile.token, kind, operation, display_name: name.trim(), description: description.trim(), use_case: use.trim(), preserve: preserve.trim(),
        candidate_count: count, ...(pureProcessing ? {} : { maybe_style_override: style.trim() }),
        ...(seed.source ? { maybe_source_version_token: seed.source.version.token } : {}),
        ...(seed.restore?{maybe_target_asset_token:seed.restore.asset_token}:{}),
        ...(referenceToken ? { maybe_reference_artifact_token: referenceToken } : {}),
        ...(operation === "generate" ? { maybe_reference_purpose: purpose, maybe_override_project_reference: !!(referenceToken || seed.source) } : {}),
        ...(maskToken ? { maybe_mask_artifact_token: maskToken } : {}),
        maybe_output_overrides: kind === "prop_3d" ? { target_height_m: height, max_triangles: triangles, max_texture_size: texture, rotation_y_degrees: rotation }
          : { canvas, content_inset_px: inset, allow_upscale: upscale }, maybe_idempotency_key: prepareKey.current,
      };
      setBusy("核对生成条件并取得本次费用估算…");
      const prepared = await api.PrepareCreation(ctx.project.token, input);
      if (epoch === requestEpoch.current) { setPlan(prepared); setAcknowledged(false); startKey.current = crypto.randomUUID(); }
    } catch (problem) { if (epoch === requestEpoch.current) setError(problem instanceof Error ? problem.message : "制作说明暂未准备好，请重试。"); }
    finally { if (epoch === requestEpoch.current) setBusy(""); }
  };
  const start = async () => {
    if (!plan || !context || busy || !acknowledged || !uncertain && !gameAssetOperation(capabilities, kind, operation).enabled) return;
    if (!uncertain && Date.parse(plan.expires_at)<=Date.now()) {prepareKey.current=crypto.randomUUID();setPlan(null);setAcknowledged(false);setError("报价已过期，请重新查看制作说明与费用。");return;}
    const captured = context; const epoch = requestEpoch.current;
    setBusy("提交本次制作…"); setError("");
    localStorage.setItem(`ga_pending_creation:${captured.project.token}`, JSON.stringify({ plan: plan.plan_token, key: startKey.current }));
    try {
      const result = await api.StartCreation(captured.project.token, plan, startKey.current);
      localStorage.removeItem(`ga_pending_creation:${captured.project.token}`);
      onStarted(captured.project.token, result.asset_token, result.run_token);
      if (epoch === requestEpoch.current) { setSubmitted(true); setUncertain(false); }
    } catch (problem) {
      onUnconfirmed(captured.project.token);
      const rejected=problem instanceof GameAssetsApiError&&problem.status>=400&&problem.status<500;
      if(rejected)localStorage.removeItem(`ga_pending_creation:${captured.project.token}`);
      if (epoch === requestEpoch.current) { setUncertain(!rejected); setError(problem instanceof Error ? problem.message : "提交结果暂未确认，请重试同一操作。"); }
    } finally { if (epoch === requestEpoch.current) setBusy(""); }
  };
  const availability = gameAssetOperation(capabilities, kind, operation);
  const configured = availability.enabled;
  const readySeed = initializedSeed === seed.key;
  const canEdit = readySeed && !busy && !uncertain && !submitted;
  const output = plan?.making.output;
  return <dialog ref={dialog} className="ga-creation-dialog" aria-label={OP_LABELS[operation]} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><h2>{OP_LABELS[operation]}</h2><p>{seed.source ? `来源：${seed.source.name} · 第 ${seed.source.version.version} 版` : "从对象与用途开始，不需要先准备 PNG 或 GLB。"}</p><small>将保存到项目：{context?.project.name ?? project?.name ?? (projectChoice === "new" ? newProjectName.trim() || "在下方选择已有项目或输入新项目名称" : projects.find((p) => p.token === projectChoice)?.name ?? "在下方选择已有项目")}</small></div><button type="button" className="ga-action" onClick={onClose}>关闭</button></header>
    <div className="ga-creation-scroll">
      {!readySeed ? <p role="status">读取这次制作的需求与来源…</p> : submitted ? <div className="ga-creation-complete"><h3>制作任务已保存</h3><p>关闭此面板，在工作区查看进度与真实候选。离开页面后任务仍会继续。</p><button type="button" className="ga-action ga-primary" onClick={onClose}>查看进度与候选</button></div> : <>
        {!configured && <p className="ga-error" role="status">{availability.reason}</p>}
        <fieldset hidden={!!plan} disabled={!canEdit} className="ga-creation-fields" onChange={invalidate}>
          {!project && <><label className="ga-field">保存到项目<select aria-label="保存到项目" value={projectChoice} onChange={(event) => { setProjectChoice(event.target.value); }}>
            <option value="new">新建项目…</option>
            {projects.map((p) => <option key={p.token} value={p.token}>{p.name}</option>)}
          </select></label>
          {projectChoice === "new" && <label className="ga-field">新项目名称<input aria-label="新项目名称" value={newProjectName} maxLength={200} placeholder="例如：森林驿站" onChange={(event) => setNewProjectName(event.target.value)} /></label>}
          <small>每项资产都属于项目；这里决定本次制作保存到哪个项目。</small></>}
          {operation === "generate" && <><label className="ga-field">用来做什么<select aria-label="制作资产类型" value={kind} onChange={(event) => { const next = event.target.value as AssetKind; setKind(next); setUse(next === "prop_3d" ? "第三人称游戏场景中的静态道具" : next === "sprite_2d" ? "俯视角 2D 地图中的静态物件" : "背包界面，深色格子中显示约 64×64 像素"); }}>{!capabilities?.asset_kinds.includes(kind) && <option value={kind} disabled>{KIND_LABELS[kind]} · 当前服务未交付</option>}{Object.entries(KIND_LABELS).filter(([key]) => capabilities?.asset_kinds.includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            {!seed.source && <div className="ga-inline-controls"><span>试填示例：</span><button type="button" className="ga-action" disabled={!capabilities?.asset_kinds.includes("icon_2d")} onClick={() => { setKind("icon_2d"); setName("治疗药水"); setDescription("一小瓶红色治疗药水，圆润玻璃瓶、软木塞、清晰的瓶身轮廓"); setUse("森林 RPG 的深色背包格子，实际显示 64×64 像素"); invalidate(); }}>背包药水</button><button type="button" className="ga-action" disabled={!capabilities?.asset_kinds.includes("prop_3d")} onClick={() => { setKind("prop_3d"); setName("营地木箱"); setDescription("一个静态关闭的旧木箱，厚木板、简单金属包角，单个整体道具"); setUse("第三人称营地场景，需要与人物尺度匹配的半米木箱"); setHeight(0.5); invalidate(); }}>半米木箱</button></div>}</>}
          <label className="ga-field">资产名称<input aria-label="制作资产名称" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="例如：治疗药水" /></label>
          <label className="ga-field">{pureProcessing ? "来源说明" : ["edit", "inpaint"].includes(operation) ? "这次修改什么" : "想要什么对象"}<textarea aria-label="对象与修改需求" rows={3} maxLength={4000} readOnly={pureProcessing} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述对象、形状、颜色、材质或想修改的位置" />{pureProcessing && <small>{operation === "mesh" ? "模型按这张概念图重建造型，文字说明用于保留来源。要改变造型，请先修改概念图。" : "本次按选中的文件加工，文字说明用于保留来源。改变外观请先修改图像或概念。"}</small>}</label>
          <label className="ga-field">在游戏中如何使用<textarea aria-label="资产游戏用途" rows={2} maxLength={1000} value={use} onChange={(event) => setUse(event.target.value)} /></label>
          {!pureProcessing && <label className="ga-field">本次外观要求<textarea aria-label="本次画风" rows={2} maxLength={2000} value={style} onChange={(event) => setStyle(event.target.value)} /><small>本次可单独调整；项目默认风格始终可从工作区上方查看和修改。</small></label>}
          {(operation === "edit" || operation === "inpaint") && <label className="ga-field">希望保留什么<input aria-label="修改时保留的内容" value={preserve} maxLength={1000} onChange={(event) => setPreserve(event.target.value)} /></label>}
          {operation === "generate" && !seed.source && <label className="ga-field">参考图片（可选）<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传制作参考图" onChange={(event) => { const file = event.target.files?.[0]; refUpload.current = undefined; if (!file) { setReference(null); return; } const epoch = requestEpoch.current; setBusy("准备参考图…"); void prepareReference(file).then((blob) => { if (epoch === requestEpoch.current) setReference(blob); }).catch((problem) => { if (epoch === requestEpoch.current) setError(problem.message); }).finally(() => { if (epoch === requestEpoch.current) setBusy(""); }); }} /><small>使用私有 PNG 工作副本，最长边最多 1024px；原文件不变。</small></label>}
          {(reference || seed.source && operation === "generate") && <label className="ga-field">参考的用途<select aria-label="参考图片用途" value={purpose} onChange={(event) => setPurpose(event.target.value as typeof purpose)}><option value="subject">参考对象的外形与构造</option><option value="style">只参考画风，制作新的对象</option><option value="both">参考对象及其外观</option></select></label>}
          {referenceUrl && !["inpaint", "erase"].includes(operation) && <figure className="ga-reference-preview"><img src={referenceUrl} alt="实际用于本次制作的私有参考或源图" /><figcaption>{seed.source ? "使用选定版本作为来源" : "本次上传的工作参考图"}</figcaption></figure>}
          {["inpaint", "erase"].includes(operation) && source && <MaskEditor source={source} purpose={operation === "erase" ? "erase" : "edit"} onChange={(blob) => { maskUpload.current = undefined; setMask(blob); invalidate(); }} />}
          <details hidden={operation === "erase" || operation === "inpaint"} open={pureProcessing}><summary>本次输出条件{kind === "prop_3d" ? ` · ${height} 米高` : ` · ${canvas}×${canvas} 像素`}</summary><div className="ga-creation-output">
            {kind === "prop_3d" ? <><label className="ga-field">高度（米）<input aria-label="本次道具高度" type="number" min="0.01" max="100" step="0.01" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label><label className="ga-field">三角面预算<input aria-label="本次三角面预算" type="number" min="100" max="1000000" value={triangles} onChange={(event) => setTriangles(Number(event.target.value))} /></label><label className="ga-field">最大贴图边长<select value={texture} onChange={(event) => setTexture(Number(event.target.value))}>{[256,512,1024,2048,4096].map((size) => <option key={size} value={size}>{size}px</option>)}</select></label>{operation === "reprocess" && <label className="ga-field">绕竖直轴转向（度）<input aria-label="本次模型转向" type="number" min="-360" max="360" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} /></label>}</> : <><label className="ga-field">最终画布（像素）<input aria-label="本次输出图像尺寸" type="number" min="64" max="4096" value={canvas} onChange={(event) => setCanvas(Number(event.target.value))} /></label><label className="ga-field">透明留白（像素）<input aria-label="本次图像留白" type="number" min="0" value={inset} onChange={(event) => setInset(Number(event.target.value))} /></label><label className="ga-check"><input type="checkbox" checked={upscale} onChange={(event) => setUpscale(event.target.checked)} />允许放大较小主体</label></>}
          </div><p className="ga-help">本次设置会记录在新版本中。已有版本和选定交付内容保持原样。</p></details>
          {!pureProcessing && <label className="ga-field">候选数量<select aria-label="制作候选数量" value={count} onChange={(event) => setCount(Number(event.target.value))}>{[1,2,3,4].map((number) => <option key={number} value={number}>{number} 个候选</option>)}</select></label>}
        </fieldset>
        {kind === "prop_3d" && operation === "generate" && <p className="ga-help">先制作可查看的概念图，选定后再单独生成模型。首版支持静态道具，角色骨骼、动作和可开合部件需另外制作。</p>}
        {plan && <section className="ga-making-summary" aria-label="本次制作说明与费用"><h3>确认这次要做的内容</h3><p>保存到项目:{context?.project.name ?? project?.name ?? "待选择"} · <strong>{plan.making.display_name}</strong> · {plan.making.candidate_count} 个{plan.making.stage === "concept" ? "概念图" : "候选"}</p><p>{pureProcessing ? "来源说明：" : ""}{plan.making.description}</p>{operation === "mesh" && <p className="ga-help">本次按选中的概念图重建 3D 模型，再应用下方尺寸和几何预算。文字保留制作来源；要改变造型，请先返回修改概念图。</p>}<p>用途：{plan.making.use_case}</p><p>外观：{plan.making.style}</p>{plan.making.preserve&&<p>保留：{plan.making.preserve}</p>}<p>输出：{kind === "prop_3d" ? `${plan.making.stage==="concept"?"本轮生成概念图；后续模型目标：":""}${output?.target_height_m} 米高 · ${output?.max_triangles} 三角面预算 · ${output?.max_texture_size}px 贴图 · 底部中心原点${Number(output?.rotation_y_degrees) ? ` · 绕竖直轴转 ${output?.rotation_y_degrees}°` : ""}` : `${output?.canvas}×${output?.canvas} 透明图 · ${output?.content_inset_px}px 留白`}</p>{referenceUrl&&<figure className="ga-reference-preview"><img src={referenceUrl} alt="确认本次实际使用的参考或原图"/><figcaption>{operation === "mesh" ? "本次使用的概念图" : "本次参考或源图"}{plan.making.has_mask?"，按已标记的选区修改":""}</figcaption></figure>}{maskUrl&&<figure className="ga-reference-preview"><img src={maskUrl} alt="本次局部修改选区，白色为修改区域"/><figcaption>{operation === "erase" ? "白色选区清为透明；选区外像素原样保留。" : "白色区域会修改；其他原始像素保留。"}</figcaption></figure>}<p className="ga-quote">{formatCreationQuote(plan)}</p><p className="ga-help">{plan.quote.billing_mode === "local" ? "这次执行本地确定性加工，不调用收费生成模型。" : "费用由此实例配置的供应商账号承担。估算包含本次生成及所需去背，实际费用可能不同，当前没有供应商硬上限；重做会另行报价。"}</p><label className="ga-check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={!!busy} />我已核对制作内容、输出条件与本次费用</label></section>}
      </>}
      {error && <p role="alert" className="ga-error">{error}</p>}{busy && <p role="status">{busy}</p>}
    </div>
    {readySeed && !submitted && <footer>{plan ? <><button type="button" className="ga-action" disabled={!!busy || uncertain} onClick={invalidate}>调整需求</button><button type="button" className="ga-action ga-primary" disabled={!!busy || !acknowledged || !configured && !uncertain} onClick={() => void start()}>{uncertain ? "重试同一提交，确认结果" : "开始本次制作"}</button></> : <button type="button" className="ga-action ga-primary" disabled={!!busy || !configured} onClick={() => void prepare()}>查看制作说明与费用</button>}</footer>}
  </dialog>;
}

function formatCreationQuote(plan: GameCreationPlan): string {
  const quote = plan.quote.quote;
  if (quote.estimated_amount === null) return "尚未取得有效费用估算";
  if (plan.quote.billing_mode === "local") return "本地加工：无供应商生成费用";
  const currency = quote.unit === "cny_micro" ? "CNY" : "USD";
  const extra=(plan.quote.additional_estimates??[]).map((item)=>item.estimated_amount===null?"说明整理费用尚未确认":`说明整理约 ${new Intl.NumberFormat("zh-CN",{style:"currency",currency:item.unit==="cny_micro"?"CNY":"USD",maximumFractionDigits:6}).format(item.estimated_amount/1_000_000)}`).join("；");
  return `本次估算 ${new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 6 }).format(quote.estimated_amount / 1_000_000)}${plan.quote.method.startsWith("public_list_price") ? "（公开单价）" : "（历史调用估算）"}${extra?`；${extra}`:""}`;
}
