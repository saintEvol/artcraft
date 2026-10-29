class_name GameAssetLodChain
extends RefCounted
## LOD chain selection (plan 13.5: the integration layer provides the
## selection/switching capability; glTF is never assumed to carry LOD
## behavior both engines understand).
##
## Semantics (v1, mirrors the Bevy crate's lod.rs so both engines agree
## on the same pack):
##   * The asset's MAIN scene is the implicit finest level (`-1` here);
##     manifest lod levels are progressively coarser with strictly
##     increasing switch distances (validated at manifest parse).
##   * Hysteresis bands are symmetric around each level's threshold:
##     coarsening onto level i engages only at distance >= d_i + h_i;
##     refining away from level i engages only at distance <= d_i - h_i;
##     between those bands the current level is kept, absorbing the
##     flicker the plan requires the config to prevent. The main scene
##     participates as a normal (finest) state.

## MAIN_LEVEL marks "the main/finest scene" where chain members use
## their manifest level numbers (>= 1 by convention).
const MAIN_LEVEL := -1

var levels: Array = []


static func from_manifest(lod_block: Dictionary) -> GameAssetLodChain:
	var chain := GameAssetLodChain.new()
	for level in lod_block.get("levels", []) as Array:
		if level is Dictionary:
			chain.levels.append({
				"level": int(level.get("level", 0)),
				"switch_distance_m": float(level.get("switch_distance_m", 0.0)),
				"hysteresis_m": float(level.get("hysteresis_m", 0.0)),
				"triangles": int(level.get("triangles", 0)),
				"file_index": int(level.get("file_index", -1)),
			})
	return chain


## Pick the level for a view distance given the currently active level
## (`MAIN_LEVEL` = the main/finest scene). Returns MAIN_LEVEL while the
## main scene remains the right choice.
func select_level(distance_m: float, current: int) -> int:
	var candidate := MAIN_LEVEL
	for level in levels:
		if distance_m >= float(level["switch_distance_m"]):
			candidate = int(level["level"])
	var current_rank := current if current > 0 else 0
	var candidate_rank := candidate if candidate > 0 else 0
	if candidate_rank == current_rank:
		return current
	if candidate_rank > current_rank:
		var target := _find(candidate)
		if target.is_empty():
			return current
		if distance_m >= float(target["switch_distance_m"]) + float(target["hysteresis_m"]):
			return candidate
		return current
	var active := _find(current)
	if active.is_empty():
		return current
	if distance_m <= float(active["switch_distance_m"]) - float(active["hysteresis_m"]):
		return candidate
	return current


func level_entry(level: int) -> Dictionary:
	if level == MAIN_LEVEL:
		return {}
	return _find(level)


func _find(level: int) -> Dictionary:
	for entry in levels:
		if int(entry["level"]) == level:
			return entry
	return {}
