extends SceneTree

# M6 addon logic check (GA-017), headless: LOD manifest validation
# (accept/reject mirrors the Bevy parser), LOD chain selection with
# hysteresis, and box-collision physics node generation. Run with:
#   godot --headless --path examples/game-assets-godot \
#     --script res://validation/m6_addon_check.gd
# Exit code 0 prints M6_GODOT_ADDON_OK.

const Journal := preload("res://addons/game_assets/journal.gd")
const Manifest := preload("res://addons/game_assets/manifest.gd")
const LodChain := preload("res://addons/game_assets/lod.gd")
const CollisionBuilder := preload("res://addons/game_assets/collision.gd")

var failures: Array[String] = []
# Completion guards (m0 pattern, flags set at each section's LAST
# statement): a runtime error aborts only the callee on 4.7.2, so a
# mid-section abort leaves the flag unset and the run goes red — the
# exact false-green this check once shipped with.
var sections_completed: Dictionary = {}


func _init() -> void:
	_check_lod_manifest_validation()
	_check_lod_selection()
	_check_collision_nodes()
	_check_update_plan()
	_finish()


func _completed(section: String) -> void:
	sections_completed[section] = true


func _check_lod_manifest_validation() -> void:
	var base := _base_manifest()
	var good: Dictionary = base
	good["assets"] = [_prop_asset({
		"levels": [
			{"level": 1, "file_index": 1, "scene_index": 0, "triangles": 8, "switch_distance_m": 10.0, "hysteresis_m": 1.0},
			{"level": 2, "file_index": 1, "scene_index": 0, "triangles": 4, "switch_distance_m": 25.0, "hysteresis_m": 2.0},
		],
	})]
	if not _manifest_ok(good):
		failures.append("valid lod chain rejected")

	var out_of_range: Dictionary = base
	out_of_range["assets"] = [_prop_asset({
		"levels": [
			{"level": 1, "file_index": 9, "scene_index": 0, "triangles": 8, "switch_distance_m": 10.0, "hysteresis_m": 1.0},
		],
	})]
	if _manifest_ok(out_of_range):
		failures.append("lod file_index out of range accepted")

	var descending: Dictionary = base
	descending["assets"] = [_prop_asset({
		"levels": [
			{"level": 2, "file_index": 1, "scene_index": 0, "triangles": 4, "switch_distance_m": 25.0, "hysteresis_m": 1.0},
			{"level": 1, "file_index": 1, "scene_index": 0, "triangles": 8, "switch_distance_m": 10.0, "hysteresis_m": 1.0},
		],
	})]
	if _manifest_ok(descending):
		failures.append("descending lod levels accepted")

	var flat_distances: Dictionary = base
	flat_distances["assets"] = [_prop_asset({
		"levels": [
			{"level": 1, "file_index": 1, "scene_index": 0, "triangles": 8, "switch_distance_m": 10.0, "hysteresis_m": 1.0},
			{"level": 2, "file_index": 1, "scene_index": 0, "triangles": 4, "switch_distance_m": 10.0, "hysteresis_m": 1.0},
		],
	})]
	if _manifest_ok(flat_distances):
		failures.append("non-increasing switch distances accepted")

	var empty_block: Dictionary = base
	empty_block["assets"] = [_prop_asset({"levels": []})]
	if _manifest_ok(empty_block):
		failures.append("empty lod block accepted")

	var level_zero: Dictionary = base
	level_zero["assets"] = [_prop_asset({
		"levels": [
			{"level": 0, "file_index": 1, "scene_index": 0, "triangles": 8, "switch_distance_m": 10.0, "hysteresis_m": 1.0},
		],
	})]
	if _manifest_ok(level_zero):
		failures.append("lod level 0 accepted (main is the implicit finest level)")

	var sticky: Dictionary = base
	sticky["assets"] = [_prop_asset({
		"levels": [
			{"level": 1, "file_index": 1, "scene_index": 0, "triangles": 8, "switch_distance_m": 10.0, "hysteresis_m": 11.0},
		],
	})]
	if _manifest_ok(sticky):
		failures.append("hysteresis wider than the switch distance accepted")
	_completed("_check_lod_manifest_validation")  # last statement: a mid-fn abort leaves it unset


func _check_lod_selection() -> void:
	var chain := LodChain.from_manifest({
		"levels": [
			{"level": 1, "file_index": 1, "triangles": 8, "switch_distance_m": 10.0, "hysteresis_m": 2.0},
			{"level": 2, "file_index": 1, "triangles": 4, "switch_distance_m": 25.0, "hysteresis_m": 5.0},
		],
	})
	var main := LodChain.MAIN_LEVEL
	if chain.select_level(5.0, main) != main:
		failures.append("near distance should keep the main scene")
	if chain.select_level(11.0, main) != main:
		failures.append("inside level-1 band should keep main (hysteresis)")
	if chain.select_level(12.0, main) != 1:
		failures.append("past level-1 band should coarsen to 1")
	if chain.select_level(29.9, 1) != 1:
		failures.append("inside level-2 band should stay on 1")
	if chain.select_level(30.0, 1) != 2:
		failures.append("past level-2 band should coarsen to 2")
	if chain.select_level(9.0, 1) != 1:
		failures.append("refining needs the inner band (9 > 10-2)")
	if chain.select_level(8.0, 1) != main:
		failures.append("inside the inner band should refine to main")
	_completed("_check_lod_selection")  # last statement: a mid-fn abort leaves it unset


func _check_collision_nodes() -> void:
	var errors := PackedStringArray()
	var none_nodes: Variant = CollisionBuilder.build(_mesh_with_collision({"kind": "none", "unit": "meter"}), errors)
	if none_nodes.is_empty() and errors.is_empty():
		pass
	else:
		failures.append("kind none should produce no nodes and no errors")

	var box_nodes: Variant = CollisionBuilder.build(_mesh_with_collision({
		"kind": "box",
		"center": [0.0, 0.5, 0.0],
		"half_extents": [0.5, 0.5, 0.5],
		"unit": "meter",
	}), errors)
	if box_nodes.size() != 1 or not (box_nodes[0] is StaticBody3D):
		failures.append("box collision should build one StaticBody3D")
	else:
		var body: StaticBody3D = box_nodes[0]
		var shape_node: CollisionShape3D = body.get_child(0)
		var shape: BoxShape3D = shape_node.shape
		if not shape.size.is_equal_approx(Vector3(1.0, 1.0, 1.0)):
			failures.append("box shape size should be half_extents*2")
		if not shape_node.position.is_equal_approx(Vector3(0.0, 0.5, 0.0)):
			failures.append("collision shape should sit at the manifest center")
		body.free()

	var unsupported: Variant = CollisionBuilder.build(_mesh_with_collision({"kind": "capsule"}), errors)
	if unsupported != null:
		failures.append("unsupported collision shape must fail explicitly (null)")
	if errors.is_empty() or not String(errors[errors.size() - 1]).contains("none and box"):
		failures.append("unsupported shape error should name the supported set")

	# Malformed typed inputs honor the null+errors contract (no crash).
	var wrong_typed: Variant = CollisionBuilder.build(_mesh_with_collision({"kind": "box", "center": "0,0,0"}), errors)
	if wrong_typed != null:
		failures.append("string-typed center must fail explicitly (null)")

	var degenerate: Variant = CollisionBuilder.build(_mesh_with_collision({
		"kind": "box", "center": [0.0, 0.0, 0.0], "half_extents": [0.5, 0.0, 0.5],
	}), errors)
	if degenerate != null:
		failures.append("degenerate box (zero half extent) must fail")
	_completed("_check_collision_nodes")  # last statement: a mid-fn abort leaves it unset


func _check_update_plan() -> void:
	# Update-conflict diff (plan 14.4, GA-018): manually modified managed
	# files must surface as conflicts; assets absent from the incoming
	# pack are "missing" and NEVER deleted.
	var journal := Journal.new()
	journal.entries = {
		"kept_asset": {"stable_key": "kept_asset", "version_id": "v1", "files": [
			{"role": "main", "path": "assets/props/kept/main.glb", "sha256": "a".repeat(64)},
		]},
		"removed_asset": {"stable_key": "removed_asset", "version_id": "v1", "files": [
			{"role": "main", "path": "assets/props/removed/main.glb", "sha256": "b".repeat(64)},
		]},
	}
	var incoming: Array = [
		{"stable_key": "kept_asset", "asset_id": "kept", "version_id": "v1", "files": [
			{"role": "main", "path": "assets/props/kept/main.glb", "sha256": "a".repeat(64)},
		]},
	]
	# scratch managed root with a MODIFIED kept file (hash drift vs journal)
	var root := OS.get_user_data_dir().path_join("m6_plan_root")
	DirAccess.make_dir_recursive_absolute(root.path_join("assets/props/kept"))
	var modified := FileAccess.open(root.path_join("assets/props/kept/main.glb"), FileAccess.WRITE)
	if modified == null:
		failures.append("scratch root unwritable; update-plan section cannot run")
		return
	modified.store_string("manually edited content")
	modified.close()
	# The removed asset's file EXISTS on disk but is absent from the
	# incoming pack: a future importer that deletes missing assets must
	# trip this tripwire.
	DirAccess.make_dir_recursive_absolute(root.path_join("assets/props/removed"))
	var removed_file := FileAccess.open(root.path_join("assets/props/removed/main.glb"), FileAccess.WRITE)
	if removed_file != null:
		removed_file.store_string("old content")
		removed_file.close()
	var plan: Dictionary = journal.plan_update(incoming, root)
	if not (plan["missing"] as Array).has("removed_asset"):
		failures.append("absent asset should be planned as missing (never deleted)")
	if (plan["new"] as Array).has("kept_asset") or (plan["updated"] as Array).has("kept_asset"):
		failures.append("unchanged asset misclassified")
	if not (plan["conflicts"] as Array).has("kept_asset"):
		failures.append("manually modified managed file must surface as a conflict")
	if not FileAccess.file_exists(root.path_join("assets/props/removed/main.glb")):
		failures.append("missing asset's file must NOT be deleted by planning alone (plan 14.4)")
	DirAccess.remove_absolute(root.path_join("assets/props/kept/main.glb"))
	DirAccess.remove_absolute(root.path_join("assets/props/removed/main.glb"))
	DirAccess.remove_absolute(root.path_join("assets/props/removed"))
	DirAccess.remove_absolute(root.path_join("assets/props/kept"))
	DirAccess.remove_absolute(root.path_join("assets/props"))
	DirAccess.remove_absolute(root.path_join("assets"))
	DirAccess.remove_absolute(root)
	_completed("_check_update_plan")  # last statement: a mid-fn abort leaves it unset


func _manifest_ok(data: Dictionary) -> bool:
	## Round-trip through the real load_from_file pipeline (temp JSON
	## under user://) instead of poking private validators.
	var path := "user://m6_check_manifest.json"
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		failures.append("cannot write temp manifest")
		return false
	file.store_string(JSON.stringify(data))
	file.close()
	var manifest := Manifest.new()
	return manifest.load_from_file(path)


func _base_manifest() -> Dictionary:
	# Fresh dictionary per call: assignments to ["assets"] must never
	# alias a shared base (GDScript dictionaries are reference types).
	return _base_manifest_template().duplicate(true)

func _base_manifest_template() -> Dictionary:
	return {
		"schema_version": "1.0",
		"pack_id": "pk1",
		"project_id": "proj1",
		"export_id": "ex1",
		"generated_at": "2026-10-23T00:00:00Z",
		"engine_profiles": [{"id": "p1", "engine": "godot", "engine_version": "4.7.2", "renderer_backend": "forward_plus", "importer_version": "1", "coordinate_conversion": "y-up", "required_features": [], "validation_status": "verified"}],
		"assets": [],
	}


func _prop_asset(lod_block: Dictionary) -> Dictionary:
	return {
		"asset_id": "a1",
		"stable_key": "crate",
		"version_id": "v1",
		"kind": "prop_3d",
		"files": [
			{"role": "main", "path": "models/crate.glb", "sha256": "b".repeat(64), "byte_length": 10},
			{"role": "lod", "path": "models/crate_lod1.glb", "sha256": "c".repeat(64), "byte_length": 10},
		],
		"mesh": {
			"scene_index": 0,
			"unit": "meter",
			"up_axis": "+Y",
			"visual_forward": "+Z",
			"origin": "bottom_center",
			"measured_dimensions_m": {"x": 1, "y": 1, "z": 1},
			"triangles": 12,
			"material_workflow": "gltf_metallic_roughness",
			"collision": {"kind": "none", "unit": "meter"},
			"lod": lod_block,
		},
	}


func _mesh_with_collision(collision: Dictionary) -> Dictionary:
	return {"scene_index": 0, "collision": collision}


func _finish() -> void:
	var expected := ["_check_lod_manifest_validation", "_check_lod_selection", "_check_collision_nodes", "_check_update_plan"]
	for section in expected:
		if not sections_completed.get(section, false):
			failures.append("section %s aborted before completion (runtime error swallowed)" % section)
	if failures.is_empty():
		print("M6_GODOT_ADDON_OK lod validation + selection + collision nodes")
		quit(0)
	else:
		for failure in failures:
			printerr("M6 FAIL: %s" % failure)
		quit(1)
