class_name TransientNotice
extends CanvasLayer
## TransientNotice — lightweight, non-blocking one-time text display (T-0120).
##
## Backs the chroma/clock explanation (18-first-run.md §3, AC7) and the
## session-end-still-offline recap (§4, AC6). Unlike BlockingNoticeScreen,
## these are notes, not rites: they don't gate anything, and they don't
## defeat ui_cancel or window-close — any key or click press dismisses one.
##
## Placeholder visuals only — 18-first-run.md §10 FR-4 leaves final styling
## open for first-run UI in general.

var _label: Label
var _built: bool = false


func _ready() -> void:
	layer = 95
	build_ui()


## Build the notice label. Idempotent, and safe to call directly without
## adding this node to a live SceneTree — see BlockingNoticeScreen.build_ui()
## for why tests use this path instead of depending on add_child()-triggered
## _ready() timing.
func build_ui() -> void:
	if _built:
		return
	_built = true

	_label = Label.new()
	_label.name = "NoticeLabel"
	_label.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_label.offset_left = -160.0
	_label.offset_right = 160.0
	_label.offset_top = -56.0
	_label.offset_bottom = -16.0
	_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_label.autowrap_mode = TextServer.AUTOWRAP_WORD
	add_child(_label)

	visible = false


## Display @a text. Builds the UI first if build_ui() has not already run.
func show_text(text: String) -> void:
	build_ui()
	_label.text = text
	visible = true


## Hide immediately.
func hide_notice() -> void:
	build_ui()
	visible = false


## Dismiss on any key or mouse-button press — a note the player can clear by
## just continuing to play, not a rite requiring a specific action.
func _unhandled_input(event: InputEvent) -> void:
	if not visible:
		return
	if (event is InputEventKey or event is InputEventMouseButton) and event.is_pressed():
		hide_notice()
