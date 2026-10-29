# game-assets-bevy (M0)

Bevy 0.20.0 example that loads the M0 game-asset pack fixture
(`test_data/game_assets/samples/pack_minimal`) through `AssetServer` with
the frozen engine version. It is the Bevy half of the M0 exit criterion
"existing fixtures load in both engines"; see
`_docs/game-assets/m0_baseline_and_compatibility.md` for the frozen version
matrix and `_docs/game-assets/validation/2026-10-22-m0-engine-load.md` for
recorded results.

The crate deliberately lives outside the desktop workspace (root
`Cargo.toml` `exclude`) with its own lockfile, so the Bevy version cannot
drift via workspace unification.

## Run

```sh
./sync_fixtures.sh
cargo run
```

The app loads the pack's transparent PNG (`Image`) and the GLB scene
(`WorldAsset` + recursive dependencies, spawned via `WorldAssetRoot`),
shows the icon in the UI, and verifies against the pack manifest:

- icon pixel size matches `image.width/height`,
- total mesh triangle count matches `mesh.triangles`,
- mesh position bounds match `measured_dimensions_m` within 1e-5 m,
- the scene is instantiated into the world (`Mesh3d` entities exist) and
  several frames render before the app exits.

It prints `M0_BEVY_LOAD_OK` and exits 0 on success, `M0_BEVY_LOAD_FAILED`
with details and a non-zero exit otherwise.

## Frozen versions

Bevy `=0.20.0` with default features (winit + wgpu/Metal, `bevy_asset`,
`bevy_gltf`, `bevy_scene`, `png`, `bevy_ui`). Rust toolchain 1.97.1. Change
any of these only together with the compatibility record.
