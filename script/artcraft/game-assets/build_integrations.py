#!/usr/bin/env python3
"""Build versioned trusted components; never put executable code in an asset pack."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "frontend/apps/artcraft/app/src/pages/PageGameAssets/integration-bundles"
VERSIONS = {"godot": "0.5.0", "bevy": "0.3.0", "cocos": "0.1.0"}


def verify_versions() -> None:
  """Reject bundles whose runtime reports disagree with the advertised SDK."""
  godot = ROOT / "integrations/godot/game_assets"
  bevy = ROOT / "integrations/bevy/game_assets_bevy"
  cocos = ROOT / "integrations/cocos/game-assets"
  frontend = (ROOT / "frontend/apps/artcraft/app/src/pages/PageGameAssets/integration-components.ts").read_text()
  checks = [
    (godot / "addons/game_assets/engine_report.gd", r'^const COMPONENT_VERSION := "([^"]+)"', "godot"),
    (godot / "addons/game_assets/plugin.cfg", r'^version="([^"]+)"', "godot"),
    (godot / "README.md", r'^# Artcraft Godot 集成 ([^\s]+)', "godot"),
    (bevy / "Cargo.toml", r'^version = "([^"]+)"', "bevy"),
    (bevy / "README.md", r'^# Artcraft Bevy 集成 ([^\s]+)', "bevy"),
    (bevy / "src/install.rs", r'^pub const IMPORTER_VERSION: &str = "game_assets_bevy_1@([^"]+)"', "bevy"),
    (cocos / "src/version.ts", r'^export const COMPONENT_VERSION = "([^"]+)"', "cocos"),
    (cocos / "extension/package.json", r'^  "version": "([^"]+)"', "cocos"),
    (cocos / "README.md", r'^# Artcraft Cocos Creator 集成 ([^\s]+)', "cocos"),
  ]
  for path, pattern, kind in checks:
    match = re.search(pattern, path.read_text(), re.MULTILINE)
    if match is None or match[1] != VERSIONS[kind]:
      raise ValueError(f"Component version mismatch: {path.relative_to(ROOT)} must identify {kind} {VERSIONS[kind]}")
  for kind, version in VERSIONS.items():
    entry = re.search(rf'^  {kind}: .*$', frontend, re.MULTILINE)
    if entry is None or f'version: "{version}"' not in entry[0] or f'artcraft-{kind}-{version}.zip' not in entry[0]:
      raise ValueError(f"Download entry does not identify {kind} {version}")


def build_cocos_extension() -> None:
  """Compile the Cocos extension so the bundle ships the real dist/ artifacts."""
  package = ROOT / "integrations/cocos/game-assets"
  subprocess.run(["npm", "install", "--no-audit", "--no-fund", "--prefix", str(package)], check=True)
  subprocess.run(["npm", "run", "build", "--prefix", str(package)], check=True)


def build(kind: str, files: list[tuple[Path, str]], engine_version: str) -> dict:
  version = VERSIONS[kind]
  target = OUTPUT / f"artcraft-{kind}-{version}.zip"
  prefix = f"artcraft-{kind}-{version}/"
  descriptor = {"component_version": version, "engine": kind, "engine_version": engine_version, "report_contract": "game-assets-engine-report.v1"}
  payloads = [(name, source.read_bytes()) for source, name in files]
  payloads.extend((name, (ROOT / name).read_bytes()) for name in ["LICENSE-MIT", "LICENSE-APACHE"])
  payloads.append(("component.json", (json.dumps(descriptor, indent=2) + "\n").encode()))
  with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, data in sorted(payloads):
      info = zipfile.ZipInfo(prefix + name, (2026, 10, 27, 0, 0, 0))
      info.external_attr = 0o100644 << 16
      info.compress_type = zipfile.ZIP_DEFLATED
      archive.writestr(info, data)
  return {**descriptor, "file": target.name, "bytes": target.stat().st_size, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}


def main() -> None:
  verify_versions()
  OUTPUT.mkdir(parents=True, exist_ok=True)
  godot = ROOT / "integrations/godot/game_assets"
  godot_files = [(path, path.relative_to(godot).as_posix()) for path in godot.rglob("*") if path.is_file() and (path.suffix in [".gd", ".tscn"] or path.name in ["plugin.cfg", "project.godot", "export_presets.cfg", "README.md"]) and ".godot" not in path.parts]
  bevy = ROOT / "integrations/bevy/game_assets_bevy"
  required = ["Cargo.toml", "Cargo.lock", "README.md", "examples/import_pack.rs", "examples/preview_pack.rs"]
  bevy_files = [(bevy / name, "game_assets_bevy/" + name) for name in required]
  bevy_files.extend((path, "game_assets_bevy/" + path.relative_to(bevy).as_posix()) for path in (bevy / "src").rglob("*.rs"))
  bevy_files.extend((path, "game_assets_bevy/" + path.relative_to(bevy).as_posix()) for path in (bevy / "assets/fonts").iterdir() if path.is_file())
  build_cocos_extension()
  cocos = ROOT / "integrations/cocos/game-assets"
  # The extension/ directory is the drop-in unit: extract and copy into a
  # Cocos project's extensions/ folder as-is.
  cocos_extension = cocos / "extension"
  cocos_files = [(path, path.relative_to(cocos_extension).as_posix()) for path in cocos_extension.rglob("*") if path.is_file()]
  cocos_files.append((cocos / "README.md", "README.md"))
  records = [build("godot", godot_files, "4.7.2"), build("bevy", bevy_files, "0.20.0"), build("cocos", cocos_files, "3.8.8")]
  (OUTPUT / "components.json").write_text(json.dumps(records, indent=2) + "\n")
  for record in records:
    print(record["file"], record["bytes"], record["sha256"])


if __name__ == "__main__":
  main()
