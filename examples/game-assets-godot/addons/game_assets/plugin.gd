@tool
extends EditorPlugin

const GAME_ASSETS_PANEL := preload("res://addons/game_assets/panel.tscn")

var _panel: Control

func _enter_tree() -> void:
	_panel = GAME_ASSETS_PANEL.instantiate()
	add_control_to_dock(DOCK_SLOT_RIGHT_BL, _panel)

func _exit_tree() -> void:
	if _panel:
		remove_control_from_docks(_panel)
		_panel.queue_free()
