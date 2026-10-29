#!/usr/bin/env python3
"""Generate/check shared animation schemas and schema-only engineering fixtures.

Rust game_asset_contracts is authoritative. No provider calls, package creation,
engine verification or production profile approval are performed here.
"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  repo = Path(__file__).resolve().parents[3]
  parser.add_argument("--services-root", type=Path, default=repo.parent / "artcraft-services")
  parser.add_argument("--check", action="store_true", help="Fail on drift without replacing published snapshots")
  args = parser.parse_args()
  services = args.services_root.resolve()
  with tempfile.TemporaryDirectory(prefix="artcraft-animation-contracts-") as temporary:
    generated = Path(temporary)
    subprocess.run(["cargo", "run", "--locked", "-p", "game_asset_contracts", "--example", "export_contract_schemas", "--", str(generated / "schemas"), str(generated / "fixtures")],
      cwd=services, env={**os.environ, "SQLX_OFFLINE": "true"}, check=True)
    changed = []
    targets = [("schemas", services / "crates/lib/game_asset_contracts/schemas"), ("fixtures", services / "crates/lib/game_asset_contracts/fixtures"),
      ("schemas", repo / "test_data/game_assets/contracts/schemas"), ("fixtures", repo / "test_data/game_assets/contracts/fixtures")]
    for source_name, destination in targets:
      for source in sorted((generated / source_name).rglob("*.json")):
        target = destination / source.relative_to(generated / source_name)
        if not target.exists() or target.read_bytes() != source.read_bytes():
          changed.append(target)
          if not args.check:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
    # Existing documentation links resolve to exact publication snapshots.
    for name in ["anim2d_frames.v1.schema.json", "anim3d_skeleton_map.v1.schema.json"]:
      source = generated / "schemas" / name
      target = repo / "_docs/game-assets/contracts" / name
      if not target.exists() or target.read_bytes() != source.read_bytes():
        changed.append(target)
        if not args.check:
          target.parent.mkdir(parents=True, exist_ok=True)
          target.write_bytes(source.read_bytes())
    for target in changed:
      print(("DRIFT " if args.check else "UPDATED ") + str(target))
    if args.check and changed:
      raise SystemExit(1)
    print("Animation contracts match the authoritative Rust types.")


if __name__ == "__main__":
  main()
