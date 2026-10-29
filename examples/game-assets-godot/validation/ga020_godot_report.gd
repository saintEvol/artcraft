extends SceneTree

# GA-020 Godot engine report (load-readiness only, mirroring the Bevy
# report): parse + validate the manifest of the REAL generated-asset
# pack (11 items from real flux+rembg iterations), verify every file's
# sha256 on disk, import-check the textures, and confirm the update
# plan classifies the pack as all-new (first import). Prints
# GA020_GODOT_REPORT_OK on success. Run:
#   godot --headless --path examples/game-assets-godot \
#     --script res://validation/ga020_godot_report.gd

const Manifest := preload("res://addons/game_assets/manifest.gd")
const Journal := preload("res://addons/game_assets/journal.gd")

const PACK_DIR := "res://game_assets/ga020_real"

var failures: Array[String] = []
var report_completed := false


func _init() -> void:
	_report()
	_finish()


func _report() -> void:
	var manifest := Manifest.new()
	if not manifest.load_from_file(PACK_DIR.path_join("manifest.json")):
		failures.append("manifest rejected: %s" % ", ".join(manifest.problems))
		return
	if manifest.assets.size() != 11:
		failures.append("expected 11 assets, got %d" % manifest.assets.size())

	var verified := 0
	var ctx := HashingContext.new()
	for asset in manifest.assets:
		if not (asset is Dictionary):
			failures.append("non-dict asset entry")
			continue
		for f in asset.get("files", []) as Array:
			if not (f is Dictionary):
				continue
			var path := String(f.get("path", ""))
			var disk := PACK_DIR.path_join(path)
			var file := FileAccess.open(disk, FileAccess.READ)
			if file == null:
				failures.append("missing file %s" % path)
				continue
			ctx.start(HashingContext.HASH_SHA256)
			var remaining := file.get_length()
			while remaining > 0:
				var chunk := file.get_buffer(mini(remaining, 1 << 20))
				ctx.update(chunk)
				remaining -= chunk.size()
			if ctx.finish().hex_encode() != String(f.get("sha256", "")).to_lower():
				failures.append("sha256 mismatch for %s" % path)
			else:
				verified += 1
	if verified != 11:
		failures.append("verified %d/11 files" % verified)

	# Texture loadability: every 2D asset decodes through Godot's loader.
	# Paths derive from the asset kind — no probe-then-fallback (which
	# logged ERROR lines for every sprite in a passing run).
	var loaded_textures := 0
	for asset in manifest.assets:
		var stable_key := String(asset.get("stable_key", ""))
		var kind := String(asset.get("kind", ""))
		var subdir := "icons" if kind == "icon_2d" else "sprites"
		var tex := load(PACK_DIR.path_join("assets/%s/%s/main.png" % [subdir, stable_key]))
		if tex is Texture2D:
			loaded_textures += 1
		else:
			failures.append("texture failed to load for %s" % stable_key)
	if loaded_textures != 11:
		failures.append("loaded %d/11 textures" % loaded_textures)

	# Update plan: first import of this pack under an empty journal
	# classifies every asset as new; nothing deleted.
	var journal := Journal.new()
	if not journal.load_from("ga020_ns"):
		journal.entries = {}
	var root := PACK_DIR
	var plan: Dictionary = journal.plan_update(manifest.assets, root)
	if (plan["new"] as Array).size() != 11:
		failures.append("update plan new=%d (want 11), conflicts=%s missing=%s" % [
			(plan["new"] as Array).size(), str(plan["conflicts"]), str(plan["missing"])
		])
	report_completed = true  # last statement: a mid-fn abort leaves it unset


func _finish() -> void:
	if not report_completed:
		failures.append("report section aborted before completion (runtime error swallowed)")
	if failures.is_empty():
		print("GA020_GODOT_REPORT_OK assets=11 files=11 textures=11")
		quit(0)
	else:
		for failure in failures:
			printerr("GA020 GODOT FAIL: %s" % failure)
		quit(1)
