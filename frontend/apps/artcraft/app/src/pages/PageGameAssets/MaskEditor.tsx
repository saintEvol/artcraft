import { useEffect, useRef, useState } from "react";

export function MaskEditor({ source, onChange, purpose = "edit" }: { source: Blob; onChange: (mask: Blob | null) => void; purpose?: "edit" | "erase" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ image: ImageBitmap; mask: HTMLCanvasElement; overlay: HTMLCanvasElement; selection: HTMLCanvasElement; point?: [number, number] } | undefined>(undefined);
  const [brush, setBrush] = useState(6);
  const [erase, setErase] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(purpose === "erase");
  const [zoom, setZoom] = useState(0);
  const [sourceWidth, setSourceWidth] = useState(480);
  const [sourceHeight, setSourceHeight] = useState(480);
  const [hasSelection, setHasSelection] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [loadedSelectionName, setLoadedSelectionName] = useState("");
  const emission = useRef(0);
  const change = useRef(onChange); change.current = onChange;
  useEffect(() => {
    let cancelled = false;
    emission.current++;
    setZoom(0); setError(""); setHasSelection(false); setImageReady(false); setLoadedSelectionName("");
    let bitmap: ImageBitmap | undefined;
    change.current(null);
    void createImageBitmap(source).then((image) => {
      if (cancelled) { image.close(); return; }
      bitmap = image;
      setSourceWidth(image.width);
      setSourceHeight(image.height);
      const visible = canvas.current!;
      visible.width = image.width; visible.height = image.height;
      const mask = document.createElement("canvas"); mask.width = image.width; mask.height = image.height;
      mask.getContext("2d")!.fillRect(0, 0, mask.width, mask.height);
      const overlay = document.createElement("canvas"); overlay.width = image.width; overlay.height = image.height;
      const selection = document.createElement("canvas"); selection.width = image.width; selection.height = image.height;
      drawing.current = { image, mask, overlay, selection };
      visible.getContext("2d")!.drawImage(image, 0, 0);
      setImageReady(true);
    }).catch(() => { if (!cancelled) setError("原图无法加载，请重新选择版本。"); });
    return () => { cancelled = true; bitmap?.close(); drawing.current = undefined; };
  }, [source]);
  const redraw = () => {
    const state = drawing.current; const context = canvas.current?.getContext("2d");
    if (!state || !context) return;
    context.clearRect(0, 0, state.mask.width, state.mask.height);
    context.drawImage(state.image, 0, 0);
    if (purpose === "erase" && preview) {
      context.globalCompositeOperation = "destination-out"; context.drawImage(state.selection, 0, 0); context.globalCompositeOperation = "source-over";
    } else context.drawImage(state.overlay, 0, 0);
  };
  useEffect(() => { redraw(); }, [preview]);
  const emit = () => {
    const currentEmission = ++emission.current;
    const state = drawing.current; if (!state) return;
    const pixels = state.mask.getContext("2d")!.getImageData(0, 0, state.mask.width, state.mask.height).data;
    let selected = false;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 0) { selected = true; break; }
    setHasSelection(selected);
    if (!selected) { change.current(null); return; }
    state.mask.toBlob((blob) => { if (drawing.current === state && emission.current === currentEmission) change.current(blob); }, "image/png");
  };
  const loadSelection = async (file: File) => {
    const state = drawing.current; if (!state) return;
    const operation = ++emission.current; setError("");
    try {
      if (file.size < 33 || file.size > 10 * 1024 * 1024) throw new Error("请载入不超过 10 MiB 的选区 PNG。");
      const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer());
      if (![137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) throw new Error("选区需要是不透明的灰度 PNG。");
      const header = new DataView(bytes.buffer);
      if (header.getUint32(16) !== state.mask.width || header.getUint32(20) !== state.mask.height) throw new Error(`选区尺寸需与原图一致：${state.mask.width}×${state.mask.height} 像素。`);
      const bitmap = await createImageBitmap(file);
      const scratch = document.createElement("canvas"); scratch.width = state.mask.width; scratch.height = state.mask.height;
      scratch.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = scratch.getContext("2d")!.getImageData(0, 0, scratch.width, scratch.height);
      const overlay = new ImageData(scratch.width, scratch.height); const selection = new ImageData(scratch.width, scratch.height);
      let selected = false;
      for (let i = 0; i < pixels.data.length; i += 4) {
        const weight = pixels.data[i];
        if (pixels.data[i + 3] !== 255 || pixels.data[i + 1] !== weight || pixels.data[i + 2] !== weight) throw new Error("请使用不透明的灰度选区 PNG：黑色保留、白色修改，灰色为部分修改。");
        selected ||= weight > 0;
        overlay.data.set([236,72,153,Math.round(weight * 0.55)], i); selection.data.set([255,255,255,weight], i);
      }
      if (!selected) throw new Error("这份选区没有可修改的像素；当前选区已保留。");
      if (drawing.current !== state || operation !== emission.current || state.point) return;
      state.mask.getContext("2d")!.putImageData(pixels, 0, 0);
      state.overlay.getContext("2d")!.putImageData(overlay, 0, 0); state.selection.getContext("2d")!.putImageData(selection, 0, 0);
      setLoadedSelectionName(file.name);
      redraw(); emit();
    } catch (problem) { if (drawing.current === state && operation === emission.current) setError(`${file.name.slice(0, 120)}：${problem instanceof Error ? problem.message : "选区无法读取，当前选区已保留。"}`); }
  };
  const saveSelection = () => {
    const state = drawing.current; if (!state || !hasSelection) return;
    state.mask.toBlob((blob) => {
      if (!blob) { setError("选区文件未能保存，请重试。"); return; }
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "game-asset-selection.png"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };
  const paint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drawing.current; if (!state?.point) return;
    setLoadedSelectionName("");
    const next = pointInImage(event, state.mask);
    for (const [surface, isMask] of [[state.mask, true], [state.overlay, false], [state.selection, false]] as const) {
      const context = surface.getContext("2d")!;
      context.globalCompositeOperation = !isMask && erase ? "destination-out" : "source-over";
      context.strokeStyle = isMask ? erase ? "black" : "white" : erase || surface === state.selection ? "white" : "rgba(236,72,153,0.55)";
      context.lineWidth = state.mask.width * brush / 100; context.lineCap = "round"; context.lineJoin = "round";
      context.beginPath(); context.moveTo(...state.point); context.lineTo(next[0] + 0.001, next[1]); context.stroke();
    }
    state.point = next; redraw();
  };
  return <section className="ga-mask-editor" aria-label="标记局部修改区域">
    <p>{purpose === "erase" ? "涂出要清为透明的区域，例如多余阴影、基座或应镂空的孔洞。可以实时看清理效果，关闭实时预览后显示粉色选区。擦除选区可恢复原像素；保存为新版本后原版仍保留。" : "在原图上涂出要修改的部分，请完整覆盖要替换的细节和边缘；未选中的旧细节会原样保留。"}</p>
    <div className="ga-inline-controls"><label>画笔大小 <input aria-label="选区画笔大小" type="range" min="1" max="25" value={brush} onChange={(e) => setBrush(Number(e.target.value))} /></label>
      <label>画布缩放 <select aria-label="选区画布缩放" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}><option value={0}>适合窗口</option><option value={1}>100% · 原图像素</option><option value={2}>200%</option></select></label>
      <button type="button" className="ga-action" aria-pressed={erase} onClick={() => setErase(!erase)}>{erase ? "正在擦除选区" : "正在标记选区"}</button>
      <button type="button" className="ga-action" onClick={() => { const state = drawing.current; if (!state) return; setLoadedSelectionName(""); state.mask.getContext("2d")!.fillStyle = "black"; state.mask.getContext("2d")!.fillRect(0, 0, state.mask.width, state.mask.height); state.overlay.getContext("2d")!.clearRect(0, 0, state.mask.width, state.mask.height); state.selection.getContext("2d")!.clearRect(0, 0, state.mask.width, state.mask.height); redraw(); emit(); }}>清空选区</button>
      <button type="button" className="ga-action" disabled={!hasSelection} onClick={saveSelection}>保存选区 PNG</button>
      {purpose === "erase" && <label className="ga-check"><input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} />实时预览透明清理</label>}</div>
    <label className="ga-field">载入已有选区 PNG<input aria-label="载入已有选区 PNG" type="file" accept="image/png" disabled={!imageReady} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void loadSelection(file); }} /><small>可载入本平台保存的选区或相同尺寸的不透明灰度 PNG，替换当前选区；原图不变。</small></label>
    {!imageReady && !error && <p role="status">正在读取原图，完成后可标记或载入选区…</p>}
    {loadedSelectionName && <p role="status">已载入选区：{loadedSelectionName}。可继续标记、擦除或保存。</p>}
    {error && <p role="alert" className="ga-error">{error}</p>}
    <div className="ga-mask-viewport" tabIndex={0} aria-label="可滚动的选区画布"><canvas ref={canvas} aria-label="在这里标记要修改的位置" style={{ touchAction: "none", width: zoom ? sourceWidth * zoom : "100%", maxWidth: zoom ? "none" : `min(480px, calc((60vh - 24px) * ${sourceWidth / sourceHeight}))`, cursor: "crosshair" }}
      onPointerDown={(event) => { const state = drawing.current; if (!state) return; state.point = pointInImage(event, state.mask); event.currentTarget.setPointerCapture(event.pointerId); paint(event); }}
      onPointerMove={paint} onPointerUp={() => { if (drawing.current) drawing.current.point = undefined; emit(); }} onPointerCancel={() => { if (drawing.current) drawing.current.point = undefined; emit(); }} /></div>
    <small>需要精细标记时可切到原图像素或 200%，并滚动画布；缩放不会清除已有选区。</small>
    <small>{purpose === "erase" ? "本次是免费透明度清理，保持原画布、摆放位置和颜色；不会调用生成模型。处理后可与原版比较。" : "选区内按新需求重新绘制，结果合回原尺寸；选区外像素保留。替换效果仍需与原版比较。"}</small>
  </section>;
}

function pointInImage(event: React.PointerEvent<HTMLCanvasElement>, image: HTMLCanvasElement): [number, number] {
  const target = event.currentTarget; const rect = target.getBoundingClientRect();
  return [
    (event.clientX - rect.left - target.clientLeft) / target.clientWidth * image.width,
    (event.clientY - rect.top - target.clientTop) / target.clientHeight * image.height,
  ];
}
