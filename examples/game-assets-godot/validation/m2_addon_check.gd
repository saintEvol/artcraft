extends SceneTree

# M2 addon logic check (GA-007), headless: manifest validation accepts the
# M0 pack, rejects tampered hashes and unknown schema majors; the importer
# lands verified files into the managed namespace and records the journal;
# a second import of the same pack is a no-change update; a journal reload
# keeps known paths (update does not lose references).

const Manifest := preload("res://addons/game_assets/manifest.gd")
const Importer := preload("res://addons/game_assets/importer.gd")
const Journal := preload("res://addons/game_assets/journal.gd")

var failures: Array[String] = []

func _init() -> void:
	var tmp := OS.get_environment("M2_TEST_ROOT")
	if tmp.is_empty():
		failures.append("set M2_TEST_ROOT to a scratch pack root")
		_finish()
		return

	var pack_dir := tmp.path_join("pack_minimal")

	# 1. Valid manifest passes preflight.
	var manifest := Manifest.new()
	if not manifest.load_from_file(pack_dir.path_join("manifest.json")):
		failures.append("valid manifest rejected: %s" % ", ".join(manifest.problems))
	if manifest.project_namespace() != "game_assets_m0":
		failures.append("unexpected namespace %s" % manifest.project_namespace())

	# 2. Unknown schema major rejected (on a COPY; the pack itself must
	# stay pristine for the clean import below).
	var bad_dir := tmp.path_join("bad_manifest")
	DirAccess.make_dir_recursive_absolute(bad_dir)
	DirAccess.copy_absolute(pack_dir.path_join("manifest.json"), bad_dir.path_join("manifest.json"))
	_write_json(bad_dir.path_join("manifest.json"), func(m: Dictionary) -> void:
		m["schema_version"] = "2.0")
	var bad_manifest := Manifest.new()
	if bad_manifest.load_from_file(bad_dir.path_join("manifest.json")):
		failures.append("schema major 2 must be rejected")
	var names_schema_problem := false
	for problem in bad_manifest.problems:
		if problem.contains("unsupported manifest schema_version"):
			names_schema_problem = true
	if not names_schema_problem:
		failures.append("schema rejection must name the problem")

	# 3. Malformed sha256 rejected by validation (wrong length; the
	# content-vs-hash mismatch case is covered by the importer step below).
	_write_json(bad_dir.path_join("manifest.json"), func(m: Dictionary) -> void:
		m["schema_version"] = "1.0"
		(m["assets"][0] as Dictionary)["files"][0]["sha256"] = "0".repeat(10))
	var malformed := Manifest.new()
	if malformed.load_from_file(bad_dir.path_join("manifest.json")):
		failures.append("malformed (short) sha256 must fail validation")

	# 4. Importer: hash mismatch refuses to copy.
	var tamper_dir := tmp.path_join("tampered")
	DirAccess.make_dir_recursive_absolute(tamper_dir.path_join("assets/icons/health_potion"))
	DirAccess.copy_absolute(pack_dir.path_join("manifest.json"), tamper_dir.path_join("manifest.json"))
	DirAccess.copy_absolute(pack_dir.path_join("assets/icons/health_potion/main.png"), tamper_dir.path_join("assets/icons/health_potion/main.png"))
	# Flip one byte of the payload copy so the manifest hash no longer matches.
	var png_path := tamper_dir.path_join("assets/icons/health_potion/main.png")
	var bytes := FileAccess.get_file_as_bytes(png_path)
	if bytes.size() < 65:
		failures.append("tamper payload unexpectedly small")
		_finish()
		return
	bytes[64] = bytes[64] ^ 0xFF
	var wf := FileAccess.open(png_path, FileAccess.WRITE)
	wf.store_buffer(bytes)
	wf.close()
	var importer := Importer.new()
	if importer.import_pack(tamper_dir):
		failures.append("importer must refuse a payload whose sha256 does not match")

	# 5. Importer: clean import lands files + journal.
	var good := Importer.new()
	if not good.import_pack(pack_dir):
		failures.append("clean import failed: %s" % ", ".join(good.report))
	var journal_path := "res://game_assets/game_assets_m0/import_journal.json"
	var journal_ok := false
	if not FileAccess.file_exists(journal_path):
		failures.append("journal missing after import")
	else:
		var jp := FileAccess.open(journal_path, FileAccess.READ)
		var parsed: Variant = JSON.parse_string(jp.get_as_text())
		journal_ok = parsed is Dictionary and not (parsed.get("entries", {}) as Dictionary).is_empty()
		if not journal_ok:
			failures.append("journal has no entries")

	# 6. UPDATE preservation: re-import the SAME pack (no-change update),
	# then verify a freshly RELOADED journal still knows every path
	# (plan M2 gate: 版本更新不丢引用). Managed files must still exist.
	if journal_ok:
		var again := Importer.new()
		if not again.import_pack(pack_dir):
			failures.append("re-import failed: %s" % ", ".join(again.report))
		var reloaded: Journal = Journal.new()
		if not reloaded.load_from("game_assets_m0"):
			failures.append("journal failed to reload after update")
		else:
			var known: PackedStringArray = reloaded.known_paths()
			for expected_path in [
				"assets/icons/health_potion/main.png",
				"assets/props/wooden_crate/main.glb",
			]:
				if not known.has(expected_path):
					failures.append("journal lost path after update: %s" % expected_path)
				elif not FileAccess.file_exists("res://game_assets/game_assets_m0/%s" % expected_path):
					failures.append("managed file vanished after update: %s" % expected_path)

	_finish()

func _write_json(path: String, mutate: Callable) -> void:
	var file := FileAccess.open(path, FileAccess.READ)
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	var m: Dictionary = parsed
	mutate.call(m)
	var out := FileAccess.open(path, FileAccess.WRITE)
	out.store_string(JSON.stringify(m, "\t"))

func _finish() -> void:
	if failures.is_empty():
		print("M2_ADDON_CHECK_OK manifest+importer logic verified")
		quit(0)
	else:
		for failure in failures:
			printerr("M2_ADDON_CHECK_FAILED: ", failure)
		quit(1)
