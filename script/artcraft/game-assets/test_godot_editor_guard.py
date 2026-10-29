#!/usr/bin/env python3
"""Exercise real editor dirty-state and reload APIs in a fresh fixture project."""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--godot", required=True, type=Path)
  args = parser.parse_args()
  project = Path(tempfile.mkdtemp(prefix="artcraft-editor-guard-")).resolve()
  shutil.copytree(ROOT / "integrations/godot/game_assets/addons", project / "addons")
  plugin = project / "addons/qa_editor_guard"
  plugin.mkdir()
  (plugin / "plugin.cfg").write_text('[plugin]\nname="Editor guard regression"\ndescription="Isolated test"\nauthor="Artcraft"\nversion="1"\nscript="plugin.gd"\n')
  shutil.copyfile(Path(__file__).with_suffix(".gd"), plugin / "plugin.gd")
  (project / "project.godot").write_text('config_version=5\n[application]\nconfig/name="Artcraft editor guard regression"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/qa_editor_guard/plugin.cfg")\n')
  fixture = ROOT / "test_data/game_assets/samples/pack_full"
  for name in ["input-full", "input-update"]:
    shutil.copytree(fixture, project / name)
    # Source inputs are data, not project resources to import independently.
    (project / name / ".gdignore").write_text("# Test source pack\n")
  manifest_path = project / "input-update/manifest.json"
  manifest = json.loads(manifest_path.read_text())
  next(asset for asset in manifest["assets"] if asset["kind"] != "prop_3d")["version_id"] += "_updated"
  manifest["pack_id"] += "_updated"
  manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
  command = [str(args.godot.expanduser().resolve()), "--headless", "--editor", "--path", str(project)]
  before_times = {}
  with (project / "test.log").open("w") as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 90
    try:
      while process.poll() is None and time.monotonic() < deadline:
        ready = project / "noop-ready.json"
        if ready.exists() and not before_times:
          handoff = json.loads(ready.read_text())
          directory = Path(handoff["root"]).resolve()
          if not directory.is_relative_to(project):
            raise ValueError("Observer directory is outside the scratch project")
          for name in handoff["files"]:
            path = (directory / name).resolve()
            if not path.is_relative_to(directory):
              raise ValueError("Observer path escapes the managed tree")
            before_times[path] = path.stat().st_mtime_ns
          (project / "noop-resume").write_text("observer ready\n")
        time.sleep(0.05)
      code = process.wait(timeout=1)
    except BaseException:
      process.kill()
      process.wait()
      raise
  output = (project / "test.log").read_text()
  print(output, end="")
  print(f"Retained isolated project: {project}")
  unchanged_times = bool(before_times) and all(path.stat().st_mtime_ns == stamp for path, stamp in before_times.items())
  print("PASS" if unchanged_times else "FAIL", "nanosecond timestamps remain unchanged for an identical package")
  report = project / "editor-guard-result.json"
  verified = code == 0 and unchanged_times and "ARTCRAFT_EDITOR_GUARD_OK" in output.splitlines() and report.is_file() and json.loads(report.read_text())["passed"] and "ERROR:" not in output
  raise SystemExit(0 if verified else (code or 1))


if __name__ == "__main__":
  main()
