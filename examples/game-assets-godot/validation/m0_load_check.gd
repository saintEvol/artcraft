extends SceneTree

# M0 headless load check for the game-asset pack fixture.
# Verifies that the frozen Godot version imports and loads both fixture
# kinds (transparent PNG texture, GLB packed scene) and that the loaded
# content matches the manifest's declared measurements.
# Run: godot --headless --import --path . (once), then
#      godot --headless --path . --script res://validation/m0_load_check.gd

const PACK_ROOT := "res://game_assets/pack_minimal"
const ICON_PATH := PACK_ROOT + "/assets/icons/health_potion/main.png"
const CRATE_PATH := PACK_ROOT + "/assets/props/wooden_crate/main.glb"
const ARROW_PATH := "res://game_assets/samples_3d/arrow_front_z.glb"

# Frozen expectations for the arrow orientation probe with ALL parts
# attached: x span 0.47 (fin exists only on +X), height 1.02 (green cap on
# +Y), z span 0.67 (nose points strictly +Z). A missing part shrinks its
# axis, so these dimensions distinguish an incomplete import from a
# complete one. Source: generate_m0_fixtures.py measured values, enforced
# by validate_m0_contracts.py.
const ARROW_AABB_SIZE := Vector3(0.47, 1.02, 0.67)
const AABB_TOLERANCE_M := 0.01
# Safety net, part 1: on 4.7.2 a runtime error directly inside _run_checks()
# aborts _run_checks while _init CONTINUES executing, so a completion flag
# set as the last statement of _run_checks turns an aborted run into an
# explicit failure instead of a false pass. (An error inside a *callee*
# aborts only that callee; _run_checks then continues and the guard-style
# checks append failures, as the manifest lookups do.)
# Safety net, part 2: a runtime error inside _init itself prevents quit()
# and would loop the SceneTree forever; _process force-quits when this
# deadline passes without a normal exit.
const DEADLINE_MS := 30000

var failures: Array[String] = []
var _started_ms := 0
var _checks_completed := false


func _init() -> void:
	_started_ms = Time.get_ticks_msec()
	_run_checks()
	if not _checks_completed:
		failures.append("checks aborted by an unexpected runtime error (see the SCRIPT ERROR above)")
	if failures.is_empty():
		print("M0_GODOT_LOAD_OK png+glb imported, loaded and measured")
		quit(0)
	else:
		for failure in failures:
			printerr("M0_GODOT_LOAD_FAILED: ", failure)
		quit(1)


func _process(_delta: float) -> bool:
	# Only reached when _init aborted early (script error) or hung.
	if Time.get_ticks_msec() - _started_ms > DEADLINE_MS:
		printerr("M0_GODOT_LOAD_FAILED: deadline exceeded before checks finished")
		quit(1)
		return true
	return false


func _run_checks() -> void:
	var manifest: Dictionary = _load_json(PACK_ROOT + "/manifest.json")
	_check_icon(manifest)
	_check_crate(manifest)
	_check_arrow()
	if not manifest.is_empty():
		var files_ok := _verify_pack_files(manifest)
		if not files_ok:
			failures.append("pack file hash/size checks failed (see lines above)")
	_checks_completed = true


func _check_icon(manifest: Dictionary) -> void:
	var texture := load(ICON_PATH)
	if texture == null:
		failures.append("icon PNG failed to load")
		return
	if not (texture is Texture2D):
		failures.append("icon loaded as %s, expected Texture2D" % texture.get_class())
		return
	var tex2d := texture as Texture2D
	var expected := _manifest_image_size(manifest, ICON_PATH)
	if expected == Vector2i.ZERO:
		failures.append("manifest has no image block for the icon file")
	elif Vector2i(tex2d.get_width(), tex2d.get_height()) != expected:
		failures.append("icon PNG is %dx%d, manifest says %dx%d" % [tex2d.get_width(), tex2d.get_height(), expected.x, expected.y])
	if tex2d is CompressedTexture2D:
		var image := (tex2d as CompressedTexture2D).get_image()
		if image == null:
			failures.append("icon texture has no decoded image")
		elif image.detect_alpha() == Image.ALPHA_NONE:
			# Fixture-specific heuristic: this icon must keep transparency;
			# an intentionally opaque image with an alpha channel would
			# false-fail here and is not covered by this check.
			failures.append("icon PNG lost its alpha channel on import")
	else:
		failures.append("icon texture is %s; alpha check only implemented for CompressedTexture2D" % texture.get_class())


func _check_crate(manifest: Dictionary) -> void:
	var packed := load(CRATE_PATH)
	if packed == null:
		failures.append("crate GLB failed to load")
		return
	if not (packed is PackedScene):
		failures.append("crate loaded as %s, expected PackedScene" % packed.get_class())
		return
	var aabb: Variant = _scene_aabb((packed as PackedScene).instantiate())
	if aabb == null:
		failures.append("crate GLB has no MeshInstance3D to measure")
		return
	var measured := (aabb as AABB).size
	var declared := _manifest_mesh_dimensions(manifest, CRATE_PATH)
	if declared == Vector3.ZERO:
		failures.append("manifest has no mesh block for the crate file")
		return
	for axis in range(3):
		if absf(measured[axis] - declared[axis]) > AABB_TOLERANCE_M:
			failures.append("crate AABB axis %d is %.3f m, manifest says %.3f m" % [axis, measured[axis], declared[axis]])


func _check_arrow() -> void:
	var packed := load(ARROW_PATH)
	if packed == null:
		failures.append("arrow GLB failed to load")
		return
	if not (packed is PackedScene):
		failures.append("arrow loaded as %s, expected PackedScene" % packed.get_class())
		return
	var aabb: Variant = _scene_aabb((packed as PackedScene).instantiate())
	if aabb == null:
		failures.append("arrow GLB has no MeshInstance3D to measure")
		return
	var measured := (aabb as AABB).size
	for axis in range(3):
		if absf(measured[axis] - ARROW_AABB_SIZE[axis]) > AABB_TOLERANCE_M:
			# A shrunken axis means one of the four parts (nose +Z, fin +X,
			# cap +Y) is missing from the imported scene.
			failures.append("arrow AABB axis %d is %.3f m, complete model measures %.3f m" % [axis, measured[axis], ARROW_AABB_SIZE[axis]])


func _load_json(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		failures.append("cannot open " + path)
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if parsed is Dictionary:
		return parsed
	failures.append("cannot parse " + path)
	return {}


func _manifest_asset_for_file(manifest: Dictionary, file_path: String) -> Variant:
	# Exact path match against the res:// constant; a suffix match could
	# pair the wrong asset when one manifest path is a suffix of another
	# (or empty).
	for asset in manifest.get("assets", []) as Array:
		for entry in (asset as Dictionary).get("files", []) as Array:
			var entry_path := String((entry as Dictionary).get("path", ""))
			if not entry_path.is_empty() and PACK_ROOT + "/" + entry_path == file_path:
				return asset
	return null


func _manifest_image_size(manifest: Dictionary, file_path: String) -> Vector2i:
	var asset: Variant = _manifest_asset_for_file(manifest, file_path)
	if asset == null:
		return Vector2i.ZERO
	var image := (asset as Dictionary).get("image", {}) as Dictionary
	return Vector2i(int(image.get("width", 0)), int(image.get("height", 0)))


func _manifest_mesh_dimensions(manifest: Dictionary, file_path: String) -> Vector3:
	var asset: Variant = _manifest_asset_for_file(manifest, file_path)
	if asset == null:
		return Vector3.ZERO
	var mesh := (asset as Dictionary).get("mesh", {}) as Dictionary
	var dims := mesh.get("measured_dimensions_m", {}) as Dictionary
	return Vector3(float(dims.get("x", 0.0)), float(dims.get("y", 0.0)), float(dims.get("z", 0.0)))


func _scene_aabb(node: Node) -> Variant:
	# Merge every MeshInstance3D's local AABB transformed up to the scene
	# root, so nested nodes with rotations/scales are measured correctly
	# (the fixtures are flat, but the helper stays general).
	var result: AABB = AABB()
	var found := false
	for child in node.find_children("*", "MeshInstance3D", true, false):
		var mesh_instance := child as MeshInstance3D
		var local: AABB = mesh_instance.get_aabb()
		var world_transform := Transform3D()
		var cursor: Node = mesh_instance
		while cursor != null and cursor != node:
			var node_3d := cursor as Node3D
			if node_3d != null:
				world_transform = node_3d.transform * world_transform
			cursor = cursor.get_parent()
		var world_aabb: AABB = world_transform * local
		if found:
			result = result.merge(world_aabb)
		else:
			result = world_aabb
			found = true
	if not found:
		return null
	# The scene is not in the tree; queue_free() would be a no-op here.
	if node.is_inside_tree():
		node.queue_free()
	else:
		node.free()
	return result


func _verify_pack_files(manifest: Dictionary) -> bool:
	var ok := true
	for asset in manifest.get("assets", []) as Array:
		for entry in (asset as Dictionary).get("files", []) as Array:
			var entry_path := String((entry as Dictionary).get("path", ""))
			var file := FileAccess.open(PACK_ROOT + "/" + entry_path, FileAccess.READ)
			if file == null:
				printerr("  missing file: ", entry_path)
				ok = false
				continue
			var bytes := file.get_buffer(file.get_length())
			if bytes.size() != int((entry as Dictionary).get("byte_length", -1)):
				printerr("  size mismatch: ", entry_path)
				ok = false
			var ctx := HashingContext.new()
			ctx.start(HashingContext.HASH_SHA256)
			ctx.update(bytes)
			var digest := ctx.finish().hex_encode()
			if digest != String((entry as Dictionary).get("sha256", "")):
				printerr("  sha256 mismatch: ", entry_path)
				ok = false
	return ok
