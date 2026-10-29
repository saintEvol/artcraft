import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi } from "@storyteller/api";
import type { PackAsset } from "./engine-report";

export function FrozenAssetVersion({ api, asset }: { api: GameAssetsApi; asset: PackAsset }) {
  const alive = useRef(true);
  const loading = useRef(false);
  const [version, setVersion] = useState<Awaited<ReturnType<GameAssetsApi["GetGameAssetVersion"]>>["version"]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const read = async () => {
    if (loading.current) return;
    loading.current = true; setBusy(true); setError("");
    try {
      const result = await api.GetGameAssetVersion(asset.version_id);
      if (result.version.token !== asset.version_id || result.version.asset_token !== asset.asset_id) throw new Error("返回版本与冻结清单不一致，请重试读取。");
      if (alive.current) setVersion(result.version);
    } catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : "版次暂时无法读取，冻结文件与原交付包仍保留。"); }
    finally { loading.current = false; if (alive.current) setBusy(false); }
  };
  return <details className="ga-frozen-version" onToggle={(event) => { if (event.currentTarget.open && !version && !loading.current) void read(); }}>
    <summary>{version ? `制作文件第 ${version.version} 版 · 查看冻结记录` : "查看这次采用的准确制作版本"}</summary>
    {busy && <p role="status">正在读取这份冻结版本…</p>}
    {version && <p>制作文件第 {version.version} 版 · 保存于 {new Date(version.created_at).toLocaleString()}。此包继续使用这一版，后续修改不会替换包内文件。</p>}
    {error && <p role="alert" className="ga-error">{error}<button type="button" className="ga-action" onClick={() => void read()}>重试读取版次</button></p>}
    <p>冻结版本标识：<code>{asset.version_id}</code></p>
    <p>包含文件：{asset.files.map((file) => file.path.split("/").at(-1)).join("、")}</p>
  </details>;
}
