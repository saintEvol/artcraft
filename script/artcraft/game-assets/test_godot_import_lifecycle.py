#!/usr/bin/env python3
"""Run the active-import recovery regression in a new, retained scratch project."""
from pathlib import Path
import argparse
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--godot", required=True, type=Path, help="Godot 4.7.2 executable")
  parser.add_argument("--pack", type=Path, default=ROOT / "test_data/game_assets/samples/pack_full")
  args = parser.parse_args()
  executable = args.godot.expanduser().resolve()
  pack = args.pack.expanduser().resolve()
  if not executable.is_file() or not (pack / "manifest.json").is_file():
    parser.error("Godot executable or asset manifest is missing")
  project = Path(tempfile.mkdtemp(prefix="artcraft-godot-import-lifecycle-"))
  (project / "project.godot").write_text('config_version=5\n[application]\nconfig/name="Artcraft import lifecycle regression"\n')
  shutil.copytree(ROOT / "integrations/godot/game_assets/addons", project / "addons")
  timestamp_source = project / "copy fixture's 来源"
  timestamp_source.mkdir()
  original = timestamp_source / "原图's 参考.bin"
  original.write_bytes(b"original file metadata")
  os.utime(original, ns=(1600000000123456789, 1600000000123456789))
  original.chmod(0o444)
  command = [str(executable), "--headless", "--path", str(project), "--script", str(Path(__file__).with_suffix(".gd")), "--", str(pack)]
  result = subprocess.run(command, capture_output=True, text=True, timeout=60)
  (project / "test.log").write_text(result.stdout + result.stderr)
  print(result.stdout, end="")
  print(result.stderr, end="")
  print(f"Retained isolated project and log: {project}")
  copied = project / "copy fixture's 副本" / original.name
  metadata_ok = copied.is_file() and copied.read_bytes() == original.read_bytes() and copied.stat().st_mtime_ns == original.stat().st_mtime_ns
  if not metadata_ok: print("FAIL exact modification time was not preserved")
  verified = metadata_ok and result.returncode == 0 and "ARTCRAFT_LIFECYCLE_OK" in result.stdout.splitlines() and "ERROR:" not in result.stdout + result.stderr
  raise SystemExit(0 if verified else (result.returncode or 1))


if __name__ == "__main__":
  main()
