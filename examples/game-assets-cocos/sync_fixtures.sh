#!/usr/bin/env bash
# Sync the compiled artcraft extension and the pack_v2_minimal fixture into
# this Cocos Creator project. Run from anywhere; paths resolve relative to
# this script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
integration="$repo_root/integrations/cocos/game-assets"

# The extension ships compiled dist/ artifacts; build them first when missing.
if [ ! -f "$integration/extension/dist/extension/main.js" ]; then
  (cd "$integration" && npm install && npm run build)
fi

rm -rf "$here/extensions/artcraft-game-assets"
mkdir -p "$here/extensions"
cp -R "$integration/extension" "$here/extensions/artcraft-game-assets"

# Only the fixture copy lives here; the extension-managed namespace
# (assets/game_assets/pack_v2_minimal_v1/ + import_journal.json) is created by
# the import and must survive re-runs of this script.
rm -rf "$here/assets/game_assets/pack_v2_minimal"
mkdir -p "$here/assets/game_assets/pack_v2_minimal"
cp -R "$repo_root/test_data/game_assets/pack_v2_minimal/." "$here/assets/game_assets/pack_v2_minimal/"

echo "synced artcraft extension + pack_v2_minimal into $here"
