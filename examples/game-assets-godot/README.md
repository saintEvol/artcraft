# game-assets-godot (M0)

Godot 4.7.2 project that loads the M0 game-asset pack fixture
(`test_data/game_assets/samples/pack_minimal`) through Godot's regular
import pipeline. It is the manual-load half of the M0 exit criterion
"existing fixtures load in both engines"; see
`_docs/game-assets/m0_baseline_and_compatibility.md` for the frozen engine
version and `_docs/game-assets/validation/2026-10-22-m0-engine-load.md`
for recorded results.

## Run the headless check

```sh
./sync_fixtures.sh
godot --headless --import --path .          # runs the importers
godot --headless --path . --script res://validation/m0_load_check.gd
```

The script loads the pack's PNG and GLB through the imported resources,
measures the crate mesh AABB (must be 1 x 1 x 1 m per the manifest),
verifies every manifest file hash, and prints `M0_GODOT_LOAD_OK` on
success.

## Manual visual check

Open `validation/m0_visual_check.tscn` in the editor (F6 to run). The scene
shows:

- the pack's 1 m wooden crate next to a translucent 1 m reference box
  (scale check),
- the `arrow_front_z` orientation probe: nose +Z, fin +X, cap +Y
  (accidental rotations are immediately visible),
- the health potion icon as a 2D overlay (transparency check).
