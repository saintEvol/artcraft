class_name GameAssetManifest
extends RefCounted
## Parses and validates one game-asset pack manifest (plan section 14.2).
## Pure logic — no editor dependencies — so the acceptance project can
## exercise it headless.

const SUPPORTED_SCHEMA_MAJOR := 1

var pack_id: String
var project_id: String
var export_id: String
var generated_at: String
var engine_profiles: Array = []
var assets: Array = []
var problems: PackedStringArray = []

## Parse + validate. Returns true when the manifest is structurally valid
## and importable by THIS plugin version; `problems` carries every reason
## otherwise (schema too new, missing engine profile, file path escape,
## atlas/LOD index out of range).
func load_from_file(manifest_path: String) -> bool:
	problems = PackedStringArray()
	var file := FileAccess.open(manifest_path, FileAccess.READ)
	if file == null:
		problems.append("cannot open manifest: %s" % manifest_path)
		return false
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if not (parsed is Dictionary):
		problems.append("manifest is not a JSON object")
		return false
	var m: Dictionary = parsed

	var schema_version := String(m.get("schema_version", ""))
	if schema_version.is_empty():
		problems.append("missing schema_version")
		return false
	var parts := schema_version.split(".")
	if parts.is_empty() or not parts[0].is_valid_int():
		problems.append("malformed schema_version: %s" % schema_version)
		return false
	if int(parts[0]) > SUPPORTED_SCHEMA_MAJOR:
		# Unknown MAJOR versions must be rejected outright (plan 14.2).
		problems.append("unsupported manifest schema_version: %s (plugin supports major %d)" % [schema_version, SUPPORTED_SCHEMA_MAJOR])
		return false

	pack_id = String(m.get("pack_id", ""))
	project_id = String(m.get("project_id", ""))
	export_id = String(m.get("export_id", ""))
	generated_at = String(m.get("generated_at", ""))
	if pack_id.is_empty() or project_id.is_empty() or export_id.is_empty():
		problems.append("pack_id/project_id/export_id must be non-empty")

	engine_profiles = m.get("engine_profiles", []) as Array
	assets = m.get("assets", []) as Array
	if engine_profiles.is_empty():
		problems.append("manifest carries no engine_profiles snapshot")
	if assets.is_empty():
		problems.append("manifest carries no assets")

	var has_godot_profile := false
	for profile in engine_profiles:
		if profile is Dictionary and String(profile.get("engine", "")) == "godot":
			has_godot_profile = true
			# Plan 14.2: unsupported REQUIRED features must fail the
			# import. The M2 addon supports none.
			var required: Array = profile.get("required_features", []) as Array
			if not required.is_empty():
				problems.append("godot profile requires unsupported features: %s" % ", ".join(required))
	if not has_godot_profile:
		problems.append("no godot engine_profile in the pack (import would be unverified)")

	for asset in assets:
		_validate_asset(asset)
	return problems.is_empty()

func _validate_asset(asset: Variant) -> void:
	if not (asset is Dictionary):
		problems.append("asset entry is not an object")
		return
	var a: Dictionary = asset
	var stable_key := String(a.get("stable_key", ""))
	if stable_key.is_empty():
		problems.append("asset missing stable_key")
	var files: Array = a.get("files", []) as Array
	if files.is_empty():
		problems.append("asset %s lists no files" % stable_key)
	var file_count := files.size()
	for entry in files:
		if not (entry is Dictionary):
			problems.append("asset %s has a malformed file entry" % stable_key)
			continue
		var f: Dictionary = entry
		var path := String(f.get("path", ""))
		if path.begins_with("/") or path.split("../").size() > 1 or path.find("//") != -1:
			problems.append("asset %s file path escapes the pack: %s" % [stable_key, path])
		var sha := String(f.get("sha256", ""))
		if sha.length() != 64:
			problems.append("asset %s file %s has a malformed sha256" % [stable_key, path])
	# Kind <-> required block parity (matches the frozen JSON Schema and
	# the Bevy parser; consumers must not drift on the same pack).
	var kind := String(a.get("kind", ""))
	match kind:
		"icon_2d", "sprite_2d":
			if (a.get("image", {}) as Dictionary).is_empty():
				problems.append("2D asset %s has no image block" % stable_key)
		"prop_3d":
			if (a.get("mesh", {}) as Dictionary).is_empty():
				problems.append("prop_3d asset %s has no mesh block" % stable_key)
		_:
			problems.append("asset %s has unknown kind %s" % [stable_key, kind])

	var image: Dictionary = a.get("image", {}) as Dictionary
	var atlas: Dictionary = image.get("atlas", {}) as Dictionary
	if not atlas.is_empty():
		var page_index: int = int(atlas.get("page_file_index", -1))
		if page_index < 0 or page_index >= file_count:
			problems.append("asset %s atlas page_file_index out of range" % stable_key)
	var mesh: Dictionary = a.get("mesh", {}) as Dictionary
	var lod: Dictionary = mesh.get("lod", {}) as Dictionary
	if not lod.is_empty():
		_validate_lod(stable_key, lod, file_count)

func _validate_lod(stable_key: String, lod: Dictionary, file_count: int) -> void:
	## LOD contract (plan 13.5/14.2): enabled but incomplete or
	## inconsistent mapping is rejected at import, never degraded. The
	## checks mirror the Bevy parser so consumers never drift on the
	## same pack.
	var levels: Array = lod.get("levels", []) as Array
	if levels.is_empty():
		problems.append("asset %s has an empty lod block" % stable_key)
		return
	var previous_level := -1
	var previous_switch := -1.0
	for level in levels:
		if not (level is Dictionary):
			problems.append("asset %s lod level entry is not an object" % stable_key)
			continue
		var l: Dictionary = level
		var file_index: int = int(l.get("file_index", -1))
		if file_index < 0 or file_index >= file_count:
			problems.append("asset %s lod file_index out of range" % stable_key)
		var level_no: int = int(l.get("level", -1))
		if level_no < 1:
			# Explicit levels are 1-based: the main file is the implicit
			# finest level (rank 0 in both engines' selectors).
			problems.append("asset %s lod level %d invalid: explicit levels start at 1" % [stable_key, level_no])
		if level_no <= previous_level:
			problems.append("asset %s lod levels must be ascending" % stable_key)
		var switch_distance := float(l.get("switch_distance_m", 0.0))
		if switch_distance <= 0.0:
			problems.append("asset %s lod level %d has a non-positive switch distance" % [stable_key, level_no])
		elif previous_switch >= 0.0 and switch_distance <= previous_switch:
			problems.append("asset %s lod switch distances must increase" % stable_key)
		var hysteresis := float(l.get("hysteresis_m", 0.0))
		if hysteresis < 0.0:
			problems.append("asset %s lod level %d has a negative hysteresis" % [stable_key, level_no])
		elif hysteresis > switch_distance:
			# A band wider than its threshold can never be left.
			problems.append("asset %s lod level %d hysteresis exceeds its switch distance" % [stable_key, level_no])
		previous_level = level_no
		previous_switch = switch_distance

## Stable namespace for the managed directory (plan 15.1):
## res://game_assets/{project_namespace}/. Derived from project identity,
## not display names.
func project_namespace() -> String:
	return project_id.to_lower()

func find_asset(stable_key: String) -> Dictionary:
	for asset in assets:
		if asset is Dictionary and String(asset.get("stable_key", "")) == stable_key:
			return asset
	return {}
