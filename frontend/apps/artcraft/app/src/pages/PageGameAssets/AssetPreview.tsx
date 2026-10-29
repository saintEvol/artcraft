import { useEffect, useRef, useState } from "react";
import { Box, ImageIcon, Loader2, RefreshCw } from "lucide-react";
import type { GameAssetsApi, GameAssetVersionInfo } from "@storyteller/api";
import { MeshPreview } from "./MeshPreview";
import { VersionSettings } from "./VersionSettings";
import { readSettings, type OutputSettings, type AssetKind } from "./profile";

interface Props {
  api: GameAssetsApi;
  projectToken: string;
  version: GameAssetVersionInfo;
  name: string;
  kind: AssetKind;
  onReady?: (versionToken: string, ready: boolean) => void;
  fullscreen?: boolean;
}

interface LoadedPreview {
  versionToken: string;
  blob: Blob;
  url: string;
  settings: OutputSettings;
  defaults: OutputSettings;
  legacy: boolean;
  profileVersion: number;
  isMesh: boolean;
  maskArtifact?: string;
}

export function AssetPreview({ api, projectToken, version, name, kind, onReady, fullscreen = false }: Props) {
  const isMesh = kind === "prop_3d";
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [background, setBackground] = useState("checker");
  const [size, setSize] = useState("fit");
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [showAnchor, setShowAnchor] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const selected = useRef(version.token);
  selected.current = version.token;

  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    setLoaded(null);
    setDimensions(null);
    setError(null);
    onReady?.(version.token, false);
    void (async () => {
      try {
        const [detail, profile] = await Promise.all([
          api.GetGameAssetVersion(version.token), api.GetGameProjectProfile(version.profile_token),
        ]);
        const main = detail.files.find((f) => f.role === "main" && f.ordinal === 0)
          ?? detail.files.find((f) => f.role === "preview" && f.ordinal === 0);
        if (!main) throw new Error("此版本还没有可预览的主文件。");
        const blob = await api.DownloadGameArtifact(projectToken, main.artifact_token);
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        const meshFile = blob.type === "model/gltf-binary";
        const output = version.spec_json.output;
        const specs = typeof profile.profile.profile_json.specs === "object" ? profile.profile.profile_json.specs as Record<string, unknown> : {};
        const settingsProfile = typeof output === "object" && output !== null
          ? { ...profile.profile.profile_json, specs: { ...specs, ...(isMesh ? { prop_3d: output } : { icon_2d: output, sprite_2d: output }) } } : profile.profile.profile_json;
        setLoaded({
          versionToken: version.token, blob, url,
          settings: readSettings(settingsProfile), profileVersion: profile.profile.version, isMesh: meshFile,
          defaults: readSettings(profile.profile.profile_json), legacy: profile.profile.profile_json.workflow_schema_version !== 1,
          maskArtifact: detail.files.find((file) => file.role === "mask")?.artifact_token,
        });
      } catch (problem) {
        if (!cancelled) setError(problem instanceof Error ? problem.message : "预览未加载，请重试。");
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [api, projectToken, version.token, version.profile_token, reload, onReady]);

  const current = loaded?.versionToken === version.token ? loaded : null;
  const viewingMesh = current?.isMesh ?? (isMesh && !["concept", "input"].includes(String(version.spec_json.stage)));
  const workingImage = ["source", "cutout", "concept", "input"].includes(String(version.spec_json.stage));
  const download = () => {
    if (!current) return;
    const extension = current.blob.type === "model/gltf-binary" ? "glb" : current.blob.type === "image/jpeg" ? "jpg" : "png";
    const filename = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "game-asset";
    const anchor = document.createElement("a"); anchor.href = current.url; anchor.download = `${filename}-v${version.version}.${extension}`; anchor.click();
  };
  const downloadMask = async () => {
    if (!current?.maskArtifact) return;
    setDownloadError("");
    try {
      const blob = await api.DownloadGameArtifact(projectToken, current.maskArtifact); const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `selection-v${version.version}.png`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setDownloadError("选区文件暂时无法下载，请重试；当前候选仍保留。"); }
  };
  return <><section className="ga-preview-panel" aria-label={`${name}的预览`}>
    {!viewingMesh && <div className="ga-preview-toolbar">
      {isMesh ? <Box size={16} /> : <ImageIcon size={16} />}
      <strong>{name} · 第 {version.version} 版</strong>
      {!viewingMesh && <>
        <label>背景 <select aria-label="预览背景" value={background} onChange={(e) => setBackground(e.target.value)}>
          <option value="checker">透明棋盘</option><option value="dark">深色游戏界面</option><option value="light">浅色背景</option>
        </select></label>
        <label>显示大小 <select aria-label="预览显示大小" value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="fit">适合窗口</option>{!workingImage && <option value="actual">游戏实际大小</option>}<option value="64">64 像素</option><option value="128">128 像素</option><option value="256">256 像素</option>
        </select></label>
        <label className="ga-check" style={{ margin: 0 }}><input type="checkbox" checked={showAnchor} onChange={(e) => setShowAnchor(e.target.checked)} />显示锚点</label>
      </>}
      <button type="button" className="ga-icon-button" style={{ marginLeft: "auto" }} aria-label="重新加载预览" onClick={() => setReload((n) => n + 1)}><RefreshCw size={15} /></button>
      {!fullscreen && <button type="button" className="ga-view-button" onClick={() => setEnlarged(true)}>放大预览</button>}
      {current && <button type="button" className="ga-view-button" onClick={download}>下载当前文件</button>}
    </div>}
    {error ? <div className="ga-preview-empty" role="alert"><p>{error}</p><button type="button" className="ga-action" onClick={() => setReload((n) => n + 1)}>重试预览</button></div>
      : !current ? <div className="ga-preview-empty" role="status"><Loader2 size={24} className="animate-spin" style={{ margin: "0 auto 12px" }} />正在读取这个版本的素材…</div>
      : viewingMesh ? <MeshPreview blob={current.blob} onReload={() => setReload((n) => n + 1)} onReady={() => onReady?.(current.versionToken, true)} onExpand={fullscreen ? undefined : () => setEnlarged(true)} onDownload={download} />
      : <div className="ga-preview-content" data-background={background}>
        <div className="ga-preview-frame" style={{
          width: size === "fit" ? fullscreen ? 600 : 300 : size === "actual" ? current.settings.displaySize : Number(size),
          aspectRatio: "1",
        }}>
          <img src={current.url} alt={`${name} 第 ${version.version} 版`} style={{ imageRendering: current.settings.sampling === "nearest" ? "pixelated" : "auto" }}
            onLoad={(e) => {
              if (selected.current === current.versionToken) setDimensions(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`);
              if (selected.current === current.versionToken) onReady?.(current.versionToken, true);
            }} onError={() => {
              if (selected.current === current.versionToken) setError("图像无法解码。请重新读取或检查这个版本的文件。");
            }} />
          {showAnchor && <span aria-label="摆放锚点" style={{ position: "absolute", left: `${current.settings.anchorX * 100}%`, top: `${current.settings.anchorY * 100}%`, color: "#ffb34f", textShadow: "0 1px 3px #000", fontSize: 24, transform: "translate(-50%, -50%)", pointerEvents: "none" }}>+</span>}
        </div>
      </div>}
    {current && <div className="ga-preview-caption"><span>{dimensions && `原始图像 ${dimensions} 像素 · `}项目设置第 {current.profileVersion} 版。{workingImage ? "此为概念或工作源文件，交付前需完成相应加工。" : viewingMesh ? "视角和线框只改变预览，不修改模型。" : "背景与显示大小只改变预览，不覆盖源文件。"}</span><button type="button" className="ga-view-button" onClick={() => setSettingsOpen(true)}>查看生效设置</button></div>}
  </section>{settingsOpen && current && <VersionSettings version={version} effective={current.settings} defaults={current.defaults} legacy={current.legacy} profileVersion={current.profileVersion} kind={kind} name={name} onDownloadMask={current.maskArtifact ? downloadMask : undefined} downloadError={downloadError} onClose={() => setSettingsOpen(false)} />}{enlarged && <EnlargedPreview api={api} projectToken={projectToken} version={version} name={name} kind={kind} onClose={() => setEnlarged(false)} />}</>;
}

function EnlargedPreview({ onClose, ...props }: Omit<Props, "fullscreen" | "onReady"> & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="ga-enlarged-preview" aria-label={`${props.name}的放大预览`} onClose={onClose}>
    <header><strong>{props.name} · 预览与评估</strong><button type="button" className="ga-action" onClick={onClose}>返回工作台</button></header>
    <AssetPreview {...props} fullscreen />
  </dialog>;
}
