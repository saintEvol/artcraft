#!/usr/bin/env python3
"""§12.4 Cocos 集成的构建产物运行时验收：打包后读取 + 实际播放。

三段式（对标 test_cocos_probes.py 的真实编辑器驱动 + godot 脚本模式）：
1. 编辑器会话（runtime-qa 任务）：装入扩展 → 导入 pack_v2_minimal → 把
   extension/static/qa_driver.ts 装为工程脚本 → main.scene 增补
   ArtcraftQaDriver 组件（引用 frames/skeleton_map JsonAsset、图集
   Texture2D、hero Prefab、spin AnimationClip）→ 开场景验证并保存。
2. CLI 构建：`--build "platform=web-mobile;debug=false"`，产物
   build/web-mobile（headless 构建不执行场景脚本，所以场景装配在第 1 步）。
3. headless Chromium：http.server 服务产物，playwright-core 驱动系统
   Google Chrome（swiftshader WebGL）打开，读取 QA 驱动写入的
   window.__ARTCRAFT_COCOS_QA__ 采样并截图，本地断言：
   - 2D：帧号序列按 core.playback frameAt（循环回绕/非循环停留/停止回 0）、
     锚点换算 (0.5-x,0.5-y)、SpriteFrame rect y 轴换算（uv 数值证据）、
     截图两帧红/蓝主导且像素差异非零（真实渲染推进）；
   - 3D：双 hero 实例独立播放、Hip 关节四元数随时间变化、motion root 保持
     恒等（in_place）、对照实例 stop 后恢复 rest；
   - §12.4：frames.json / skeleton_map.json 作为 JsonAsset 打进构建产物且
     运行时可读（uuid + 内容摘要 + 产物内物理存在）。

成功输出汇总行 ARTCRAFT_COCOS_RUNTIME_OK。
"""
from pathlib import Path
import json
import math
import struct
import subprocess
import sys
import threading
import time
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cocos_driver import COCOS_CREATOR, ROOT, create_project, run_editor_task

PACK_DIR = ROOT / "test_data/game_assets/pack_v2_minimal"
BUILD_TIMEOUT_S = 900
PLAYWRIGHT_VERSION = "1.53.0"
PLAYWRIGHT_CACHE = Path("/tmp/artcraft-cocos-qa-playwright")
CHROME_APP = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

RECORDS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> bool:
  line = "PASS" if ok else "FAIL"
  print(f"{line} {name}" + (f" :: {detail}" if detail else ""), flush=True)
  RECORDS.append((name, ok, detail))
  return ok


# ---------------------------------------------------------------------------
# 阶段 1：编辑器会话（导包 + QA 场景装配）
# ---------------------------------------------------------------------------

def phase_editor_setup(project: Path) -> bool:
  result_path, log_path = run_editor_task(project, {"kind": "runtime-qa", "packDir": str(PACK_DIR)})
  print(f"[runtime] editor log: {log_path}")
  if not result_path.exists():
    return record("R0.editor-result", False, f"编辑器任务未产出结果文件：{result_path}")
  summary = json.loads(result_path.read_text(encoding="utf-8"))
  ok = True
  for item in summary.get("records", []):
    ok = record(str(item.get("name", "?")), bool(item.get("pass")), str(item.get("detail", ""))) and ok
  if summary.get("fatal"):
    ok = record("R.fatal", False, str(summary["fatal"])) and ok
  return ok


# ---------------------------------------------------------------------------
# 阶段 2：CLI 构建 web-mobile
# ---------------------------------------------------------------------------

def phase_build(project: Path) -> bool:
  build_dir = project / "build/web-mobile"
  log_path = project.parent / f"{project.name}-build.log"
  command = [str(COCOS_CREATOR), "--project", str(project),
             "--build", "platform=web-mobile;debug=false"]
  print(f"[runtime] build: {' '.join(command[1:])}", flush=True)
  started = time.time()
  with log_path.open("w") as log_file:
    process = subprocess.Popen(command, stdout=log_file, stderr=subprocess.STDOUT)
    try:
      exit_code = process.wait(timeout=BUILD_TIMEOUT_S)
    except subprocess.TimeoutExpired:
      process.kill()
      process.wait(timeout=30)
      exit_code = -1
  elapsed = time.time() - started
  log_text = log_path.read_text(encoding="utf-8", errors="replace")
  tail = [line for line in log_text.splitlines() if line.strip()][-12:]
  print("[runtime] build log tail:")
  for line in tail:
    print(f"  | {line}")
  index = build_dir / "index.html"
  settings = build_dir / "src/settings.json"
  bundle_jsons = list(build_dir.glob("assets/**/*.json"))
  finished = "build Task (web-mobile) Finished" in log_text
  # CLI 构建进程以非零码退出（本机 3.8.8 构建收尾 worker 被 SIGTERM 的已知
  # 噪声）；验收以任务完成标记 + 产物存在为准，退出码如实记录。
  ok = record("BUILD.web-mobile-output", index.is_file() and finished,
              f"exit={exit_code} elapsed={elapsed:.0f}s index={index.is_file()} finished={finished} "
              f"settings={settings.is_file()} asset_json={len(bundle_jsons)} log={log_path}")
  if not ok:
    return False
  # §12.4 物理证据：frames/skeleton_map 内容确实在产物内。
  frames_hits = [p for p in build_dir.rglob("*.json")
                 if "game.anim2d.frames.v1" in p.read_text(encoding="utf-8", errors="ignore")]
  map_hits = [p for p in build_dir.rglob("*.json")
              if "game.anim3d.skeleton_map.v1" in p.read_text(encoding="utf-8", errors="ignore")]
  record("BUILD.frames-json-packed", bool(frames_hits),
         ";".join(str(p.relative_to(build_dir)) for p in frames_hits[:3]))
  record("BUILD.skeleton-map-packed", bool(map_hits),
         ";".join(str(p.relative_to(build_dir)) for p in map_hits[:3]))
  return True


# ---------------------------------------------------------------------------
# 阶段 3：headless Chromium 断言
# ---------------------------------------------------------------------------

def ensure_playwright() -> Path:
  marker = PLAYWRIGHT_CACHE / "node_modules/playwright-core/package.json"
  if not marker.is_file():
    PLAYWRIGHT_CACHE.mkdir(parents=True, exist_ok=True)
    subprocess.run(["npm", "init", "-y"], cwd=PLAYWRIGHT_CACHE, check=True,
                   capture_output=True, text=True)
    subprocess.run(["npm", "install", "--no-audit", "--no-fund",
                    f"playwright-core@{PLAYWRIGHT_VERSION}"],
                   cwd=PLAYWRIGHT_CACHE, check=True, capture_output=True, text=True)
  return PLAYWRIGHT_CACHE / "node_modules"


def phase_browser(project: Path) -> bool:
  build_dir = project / "build/web-mobile"
  out_dir = project.parent / f"{project.name}-browser"
  out_dir.mkdir(parents=True, exist_ok=True)
  qa_path = out_dir / "browser-result.json"

  handler = partial(SimpleHTTPRequestHandler, directory=str(build_dir))
  server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
  port = server.server_address[1]
  thread = threading.Thread(target=server.serve_forever, daemon=True)
  thread.start()
  try:
    url = f"http://127.0.0.1:{port}/index.html"
    runner = Path(__file__).resolve().parent / "cocos_qa_browser.js"
    modules = ensure_playwright()
    print(f"[runtime] browser: {url}", flush=True)
    completed = subprocess.run(
        ["node", str(runner), url, str(qa_path), str(out_dir), str(modules)],
        capture_output=True, text=True, timeout=300)
    if completed.stdout:
      print(completed.stdout.strip())
    if not qa_path.exists():
      return record("B.browser-run", False,
                    f"runner exit={completed.returncode} stderr={completed.stderr[-500:]}")
    output = json.loads(qa_path.read_text(encoding="utf-8"))
    return assert_browser(output, out_dir)
  finally:
    server.shutdown()
    server.server_close()


# ---------------------------------------------------------------------------
# 断言（纯 python，读取 browser-result.json 与截图）
# ---------------------------------------------------------------------------

def assert_browser(output: dict, out_dir: Path) -> bool:
  ok = True
  qa = output.get("qa") or {}
  if qa.get("error") is not None:
    ok = record("B.qa-driver-error", False, str(qa.get("error"))) and ok
  ok = record("B.webgl-context", bool(output.get("webgl")), f"webgl={output.get('webgl')}") and ok
  ok = record("B.qa-done", qa.get("done") is True,
              f"samples={len(qa.get('samples', []))} console={len(output.get('consoleLines', []))}") and ok

  frames = (qa.get("json") or {}).get("frames") or {}
  skeleton = (qa.get("json") or {}).get("skeletonMap") or {}
  ok = record("B.json-frames-readable", frames.get("uuid") is not None
              and frames.get("schemaVersion") == "game.anim2d.frames.v1"
              and frames.get("fps") == 4 and frames.get("loop") is True
              and frames.get("frameCount") == 2,
              f"uuid={frames.get('uuid')} clip={frames.get('clipName')} fps={frames.get('fps')}") and ok
  ok = record("B.json-skeleton-map-readable", skeleton.get("uuid") is not None
              and skeleton.get("schemaVersion") == "game.anim3d.skeleton_map.v1"
              and skeleton.get("clipName") == "spin" and skeleton.get("mappingCount") == 1,
              f"uuid={skeleton.get('uuid')} token={skeleton.get('rigToken')}") and ok

  geometry = qa.get("geometry") or {}
  walk = geometry.get("walkLoop") or {}
  frame0 = geometry.get("spriteFrameFrame0") or {}
  probe = geometry.get("uvProbe") or {}

  def uv_close(actual, expected, eps=1e-6) -> bool:
    return (isinstance(actual, list) and len(actual) >= len(expected)
            and all(abs(a - e) <= eps for a, e in zip(actual, expected)))

  # rect y 轴换算：帧表 rect(1,1,8,8)（图集 20x10，顶部）→ SpriteFrame
  # rect(1,1,8,8)（flipY=10-1-8=1，对称例）uv v∈[0.1,0.9]；
  # 探针 rect(1,0,8,4)（图集顶部 4 行）→ SpriteFrame y'=6，uv v∈[0.6,1.0]。
  ok = record("B.rect-frame0-uv", frame0.get("rect") == [1, 1, 8, 8]
              and uv_close(frame0.get("uv"), [0.05, 0.9, 0.45, 0.9, 0.05, 0.1, 0.45, 0.1]),
              f"rect={frame0.get('rect')} uv={frame0.get('uv')}") and ok
  ok = record("B.rect-y-flip-uv-probe", probe.get("spriteFrameRect") == [1, 6, 8, 4]
              and uv_close(probe.get("uv"), [0.05, 1.0, 0.45, 1.0, 0.05, 0.6, 0.45, 0.6]),
              f"atlas={probe.get('atlas')} rect={probe.get('spriteFrameRect')} uv={probe.get('uv')}") and ok

  # 锚点换算：平台 (0.5, 1.0) → cocos (0, -0.5)；几何 bbox 与该锚点一致。
  anchor = walk.get("anchorPoint")
  ok = record("B.anchor-conversion", anchor == [0, -0.5],
              f"anchorPoint={anchor} contentSize={walk.get('contentSize')}") and ok
  node_pos = walk.get("nodePos") or [0, 0]
  world_rect = walk.get("worldRect") or {}
  if anchor == [0, -0.5] and world_rect:
    # 引擎世界 bbox 与锚点公式一致：bbox.min = P - anchor * 世界尺寸。
    expected_x = node_pos[0] - anchor[0] * world_rect.get("width", 0)
    expected_y = node_pos[1] - anchor[1] * world_rect.get("height", 0)
    geo_ok = (abs(world_rect.get("x", -1) - expected_x) < 0.5
              and abs(world_rect.get("y", -1) - expected_y) < 0.5)
  else:
    geo_ok = False
  ok = record("B.anchor-visual-geometry", geo_ok,
              f"pos={node_pos} rect={world_rect}") and ok

  samples = qa.get("samples") or []
  events = qa.get("events") or {}
  ok = assert_samples(samples, events) and ok
  ok = assert_screenshots(output, out_dir, geometry) and ok
  return ok


FPS = 4.0
COUNT = 2
FRAME_PERIOD = 1.0 / FPS
BOUNDARY_GUARD_S = 0.06


def guarded(t: float) -> bool:
  """离帧边界足够远（组件与 QA 时钟可有 ≤1 帧偏差）。"""
  return (t % FRAME_PERIOD) > BOUNDARY_GUARD_S and (t % FRAME_PERIOD) < FRAME_PERIOD - BOUNDARY_GUARD_S


def assert_samples(samples: list, events: dict) -> bool:
  ok = True
  if not record("B.samples-collected", len(samples) >= 40, f"n={len(samples)}"):
    return False

  loop_errors = []
  for sample in samples:
    elapsed = sample.get("loopElapsed", -1)
    if elapsed < 0 or not guarded(elapsed):
      continue
    expected = math.floor(elapsed * FPS) % COUNT
    if sample["loopFrame"] != expected:
      loop_errors.append((elapsed, sample["loopFrame"], expected))
  ok = record("B.2d-loop-frame-sequence", not loop_errors,
              f"errors={loop_errors[:5]}（含循环回绕，按组件 elapsed，边界±{BOUNDARY_GUARD_S}s 除外）") and ok

  once_stop = events.get("onceStoppedAt")
  hold_errors = []
  hold_n = 0
  for sample in samples:
    if once_stop is None or sample["t"] > once_stop - 0.06:
      continue
    elapsed = sample.get("onceElapsed", -1)
    if elapsed >= 0.55:  # 非循环：一旦越过首帧边界即应停留末帧
      hold_n += 1
      if sample["onceFrame"] != 1:
        hold_errors.append((elapsed, sample["onceFrame"]))
  ok = record("B.2d-once-holds-last-frame", hold_n > 0 and not hold_errors,
              f"checked={hold_n} errors={hold_errors[:5]}（停止前、onceElapsed≥0.55 的采样）") and ok

  stop_errors = []
  stop_n = 0
  if once_stop is not None:
    for sample in samples:
      t = sample["t"]
      if t > once_stop + 0.06:
        stop_n += 1
        if sample["onceFrame"] != 0:  # 停止回第 0 帧
          stop_errors.append((t, sample["onceFrame"]))
  ok = record("B.2d-stop-resets-to-frame0", stop_n > 0 and not stop_errors and once_stop is not None,
              f"stopAt={once_stop} checked={stop_n} errors={stop_errors[:5]}") and ok

  # 3D：heroA Hip 随时间变化，接近 45° 峰值（|z|≈0.3827）；motion root 恒等。
  hip_a = [(s["t"], s["hipA"][2]) for s in samples]
  peak = max((abs(z) for _, z in hip_a), default=0.0)
  near_peak = sum(1 for _, z in hip_a if abs(z) > 0.28)
  ok = record("B.3d-hipA-animates", peak > 0.3 and near_peak >= 2,
              f"peakZ={peak:.4f}(期望≈0.3827) samplesNearPeak={near_peak}") and ok

  root_bad = [(s["t"], s["heroRootA"]) for s in samples
              if max(abs(v) for v in s["heroRootA"][:3]) > 1e-3 or abs(s["heroRootA"][3] - 1) > 1e-3]
  ok = record("B.3d-motion-root-in-place", not root_bad, f"violations={len(root_bad)}") and ok

  hero_stop = events.get("heroBStoppedAt")
  rest = events.get("restHipB")
  pre_rotated = any(hero_stop is not None and hero_stop - 0.12 <= s["t"] <= hero_stop - 0.02
                    and abs(s["hipB"][2]) > 0.05 for s in samples)
  post = [s for s in samples if hero_stop is not None and s["t"] > hero_stop + 0.06]
  post_rest = all(max(abs(s["hipB"][i] - (rest[i] if rest else 0)) for i in range(4)) < 1e-6
                  for s in post) if post and rest else False
  post_constant = (max((s["hipB"][2] for s in post), default=0)
                   - min((s["hipB"][2] for s in post), default=0)) < 1e-9 if len(post) > 1 else False
  ok = record("B.3d-heroB-restored-after-stop",
              hero_stop is not None and pre_rotated and post_rest and post_constant,
              f"stopAt={hero_stop} preRotated={pre_rotated} postRest={post_rest} "
              f"postConstant={post_constant} rest={rest}") and ok

  independent = any(hero_stop is not None and s["t"] > hero_stop + 0.06
                    and abs(s["hipA"][2]) > 0.1 and abs(s["hipB"][2]) < 1e-6
                    for s in samples)
  ok = record("B.3d-instances-independent", independent,
              "停止后 A 仍在旋转而 B 保持 rest") and ok
  return ok


def assert_screenshots(output: dict, out_dir: Path, geometry: dict) -> bool:
  ok = True
  shots = output.get("shots") or {}
  entries = shots.get("all") or []
  ok = record("B.shots-captured", len(entries) >= 8, f"n={len(entries)}") and ok
  if len(entries) == 0:
    return ok

  walk = (geometry.get("walkLoop") or {})
  visible = geometry.get("visibleSize") or {}

  def pick(want_red: bool):
    for entry in entries:
      image = decode_png(out_dir / entry["file"])
      if image is None:
        continue
      rect = crop_rect(walk, visible, image["width"], image["height"])
      hits = total = 0
      for y in range(rect[1], rect[3], 2):
        for x in range(rect[0], rect[2], 2):
          r, g, b = image["pixels"][y][x]
          total += 1
          if want_red and r > 180 and g < 140 and b < 140:
            hits += 1
          elif not want_red and b > 180 and r < 140 and g < 160:
            hits += 1
      if total > 0 and hits / total > 0.5:
        return image, entry, rect, hits, total
    return None, None, None, 0, 0

  red, red_entry, rect, red_hits, red_total = pick(True)
  blue, blue_entry, _, blue_hits, blue_total = pick(False)
  ok = record("B.shot-frame0-red-dominant", red is not None,
              f"{red_entry and red_entry['file']} {red_hits}/{red_total} px in crop {rect}") and ok
  ok = record("B.shot-frame1-blue-dominant", blue is not None,
              f"{blue_entry and blue_entry['file']} {blue_hits}/{blue_total} px in crop {rect}") and ok

  if red is not None and blue is not None and red["width"] == blue["width"] and red["height"] == blue["height"]:
    diff = 0
    total_px = 0
    for y in range(0, red["height"], 2):
      for x in range(0, red["width"], 2):
        a, b = red["pixels"][y][x], blue["pixels"][y][x]
        total_px += 1
        if max(abs(a[i] - b[i]) for i in range(3)) > 30:
          diff += 1
    ok = record("B.screenshots-differ", diff / max(total_px, 1) > 0.005,
                f"{diff}/{total_px} px differ (>30/255，红帧 vs 蓝帧截图)") and ok
  else:
    ok = record("B.screenshots-differ", False, "未同时观察到红帧与蓝帧") and ok
  return ok


def crop_rect(walk: dict, visible: dict, shot_w: int, shot_h: int) -> tuple[int, int, int, int]:
  """设计坐标（原点屏幕中心、y 向上）→ 截图像素（原点左上、y 向下）。"""
  world = walk.get("worldRect") or {}
  vis_w, vis_h = visible.get("width", 960), visible.get("height", 640)
  sx, sy = shot_w / vis_w, shot_h / vis_h
  x0 = int(round((world.get("x", 0) + vis_w / 2) * sx))
  x1 = int(round((world.get("x", 0) + world.get("width", 0) + vis_w / 2) * sx))
  y0 = int(round((vis_h / 2 - (world.get("y", 0) + world.get("height", 0))) * sy))
  y1 = int(round((vis_h / 2 - world.get("y", 0)) * sy))
  clamp = lambda v, lo, hi: max(lo, min(hi, v))
  return (clamp(x0, 0, shot_w - 2), clamp(y0, 0, shot_h - 2),
          clamp(x1, x0 + 1, shot_w), clamp(y1, y0 + 1, shot_h))


# ---------------------------------------------------------------------------
# 极简 PNG 解码（截图是无调色板真彩 PNG）
# ---------------------------------------------------------------------------

def decode_png(path: Path):
  data = path.read_bytes()
  if data[:8] != b"\x89PNG\r\n\x1a\n":
    return None
  pos, idat, width = 8, b"", 0
  height = bit_depth = color_type = 0
  while pos < len(data):
    length, kind = struct.unpack(">I4s", data[pos:pos + 8])
    chunk = data[pos + 8:pos + 8 + length]
    if kind == b"IHDR":
      width, height, bit_depth, color_type = struct.unpack(">IIBB", chunk[:10])
    elif kind == b"IDAT":
      idat += chunk
    pos += 12 + length
  if bit_depth != 8 or color_type not in (2, 6):
    return None
  channels = 3 if color_type == 2 else 4
  raw = zlib.decompress(idat)
  stride = width * channels + 1
  rows, prev = [], bytearray(width * channels)

  def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

  for y in range(height):
    filter_type = raw[y * stride]
    line = bytearray(raw[y * stride + 1:(y + 1) * stride])
    for i in range(len(line)):
      left = line[i - channels] if i >= channels else 0
      up = prev[i]
      up_left = prev[i - channels] if i >= channels else 0
      if filter_type == 1:
        line[i] = (line[i] + left) & 255
      elif filter_type == 2:
        line[i] = (line[i] + up) & 255
      elif filter_type == 3:
        line[i] = (line[i] + ((left + up) >> 1)) & 255
      elif filter_type == 4:
        line[i] = (line[i] + paeth(left, up, up_left)) & 255
    prev = line
    rows.append(line)
  pixels = [[(rows[y][x * channels], rows[y][x * channels + 1], rows[y][x * channels + 2])
             for x in range(width)] for y in range(height)]
  return {"width": width, "height": height, "pixels": pixels}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> int:
  if not COCOS_CREATOR.is_file():
    print("FAIL Cocos Creator 3.8.8 not found")
    return 1
  if not CHROME_APP.is_file():
    print("FAIL Google Chrome not found at /Applications/Google Chrome.app")
    return 1
  project = create_project("artcraft-cocos-runtime-")
  print(f"[runtime] project: {project}")
  ok = phase_editor_setup(project)
  if ok:
    ok = phase_build(project)
  if ok:
    ok = phase_browser(project)
  all_pass = ok and all(passed for _, passed, _ in RECORDS)
  print(f"[runtime] retained project: {project}")
  print("ARTCRAFT_COCOS_RUNTIME_OK" if all_pass else "ARTCRAFT_COCOS_RUNTIME_FAIL")
  return 0 if all_pass else 1


if __name__ == "__main__":
  raise SystemExit(main())
