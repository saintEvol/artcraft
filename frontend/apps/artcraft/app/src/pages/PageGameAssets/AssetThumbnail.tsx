import { useEffect, useState } from "react";
import { Box, ImageIcon } from "lucide-react";
import type { GameAssetsApi, GameAssetVersionInfo } from "@storyteller/api";

export function AssetThumbnail({ api, project, version, name, mesh }: {
  api: GameAssetsApi; project: string; version?: GameAssetVersionInfo; name: string; mesh: boolean;
}) {
  const [image, setImage] = useState<{ token: string; url: string }>();
  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    let url: string | undefined;
    void (async () => {
      try {
        const detail = await api.GetGameAssetVersion(version.token);
        const file = detail.files.find((file) => file.role === "thumbnail")
          ?? detail.files.find((file) => file.role === "preview")
          ?? (!mesh ? detail.files.find((file) => file.role === "main") : undefined);
        if (!file || cancelled) return;
        const blob = await api.DownloadGameArtifact(project, file.artifact_token);
        if (cancelled || !blob.type.startsWith("image/")) return;
        url = URL.createObjectURL(blob);
        setImage({ token: version.token, url });
      } catch { /* The full preview retains a visible retry and error. */ }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [api, project, version?.token, mesh]);
  return <span className="ga-asset-thumbnail" title={mesh ? "概念参考缩略图；打开资产查看实际模型" : name}>{image && version && image.token === version.token
    ? <><img src={image?.url} alt={`${name}的${mesh ? "概念参考" : ""}缩略图`} loading="lazy" />{mesh && <small className="ga-thumbnail-kind">概念</small>}</>
    : mesh ? <Box size={22} /> : <ImageIcon size={22} />}</span>;
}
