@tool
extends Control
## Editor dock: pick an unpacked pack directory, preflight the manifest,
## import into the managed namespace, and read the report.

const Importer := preload("res://addons/game_assets/importer.gd")

var _path_edit: LineEdit
var _log: RichTextLabel

func _ready() -> void:
	var layout := VBoxContainer.new()
	add_child(layout)

	var row := HBoxContainer.new()
	layout.add_child(row)
	_path_edit = LineEdit.new()
	_path_edit.placeholder_text = "Path to the unpacked pack root (contains manifest.json)"
	_path_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(_path_edit)
	var browse := Button.new()
	browse.text = "…"
	browse.pressed.connect(_on_browse)
	row.add_child(browse)

	var buttons := HBoxContainer.new()
	layout.add_child(buttons)
	var preflight := Button.new()
	preflight.text = "Preflight"
	preflight.pressed.connect(_on_preflight)
	buttons.add_child(preflight)
	var import_button := Button.new()
	import_button.text = "Import"
	import_button.pressed.connect(_on_import)
	buttons.add_child(import_button)

	_log = RichTextLabel.new()
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_log.scroll_following = true
	layout.add_child(_log)

func _on_browse() -> void:
	var dialog := FileDialog.new()
	dialog.file_mode = FileDialog.FILE_MODE_OPEN_DIR
	dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.current_dir = ProjectSettings.globalize_path("res://")
	dialog.dir_selected.connect(func(dir: String) -> void: _path_edit.text = dir)
	add_child(dialog)
	dialog.popup_centered(Vector2i(800, 500))

func _on_preflight() -> void:
	var manifest := Importer.Manifest.new()
	var ok := manifest.load_from_file(_pack_dir().path_join("manifest.json"))
	_log.clear()
	_log.append_text("preflight: %s\n" % ("OK" if ok else "FAILED"))
	for problem in manifest.problems:
		_log.append_text("  - %s\n" % problem)

func _on_import() -> void:
	var importer := Importer.new()
	importer.progress.connect(func(message: String) -> void: _log.append_text(message + "\n"))
	var ok := importer.import_pack(_pack_dir())
	_log.clear()
	_log.append_text("import: %s\n" % ("OK" if ok else "FAILED"))
	for line in importer.report:
		_log.append_text(line + "\n")

func _pack_dir() -> String:
	var text := _path_edit.text.strip_edges()
	if text.begins_with("res://") or text.begins_with("user://"):
		return text
	return ProjectSettings.globalize_path(text)
