extends SceneTree
## Targeted regression for the real recovery-vs-active-import failure.
## Run in an isolated project, never in a developer's game directory.

const Importer := preload("res://addons/game_assets/importer.gd")
const EditorPresence := preload("res://addons/game_assets/editor_presence.gd")
const Preview := preload("res://addons/game_assets/preview.gd")
const FileCopy := preload("res://addons/game_assets/file_copy.gd")
const Transaction := preload("res://addons/game_assets/file_transaction.gd")
const Manifest := preload("res://addons/game_assets/manifest.gd")
const Journal := preload("res://addons/game_assets/journal.gd")
const Browser := preload("res://addons/game_assets/installed_browser.gd")
const Catalog := preload("res://addons/game_assets/installed_catalog.gd")
const Report := preload("res://addons/game_assets/engine_report.gd")
const ImportLock := preload("res://addons/game_assets/import_lock.gd")
var failures: Array[String] = []

func _init() -> void:
	call_deferred("_run")

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 1: quit(2); return
	if args.size() > 1 and args[1] == "presence":
		var editor := EditorPresence.new()
		if not editor.register(): quit(1); return
		var ready := FileAccess.open("res://presence-ready", FileAccess.WRITE); ready.close()
		while not FileAccess.file_exists("res://presence-release"): await process_frame
		editor.release(); quit(0); return
	if args.size() > 1 and args[1] == "abandon":
		var abandoned := ImportLock.new()
		quit(0 if abandoned.acquire() else 1); return
	if args.size() > 1 and args[1] == "probe":
		var other := Importer.new()
		var rejected: bool = not other.preflight(args[0])
		var lock := ImportLock.new()
		var live_recovery_rejected: bool = not lock.recover_abandoned()
		var result := FileAccess.open("res://probe.json", FileAccess.WRITE)
		result.store_string(JSON.stringify({"rejected": rejected, "live_recovery_rejected": live_recovery_rejected})); result.close()
		quit(0 if rejected and live_recovery_rejected else 1); return
	var importer := Importer.new()
	_check(importer.import_pack(args[0]), "first import prepares verified files")
	if not failures.is_empty(): push_error("\n".join(importer.report)); _finish(); return
	var marker: String = importer.managed_root + ".pending.json"
	var manifest_path: String = importer.managed_root.path_join("manifest.json")
	var prepared_hash := FileAccess.get_sha256(manifest_path)
	var other := Importer.new()
	_check(not other.preflight(args[0]), "second importer cannot recover active transaction")
	_check(FileAccess.file_exists(marker), "active transaction marker is retained")
	_check(FileAccess.get_sha256(manifest_path) == prepared_hash, "active imported tree remains untouched")
	_check(not importer.preflight(args[0]), "same instance cannot replace its active lock")
	var child := OS.create_process(OS.get_executable_path(), PackedStringArray(["--headless", "--path", ProjectSettings.globalize_path("res://"), "--script", OS.get_cmdline_args()[OS.get_cmdline_args().find("--script") + 1], "--", args[0], "probe"]))
	_check(child > 0, "second process starts")
	var deadline := Time.get_ticks_msec() + 20000
	while child > 0 and OS.is_process_running(child) and Time.get_ticks_msec() < deadline: await process_frame
	_check(FileAccess.file_exists("res://probe.json"), "second process reports lock result")
	if FileAccess.file_exists("res://probe.json"):
		var probe: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://probe.json"))
		_check(probe is Dictionary and probe.get("rejected") == true and probe.get("live_recovery_rejected") == true, "active lock also protects against another process")
	_check(FileAccess.file_exists(marker) and FileAccess.get_sha256(manifest_path) == prepared_hash, "cross-process probe did not roll back the live import")
	_check(importer.rollback(), "owner can explicitly roll back")
	_check(not FileAccess.file_exists(marker), "rollback clears its transaction marker")
	_check(not DirAccess.dir_exists_absolute(ImportLock.DIRECTORY), "owner releases lock after rollback")
	var retry := Importer.new()
	_check(retry.preflight(args[0]), "preflight works after rollback")
	var abandoned_child := OS.create_process(OS.get_executable_path(), PackedStringArray(["--headless", "--path", ProjectSettings.globalize_path("res://"), "--script", OS.get_cmdline_args()[OS.get_cmdline_args().find("--script") + 1], "--", args[0], "abandon"]))
	deadline = Time.get_ticks_msec() + 20000
	while abandoned_child > 0 and OS.is_process_running(abandoned_child) and Time.get_ticks_msec() < deadline: await process_frame
	_check(DirAccess.dir_exists_absolute(ImportLock.DIRECTORY), "interrupted process leaves a recoverable lock")
	var recovery := ImportLock.new()
	_check(recovery.recover_abandoned(), "explicit recovery releases an exited process lock")
	_check(retry.preflight(args[0]), "normal preflight resumes after lock recovery")
	_test_selected_copy_recovery(args[0])
	_test_catalog(args[0])
	_test_metadata_and_mutation_guard(args[0])
	_test_mouse_event_state()
	await _test_other_editor_presence(args[0])
	_finish()

func _check(ok: bool, message: String) -> void:
	if not ok: failures.append(message)
	print("PASS " if ok else "FAIL ", message)

func _finish() -> void:
	for failure in failures: push_error(failure)
	if failures.is_empty(): print("ARTCRAFT_LIFECYCLE_OK")
	quit(0 if failures.is_empty() else 1)

func _test_selected_copy_recovery(pack_dir: String) -> void:
	var manifest := Manifest.new()
	_check(manifest.load_from_file(pack_dir.path_join("manifest.json")), "recovery fixture has a valid manifest")
	var target := manifest.project_namespace() + "_copy_recovery"
	var destination := "res://game_assets/" + target
	DirAccess.make_dir_recursive_absolute(destination)
	_check(Report.save(manifest.data, destination.path_join("manifest.json")), "seed selected copy identity")
	var journal := Journal.new(); _check(journal.save(target), "seed selected copy journal")
	var transaction := Transaction.new()
	_check(transaction.prepare(destination), "prepare selected copy update")
	_check(Report.save({"format": Transaction.TAG, "root": destination, "stage": transaction.stage, "backup": transaction.backup, "phase": "prepared"}, destination + ".pending.json"), "write interrupted swap marker")
	_check(DirAccess.rename_absolute(destination, transaction.backup) == OK, "simulate interruption after old root moved to backup")
	_check(not DirAccess.dir_exists_absolute(destination), "selected copy root is absent before recovery")
	var importer := Importer.new()
	_check(importer.preflight(pack_dir, target), "selected copy recovers before its identity is read")
	_check(FileAccess.file_exists(destination.path_join("manifest.json")) and not FileAccess.file_exists(destination + ".pending.json"), "copy identity restored and interrupted marker cleared")
	var foreign := manifest.data.duplicate(true); foreign.project_id = "another_project"
	_check(Report.save(foreign, destination.path_join("manifest.json")), "seed foreign project identity")
	_check(not importer.preflight(pack_dir, target), "foreign project cannot be overwritten through selected target")

func _test_catalog(pack_dir: String) -> void:
	var manifest := Manifest.new()
	if not manifest.load_from_file(pack_dir.path_join("manifest.json")): _check(false, "catalog fixture valid"); return
	var journal := Journal.new()
	for asset in manifest.assets: journal.record(asset)
	var partial := manifest.data.duplicate(true); partial.assets = [manifest.assets[0]]
	var catalog := Catalog.from_journal(partial, journal.entries)
	_check(catalog.assets.size() == manifest.assets.size(), "partial delivery retains the complete installed inventory")
	_check(partial.assets.size() == 1, "catalog does not expand current delivery report scope")
	var changed: Dictionary = manifest.assets[0].duplicate(true); changed.version_id += "_updated"
	journal.record(changed); partial.assets = [changed]
	catalog = Catalog.from_journal(partial, journal.entries)
	_check(catalog.assets[0].version_id == changed.version_id, "catalog reflects the updated asset version")
	_check(catalog.assets[-1].version_id == manifest.assets[-1].version_id, "catalog retains the old version of an omitted asset")

	var browser := Browser.new(); root.add_child(browser)
	var pack: Dictionary = {"namespace": "qa", "root": "res://game_assets/qa", "manifest": partial, "catalog": catalog, "label": "工程中的资产"}
	var packs: Array[Dictionary] = [pack]
	browser.refresh(packs, "qa")
	var asset_options: OptionButton
	for control in browser.find_children("*", "OptionButton", true, false):
		if control.accessibility_name == "选择已安装资产": asset_options = control
	_check(asset_options != null and asset_options.item_count == catalog.assets.size(), "empty search shows every installed asset")
	for control in browser.find_children("*", "LineEdit", true, false): control.text = "  "
	browser.refresh(packs, "qa")
	_check(asset_options.item_count == catalog.assets.size(), "whitespace search also shows every installed asset")
	browser.free()

func _test_metadata_and_mutation_guard(pack_dir: String) -> void:
	var copy := FileCopy.new()
	_check(copy.preserve_tree("res://copy fixture's 来源", "res://copy fixture's 副本"), "old file data and modification time can be copied")
	var path := "原图's 参考.bin"
	_check(FileAccess.get_modified_time("res://copy fixture's 副本/" + path) == 1600000000, "old timestamp is retained instead of the copy time")
	var importer := Importer.new()
	importer.before_mutation = func(_root: String) -> PackedStringArray: return PackedStringArray(["Unsaved editor scene"])
	_check(importer.preflight(pack_dir), "read-only disk planning is available while a scene is unsaved")
	var destination: String = importer.managed_root
	_check(not importer.import_pack(pack_dir), "an unsaved scene guard stops the write before preparation")
	_check(not FileAccess.file_exists(destination.path_join("manifest.json")), "rejected editor state does not create an installation")
	_check(importer.failure_report().status == "conflicts", "editor state conflict is reported explicitly")
	var kept := Importer.new()
	_check(kept.import_pack(pack_dir, "keep"), "keep current does not require an existing disk conflict")
	_check(kept.result.get("kept_current") == true and kept.result.status == "partial", "keep is a partial non-application result")
	_check(not FileAccess.file_exists(destination.path_join("manifest.json")), "keep does not install new assets")

func _test_mouse_event_state() -> void:
	var motion := InputEventMouseMotion.new(); motion.relative = Vector2(12, -6); motion.button_mask = MOUSE_BUTTON_MASK_LEFT
	_check(not Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT) and Preview.drag_motion(motion) == Vector2(12, -6), "drag uses the delivered event mask even after global release")
	motion.button_mask = 0
	_check(Preview.drag_motion(motion) == Vector2.ZERO, "unpressed motion does not rotate the camera")

func _test_other_editor_presence(pack_dir: String) -> void:
	var child := OS.create_process(OS.get_executable_path(), PackedStringArray(["--headless", "--path", ProjectSettings.globalize_path("res://"), "--script", OS.get_cmdline_args()[OS.get_cmdline_args().find("--script") + 1], "--", pack_dir, "presence"]))
	var deadline := Time.get_ticks_msec() + 15000
	while not FileAccess.file_exists("res://presence-ready") and Time.get_ticks_msec() < deadline: await process_frame
	_check(child > 0 and OS.is_process_running(child), "another editor process owns a live session record")
	var importer := Importer.new()
	_check(not importer.preflight(pack_dir), "a different editor session blocks CLI and import writers")
	var release := FileAccess.open("res://presence-release", FileAccess.WRITE); release.close()
	while OS.is_process_running(child) and Time.get_ticks_msec() < deadline: await process_frame
	_check(EditorPresence.other_editors().is_empty(), "closing the editor releases its own presence record")
	_check(importer.preflight(pack_dir), "import planning resumes after the other editor exits")
