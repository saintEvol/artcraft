import { useEffect, useMemo, useRef, useState } from "react";
import {
  GenerationConnectorsApi,
  GameAssetsApiError,
  characterCreationV2Operation,
  type GameAssetsApi,
  type GameAssetsCapabilities,
  type GameAssetInfo,
  type GameAssetVersionInfo,
  type GameProjectProfileInfo,
  type GenerationConnector,
  type GameVersionGateV2,
  type PreparedCharacterMeshV2,
  type StartCharacterMeshV2,
} from "@storyteller/api";

const MODEL_LABELS: Record<string, string> = {
  "Tripo/Tripo-P1.0": "Tripo P1.0 · 面数 50–20,000",
  "Tripo/Tripo-H3.1": "Tripo H3.1 · 面数最多 1,500,000（超高几何 2,000,000）",
};
const TEXTURE_LABELS: Record<string, string> = { standard: "标准", detailed: "精细", extreme: "极致" };
const GEOMETRY_LABELS: Record<string, string> = { standard: "标准几何", ultra: "超高几何" };
const SIDE_LABELS: Record<string, string> = { left: "左侧面", right: "右侧面" };
const STEP_KEY_LABELS: Record<string, string> = { mesh: "生成模型", rig_check: "可绑骨检查（免费）", rig: "自动绑骨" };
const BAILIAN_PROVIDER = "bailian_tripo";

export interface MeshCharacterAsset extends GameAssetInfo {
  versions: GameAssetVersionInfo[];
}

interface Props {
  api: GameAssetsApi;
  project: string;
  profile: GameProjectProfileInfo | null;
  capabilities: GameAssetsCapabilities | null;
  assets: MeshCharacterAsset[];
  initialAsset?: string;
  /** The concept version the user is viewing; never the asset's current_version. */
  initialVersion?: string;
  onStarted: (project: string, run: string, asset: string) => void;
  onClose: () => void;
}

/** Paid character_3d/mesh launch: explicit reviewed concept selection, free
 * prepare with a per-step native quote, then one explicit authorization per
 * paid step before start_v2. Uncertain starts keep their idempotency key. */
export function CharacterMeshLaunch({ api, project, profile, capabilities, assets, initialAsset, initialVersion, onStarted, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const connectorsApi = useMemo(() => new GenerationConnectorsApi(), []);
  const requestEpoch = useRef(0);
  const connectorsEpoch = useRef(0);
  const prepareKey = useRef(crypto.randomUUID());
  const startKey = useRef(crypto.randomUUID());
  const [connectors, setConnectors] = useState<GenerationConnector[]>();
  const [connector, setConnector] = useState("");
  const [assetToken, setAssetToken] = useState(initialAsset ?? "");
  const [versionToken, setVersionToken] = useState("");
  const [gates, setGates] = useState<Record<string, GameVersionGateV2 | "failed">>({});
  const [model, setModel] = useState("Tripo/Tripo-P1.0");
  const [side, setSide] = useState<"left" | "right">("right");
  const [texture, setTexture] = useState("standard");
  const [faceLimit, setFaceLimit] = useState(20000);
  const [geometry, setGeometry] = useState("");
  const [plan, setPlan] = useState<PreparedCharacterMeshV2 | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [startedRun, setStartedRun] = useState("");
  const prepareAvailability = characterCreationV2Operation(capabilities, "prepare_mesh_v2");
  const startAvailability = characterCreationV2Operation(capabilities, "start_v2");
  const characters = assets.filter((asset) => asset.kind === "character_3d" && !asset.maybe_archived_at);
  const asset = characters.find((entry) => entry.token === assetToken);
  const concepts = (asset?.versions ?? []).filter((version) => version.spec_json.stage === "concept");
  const paidSteps = plan ? plan.quote.steps.filter((step) => step.quote.estimated_amount !== 0) : [];
  const allConfirmed = paidSteps.length > 0 && paidSteps.every((step) => confirmed[step.key]);

  useEffect(() => { if (prepareAvailability.enabled) dialog.current?.showModal(); return () => dialog.current?.close(); }, [prepareAvailability.enabled]);
  useEffect(() => {
    const epoch = ++connectorsEpoch.current;
    if (!prepareAvailability.enabled) return;
    setConnectors(undefined);
    void connectorsApi.ListAll()
      .then((items) => {
        if (epoch !== connectorsEpoch.current) return;
        const usable = items.filter((item) => item.provider === BAILIAN_PROVIDER && item.enabled && !item.archived);
        setConnectors(usable);
        setConnector((current) => usable.some((item) => item.token === current) ? current : usable[0]?.token ?? "");
      })
      .catch((problem) => {
        if (epoch !== connectorsEpoch.current) return;
        setConnectors([]);
        setError(problem instanceof Error ? problem.message : "Provider 连接器暂时无法读取。");
      });
    // One connector read per dialog; the server resolves the current configuration again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepareAvailability.enabled]);
  // Concept review gates decide which frozen concepts may be paid for; the
  // project view itself does not track character review state.
  useEffect(() => {
    const epoch = ++requestEpoch.current;
    setGates({});
    setVersionToken((current) => concepts.some((version) => version.token === current) ? current : "");
    if (!concepts.length) return;
    void Promise.all(concepts.map((version) => api.GetGameAssetVersionDetailsV2(version.token)
      .then((detail) => [version.token, detail.gate] as const)
      .catch(() => [version.token, "failed" as const] as const)))
      .then((entries) => {
        if (epoch !== requestEpoch.current) return;
        const next = Object.fromEntries(entries);
        setGates(next);
        setVersionToken((current) => current || (initialVersion && next[initialVersion]?.source_gate_passed === true ? initialVersion : ""));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetToken]);
  const invalidate = () => {
    setPlan(null); setConfirmed({}); setUncertain(false); setError("");
    prepareKey.current = crypto.randomUUID();
  };
  const prepare = async () => {
    if (busy || plan || !prepareAvailability.enabled) return;
    setError(""); setBusy("prepare");
    try {
      if (!profile) throw new Error("项目尚未保存制作设置；请先在设置中确认角色规格。");
      if (!asset || !versionToken) throw new Error("请选择要制作的角色和已审核通过的概念版本。");
      if (!connector) throw new Error("没有可用的百炼 Tripo 连接器，请先在 Provider 连接器中配置。");
      const bounds = faceLimitBounds(model);
      if (!Number.isInteger(faceLimit) || faceLimit < bounds[0] || faceLimit > bounds[1]) {
        throw new Error(`面数需要在 ${bounds[0].toLocaleString()}–${bounds[1].toLocaleString()} 之间。`);
      }
      const prepared = await api.PrepareCharacterMeshV2(project, {
        kind: "character_3d", operation: "mesh", candidate_count: 1,
        profile_token: profile.token,
        maybe_target_asset_token: asset.token,
        expected_revision: asset.revision,
        maybe_source_version_token: versionToken,
        maybe_parent_version_token: versionToken,
        connector_token: connector,
        mesh_parameters: {
          model: model as "Tripo/Tripo-P1.0" | "Tripo/Tripo-H3.1",
          side_orientation: side,
          texture_quality: texture as "standard" | "detailed" | "extreme",
          face_limit: faceLimit,
          geometry_quality: model === "Tripo/Tripo-H3.1" && geometry ? geometry as "standard" | "ultra" : null,
        },
        idempotency_key: prepareKey.current,
      });
      if (prepared.resolved_inputs.source_version_token !== versionToken) {
        throw new Error("准备结果与所选概念版本不一致，请重新选择后再试。");
      }
      setPlan(prepared); setConfirmed({}); setUncertain(false); startKey.current = crypto.randomUUID();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "制作说明与费用暂时无法准备，请重试。");
    } finally { setBusy(""); }
  };
  const start = async () => {
    if (!plan || busy || !allConfirmed) return;
    if (Date.parse(plan.expires_at) <= Date.now()) {
      invalidate(); setError("报价已过期，请重新查看制作说明与费用。");
      return;
    }
    const request: StartCharacterMeshV2 = {
      plan_token: plan.plan_token, plan_hash_hex: plan.plan_hash_hex, acknowledge_fees: true,
      fee_authorizations: paidSteps.map((step) => ({
        step_key: step.key, quote_hash: step.quote_hash,
        maximum_amount: step.quote.maybe_max_chargeable,
        accepts_uncapped_estimate: step.quote.maybe_max_chargeable === null,
      })),
      idempotency_key: startKey.current,
    };
    const pendingKey = `ga_pending_character_mesh_start:${project}:${plan.plan_token}`;
    setBusy("start"); setError("");
    localStorage.setItem(pendingKey, JSON.stringify({ key: request.idempotency_key }));
    try {
      const result = await api.StartCharacterMeshV2(project, request);
      localStorage.removeItem(pendingKey);
      setUncertain(false); setStartedRun(result.run_token);
      onStarted(project, result.run_token, result.asset_token);
    } catch (problem) {
      const rejected = problem instanceof GameAssetsApiError && problem.status >= 400 && problem.status < 500;
      if (rejected) localStorage.removeItem(pendingKey);
      setUncertain(!rejected);
      setError(problem instanceof Error ? problem.message : "提交结果暂未确认，请重试同一操作。");
    } finally { setBusy(""); }
  };
  if (!prepareAvailability.enabled) return null;
  const canPrepare = !!connectors?.length && !!asset && !!versionToken && !!profile;
  return <dialog ref={dialog} className="ga-creation-dialog" aria-label="角色模型收费制作" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><h2>角色模型收费制作</h2><p>{plan ? "以下费用与授权来自刚取得的制作计划。" : "选择同一角色的已审核概念，准备免费报价后再单独确认费用。"}</p></div>
      <button type="button" className="ga-action" onClick={onClose}>关闭</button></header>
    <div className="ga-creation-scroll">
      {startedRun ? <div className="ga-creation-complete"><h3>制作任务已提交</h3><p>任务 {startedRun} 已进入“角色检查与制作任务”列表；提交状态与结果在那里查看。</p><button type="button" className="ga-action ga-primary" onClick={onClose}>查看任务进度</button></div> : <>
        <fieldset hidden={!!plan} disabled={!!busy} className="ga-creation-fields" onChange={invalidate}>
          <label className="ga-field">角色<select aria-label="制作目标角色" value={assetToken} disabled={!!busy} onChange={(event) => { setAssetToken(event.target.value); }}>
            <option value="">{characters.length ? "请选择角色" : "当前项目还没有角色资产"}</option>
            {characters.map((entry) => <option key={entry.token} value={entry.token}>{entry.stable_key}{initialAsset === entry.token ? "（当前查看）" : ""}</option>)}
          </select></label>
          {!!concepts.length && <label className="ga-field">概念版本（显式选择，不使用当前交付版本）<select aria-label="概念版本来源" value={versionToken} disabled={!!busy} onChange={(event) => setVersionToken(event.target.value)}>
            <option value="">请选择已审核通过的概念版本</option>
            {concepts.map((version) => {
              const gate = gates[version.token];
              const eligible = gate && gate !== "failed" && gate.source_gate_passed === true;
              const reason = !gate ? "读取审核状态…" : gate === "failed" ? "审核状态读取失败" : eligible ? "" : "尚未同时通过技术检查与人工审核，不能用于收费制作";
              return <option key={version.token} value={version.token} disabled={!eligible}>第 {version.version} 版概念{reason ? ` · ${reason}` : " · 可制作"}</option>;
            })}
          </select><small>只有同时通过技术检查与人工审核的概念才能付费重建模型。</small></label>}
          {!!asset?.versions.length && !concepts.length && <p className="ga-help">这个角色还没有概念版本，不能进行模型制作。</p>}
          <label className="ga-field">供应商连接器（百炼 Tripo）<select aria-label="供应商连接器" value={connector} disabled={!!busy} onChange={(event) => setConnector(event.target.value)}>
            {!connector && <option value="">暂无可用连接器</option>}
            {(connectors ?? []).map((item) => <option key={item.token} value={item.token}>{item.display_name}{item.credential_state !== "configured" ? " · 凭证未就绪" : ""}</option>)}
          </select>
            {connectors !== undefined && !connectors.length && <small>没有启用的百炼 Tripo 连接器；请先在“Provider 连接器”中配置账号。</small>}</label>
          <div className="ga-creation-output">
            <label className="ga-field">生成模型<select aria-label="生成模型" value={model} disabled={!!busy} onChange={(event) => {
              setModel(event.target.value);
              const bounds = faceLimitBounds(event.target.value);
              setFaceLimit((current) => Math.min(Math.max(current, bounds[0]), bounds[1]));
            }}>{Object.entries(MODEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="ga-field">概念侧面朝向<select aria-label="概念侧面朝向" value={side} disabled={!!busy} onChange={(event) => setSide(event.target.value as typeof side)}>
              {Object.entries(SIDE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label className="ga-field">贴图质量<select aria-label="贴图质量" value={texture} disabled={!!busy} onChange={(event) => setTexture(event.target.value)}>
              {Object.entries(TEXTURE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label className="ga-field">面数上限<input aria-label="面数上限" type="number" min={faceLimitBounds(model)[0]} max={faceLimitBounds(model)[1]} value={faceLimit} disabled={!!busy} onChange={(event) => setFaceLimit(Number(event.target.value))} /></label>
            <label className="ga-field">几何质量（仅 H3.1）<select aria-label="几何质量" value={geometry} disabled={!!busy || model !== "Tripo/Tripo-H3.1"} onChange={(event) => setGeometry(event.target.value)}>
              <option value="">默认（不指定）</option>
              {Object.entries(GEOMETRY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select><small>P1.0 不接受此参数，服务端会拒绝而不是忽略。</small></label>
          </div>
        </fieldset>
        {plan && <section className="ga-making-summary" aria-label="本次费用与授权">
          <h3>分步费用与授权</h3>
          <p>角色：{asset?.stable_key} · 概念第 {concepts.find((version) => version.token === versionToken)?.version ?? "?"} 版 · 冻结视图：{plan.resolved_inputs.views.map((view) => view.view).join(" / ")}</p>
          {plan.quote.steps.map((step) => {
            const paid = step.quote.estimated_amount !== 0;
            const uncapped = step.quote.maybe_max_chargeable === null;
            return <div key={step.key} className="ga-mesh-quote-step">
              <p>{STEP_KEY_LABELS[step.key] ?? step.key} · {step.model} · 最多调用 {step.maximum_calls} 次</p>
              <p className="ga-quote">{step.quote.estimated_amount === null
                ? `费用未知：${step.quote.unit === "bailian_tripo_credit" ? "供应商" : "服务"}尚未给出此步骤的估算；未知不等于免费，需先对账确认。`
                : uncapped
                  ? `预计 ${step.quote.estimated_amount} ${step.quote.unit}（估计值，非供应商保证的硬上限）`
                  : `预计 ${step.quote.estimated_amount} ${step.quote.unit}，可计费上限 ${step.quote.maybe_max_chargeable} ${step.quote.unit}`}</p>
              {paid ? <label className="ga-check"><input type="checkbox" checked={confirmed[step.key] === true} disabled={!!busy} onChange={(event) => setConfirmed((old) => ({ ...old, [step.key]: event.target.checked }))} />
                {uncapped ? `我确认授权“${STEP_KEY_LABELS[step.key] ?? step.key}”按上述估算计费，并接受没有硬上限的风险` : `我确认授权“${STEP_KEY_LABELS[step.key] ?? step.key}”最多花费 ${step.quote.maybe_max_chargeable} ${step.quote.unit}`}</label>
                : <p className="ga-help">此步骤不产生供应商费用。</p>}
            </div>;
          })}
          <p className="ga-help">{plan.quote.limitation}</p>
          <p className="ga-help">计费走供应商账号（{plan.quote.unit}），报价不授权提交；有效期至 {new Date(plan.expires_at).toLocaleString()}。</p>
          {!startAvailability.enabled && <p className="ga-help">{startAvailability.reason}</p>}
        </section>}
        {error && <p role="alert" className="ga-error">{error}</p>}
        {busy && <p role="status">{busy === "prepare" ? "正在核对来源与取得分步报价…" : "正在提交本次制作…"}</p>}
      </>}
    </div>
    {!startedRun && <footer>{plan ? <>
      <button type="button" className="ga-action" disabled={!!busy || uncertain} onClick={invalidate}>调整需求</button>
      <button type="button" className="ga-action ga-primary" disabled={!!busy || !allConfirmed || !startAvailability.enabled && !uncertain} onClick={() => void start()}>{uncertain ? "重试同一提交，确认结果" : "确认费用并开始制作"}</button>
    </> : <button type="button" className="ga-action ga-primary" disabled={!!busy || !canPrepare} onClick={() => void prepare()}>查看制作说明与费用</button>}</footer>}
  </dialog>;
}

function faceLimitBounds(model: string): [number, number] {
  return model === "Tripo/Tripo-P1.0" ? [50, 20000] : [1, 1500000];
}
