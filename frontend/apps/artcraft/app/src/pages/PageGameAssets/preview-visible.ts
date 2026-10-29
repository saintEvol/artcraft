/** Rendering offscreen or after a suspended tab is not playback observation. */
export function previewVisible(element: HTMLElement): boolean {
  if (!element.isConnected || document.visibilityState !== "visible") return false;
  const box = element.getBoundingClientRect();
  let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right), top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if ((node === element && ["hidden", "collapse"].includes(style.visibility)) || style.display === "none" || (style.opacity !== "" && Number(style.opacity) === 0)) return false;
    if (node !== element) {
      const parent = node.getBoundingClientRect();
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) { left = Math.max(left, parent.left); right = Math.min(right, parent.right); }
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) { top = Math.max(top, parent.top); bottom = Math.min(bottom, parent.bottom); }
    }
    if (right <= left || bottom <= top) return false;
  }
  return right > left && bottom > top;
}
