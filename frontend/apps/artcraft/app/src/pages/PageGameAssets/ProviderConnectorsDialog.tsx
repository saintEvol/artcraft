import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { GenerationConnectorsApi, type GenerationConnector, type GenerationConnectorCatalog, type GenerationConnectorUse, type ConnectorCredentialUpdate } from "@storyteller/api";

const OPERATION_LABELS: Record<string, string> = {
  static_image: "静态图像", single_image_mesh: "单图建模", multiview_mesh: "多视图建模",
  rig_check_and_autorig: "可绑骨检查与自动绑骨", native_preset_animation: "原生预设动作",
  mesh_rig_motion: "建模、绑骨与动作", mesh_and_rig: "建模与绑骨",
  pixel_character_animation_and_inpaint: "像素角色、动画与局部修正", sprite_animation_and_inpaint: "Sprite 动画与局部修正",
};
const IMPLEMENTATION_LABELS: Record<string, string> = { implemented: "已接通原生执行", candidate: "选型候选，尚未接通" };
const READINESS_LABELS: Record<string, string> = { connector_schema_unavailable: "实例尚未完成连接器数据库迁移", connector_encryption_unavailable: "实例尚未配置连接器加密密钥" };

/** Account credentials stay in this dialog's memory and are never cached in
 * localStorage, project profiles, URL parameters or a masked-value round trip. */
export function ProviderConnectorsDialog({ onClose }: { onClose(): void }) {
  const api = useMemo(() => new GenerationConnectorsApi(), []);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestEpoch = useRef(0);
  const createKey = useRef<string | undefined>(undefined);
  const [catalog, setCatalog] = useState<GenerationConnectorCatalog>();
  const [connectors, setConnectors] = useState<GenerationConnector[]>([]);
  const [selected, setSelected] = useState<GenerationConnector>();
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [configuration, setConfiguration] = useState<Record<string, unknown>>({});
  const [credentialAction, setCredentialAction] = useState<"keep" | "set" | "clear">("keep");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [uses, setUses] = useState<GenerationConnectorUse[]>();
  const [usesCursor, setUsesCursor] = useState<string | null>(null);
  const schema = catalog?.providers.find((item) => item.provider === provider);
  const unsupportedFields = schema?.fields.some((field) => field.secret ? field.name !== "api_key" || field.control !== "password" : !["text", "enum"].includes(field.control));

  useEffect(() => {
    dialog.current?.showModal();
    void refresh();
    return () => { requestEpoch.current++; dialog.current?.close(); };
  }, []);

  const reset = (nextProvider = catalog?.providers[0]?.provider ?? "", source = catalog) => {
    createKey.current = undefined;
    setSelected(undefined); setProvider(nextProvider); setName(""); setEnabled(true); setApiKey(""); setCredentialAction("keep");
    setConfiguration(Object.fromEntries((source?.providers.find((item) => item.provider === nextProvider)?.fields ?? []).filter((field) => !field.secret).map((field) => [field.name, field.choices[0] ?? ""])));
    setUses(undefined); setUsesCursor(null); setNotice(undefined);
  };

  const choose = (item: GenerationConnector) => {
    createKey.current = undefined;
    setSelected(item); setProvider(item.provider); setName(item.display_name); setEnabled(item.enabled); setConfiguration({ ...item.configuration });
    setApiKey(""); setCredentialAction("keep"); setUses(undefined); setUsesCursor(null); setError(undefined); setNotice(undefined);
  };

  async function refresh() {
    const epoch = ++requestEpoch.current;
    setLoading(true); setError(undefined);
    try {
      const nextCatalog = await api.Catalog();
      const items = nextCatalog.unavailable_reasons.includes("connector_schema_unavailable") ? [] : await api.ListAll();
      if (epoch !== requestEpoch.current) return;
      setCatalog(nextCatalog); setConnectors(items);
      if (selected) {
        const latest = items.find((item) => item.token === selected.token);
        if (latest) choose(latest); else reset(nextCatalog.providers[0]?.provider, nextCatalog);
      } else if (!provider) reset(nextCatalog.providers[0]?.provider, nextCatalog);
    } catch (failure) { if (epoch === requestEpoch.current) setError(message(failure)); }
    finally { if (epoch === requestEpoch.current) setLoading(false); }
  }

  const changed = () => { createKey.current = undefined; setNotice(undefined); };
  const save = async () => {
    if (busy || loading || !catalog?.management_available || !schema || unsupportedFields || !name.trim() || selected?.archived) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const credential: ConnectorCredentialUpdate = credentialAction === "set" ? { action: "set", api_key: apiKey } : { action: credentialAction };
      const input = { display_name: name, enabled, configuration, credential };
      const saved = selected ? await api.Update(selected.token, input)
        : await api.Create({ ...input, provider, idempotency_key: createKey.current ??= crypto.randomUUID() });
      setConnectors((items) => [...items.filter((item) => item.token !== saved.token), saved]);
      choose(saved); setNotice("连接器已保存。账号访问权限和制作质量仍需单独验证。");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };

  const archive = async () => {
    if (!selected || selected.archived || busy) return;
    setBusy(true); setError(undefined);
    try {
      const saved = await api.Archive(selected);
      setConnectors((items) => items.map((item) => item.token === saved.token ? saved : item)); choose(saved);
      setNotice("连接器已归档，后续调用仍读取当前配置。");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };

  const loadUses = async (append = false) => {
    if (!selected || busy) return;
    setBusy(true); setError(undefined);
    try {
      const page = await api.Uses(selected.token, append ? usesCursor ?? undefined : undefined);
      if (page.connector_token !== selected.token) throw new Error("执行引用与当前连接器不匹配。");
      setUses((old) => append ? [...(old ?? []), ...page.executions] : page.executions); setUsesCursor(page.next_cursor);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };

  return <dialog ref={dialog} className="ga-dialog" aria-labelledby="ga-connectors-title" onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <div className="ga-dialog-heading"><div><p className="ga-eyebrow">生成服务与账号</p><h2 id="ga-connectors-title">Provider 连接器</h2></div>
      <button type="button" className="ga-icon-button" disabled={busy} onClick={onClose} aria-label="关闭连接器管理"><X size={19} /></button></div>
    <div className="ga-dialog-body">
      <p className="ga-info">制作入口接入这些账号的工作尚未完成，当前可以管理账号并查看通路能力。</p>
      <p className="ga-help">每个连接器对应一个供应商账号。保存配置不会开始制作；制作路线按原生能力和验收门禁开放。</p>
      {catalog?.unavailable_reasons.map((reason) => <p className="ga-info" key={reason}>{READINESS_LABELS[reason] ?? reason}</p>)}
      <div className="ga-settings-columns"><section><h3>已配置账号</h3>
        <div className="ga-connectors-list">{connectors.map((item) => <button type="button" className="ga-action" key={item.token} disabled={busy || loading} aria-pressed={selected?.token === item.token} onClick={() => choose(item)}>
          {item.display_name} · {catalog?.providers.find((entry) => entry.provider === item.provider)?.label ?? item.provider}{item.archived ? " · 已归档" : !item.enabled ? " · 已禁用" : ""}
        </button>)}</div>
        {!loading && !connectors.length && <p className="ga-help">还没有账号连接器。</p>}
        <div className="ga-connectors-actions"><button type="button" className="ga-action" disabled={busy || loading || !catalog?.providers.length} onClick={() => reset()}>新增账号</button>
          <button type="button" className="ga-action" disabled={busy || loading} onClick={() => void refresh()}>{loading ? "读取中…" : "刷新账号"}</button></div>
      </section><section><h3>{selected ? selected.display_name : "新增连接器"}</h3>
        <fieldset disabled={busy || loading || !!selected?.archived || !catalog?.management_available} className="ga-connectors-fields">
          <label className="ga-field">供应商<select disabled={!!selected} value={provider} onChange={(event) => reset(event.target.value)}>{catalog?.providers.map((item) => <option value={item.provider} key={item.provider}>{item.label}</option>)}</select></label>
          <label className="ga-field">账号名称<input value={name} maxLength={120} onChange={(event) => { changed(); setName(event.target.value); }} placeholder="例如：百炼项目账号" /></label>
          {schema?.fields.filter((field) => !field.secret).map((field) => <label className="ga-field" key={field.name}>{field.label}
            {field.control === "enum" ? <select value={String(configuration[field.name] ?? "")} onChange={(event) => { changed(); setConfiguration((old) => ({ ...old, [field.name]: event.target.value })); }}>{field.choices.map((choice) => <option value={choice} key={choice}>{choice === "api_cn_beijing" ? "北京地域 · 按量 API" : choice === "api" ? "按量 API" : choice}</option>)}</select>
              : <input value={String(configuration[field.name] ?? "")} required={field.required} onChange={(event) => { changed(); setConfiguration((old) => ({ ...old, [field.name]: event.target.value })); }} />}
            <small>{field.help}</small></label>)}
          <label className="ga-field">API 凭证操作<select value={credentialAction} onChange={(event) => { changed(); setApiKey(""); setCredentialAction(event.target.value as typeof credentialAction); }}>
            <option value="keep">{selected?.has_credential ? "保留已存凭证" : "暂不填写凭证"}</option><option value="set">填写／替换 API Key</option><option value="clear">清除当前凭证</option></select></label>
          {credentialAction === "set" && <label className="ga-field">API Key<input type="password" value={apiKey} autoComplete="new-password" spellCheck={false} onChange={(event) => { changed(); setApiKey(event.target.value); }} /></label>}
          <label className="ga-connectors-enabled"><input type="checkbox" checked={enabled} onChange={(event) => { changed(); setEnabled(event.target.checked); }} />允许新任务使用此账号</label>
        </fieldset>
        {selected && <p className="ga-help">凭证：{selected.credential_state === "configured" ? "已加密保存，访问权限待验证" : selected.credential_state === "missing" ? "未填写" : "无法读取，需要检查加密密钥或重填"}</p>}
        {unsupportedFields && <p className="ga-error">此供应商的配置字段需要更新客户端后编辑。</p>}
        <div className="ga-connectors-actions"><button type="button" className="ga-action ga-primary" disabled={busy || loading || !schema || unsupportedFields || !catalog?.management_available || !name.trim() || !!selected?.archived || credentialAction === "set" && !apiKey.trim()} onClick={() => void save()}>{busy ? "处理中…" : "保存连接器"}</button>
          {selected && <button type="button" className="ga-action" disabled={busy || loading || selected.archived} onClick={() => void archive()}>归档账号</button>}
          {selected && <button type="button" className="ga-action" disabled={busy || loading} onClick={() => void loadUses()}>查看关联任务</button>}</div>
      </section></div>
      {schema && <section><h3>此通路的业务能力</h3>{schema.operations.map((operation) => <div className="ga-settings-summary" key={operation.operation}>
        <strong>{OPERATION_LABELS[operation.operation] ?? operation.operation}</strong><p>{IMPLEMENTATION_LABELS[operation.implementation_state] ?? "当前客户端无法识别此能力状态"}</p>
        {operation.model_ids.length > 0 && <p>{operation.model_ids.join("、")}</p>}{operation.restrictions.map((restriction) => <p key={restriction}>{restriction}</p>)}
      </div>)}</section>}
      {uses && <section><h3>关联任务</h3><p className="ga-help">这里显示使用此连接器的任务。</p>{!uses.length && <p>还没有执行引用。</p>}
        {uses.map((item) => <p key={item.execution_token}><code>{item.execution_token}</code> · {item.prepared_at}</p>)}
        {usesCursor && <button type="button" className="ga-action" disabled={busy} onClick={() => void loadUses(true)}>继续读取执行</button>}</section>}
      <div aria-live="polite">{error && <p className="ga-error" role="alert">{error}</p>}{notice && <p className="ga-info">{notice}</p>}</div>
    </div>
  </dialog>;
}

function message(error: unknown): string { return error instanceof Error ? error.message : "连接器操作未完成，请刷新状态。"; }
