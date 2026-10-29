#!/usr/bin/env bash
# Copy the M0 fixtures from the shared test_data location into this Bevy
# example's asset root. Run from anywhere; paths resolve relative to this
# script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
src="$repo_root/test_data/game_assets/samples"

rm -rf "$here/assets/game_assets"
mkdir -p "$here/assets/game_assets"
cp -R "$src/pack_minimal" "$here/assets/game_assets/"

echo "synced M0 fixtures into $here/assets/game_assets"
