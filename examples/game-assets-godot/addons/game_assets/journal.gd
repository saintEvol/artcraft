class_name GameAssetImportJournal
extends RefCounted
## Append-only record of what the plugin imported into the managed
## directory (plan 15.1: stable identity, update without breaking user
## scenes). Stored at res://game_assets/import_journal.json.

## entry: {asset_id, stable_key, version_id, files: [{role, path, sha256}]}

var entries: Dictionary = {}

static func journal_path(for_namespace: String) -> String:
	return "res://game_assets/%s/import_journal.json" % for_namespace

func load_from(for_namespace: String) -> bool:
	var path := journal_path(for_namespace)
	if not FileAccess.file_exists(path):
		return false
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return false
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if parsed is Dictionary and parsed.get("entries", {}) is Dictionary:
		entries = parsed.get("entries", {}) as Dictionary
		return true
	return false

func save(for_namespace: String) -> bool:
	var path := journal_path(for_namespace)
	var dir := path.get_base_dir()
	DirAccess.make_dir_recursive_absolute(dir)
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(JSON.stringify({"version": 1, "entries": entries}, "\t"))
	return true

func record(asset: Dictionary) -> void:
	var files: Array = []
	for f in asset.get("files", []) as Array:
		if f is Dictionary:
			files.append({
				"role": f.get("role", ""),
				"path": f.get("path", ""),
				"sha256": f.get("sha256", ""),
			})
	entries[String(asset.get("asset_id", ""))] = {
		"stable_key": asset.get("stable_key", ""),
		"version_id": asset.get("version_id", ""),
		"files": files,
	}

func known_paths() -> PackedStringArray:
	var paths := PackedStringArray()
	for entry in entries.values():
		if entry is Dictionary:
			for f in entry.get("files", []) as Array:
				if f is Dictionary:
					paths.append(String(f.get("path", "")))
	return paths

## Update plan (plan 14.4, GA-018 两引擎更新与冲突处理): compare an
## incoming pack against the journal + the managed files on disk.
## Returns {new: [], updated: [], unchanged: [], conflicts: [], missing: []}
## keyed by stable_key:
##   new        - asset not in the journal yet;
##   updated    - journal knows it AND the file set/hash changed;
##   unchanged  - journal knows it and nothing changed;
##   conflicts  - the managed file on disk no longer matches the
##                journal's recorded hash (manual modification): the
##                user's content wins and must be resolved explicitly,
##                never overwritten silently;
##   missing    - in the journal but not in the incoming pack (NOT
##                deleted: plan 14.4, deletion is explicit and
##                reviewable).
## `managed_root` is the absolute or res:// root the files live under.
func plan_update(manifest_assets: Array, managed_root: String) -> Dictionary:
	var plan := {"new": [], "updated": [], "unchanged": [], "conflicts": [], "missing": []}
	var by_asset_id := {}
	for entry in entries.values():
		if entry is Dictionary:
			by_asset_id[String(entry.get("stable_key", ""))] = entry

	var incoming := {}
	for asset in manifest_assets:
		if asset is Dictionary:
			incoming[String(asset.get("stable_key", ""))] = asset

	for stable_key in incoming:
		var asset: Dictionary = incoming[stable_key]
		var recorded: Dictionary = by_asset_id.get(stable_key, {}) as Dictionary
		if recorded.is_empty():
			plan["new"].append(stable_key)
			continue
		var incoming_files: Array = asset.get("files", []) as Array
		var recorded_files: Array = recorded.get("files", []) as Array
		var incoming_hashes := {}
		for f in incoming_files:
			if f is Dictionary:
				incoming_hashes[String(f.get("path", ""))] = String(f.get("sha256", ""))
		var recorded_hashes := {}
		for f in recorded_files:
			if f is Dictionary:
				recorded_hashes[String(f.get("path", ""))] = String(f.get("sha256", ""))
		if incoming_hashes == recorded_hashes:
			plan["unchanged"].append(stable_key)
		else:
			plan["updated"].append(stable_key)
		# Manual modification check: the disk file drifted from what the
		# journal recorded at import time.
		for path in recorded_hashes:
			var disk := managed_root.path_join(path)
			if not FileAccess.file_exists(disk):
				# A journal-recorded file missing on disk leaves the
				# managed set broken; surface it as a conflict instead of
				# planning "unchanged" and silently keeping it broken.
				if not (stable_key in plan["conflicts"]):
					plan["conflicts"].append(stable_key)
				continue
			var file := FileAccess.open(disk, FileAccess.READ)
			if file == null:
				continue
			var bytes := file.get_buffer(file.get_length())
			var ctx := HashingContext.new()
			ctx.start(HashingContext.HASH_SHA256)
			ctx.update(bytes)
			if ctx.finish().hex_encode() != String(recorded_hashes[path]).to_lower():
				if not (stable_key in plan["conflicts"]):
					plan["conflicts"].append(stable_key)

	for stable_key in by_asset_id:
		if not incoming.has(stable_key):
			plan["missing"].append(stable_key)
	return plan
