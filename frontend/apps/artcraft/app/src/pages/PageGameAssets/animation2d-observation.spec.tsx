import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import { Animation2dPreview } from "./Animation2dPreview";

const visibility = vi.hoisted(() => ({ visible: true }));
vi.mock("./preview-visible", () => ({ previewVisible: () => visibility.visible }));
const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;

beforeEach(() => {
  visibility.visible = true; frames.clear(); sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("URL", class extends URL { static override createObjectURL = () => "blob:atlas"; static override revokeObjectURL = () => {}; });
  vi.stubGlobal("Image", class { naturalWidth = 8; naturalHeight = 4; onload: (() => void) | null = null; onerror = null; set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("records natural visible playback/loop separately from decode and never records a seek as playback", async () => {
  const onDecoded = vi.fn(), onPlayback = vi.fn(), width = vi.spyOn(HTMLCanvasElement.prototype, "width", "set");
  render(<Animation2dPreview png={png()} frameTable={table()} contextKey="first" sampling="nearest" pixelsPerWorldUnit={100} onDecoded={onDecoded} onPlayback={onPlayback} />);
  await waitFor(() => expect(frames.size).toBe(1)); await tick(0);
  expect(onDecoded).toHaveBeenCalledExactlyOnceWith("first"); expect(onPlayback).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("动画帧"), { target: { value: "1" } }); await tick(10);
  expect(onPlayback).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "停止" })); await tick(20);
  fireEvent.click(screen.getByRole("button", { name: "播放" })); await tick(145); await tick(270);
  expect(onPlayback).toHaveBeenCalledWith("first", "default", false);
  expect(onPlayback).toHaveBeenCalledWith("first", "default", true);
  expect(width).toHaveBeenCalledTimes(1);
});

it("does not count hidden or suspended playback and cancels stale callbacks on a new context", async () => {
  const onPlayback = vi.fn(); visibility.visible = false;
  const props = { png: png(), frameTable: table(), contextKey: "old", sampling: "nearest" as const, pixelsPerWorldUnit: 100, onPlayback };
  const view = render(<Animation2dPreview {...props} />);
  await waitFor(() => expect(frames.size).toBe(1)); await tick(0);
  fireEvent.click(screen.getByRole("button", { name: "播放" })); await tick(125); await tick(250);
  expect(onPlayback).not.toHaveBeenCalled();
  visibility.visible = true; await tick(1500);
  expect(onPlayback).not.toHaveBeenCalled();
  const stale = [...frames.values()][0];
  view.rerender(<Animation2dPreview {...props} contextKey="new" />);
  await act(async () => stale(1625));
  expect(onPlayback).not.toHaveBeenCalled();
});

async function tick(now: number) { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(now)); }); }
function png(): Blob {
  const bytes = new Uint8Array(33), header = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0); header.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12); header.setUint32(16, 8); header.setUint32(20, 4); bytes[24] = 8; bytes[25] = 6;
  return new NodeBlob([bytes]) as unknown as Blob;
}
function table() { return { schema_version: "game.anim2d.frames.v1", clip_name: "walk", canvas: { width: 2, height: 2 }, anchor: { origin: "top_left", x: 0.5, y: 1 }, atlas: { role: "main", ordinal: 0, width: 8, height: 4, extrude_px: 1 }, fps: 8, loop: true, directions: [{ name: "default", frames: [{ x: 1, y: 1, width: 2, height: 2 }, { x: 5, y: 1, width: 2, height: 2 }] }] }; }
