import { afterEach, expect, it, vi } from "vitest";
import { previewVisible } from "./preview-visible";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("honors the scroll-pane clip instead of only checking the window bounds", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const pane = document.createElement("div"), canvas = document.createElement("canvas"); pane.append(canvas); document.body.append(pane);
  pane.style.overflowY = "auto";
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 50));
  const bounds = vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 60, 100, 100));
  expect(previewVisible(canvas)).toBe(false);
  bounds.mockReturnValue(new DOMRect(0, 20, 100, 100)); expect(previewVisible(canvas)).toBe(true);
  pane.style.opacity = "0"; expect(previewVisible(canvas)).toBe(false);
  pane.style.opacity = "1"; canvas.style.visibility = "hidden"; expect(previewVisible(canvas)).toBe(false);
});

it("rejects hidden documents and disconnected canvases", () => {
  const canvas = document.createElement("canvas"); vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); expect(previewVisible(canvas)).toBe(false);
  document.body.append(canvas); vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); expect(previewVisible(canvas)).toBe(false);
});
