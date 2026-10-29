@tool
extends EditorPlugin
## Test-only plugin copied to an isolated project; never distributed as product code.
const Importer := preload("res://addons/game_assets/importer.gd")
const Builder := preload("res://addons/game_assets/resource_builder.gd")
const EditorResources := preload("res://addons/game_assets/editor_resources.gd")
var failures: Array[String] = []
var checks: Array[Dictionary] = []

func _enter_tree() -> void: call_deferred("_run")

func _run() -> void:
	var filesystem := EditorInterface.get_resource_filesystem()
	_check(await EditorResources.scan(filesystem, get_tree()), "initial editor scan finishes")
	var seeded := await _install(ProjectSettings.globalize_path("res://input-full"), "cancel")
	_check(seeded.get("ok", false), "real fixture imports into the editor")
	if not seeded.get("ok", false): _finish(); return
	var root: String = seeded.root
	var manifest: Dictionary = seeded.manifest
	var asset: Dictionary = manifest.assets.filter(func(value: Dictionary) -> bool: return value.kind != "prop_3d")[0]
	var path := root.path_join("scenes/" + String(asset.stable_key) + ".tscn")
	EditorInterface.open_scene_from_path(path)
	var deadline := Time.get_ticks_msec() + 10000
	while (EditorInterface.get_edited_scene_root() == null or EditorInterface.get_edited_scene_root().scene_file_path != path) and Time.get_ticks_msec() < deadline:
		await get_tree().process_frame
	var edited := EditorInterface.get_edited_scene_root() as Node2D
	_check(edited != null and edited.scene_file_path == path, "managed scene opens in the actual editor")
	if edited == null:
		print("OPEN_SCENES ", EditorInterface.get_open_scenes(), " EXPECTED ", path)
		_finish(); return
	edited.position = Vector2(321, 123)
	EditorInterface.mark_scene_as_unsaved()
	_check(path in EditorInterface.get_unsaved_scenes(), "editor API reports the unsaved managed scene")
	var before := FileAccess.get_sha256(root.path_join("manifest.json"))
	var scene_before := FileAccess.get_sha256(path)
	var blocked := Importer.new(); blocked.before_mutation = EditorResources.guard_managed_changes
	_check(not blocked.import_pack(ProjectSettings.globalize_path("res://input-update")), "write is blocked for the unsaved scene")
	_check(FileAccess.get_sha256(root.path_join("manifest.json")) == before and FileAccess.get_sha256(path) == scene_before, "blocked write leaves every checked disk file unchanged")
	_check(edited.position == Vector2(321, 123) and path in EditorInterface.get_unsaved_scenes(), "unsaved game edits remain in memory")
	_check(not EditorResources.reload_changed_open_scenes(root, String(seeded.backup)).is_empty(), "automatic reload refuses unsaved scene edits")
	_check(edited.position == Vector2(321, 123), "reload refusal preserves the live scene")
	var copied := await _install(ProjectSettings.globalize_path("res://input-update"), "copy")
	_check(copied.get("ok", false) and copied.get("root") != root, "copy can install separately while original scene is unsaved")
	_check(edited.position == Vector2(321, 123) and path in EditorInterface.get_unsaved_scenes(), "copy leaves original unsaved scene intact")
	# This headless fixture tests scene saving, not GPU thumbnail generation.
	EditorInterface.save_scene_as(path, false)
	_check(path not in EditorInterface.get_unsaved_scenes() and FileAccess.get_sha256(path) != scene_before, "explicit test save persists the intended local scene change")
	var saved_hash := FileAccess.get_sha256(path)
	var disk_conflict := Importer.new(); disk_conflict.before_mutation = EditorResources.guard_managed_changes
	_check(not disk_conflict.import_pack(ProjectSettings.globalize_path("res://input-update")), "saved managed edits require an explicit conflict choice")
	var applied := await _install(ProjectSettings.globalize_path("res://input-update"), "replace")
	_check(applied.get("ok", false), "explicit backup replacement applies the new version")
	if applied.get("ok", false):
		_check(FileAccess.get_sha256(String(applied.backup).path_join("scenes/" + String(asset.stable_key) + ".tscn")) == saved_hash, "backup retains the saved local scene change")
		_check(EditorResources.reload_changed_open_scenes(root, String(applied.backup)).is_empty(), "changed clean scene reload is allowed")
		await get_tree().process_frame
		var reloaded := EditorInterface.get_edited_scene_root() as Node2D
		_check(reloaded != null and reloaded.get_meta("artcraft_version_id", "") == String(asset.version_id) + "_updated", "open editor scene reflects the new version after reload")
		_check(reloaded != null and reloaded.position == Vector2.ZERO, "explicit replacement resets managed root properties to generated defaults")
	var observed := {}
	for relative in ["manifest.json", "import_journal.json", "catalog.json", "preview.tscn", "scenes/" + String(asset.stable_key) + ".tscn"]:
		observed[relative] = {"sha": FileAccess.get_sha256(root.path_join(relative)), "mtime": FileAccess.get_modified_time(root.path_join(relative))}
	var handoff := FileAccess.open("res://noop-ready.json", FileAccess.WRITE)
	handoff.store_string(JSON.stringify({"root": ProjectSettings.globalize_path(root), "files": observed.keys()})); handoff.close()
	var resume_deadline := Time.get_ticks_msec() + 10000
	while not FileAccess.file_exists("res://noop-resume") and Time.get_ticks_msec() < resume_deadline: await get_tree().process_frame
	_check(FileAccess.file_exists("res://noop-resume"), "external nanosecond timestamp observer is ready")
	var repeated := await _install(ProjectSettings.globalize_path("res://input-update"), "cancel")
	_check(repeated.get("ok", false), "identical package can be applied again")
	var preserved := true
	for relative in observed:
		if FileAccess.get_sha256(root.path_join(relative)) != observed[relative].sha or FileAccess.get_modified_time(root.path_join(relative)) != observed[relative].mtime: preserved = false
	_check(preserved, "identical package preserves generated files, journal and catalog")
	_finish()

func _install(directory: String, decision: String) -> Dictionary:
	var importer := Importer.new(); importer.before_mutation = EditorResources.guard_managed_changes
	if not importer.import_pack(directory, decision): return {"ok": false, "problems": Array(importer.report)}
	if not await EditorResources.scan(EditorInterface.get_resource_filesystem(), get_tree(), EditorResources.expected_data(importer.manifest_data, importer.managed_root)): importer.rollback(); return {"ok": false}
	if not importer.check_before_mutation(): importer.rollback(); return {"ok": false}
	var builder := Builder.new()
	if not builder.build(importer.manifest_data, importer.managed_root, importer.managed_namespace, importer.plan.unchanged.filter(func(key: String) -> bool: return not importer.plan.conflicts.has(key))) or not importer.finish_import():
		importer.rollback(); return {"ok": false, "problems": Array(builder.problems)}
	return {"ok": true, "root": importer.managed_root, "manifest": importer.manifest_data, "backup": importer.result.previous_files}

func _check(ok: bool, message: String) -> void:
	checks.append({"passed": ok, "message": message})
	if not ok: failures.append(message)
	print("PASS " if ok else "FAIL ", message)

func _finish() -> void:
	var file := FileAccess.open("res://editor-guard-result.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"passed": failures.is_empty(), "checks": checks}, "\t")); file.close()
	for failure in failures: push_error(failure)
	if failures.is_empty(): print("ARTCRAFT_EDITOR_GUARD_OK")
	await get_tree().process_frame
	get_tree().quit(0 if failures.is_empty() else 1)
