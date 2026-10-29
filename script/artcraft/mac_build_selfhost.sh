#!/usr/bin/env bash
# Build the macOS desktop app for the local ArtCraft backend.
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
frontend_dir="${root_dir}/frontend"
cli_dir="${root_dir}/tmp/desktop-cli"
rust_dir="${root_dir}/crates/desktop/artcraft"

source "${root_dir}/script/common/frontend_preflight.sh"
frontend_preflight "${frontend_dir}"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'This launcher builds a macOS .app.' >&2
  exit 1
fi

if [[ ! -x "${frontend_dir}/node_modules/.bin/nx" ]]; then
  (cd "${frontend_dir}" && npm ci --no-audit --no-fund)
fi
if [[ ! -x "${cli_dir}/node_modules/.bin/tauri" ]]; then
  npm install --prefix "${cli_dir}" --package-lock=false --save-exact \
    @tauri-apps/cli@2.10.0 --no-audit --no-fund
fi

(
  cd "${frontend_dir}"
  VITE_ENVIRONMENT_TYPE=development NX_DAEMON=false NX_ISOLATE_PLUGINS=false \
    npx nx build artcraft --skip-sync
)

export SQLX_OFFLINE=true
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export CARGO_PROFILE_DEV_DEBUG=0
# macOS 27 rejects proc-macro dylibs affected by rustc's debug-info stripping.
export CARGO_PROFILE_DEV_STRIP=none
export LIBCLANG_PATH="${LIBCLANG_PATH:-/Library/Developer/CommandLineTools/usr/lib}"
export TAURI_APP_PATH="${rust_dir}"
export TAURI_FRONTEND_PATH="${frontend_dir}"
cd "${root_dir}"
"${cli_dir}/node_modules/.bin/tauri" build --debug --bundles app \
  --config "${rust_dir}/tauri-selfhost.conf.json"

app_bundle="${root_dir}/target/debug/bundle/macos/ArtCraft.app"
codesign --force --deep --sign - "${app_bundle}"
codesign --verify --deep --strict "${app_bundle}"

echo "Desktop app: ${root_dir}/target/debug/bundle/macos/ArtCraft.app"
echo 'API selection is loaded from ~/Artcraft/settings/env_configs.json.'
