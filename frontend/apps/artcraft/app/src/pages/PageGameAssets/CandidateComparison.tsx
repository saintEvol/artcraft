import { useEffect, useRef, useState } from "react";
import type { GameAssetsApi, GameAssetVersionInfo } from "@storyteller/api";
import { AssetPreview } from "./AssetPreview";
import type { AssetKind } from "./profile";

interface Props {
  api: GameAssetsApi; project: string; name: string; kind: AssetKind;
  comparison: GameAssetVersionInfo; current: GameAssetVersionInfo;
  onReady: (token: string, ready: boolean) => void;
}

export function CandidateComparison(props: Props) {
  const [expanded, setExpanded] = useState(false);
  return <><div className="ga-comparison">
    <div><p className="ga-comparison-label">对比候选 · 文件第 {props.comparison.version} 版</p><AssetPreview api={props.api} projectToken={props.project} version={props.comparison} name={props.name} kind={props.kind} /></div>
    <div><p className="ga-comparison-label">当前候选 <button type="button" className="ga-view-button" onClick={() => setExpanded(true)}>放大对比</button></p><AssetPreview api={props.api} projectToken={props.project} version={props.current} name={props.name} kind={props.kind} onReady={props.onReady} /></div>
  </div>{expanded && <ComparisonDialog {...props} onClose={() => setExpanded(false)} />}</>;
}

function ComparisonDialog({ onClose, ...props }: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="ga-enlarged-preview ga-comparison-dialog" aria-label={`${props.name}的候选对比`} onClose={onClose}>
    <header><strong>{props.name} · 对比两个候选</strong><button type="button" className="ga-action" onClick={onClose}>返回工作台</button></header>
    <div className="ga-comparison">
      <div><p className="ga-comparison-label">对比候选 · 文件第 {props.comparison.version} 版</p><AssetPreview api={props.api} projectToken={props.project} version={props.comparison} name={props.name} kind={props.kind} fullscreen /></div>
      <div><p className="ga-comparison-label">当前候选 · 文件第 {props.current.version} 版</p><AssetPreview api={props.api} projectToken={props.project} version={props.current} name={props.name} kind={props.kind} fullscreen /></div>
    </div>
  </dialog>;
}
