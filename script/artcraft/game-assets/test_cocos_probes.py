#!/usr/bin/env python3
"""Run the P1/P2 Cocos Creator probes in a real editor (3.8.8).

P1: animation-only GLB must import into a cc.AnimationClip + cc.Prefab
    sub-assets without errors.
P2: the clip's curves bind by relative node path (no source-file UUID), so it
    can be assigned directly to two hero instances' SkeletalAnimation.clips
    and played per instance.

A macOS editor window appears while the task runs; the extension quits the
editor itself once results are written. See integrations/cocos/game-assets/PROBES.md.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cocos_driver import ROOT, create_project, report_summary, run_editor_task


def main() -> int:
  if not Path("/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator").is_file():
    print("FAIL Cocos Creator 3.8.8 not found at /Applications/Cocos/Creator/3.8.8")
    return 1
  project = create_project("artcraft-cocos-probes-")
  pack_dir = ROOT / "test_data/game_assets/pack_v2_minimal"
  result_path, log_path = run_editor_task(project, {
      "kind": "probes",
      "packDir": str(pack_dir),
  })
  print(f"Retained probe project and log: {project}")
  print(f"Editor log: {log_path}")
  return report_summary(result_path, "ARTCRAFT_COCOS_PROBES_OK")


if __name__ == "__main__":
  raise SystemExit(main())
