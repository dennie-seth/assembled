class_name BlockingNoticeScreen
extends CanvasLayer
## BlockingNoticeScreen — shared full-screen, unskippable notice UI (T-0120).
##
## Backs both the phrase-reveal screen (18-first-run.md §2) and the pre-play
## offline notice (§4): a full-rect background, a notice label, and exactly
## one way out — the acknowledgment button. ui_cancel/Escape and an OS
## window-close request are both defeated while a screen built from this
## class is showing (AC8) — there is no dismiss/continue shortcut.
##
## Placeholder visuals only — 18-first-run.md §10 FR-4 leaves the final
## styling open. What matters here is that something is rendered at all.

## Emitted when the player performs the single explicit acknowledgment action.
signal acknowledged()

## Text of the acknowledgment button. Set before build_ui() runs to
## customize it — e.g. the offline notice uses "[ Continue anyway ]" while
## the phrase screen keeps the default "[ I understand ]" (18-first-run.md §2).
@export var acknowledge_button_text: String = "[ I understand ]"

var _label: Label
var _button: Button
var _built: bool = false
var _was_auto_accept_quit: bool = true


func _ready() -> void:
	layer = 100
	process_mode = Node.PROCESS_MODE_ALWAYS
	build_ui()
	_block_window_close(get_tree())


func _exit_tree() -> void:
	_unblock_window_close(get_tree())


## Defeat an OS window-close request while this screen is active — with
## auto_accept_quit off, a close request is simply left unhandled instead of
## quitting the app out from under an unacknowledged notice (AC8). Takes the
## tree explicitly (rather than reading get_tree() internally) so it can be
## unit-tested without needing this node to be part of a live SceneTree.
func _block_window_close(tree: SceneTree) -> void:
	if tree:
		_was_auto_accept_quit = tree.auto_accept_quit
		tree.auto_accept_quit = false


## Undo _block_window_close(). See its docs for why the tree is a parameter.
func _unblock_window_close(tree: SceneTree) -> void:
	if tree:
		tree.auto_accept_quit = _was_auto_accept_quit


## Build the background, notice label, and acknowledgment button. Idempotent,
## and safe to call directly without adding this node to a live SceneTree —
## tests use this path rather than depending on add_child()-triggered
## _ready() timing (see test_chroma_shader.gd's design note on the same
## hazard in this headless test harness).
func build_ui() -> void:
	if _built:
		return
	_built = true

	var root := Control.new()
	root.name = "Root"
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(root)

	var background := ColorRect.new()
	background.name = "Background"
	background.set_anchors_preset(Control.PRESET_FULL_RECT)
	background.color = Color(0.03, 0.03, 0.05, 1.0)
	root.add_child(background)

	_label = Label.new()
	_label.name = "NoticeLabel"
	_label.set_anchors_preset(Control.PRESET_FULL_RECT)
	_label.offset_left = 24.0
	_label.offset_top = 24.0
	_label.offset_right = -24.0
	_label.offset_bottom = -48.0
	_label.autowrap_mode = TextServer.AUTOWRAP_WORD
	_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	root.add_child(_label)

	_button = Button.new()
	_button.name = "AcknowledgeButton"
	_button.text = acknowledge_button_text
	_button.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_button.offset_left = -80.0
	_button.offset_right = 80.0
	_button.offset_top = -32.0
	_button.offset_bottom = -8.0
	_button.pressed.connect(_on_acknowledge_pressed)
	root.add_child(_button)


## Set the notice copy displayed to the player. Builds the UI first if
## build_ui() has not already run.
func set_notice_text(text: String) -> void:
	build_ui()
	_label.text = text


func _on_acknowledge_pressed() -> void:
	acknowledged.emit()


## Swallow ui_cancel/Escape — this screen has exactly one way out: the
## acknowledgment button above (AC8).
func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		var vp := get_viewport()
		if vp:
			vp.set_input_as_handled()
