#!/usr/bin/env python3
"""Shared helpers for driving a real Cocos Creator 3.8.8 editor run.

Builds a throwaway project (package.json + minimal main.scene + the compiled
artcraft-game-assets extension), launches the editor with a task JSON, waits
for the extension's result file, then guarantees the editor process exits.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
COCOS_CREATOR = Path("/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator")
EXTENSION_SOURCE = ROOT / "integrations/cocos/game-assets/extension"
COCOS_PACKAGE = ROOT / "integrations/cocos/game-assets"

EDITOR_STARTUP_TIMEOUT_S = 300

# Minimal cc.Scene derived from the editor's own test scene (camera + light +
# globals); Cocos 3.8.8 imports it as cc.SceneAsset on first project open.
MINIMAL_SCENE = [
    {"__type__": "cc.SceneAsset", "_name": "", "_objFlags": 0, "_native": "", "scene": {"__id__": 1}},
    {"__type__": "cc.Scene", "_name": "", "_objFlags": 0, "_parent": None,
     "_children": [{"__id__": 2}, {"__id__": 5}], "_active": True, "_components": [],
     "_prefab": None, "autoReleaseAssets": False, "_globals": {"__id__": 7},
     "_id": "f46876e4-e81b-4931-b493-6d367be385e7"},
    {"__type__": "cc.Node", "_name": "Main Light", "_objFlags": 0, "_parent": {"__id__": 1},
     "_children": [], "_active": True, "_components": [{"__id__": 3}], "_prefab": None,
     "_lpos": {"__type__": "cc.Vec3", "x": 0, "y": 0, "z": 0},
     "_lrot": {"__type__": "cc.Quat", "x": -0.25, "y": -0.25, "z": -0.06698729810778066, "w": 0.9330127018922194},
     "_lscale": {"__type__": "cc.Vec3", "x": 1, "y": 1, "z": 1}, "_layer": 1073741824,
     "_euler": {"__type__": "cc.Vec3", "x": -30, "y": -30, "z": 0}, "_id": "c0y6F5f+pAvI805TdmxIjx"},
    {"__type__": "cc.DirectionalLight", "_name": "", "_objFlags": 0, "node": {"__id__": 2},
     "_enabled": True, "__prefab": None,
     "_color": {"__type__": "cc.Color", "r": 255, "g": 255, "b": 255, "a": 255},
     "_useColorTemperature": False, "_colorTemperature": 6550,
     "_staticSettings": {"__id__": 4}, "_illuminance": 65000, "_id": "597uMYCbhEtJQc0ffJlcgA"},
    {"__type__": "cc.StaticLightSettings", "_baked": False, "_editorOnly": False,
     "_bakeable": False, "_castShadow": False},
    {"__type__": "cc.Node", "_name": "Main Camera", "_objFlags": 0, "_parent": {"__id__": 1},
     "_children": [], "_active": True, "_components": [{"__id__": 6}], "_prefab": None,
     "_lpos": {"__type__": "cc.Vec3", "x": -10, "y": 10, "z": 10},
     "_lrot": {"__type__": "cc.Quat", "x": -0.27781593346944056, "y": -0.36497167621709875,
               "z": -0.11507512748638377, "w": 0.8811195706053617},
     "_lscale": {"__type__": "cc.Vec3", "x": 1, "y": 1, "z": 1}, "_layer": 1073741824,
     "_euler": {"__type__": "cc.Vec3", "x": -35, "y": -45, "z": 0}, "_id": "c9DMICJLFO5IeO07EPon7U"},
    {"__type__": "cc.Camera", "_name": "", "_objFlags": 0, "node": {"__id__": 5},
     "_enabled": True, "__prefab": None, "_projection": 1, "_priority": 0, "_fov": 45,
     "_fovAxis": 0, "_orthoHeight": 10, "_near": 1, "_far": 1000,
     "_color": {"__type__": "cc.Color", "r": 51, "g": 51, "b": 51, "a": 255},
     "_depth": 1, "_stencil": 0, "_clearFlags": 7,
     "_rect": {"__type__": "cc.Rect", "x": 0, "y": 0, "width": 1, "height": 1},
     "_aperture": 19, "_shutter": 7, "_iso": 0, "_screenScale": 1,
     "_visibility": 1822425087, "_targetTexture": None, "_id": "7dWQTpwS5LrIHnc1zAPUtf"},
    {"__type__": "cc.SceneGlobals", "ambient": {"__id__": 8}, "shadows": {"__id__": 9},
     "_skybox": {"__id__": 10}, "fog": {"__id__": 11}},
    {"__type__": "cc.AmbientInfo",
     "_skyColor": {"__type__": "cc.Color", "r": 51, "g": 128, "b": 204, "a": 1},
     "_skyIllum": 20000, "_groundAlbedo": {"__type__": "cc.Color", "r": 51, "g": 51, "b": 51, "a": 255}},
    {"__type__": "cc.ShadowsInfo", "_type": 0, "_enabled": False,
     "_normal": {"__type__": "cc.Vec3", "x": 0, "y": 1, "z": 0}, "_distance": 0,
     "_shadowColor": {"__type__": "cc.Color", "r": 76, "g": 76, "b": 76, "a": 255},
     "_autoAdapt": True, "_pcf": 0, "_bias": 1e-05, "_normalBias": 0, "_near": 1,
     "_far": 30, "_orthoSize": 5, "_maxReceived": 4,
     "_size": {"__type__": "cc.Vec2", "x": 512, "y": 512}, "_saturation": 0.75},
    {"__type__": "cc.SkyboxInfo", "_envmap": None, "_isRGBE": False, "_enabled": False, "_useIBL": False},
    {"__type__": "cc.FogInfo", "_type": 0,
     "_fogColor": {"__type__": "cc.Color", "r": 200, "g": 200, "b": 200, "a": 255},
     "_enabled": False, "_fogDensity": 0.3, "_fogStart": 0.5, "_fogEnd": 300,
     "_fogAtten": 5, "_fogTop": 1.5, "_fogRange": 1.2},
]


def ensure_extension_built() -> None:
  main = EXTENSION_SOURCE / "dist/extension/main.js"
  if main.is_file():
    return
  subprocess.run(["npm", "run", "build"], cwd=COCOS_PACKAGE, check=True,
                 capture_output=True, text=True)


def create_project(prefix: str) -> Path:
  ensure_extension_built()
  project = Path(tempfile.mkdtemp(prefix=prefix))
  (project / "assets").mkdir(parents=True)
  (project / "package.json").write_text(json.dumps({
      "name": "artcraft-cocos-test",
      "version": "0.1.0",
      "type": "3d",
      "uuid": str(uuid.uuid4()),
      "creator": {"version": "3.8.8"},
  }, indent=2), encoding="utf-8")
  (project / "assets/main.scene").write_text(json.dumps(MINIMAL_SCENE), encoding="utf-8")
  shutil.copytree(EXTENSION_SOURCE, project / "extensions/artcraft-game-assets")
  return project


def run_editor_task(project: Path, task: dict, timeout_s: int = 300) -> tuple[Path, Path]:
  """Launch the editor with ARTCRAFT_COCOS_TASK; wait for the result file.

  Returns (result_path, editor_log_path). Kills the editor by exact pid if the
  result never arrives.
  """
  result_path = project.parent / f"{project.name}-result.json"
  task = {**task, "resultPath": str(result_path)}
  task_path = project.parent / f"{project.name}-task.json"
  task_path.write_text(json.dumps(task), encoding="utf-8")
  log_path = project.parent / f"{project.name}-editor.log"
  if result_path.exists():
    result_path.unlink()
  env = {**os.environ, "ARTCRAFT_COCOS_TASK": str(task_path)}
  with log_path.open("w") as log_file:
    process = subprocess.Popen(
        [str(COCOS_CREATOR), "--project", str(project)],
        stdout=log_file, stderr=subprocess.STDOUT, env=env)
  try:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
      if result_path.exists():
        time.sleep(2)  # let the editor flush + quit itself
        return result_path, log_path
      if process.poll() is not None:
        break
      time.sleep(2)
    return result_path, log_path
  finally:
    if process.poll() is None:
      process.kill()
    try:
      process.wait(timeout=30)
    except subprocess.TimeoutExpired:
      pass


def report_summary(result_path: Path, marker: str) -> int:
  """Print PASS/FAIL lines from the task result; exit 0 only if all passed."""
  if not result_path.exists():
    print(f"FAIL editor task produced no result file: {result_path}")
    return 1
  summary = json.loads(result_path.read_text(encoding="utf-8"))
  for record in summary.get("records", []):
    line = "PASS" if record.get("pass") else "FAIL"
    print(f"{line} {record.get('name', '?')}"
          + (f" :: {record['detail']}" if record.get("detail") else ""))
  if summary.get("fatal"):
    print(f"FAIL fatal :: {summary['fatal']}")
  all_pass = bool(summary.get("allPass"))
  print(marker if all_pass else marker.replace("_OK", "_FAIL"))
  return 0 if all_pass else 1
