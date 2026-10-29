import { useEffect, useRef, useState } from "react";
import { frameAt, parseFrameTable } from "@storyteller/api";
import { previewVisible } from "./preview-visible";

interface Props {
  png: Blob;
  frameTable: unknown;
  sampling: "nearest" | "linear";
  pixelsPerWorldUnit: number;
  /** Includes version/files/dependency/preview contract identity. */
  contextKey: string;
  onPlayback?: (context: string, direction: string, loopObserved: boolean) => void;
  onDecoded?: (context: string) => void;
  onError?: (context: string, message: string) => void;
}

export function Animation2dPreview(props: Props) {
  // A different immutable context always gets a fresh clock and observations.
  return <AnimationPlayer key={props.contextKey} {...props} />;
}

function AnimationPlayer({ png, frameTable, sampling, pixelsPerWorldUnit, contextKey, onPlayback, onDecoded, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0), playing = useRef(false), selectedDirection = useRef(0);
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  const [running, setRunning] = useState(false), [direction, setDirection] = useState(0), [frame, setFrame] = useState(0);
  const callback = useRef(onPlayback); callback.current = onPlayback;
  const decodedCallback = useRef(onDecoded), errorCallback = useRef(onError), playbackEpoch = useRef(0);
  decodedCallback.current = onDecoded; errorCallback.current = onError;
  let parsed: ReturnType<typeof parseFrameTable> | undefined;
  let parseError = "";
  try {
    parsed = parseFrameTable(frameTable);
    if (!["nearest", "linear"].includes(sampling) || !Number.isFinite(pixelsPerWorldUnit) || pixelsPerWorldUnit <= 0) throw new Error("缺少冻结的采样方式或世界尺度。");
  } catch (problem) { parseError = problem instanceof Error ? problem.message : "帧表无效。"; }
  const validTable = parsed;
  useEffect(() => { if (parseError) errorCallback.current?.(contextKey, parseError); }, [contextKey, parseError]);

  useEffect(() => {
    if (!validTable) return;
    const table = validTable;
    let cancelled = false, raf = 0, previous: number | undefined;
    let lastFrame = -1, lastDirection = -1;
    let decoded = false, continuousSeconds = 0, epoch = playbackEpoch.current, previouslyVisible = false;
    const looped = new Set<number>();
    const fail = (message: string) => { if (!cancelled) { setError(message); playing.current = false; setRunning(false); errorCallback.current?.(contextKey, message); } };
    const image = new Image(), url = URL.createObjectURL(png);
    setReady(false); setError(""); playing.current = false; phase.current = 0; selectedDirection.current = 0; setDirection(0); setFrame(0); setRunning(false);
    const observed = new Set<number>();
    const tick = (now: number) => {
      if (cancelled) return;
      const delta = previous === undefined ? 0 : Math.max(0, now - previous) / 1000;
      if (playing.current && previous !== undefined) phase.current += delta;
      previous = now;
      const i = frameAt(phase.current, table.fps, table.directions[0].frames.length, table.loop), d = selectedDirection.current;
      const rect = table.directions[d].frames[i];
      const sameSegment = epoch === playbackEpoch.current && d === lastDirection;
      if (!sameSegment) { continuousSeconds = 0; epoch = playbackEpoch.current; }
      const visible = !!canvas.current && previewVisible(canvas.current);
      const visiblePlayback = sameSegment && previouslyVisible && visible && playing.current && delta > 0 && delta <= Math.max(1, 2 / table.fps);
      if (visiblePlayback) continuousSeconds += delta; else if (playing.current) continuousSeconds = 0;
      if (i !== lastFrame || d !== lastDirection) {
        const ctx = canvas.current?.getContext("2d");
        if (!ctx || !canvas.current) { fail("无法创建动画画布。"); return; }
        // The whole frame canvas is copied, including transparent edges.
        if (canvas.current.width !== table.canvas.width) canvas.current.width = table.canvas.width;
        if (canvas.current.height !== table.canvas.height) canvas.current.height = table.canvas.height;
        ctx.imageSmoothingEnabled = sampling === "linear";
        ctx.clearRect(0, 0, table.canvas.width, table.canvas.height);
        try { ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, table.canvas.width, table.canvas.height); }
        catch { fail("动画帧未能绘制到固定画布。"); return; }
        if (!decoded) { decoded = true; decodedCallback.current?.(contextKey); }
        if (visiblePlayback && lastFrame >= 0 && i !== lastFrame && d === lastDirection && !observed.has(d)) { observed.add(d); callback.current?.(contextKey, table.directions[d].name, false); }
        if (visiblePlayback && table.loop && continuousSeconds >= table.directions[0].frames.length / table.fps && i < lastFrame && d === lastDirection && !looped.has(d)) { looped.add(d); callback.current?.(contextKey, table.directions[d].name, true); }
        lastFrame = i; lastDirection = d; setFrame(i);
      }
      if (visiblePlayback && table.directions[0].frames.length === 1 && continuousSeconds >= 1 / table.fps) {
        if (!observed.has(d)) { observed.add(d); callback.current?.(contextKey, table.directions[d].name, false); }
        if (table.loop && !looped.has(d)) { looped.add(d); callback.current?.(contextKey, table.directions[d].name, true); }
      }
      if (!table.loop && phase.current >= table.directions[0].frames.length / table.fps) { playing.current = false; setRunning(false); }
      previouslyVisible = visible;
      raf = requestAnimationFrame(tick);
    };
    image.onload = () => {
      if (cancelled) return;
      if (image.naturalWidth !== table.atlas.width || image.naturalHeight !== table.atlas.height) { fail("PNG 尺寸与帧表的图集声明不一致。"); return; }
      setReady(true); raf = requestAnimationFrame(tick);
    };
    image.onerror = () => fail("动画图集无法解码。");
    // Check dimensions before the browser allocates PNG decode memory.
    void png.slice(0, 33).arrayBuffer().then((buffer) => {
      if (cancelled) return;
      const bytes = new Uint8Array(buffer), header = new DataView(buffer);
      if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)
        || header.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
        || header.getUint32(16) !== table.atlas.width || header.getUint32(20) !== table.atlas.height || bytes[24] !== 8 || bytes[25] !== 6) {
        throw new Error("图集必须是与帧表一致的 RGBA8 PNG。");
      }
      image.src = url;
    }).catch((problem: unknown) => fail(problem instanceof Error ? problem.message : "图集文件头无法读取。"));
    return () => { cancelled = true; playing.current = false; cancelAnimationFrame(raf); image.onload = null; image.onerror = null; image.src = ""; URL.revokeObjectURL(url); };
    // The content identity freezes the decoded contract; transient callbacks
    // must not reset playback while React updates the displayed frame counter.
  }, [png, contextKey, frameTable, sampling]);

  if (!parsed || parseError) return <p role="alert">{parseError}</p>;
  const table = parsed, count = table.directions[0].frames.length;
  const stop = () => { playing.current = false; setRunning(false); phase.current = 0; playbackEpoch.current++; };
  const step = (delta: number) => { playing.current = false; setRunning(false); const next = table.loop ? (frame + delta + count) % count : Math.max(0, Math.min(frame + delta, count - 1)); phase.current = next / table.fps; playbackEpoch.current++; };
  return <section aria-label="2D 动画预览">
    <div className="ga-preview-toolbar">
      <button type="button" disabled={!ready || !!error} onClick={() => { playing.current = !playing.current; setRunning(playing.current); }}>{running ? "暂停" : "播放"}</button>
      <button type="button" disabled={!ready || !!error} onClick={stop}>停止</button>
      <button type="button" disabled={!ready || !!error} onClick={() => step(-1)}>上一帧</button>
      <button type="button" disabled={!ready || !!error} onClick={() => step(1)}>下一帧</button>
      <label>方向 <select aria-label="动画方向" value={direction} onChange={(event) => { const next = Number(event.target.value); selectedDirection.current = next; setDirection(next); }}>
        {table.directions.map((d, index) => <option key={d.name} value={index}>{d.name}</option>)}
      </select></label>
      <label>帧 <input aria-label="动画帧" type="range" min={0} max={count - 1} value={frame} onChange={(event) => { playing.current = false; setRunning(false); phase.current = Number(event.target.value) / table.fps; playbackEpoch.current++; }} /></label>
      <span>{frame + 1} / {count} · {table.fps} FPS</span>
    </div>
    {error ? <p role="alert">{error}</p> : <div className="ga-preview-content" data-background="checker" style={{ minHeight: 320 }}>
      <div style={{ position: "relative", width: table.canvas.width, aspectRatio: `${table.canvas.width}/${table.canvas.height}`, maxWidth: "100%" }}>
        <canvas ref={canvas} aria-label={`${table.clip_name} 固定画布`} style={{ width: "100%", display: "block", imageRendering: sampling === "nearest" ? "pixelated" : "auto" }} />
        <span aria-label="固定锚点" style={{ position: "absolute", left: `${table.anchor.x * 100}%`, top: `${table.anchor.y * 100}%`, transform: "translate(-50%, -50%)", color: "#ffb34f" }}>+</span>
      </div>
    </div>}
    <p>{(table.canvas.width / pixelsPerWorldUnit).toFixed(3)} × {(table.canvas.height / pixelsPerWorldUnit).toFixed(3)} 世界单位 · {table.loop ? "循环" : "播放结束保留末帧"} · 播放观察与人工确认分别记录。</p>
  </section>;
}
