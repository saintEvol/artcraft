extends SceneTree
## Manifest 2.0 consumer regression: dual-version parsing, journal v2,
## install graph, 2D playback resources and 3D binding. Run headless in the
## isolated scratch project prepared by test_godot_manifest_v2.py.

const Manifest := preload("res://addons/game_assets/manifest.gd")
const Journal := preload("res://addons/game_assets/journal.gd")
const InstallGraph := preload("res://addons/game_assets/install_graph.gd")
const Animation2D := preload("res://addons/game_assets/animation_2d_resources.gd")
const Binding := preload("res://addons/game_assets/animation_binding.gd")
const Importer := preload("res://addons/game_assets/importer.gd")
const Builder := preload("res://addons/game_assets/resource_builder.gd")

var failures: Array[String] = []

func _init() -> void:
	call_deferred("_run")

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 2:
		push_error("usage: -- <packs dir> <fixtures dir>")
		quit(2)
		return
	var packs := args[0]
	_test_manifest_parsing(packs, "res://fixtures_manifest_v2")
	_test_journal(packs)
	_test_install_graph(packs)
	_test_animation_2d()
	_test_animation_binding(packs)
	_test_full_lifecycle(packs)
	_test_update_scenarios(packs)
	_finish()

func _check(ok: bool, message: String) -> void:
	if not ok: failures.append(message)
	print("PASS " if ok else "FAIL ", message)

func _finish() -> void:
	for failure in failures: push_error(failure)
	if failures.is_empty(): print("ARTCRAFT_MANIFEST_V2_OK")
	quit(0 if failures.is_empty() else 1)

func _load_manifest(path: String):
	var manifest := Manifest.new()
	manifest.load_from_file(path)
	return manifest

func _expect_problem(manifest, token: String, label: String) -> void:
	var found := false
	for problem in manifest.problems:
		if String(problem).contains(token):
			found = true
			break
	_check(found, label)

# --- mutations of the valid pack manifest; each must fail with its rule ---

func _mutate_stage(m: Dictionary) -> void:
	m.assets[0].stage = "asset"

func _mutate_ordinal(m: Dictionary) -> void:
	m.assets[0].files[0].ordinal = 1

func _mutate_missing_frames(m: Dictionary) -> void:
	m.assets[1].files.remove_at(1)

func _mutate_unsafe_path(m: Dictionary) -> void:
	m.assets[3].files[0].path = "../escape.png"

func _mutate_dependency_hash(m: Dictionary) -> void:
	m.assets[2].dependencies[0].rig_main_sha256 = "f" + String(m.assets[2].dependencies[0].rig_main_sha256).substr(1)

func _mutate_gltf_for_2d(m: Dictionary) -> void:
	m.assets[1].files[0].mime = "model/gltf-binary"

func _mutate_unknown_field(m: Dictionary) -> void:
	m.assets[0].delivery_note = "private"

func _mutate_bad_scale(m: Dictionary) -> void:
	for profile in m.engine_profiles:
		if profile.engine == "godot":
			profile.animation_2d_world_unit_scale = 50.0

func _mutate_unsupported_feature(m: Dictionary) -> void:
	for profile in m.engine_profiles:
		if profile.engine == "godot":
			profile.required_features = ["game.unknown.feature.v1"]

func _mutate_no_godot(m: Dictionary) -> void:
	var remaining: Array = []
	for profile in m.engine_profiles:
		if profile.engine != "godot":
			remaining.append(profile)
	m.engine_profiles = remaining

func _mutate_wrong_version(m: Dictionary) -> void:
	m.schema_version = "2.1"

func _test_manifest_parsing(packs: String, fixtures: String) -> void:
	print("--- manifest parsing")
	var valid = _load_manifest(packs + "/pack_v2/manifest.json")
	_check(valid.problems.is_empty(), "2.0 pack with godot profile parses: %s" % "; ".join(valid.problems))
	var verdicts := {
		"valid_all_kinds.json": true,
		"invalid_intermediate_stage.json": false,
		"invalid_missing_frames.json": false,
		"invalid_missing_rig_dependency.json": false,
		"invalid_null_metadata.json": false,
		"invalid_private_source.json": false,
		"invalid_reserved_path.json": false,
		"invalid_sidecar_reference.json": false,
		"invalid_unknown_rig_field.json": false,
	}
	var tokens := {
		"invalid_intermediate_stage.json": "kind_metadata_mismatch",
		"invalid_missing_frames.json": "invalid_frames_reference",
		"invalid_missing_rig_dependency.json": "exactly_one_rig_required",
		"invalid_null_metadata.json": "kind_metadata_mismatch",
		"invalid_private_source.json": "private_or_unsupported_delivery_file",
		"invalid_reserved_path.json": "invalid_file_identity",
		"invalid_sidecar_reference.json": "invalid_skeleton_map_reference",
		"invalid_unknown_rig_field.json": "invalid_rig_metadata",
	}
	var directory := DirAccess.open(fixtures)
	for name in directory.get_files():
		if not name.ends_with(".json"): continue
		var manifest = _load_manifest(fixtures + "/" + name)
		var expected: Variant = verdicts.get(name, null)
		if expected == null:
			_check(false, "fixture %s has no expected verdict" % name)
			continue
		if expected:
			_check(manifest.problems.is_empty(), "fixture %s is valid: %s" % [name, "; ".join(manifest.problems)])
		else:
			_check(not manifest.problems.is_empty(), "fixture %s is rejected" % name)
			if tokens.has(name):
				_expect_problem(manifest, tokens[name], "fixture %s reports %s" % [name, tokens[name]])

	var mutations := {
		"stage": ["_mutate_stage", "kind_metadata_mismatch"],
		"ordinal": ["_mutate_ordinal", "invalid_file_ordinal"],
		"missing_frames": ["_mutate_missing_frames", "invalid_frames_reference"],
		"unsafe_path": ["_mutate_unsafe_path", "invalid_file_identity"],
		"dependency_hash": ["_mutate_dependency_hash", "dependency_changed"],
		"gltf_for_2d": ["_mutate_gltf_for_2d", "main_mime_mismatch"],
		"unknown_field": ["_mutate_unknown_field", "unknown field"],
		"bad_scale": ["_mutate_bad_scale", "godot_animation_world_unit_conversion_required"],
		"unsupported_feature": ["_mutate_unsupported_feature", "尚不支持"],
		"no_godot": ["_mutate_no_godot", "no godot engine_profile"],
		"wrong_version": ["_mutate_wrong_version", "unsupported manifest schema_version"],
	}
	var original_text := FileAccess.get_file_as_string(packs + "/pack_v2/manifest.json")
	for case in mutations:
		var document: Dictionary = JSON.parse_string(original_text)
		Callable(self, mutations[case][0]).call(document)
		var scratch := "res://mutation_%s.json" % case
		var file := FileAccess.open(scratch, FileAccess.WRITE)
		file.store_string(JSON.stringify(document))
		file.close()
		var manifest = _load_manifest(scratch)
		_check(not manifest.problems.is_empty(), "mutation %s is rejected" % case)
		_expect_problem(manifest, mutations[case][1], "mutation %s reports %s" % [case, mutations[case][1]])
		DirAccess.remove_absolute(scratch)

func _test_journal(packs: String) -> void:
	print("--- journal v2")
	var manifest = _load_manifest(packs + "/pack_v2/manifest.json")
	var journal := Journal.new()
	for asset in manifest.assets:
		journal.record(asset)
	var hero: Dictionary = journal.entries.get("hero", {})
	_check(String(hero.get("stage", "")) == "rigged" and String(hero.get("main_sha256", "")) == String((hero.get("files", []) as Array)[0].get("sha256", "")), "hero entry records stage and verified main hash")
	var clip: Dictionary = journal.entries.get("walk_3d", {})
	_check((clip.get("dependencies", []) as Array).size() == 1 and String((clip.get("dependencies", []) as Array)[0].get("rig_main_sha256", "")) == String(hero.get("main_sha256", "")), "clip entry records its rig dependency")
	DirAccess.make_dir_recursive_absolute("res://journal_case/qa")
	_check(journal.save("journal_case/qa"), "journal v2 saves")
	var reloaded := Journal.new()
	_check(reloaded.load_from("journal_case/qa"), "journal v2 reloads with matching install_state_hash")
	_check(reloaded.install_state_hash() == journal.install_state_hash() and journal.install_state_hash().length() == 64, "install_state_hash is deterministic")
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://game_assets/journal_case/qa/import_journal.json"))
	_check(int(document.get("version", 0)) == 2 and not String(document.get("install_state_hash", "")).is_empty(), "saved journal carries version 2 and its state hash")

	var truncation := FileAccess.open("res://game_assets/journal_case/qa/import_journal.json", FileAccess.WRITE)
	truncation.store_string(JSON.stringify(document).substr(0, 40))
	truncation.close()
	var broken := Journal.new()
	_check(not broken.load_from("journal_case/qa"), "truncated journal is rejected")

	_write_journal("journal_case/qa", {"version": 9, "entries": {}, "generated_files": []})
	var unknown := Journal.new()
	_check(not unknown.load_from("journal_case/qa"), "unknown journal version stops updates")

	_write_journal("journal_case/qa", {
		"version": 1,
		"entries": {"hud_icon": {"stable_key": "hud_icon", "display_name": "HUD icon", "kind": "icon_2d", "version_id": "icon_v0", "files": [{"role": "main", "path": "assets/icons/hud_icon/main.png", "sha256": "a".repeat(64)}]}},
		"generated_files": [],
	})
	var upgrading := Journal.new()
	_check(upgrading.load_from("journal_case/qa"), "legacy v1 journal still reads")
	_check(upgrading.save("journal_case/qa"), "legacy journal upgrades on save")
	var upgraded: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://game_assets/journal_case/qa/import_journal.json"))
	_check(int(upgraded.get("version", 0)) == 2, "upgraded journal is version 2")
	var verified := Journal.new()
	_check(verified.load_from("journal_case/qa"), "upgraded journal passes its own state hash")

	var tampered: Dictionary = upgraded.duplicate(true)
	tampered.entries.hud_icon.version_id = "icon_tampered"
	_write_journal("journal_case/qa", tampered)
	var drifting := Journal.new()
	_check(not drifting.load_from("journal_case/qa"), "hand-edited journal fails install_state_hash verification")

func _write_journal(for_namespace: String, document: Dictionary) -> void:
	var path := "res://game_assets/" + for_namespace + "/import_journal.json"
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(document))
	file.close()

func _test_install_graph(packs: String) -> void:
	print("--- install graph")
	var manifest = _load_manifest(packs + "/pack_sync/manifest.json")
	var graph := InstallGraph.new()
	var state := graph.build({}, manifest.assets, "res://graph_case/fresh", packs + "/pack_sync")
	_check(state.ok, "fresh self-contained pack closes its graph: %s" % "; ".join(graph.problems))
	_check((state.entries as Dictionary).has("hero") and (state.entries as Dictionary).has("walk_3d"), "final graph contains retained plus incoming assets")

	var retained := Journal.new()
	var rig_only = _load_manifest(packs + "/pack_rig_only/manifest.json")
	var stale = _load_manifest(packs + "/pack_v2/manifest.json")
	for asset in stale.assets:
		if String(asset.kind) == "anim_3d":
			retained.record(asset)
	_check(not graph.build(retained.entries, rig_only.assets, "res://graph_case/retained", packs + "/pack_rig_only").ok, "replacing the rig while keeping its clips is rejected")
	_check(graph.build(retained.entries, manifest.assets, "res://graph_case/retained", packs + "/pack_sync").ok, "synchronized rig + clip update closes the graph")

	var conflicting: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(packs + "/pack_sync/manifest.json"))
	for asset in conflicting.assets:
		if String(asset.asset_id) == "walk_3d":
			asset.dependencies[0].version_id = "rig_v1"
	_write_raw("res://graph_case/conflict_manifest.json", JSON.stringify(conflicting))
	var conflict_manifest = _load_manifest("res://graph_case/conflict_manifest.json")
	_check(not conflict_manifest.problems.is_empty(), "clip bound to the older rig version is rejected at manifest level")
	_expect_problem(conflict_manifest, "dependency_changed", "version mismatch reports dependency_changed")

	# Retained rig bytes must still match the recorded hash.
	var hero_files: Array = []
	for asset in stale.assets:
		if String(asset.asset_id) == "hero":
			hero_files = asset.files
	DirAccess.make_dir_recursive_absolute("res://graph_case/drift/assets/characters/hero")
	DirAccess.copy_absolute(packs + "/pack_v2/" + String(hero_files[0].path), "res://graph_case/drift/" + String(hero_files[0].path))
	var with_clip := Journal.new()
	for asset in stale.assets:
		with_clip.record(asset)
	var reader := FileAccess.open("res://graph_case/drift/" + String(hero_files[0].path), FileAccess.READ)
	var trimmed := reader.get_buffer(reader.get_length() - 1)
	reader.close()
	var writer := FileAccess.open("res://graph_case/drift/" + String(hero_files[0].path), FileAccess.WRITE)
	writer.store_buffer(trimmed)
	writer.close()
	var incoming_2d: Array = []
	for asset in stale.assets:
		if String(asset.kind) == "anim_2d":
			incoming_2d.append(asset)
	var drift_graph := InstallGraph.new()
	_check(not drift_graph.build(with_clip.entries, incoming_2d, "res://graph_case/drift", packs + "/pack_v2").ok, "retained rig with drifted bytes fails the graph")

func _write_raw(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file != null:
		file.store_string(text)
		file.close()

func _test_animation_2d() -> void:
	print("--- animation 2d")
	var errors := PackedStringArray()
	var table := Animation2D.parse_frames(FileAccess.get_file_as_string("res://fixtures_frames/valid_fixed_canvas.json"), errors)
	_check(not table.is_empty(), "valid frames fixture parses: %s" % "; ".join(errors))
	errors = PackedStringArray()
	_check(Animation2D.parse_frames(FileAccess.get_file_as_string("res://fixtures_frames/invalid_direction_order.json"), errors).is_empty(), "direction order violation is rejected")
	errors = PackedStringArray()
	_check(Animation2D.parse_frames(FileAccess.get_file_as_string("res://fixtures_frames/invalid_extra_field.json"), errors).is_empty(), "unknown frames field is rejected")
	errors = PackedStringArray()
	var delivered: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://packs/pack_v2/assets/animations_2d/walk/frames.json"))
	table = Animation2D.parse_frames(JSON.stringify(delivered), errors)
	_check(not table.is_empty(), "delivered 4-direction frames table parses: %s" % "; ".join(errors))

	# Playback index parity with animation_2d.rs::frame_at.
	_check(Animation2D.frame_index_at(0.5, 8.0, 4, true) == 0, "frame_at(0.5, 8, 4, loop) == 0")
	_check(Animation2D.frame_index_at(100.0, 8.0, 4, false) == 3, "one-shot clamps at the last frame")
	_check(Animation2D.frame_index_at(1.9, 8.0, 4, true) == 3, "looping wraps by phase")
	_check(Animation2D.frame_index_at(0.3, 8.0, 4, true) == 2, "floor(t*fps) selects the frame")
	_check(Animation2D.frame_index_at(-1.0, 8.0, 4, true) == -1, "negative time is unrepresentable")
	_check(Animation2D.frame_index_at(0.0, 8.0, 4, false) == 0, "t=0 selects frame 0")

	var offset := Animation2D.anchor_offset({"x": 0.2, "y": 0.9}, {"width": 2, "height": 2})
	_check(absf(offset.x - 0.6) < 0.0001 and absf(offset.y + 0.8) < 0.0001, "anchor offset places the anchor on the node origin")
	var scale := Animation2D.world_scale(50.0)
	_check(absf(scale.x - 2.0) < 0.0001 and absf(scale.y - 2.0) < 0.0001, "world scale is 100 / pixels_per_world_unit")

func _test_animation_binding(packs: String) -> void:
	print("--- animation binding")
	var errors := PackedStringArray()
	var skeleton_map := Binding.parse_skeleton_map(FileAccess.get_file_as_string("res://fixtures_skeleton/valid_engineering_shape.json"), errors)
	_check(not skeleton_map.is_empty(), "valid skeleton map fixture parses: %s" % "; ".join(errors))
	errors = PackedStringArray()
	_check(Binding.parse_skeleton_map(FileAccess.get_file_as_string("res://fixtures_skeleton/invalid_root_motion.json"), errors).is_empty(), "non in_place root motion is rejected")

	var binder := Binding.new()
	var binding := binder.build_node_map(packs + "/pack_v2/assets/characters/hero/main.glb", "Model")
	_check(binder.problems.is_empty() and not binding.is_empty(), "node map builds from the rigged GLB: %s" % "; ".join(binder.problems))
	var paths: Dictionary = binding.get("paths", {})
	_check(paths.has("Hero") and paths.has("Hero/Hip"), "binding covers every glTF node path")
	var hero_entry: Dictionary = paths.get("Hero", {})
	var hip_entry: Dictionary = paths.get("Hero/Hip", {})
	_check(bool(hero_entry.get("is_joint", false)) and String(hero_entry.get("bone", "")) == "Hero" and String(hero_entry.get("node_path", "")) == "Model/Skeleton3D", "motion root maps to a Skeleton3D bone")
	_check(bool(hip_entry.get("is_joint", false)) and int(hip_entry.get("bone_index", -1)) == 1, "child joint maps to its bone index from GLTFState")
	var hip_rest: Dictionary = hip_entry.get("rest", {})
	_check(absf(float((hip_rest.get("position", []) as Array)[1]) - 1.0) < 0.0001, "joint rest translation recorded from the skeleton")

	var walk_map: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(packs + "/pack_v2/assets/animations_3d/walk/skeleton_map.json"))
	var parsed_map := Binding.parse_skeleton_map(JSON.stringify(walk_map), errors)
	_check(binder.verify_contract_mapping(binding, parsed_map), "every skeleton map path resolves through the binding")
	var built := binder.build_animation_library(packs + "/pack_v2/assets/animations_3d/walk/main.glb", binding, parsed_map, ["Hero"])
	_check(binder.problems.is_empty() and not built.is_empty(), "clip retargets into an AnimationLibrary: %s" % "; ".join(binder.problems))
	if built.is_empty():
		return
	var library: AnimationLibrary = built["library"]
	var animation: Animation = library.get_animation(String(built["clip"]))
	_check(animation != null, "library carries the contract clip name")
	if animation == null:
		return
	var bone_tracks := 0
	var bone_path_ok := true
	for track in animation.get_track_count():
		if String(animation.track_get_path(track)) != "Model/Skeleton3D:Hip":
			bone_path_ok = false
		bone_tracks += 1
	_check(bone_tracks > 0 and bone_path_ok, "retargeted tracks address the rig skeleton bone")
	_check(animation.track_get_key_count(0) >= 2, "baked keys survive retargeting")
	var first: Variant = animation.track_get_key_value(0, 0)
	_check(first is Quaternion and absf((first as Quaternion).w - 1.0) < 0.001, "first rotation key is the rest identity")
	_check(String(library.get_meta("artcraft_coordinate_conversion", "")) == "y_up_z_forward_passthrough", "library records the coordinate conversion")
	_check(not String(library.get_meta("artcraft_importer_version", "")).is_empty(), "library records the importer version")

func _import_and_build(pack_dir: String, decision: String = "cancel") -> Object:
	var importer := Importer.new()
	if not importer.import_pack(pack_dir, decision):
		return importer
	var builder := Builder.new()
	var unchanged: Array = importer.plan.unchanged.filter(func(key: String) -> bool: return not importer.plan.conflicts.has(key))
	if not builder.build(importer.manifest_data, importer.managed_root, importer.managed_namespace, unchanged):
		importer.rollback()
		importer.result = importer.failure_report(builder.problems)
		return importer
	importer.finish_import()
	return importer

func _test_full_lifecycle(packs: String) -> void:
	print("--- full lifecycle")
	var importer := _import_and_build(packs + "/pack_v2")
	_check(String(importer.result.get("status", "")) == "succeeded", "2.0 pack imports end to end: %s" % "; ".join(importer.report))
	var root := "res://game_assets/engineering_project"
	var journal := Journal.new()
	_check(journal.load_from("engineering_project"), "installed journal v2 reads back")
	_check(journal.entries.has("hero") and journal.entries.has("walk_2d") and journal.entries.has("walk_3d") and journal.entries.has("hud_icon"), "all four kinds are recorded")
	var expected_derived := ["scenes/characters/hero.tscn", "scenes/animations_2d/walk.tscn", "scenes/animations_3d/walk.tscn", "scenes/icons/hud_icon.tscn", "animations/walk.tres", "animations/walk.library.tres", "bindings/hero.json", "preview.tscn", "catalog.json"]
	var recorded := {}
	for record in journal.generated_files:
		recorded[String(record.path)] = String(record.sha256)
	for path in expected_derived:
		var on_disk := FileAccess.file_exists(root + "/" + path)
		_check(on_disk and recorded.has(path) and recorded[path] == FileAccess.get_sha256(root + "/" + path), "derived resource journaled with its digest: " + path)

	var walk_scene := ResourceLoader.load(root + "/scenes/animations_2d/walk.tscn") as PackedScene
	_check(walk_scene != null, "anim_2d scene loads")
	if walk_scene != null:
		var sprite := walk_scene.instantiate() as AnimatedSprite2D
		_check(sprite != null and sprite.sprite_frames != null, "anim_2d scene root is an AnimatedSprite2D with SpriteFrames")
		if sprite != null and sprite.sprite_frames != null:
			var names := sprite.sprite_frames.get_animation_names()
			var has_all := names.size() == 4
			for direction in ["n", "e", "s", "w"]:
				if not names.has(direction):
					has_all = false
			_check(has_all, "one named animation per direction")
			var frames := sprite.sprite_frames.get_frame_count("n")
			_check(frames == 2 and absf(sprite.sprite_frames.get_animation_speed("n") - 8.0) < 0.0001 and sprite.sprite_frames.get_animation_loop("n"), "direction animation carries fps, loop and frame count")
			var frame0 := sprite.sprite_frames.get_frame_texture("n", 0) as AtlasTexture
			_check(frame0 != null and frame0.region == Rect2(1, 1, 2, 2), "frames reference atlas rects")
			_check(absf(sprite.offset.x) < 0.0001 and absf(sprite.offset.y) < 0.0001, "centered anchor yields zero offset")
			_check(absf(sprite.scale.x - 2.0) < 0.0001 and absf(sprite.scale.y - 2.0) < 0.0001, "root scale is 100/pixels_per_world_unit")
			sprite.free()

	var clip_scene := ResourceLoader.load(root + "/scenes/animations_3d/walk.tscn") as PackedScene
	_check(clip_scene != null, "anim_3d scene loads")
	if clip_scene != null:
		var clip_root := clip_scene.instantiate()
		var players: Array = clip_root.find_children("*", "AnimationPlayer", true, false)
		_check(players.size() == 1, "anim_3d scene carries one AnimationPlayer")
		if not players.is_empty():
			var player: AnimationPlayer = players[0]
			var libraries: Array = player.get_animation_library_list()
			var found := false
			for name in libraries:
				if String(name) == "walk":
					found = true
			_check(found, "retargeted library is attached under the clip name")
		clip_root.free()

	var hero_scene := ResourceLoader.load(root + "/scenes/characters/hero.tscn") as PackedScene
	_check(hero_scene != null, "character scene loads")
	if hero_scene != null:
		var hero_root := hero_scene.instantiate()
		var skeletons: Array = hero_root.find_children("*", "Skeleton3D", true, false)
		var collisions: Array = hero_root.find_children("*", "StaticBody3D", true, false)
		_check(skeletons.size() == 1, "character scene embeds the imported Skeleton3D")
		_check(collisions.size() == 1, "character capsule collision is generated")
		hero_root.free()

func _test_update_scenarios(packs: String) -> void:
	print("--- update scenarios")
	var root := "res://game_assets/engineering_project"
	var journal_path := root + "/import_journal.json"
	var baseline_journal := FileAccess.get_file_as_string(journal_path)
	var baseline_preview := FileAccess.get_sha256(root + "/preview.tscn")

	var importer := Importer.new()
	_check(not importer.import_pack(packs + "/pack_rig_only"), "rig-only update over a live clip dependency is refused")
	_check(FileAccess.get_file_as_string(journal_path) == baseline_journal, "refused update leaves the journal untouched")
	_check(FileAccess.get_sha256(root + "/preview.tscn") == baseline_preview, "refused update leaves derived resources untouched")
	_check(not importer.report.is_empty(), "refusal explains the reason")

	var original := FileAccess.get_file_as_string(journal_path)
	for case in ["{not json", JSON.stringify({"version": 9, "entries": {}, "generated_files": []}), JSON.stringify({"version": 2, "entries": {}, "generated_files": [], "install_state_hash": "0".repeat(64)})]:
		_write_raw(journal_path, case)
		var broken := Importer.new()
		_check(not broken.import_pack(packs + "/pack_sync"), "corrupt/unknown journal stops the update (%s)" % case.substr(0, 24))
	_write_raw(journal_path, original)

	# Committed transaction rolls back files, journal and derived resources.
	var committed := Importer.new()
	_check(committed.import_pack(packs + "/pack_sync"), "synchronized update stages")
	_check(committed.rollback(), "committed transaction rolls back on request")
	_check(FileAccess.get_file_as_string(journal_path) == baseline_journal, "rollback restores the previous journal")
	_check(FileAccess.get_sha256(root + "/preview.tscn") == baseline_preview, "rollback restores derived resources")

	importer = _import_and_build(packs + "/pack_sync", "replace")
	_check(String(importer.result.get("status", "")) == "succeeded", "synchronized rig + clip update succeeds: %s" % "; ".join(importer.report))
	var journal := Journal.new()
	_check(journal.load_from("engineering_project"), "updated journal v2 still reads")
	_check(String(journal.entries.hero.version_id) == "rig_v2" and String(journal.entries.walk_3d.version_id) == "clip_v2", "final versions follow the synchronized pack")
	_check(journal.install_state_hash() != String(JSON.parse_string(baseline_journal).get("install_state_hash", "")), "install_state_hash tracks the new state")

	importer = _import_and_build(packs + "/pack_v1_static", "replace")
	_check(String(importer.result.get("status", "")) == "succeeded", "1.x static pack updates a 2.0 installation: %s" % "; ".join(importer.report))
	journal = Journal.new()
	_check(journal.load_from("engineering_project"), "journal still loads after the 1.x merge")
	var document: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(journal_path))
	_check(int(document.get("version", 0)) == 2, "final description stays journal v2")
	_check(String(journal.entries.hud_icon.version_id) == "icon_v2", "1.x asset version applied")
	_check((journal.entries.walk_3d.get("dependencies", []) as Array).size() == 1, "1.x update preserves anim_3d dependencies")
	_check(String(journal.entries.hero.version_id) == "rig_v2", "1.x update preserves the retained rig")

	importer = _import_and_build(packs + "/pack_v2", "copy")
	_check(String(importer.result.get("status", "")) == "succeeded", "copy import succeeds: %s" % "; ".join(importer.report))
	var copy_journal := Journal.new()
	_check(copy_journal.load_from(importer.managed_namespace), "copy journal validates with its recomputed install_state_hash")
