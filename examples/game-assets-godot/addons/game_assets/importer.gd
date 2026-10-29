class_name GameAssetPackImporter
extends RefCounted
## Copies a verified pack into the managed res://game_assets/{ns}/
## directory. The plugin never deletes files a newer pack omits (plan
## 14.4: deletion is an explicit, reviewable operation) and verifies the
## sha256 of every file as it lands.

signal progress(message: String)

const Manifest := preload("res://addons/game_assets/manifest.gd")
const Journal := preload("res://addons/game_assets/journal.gd")

var report: PackedStringArray = PackedStringArray()

## Import (or update) one pack. `pack_dir` is a res:// or absolute path to
## the unpacked pack root containing manifest.json. Returns true when
## every file verified and landed.
func import_pack(pack_dir: String) -> bool:
	report = PackedStringArray()
	var manifest := Manifest.new()
	var manifest_path := pack_dir.path_join("manifest.json")
	if not manifest.load_from_file(manifest_path):
		_append_problems("preflight failed", manifest.problems)
		return false

	var ns: String = manifest.project_namespace()
	var managed_root := "res://game_assets/%s" % ns
	var journal := Journal.new()
	journal.load_from(ns)

	# Update gate (plan 14.4, GA-018): compare against the journal and
	# the managed files BEFORE copying. Manually modified (or missing)
	# managed files abort the import — the user's content wins and the
	# conflict needs an explicit resolution, never a silent overwrite.
	var plan := journal.plan_update(manifest.assets, managed_root)
	if not (plan["conflicts"] as Array).is_empty():
		report.append("CONFLICT: refusing to import over manually modified assets: %s" % ", ".join(plan["conflicts"]))
		report.append("resolve the conflicts (restore or rename the modified files), then import again")
		return false

	var imported := 0
	var updated := 0
	for asset in manifest.assets:
		if not (asset is Dictionary):
			continue
		var stable_key := String(asset.get("stable_key", ""))
		for f in asset.get("files", []) as Array:
			if not (f is Dictionary):
				continue
			var rel_path := String(f.get("path", ""))
			var source := pack_dir.path_join(rel_path)
			var dest := managed_root.path_join(rel_path)
			if not _copy_verified(source, dest, String(f.get("sha256", ""))):
				_append_problems("copy failed for %s" % rel_path, PackedStringArray(["sha256 mismatch or unreadable source"]))
				# Persist what already landed so a later import does not
				# flag these plugin-copied files as manual modifications.
				journal.save(ns)
				return false
			if not journal.known_paths().has(rel_path):
				imported += 1
			else:
				updated += 1
			progress.emit("imported %s" % rel_path)
		journal.record(asset)

	if not journal.save(ns):
		report.append("WARNING: journal save failed for %s" % ns)
	report.append("pack %s -> %s: files(new-to-pack=%d, known=%d), assets=%d" % [manifest.pack_id, managed_root, imported, updated, manifest.assets.size()])
	return true

func _copy_verified(source: String, dest: String, expected_sha256: String) -> bool:
	var file := FileAccess.open(source, FileAccess.READ)
	if file == null:
		return false
	var bytes := file.get_buffer(file.get_length())
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	var digest := ctx.finish().hex_encode()
	if digest != expected_sha256.to_lower():
		return false
	DirAccess.make_dir_recursive_absolute(dest.get_base_dir())
	var out := FileAccess.open(dest, FileAccess.WRITE)
	if out == null:
		return false
	out.store_buffer(bytes)
	return true

func _append_problems(context: String, problems: PackedStringArray) -> void:
	report.append("%s:" % context)
	for problem in problems:
		report.append("  - %s" % problem)
