#!/usr/bin/env bash
# Copy the M0 fixtures from the shared test_data location into this Godot
# project so the editor's regular import pipeline processes them. Run from
# anywhere; paths resolve relative to this script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
src="$repo_root/test_data/game_assets/samples"

# Only the fixture copies live here; the addon-managed namespace
# (game_assets/game_assets_m0/ + import_journal.json) must survive.
rm -rf "$here/game_assets/pack_minimal" "$here/game_assets/samples_3d"
mkdir -p "$here/game_assets/pack_minimal"
cp -R "$src/pack_minimal/." "$here/game_assets/pack_minimal/"
# The orientation probe model is loaded by the visual check scene.
mkdir -p "$here/game_assets/samples_3d"
cp "$src/3d/arrow_front_z.glb" "$here/game_assets/samples_3d/"

echo "synced M0 fixtures into $here/game_assets"
