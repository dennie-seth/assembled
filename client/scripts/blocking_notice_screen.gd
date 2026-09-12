class_name BlockingNoticeScreen
extends CanvasLayer
## BlockingNoticeScreen — shared full-screen, unskippable notice UI (T-0120).
##
## Backs both the phrase-reveal screen (18-first-run.md §2) and the pre-play
## offline notice (§4): a full-rect background, a scrollable notice label,
## and exactly one way out — the acknowledgment button. ui_cancel/Escape and
## an OS window-close request are both defeated while a screen built from
## this class is showing (AC8) — there is no dismiss/continue shortcut.
##
## The notice label lives inside a ScrollContainer rather than a fixed-size
## Label (Codex re-review, 2026-09-11): at the game's 384x216 logical
## viewport, the full first-run notice copy — longer still with a real save
## path substituted in — does not fit in a fixed box, and a Label's
## autowrap-driven minimum size overrides any anchor-imposed size that's too
## small for it, pushing text down over the acknowledgment button instead of
## clipping. The ScrollContainer reserves the button its own area at the
## bottom that the scrollable region never extends into, and makes the rest
## of the copy reachable by scrolling instead of silently unreadable.
##
## Placeholder visuals only — 18-first-run.md §10 FR-4 leaves the final
## styling open. What matters here is that something is rendered at all.

## Emitted when the player performs the single explicit acknowledgment action.
signal acknowledged()

## Text of the acknowledgment button. Set before build_ui() runs to
## customize it — e.g. the offline notice uses "[ Continue anyway ]" while
## the phrase screen keeps the default "[ I understand ]" (18-first-run.md §2).
@export var acknowledge_button_text: String = "[ I understand ]"

## Height (px) reserved at the bottom of the screen for the acknowledgment
## button — the scrollable notice area stops short of this by this much, so
## the two can never overlap regardless of how tall the notice copy wraps to.
const BUTTON_AREA_HEIGHT: float = 48.0

var _scroll: ScrollContainer
var _content: VBoxContainer
var _phrase_label: Label
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


## Build the background, scrollable notice area, and acknowledgment button.
## Idempotent, and safe to call directly without adding this node to a live
## SceneTree — tests use this path rather than depending on
## add_child()-triggered _ready() timing (see test_chroma_shader.gd's design
## note on the same hazard in this headless test harness).
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

	_scroll = ScrollContainer.new()
	_scroll.name = "Scroll"
	_scroll.set_anchors_preset(Control.PRESET_FULL_RECT)
	_scroll.offset_left = 16.0
	_scroll.offset_top = 16.0
	_scroll.offset_right = -16.0
	_scroll.offset_bottom = -BUTTON_AREA_HEIGHT
	# Only vertical scrolling is ever needed — disabling the horizontal axis
	# is also what makes ScrollContainer stretch Content to the container's
	# width instead of leaving it at its natural (unwrapped) minimum width.
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	root.add_child(_scroll)

	_content = VBoxContainer.new()
	_content.name = "Content"
	_content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_content.add_theme_constant_override("separation", 12)
	_scroll.add_child(_content)

	_label = Label.new()
	_label.name = "NoticeLabel"
	_label.autowrap_mode = TextServer.AUTOWRAP_WORD
	_content.add_child(_label)

	_button = Button.new()
	_button.name = "AcknowledgeButton"
	_button.text = acknowledge_button_text
	_button.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_button.offset_left = -80.0
	_button.offset_right = 80.0
	_button.offset_top = -40.0
	_button.offset_bottom = -8.0
	_button.pressed.connect(_on_acknowledge_pressed)
	root.add_child(_button)


## Set the notice copy displayed to the player. Builds the UI first if
## build_ui() has not already run.
func set_notice_text(text: String) -> void:
	build_ui()
	_label.text = text


## Display @a phrase in its own dedicated control, visually distinct from the
## warning copy set via set_notice_text() (Codex re-review, 2026-09-11: the
## phrase-reveal screen must show the phrase itself, not just talk about it).
## Only the phrase-reveal screen calls this — the offline and error screens
## never do, and have no phrase label as a result. Builds the UI first if
## build_ui() has not already run, and inserts the phrase above the notice
## text on first call.
func set_phrase_text(phrase: String) -> void:
	build_ui()
	if _phrase_label == null:
		_phrase_label = Label.new()
		_phrase_label.name = "PhraseLabel"
		_phrase_label.autowrap_mode = TextServer.AUTOWRAP_WORD
		_phrase_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_phrase_label.add_theme_font_size_override("font_size", 20)
		_content.add_child(_phrase_label)
		_content.move_child(_phrase_label, 0)
	_phrase_label.text = phrase


## The scrollable container the notice/phrase labels live in. Test-only
## accessor, mirroring the getters this class already exposes for its other
## nodes.
func get_scroll_container() -> ScrollContainer:
	return _scroll


## The warning-copy label. Test-only accessor.
func get_notice_label() -> Label:
	return _label


## The phrase-display label, or null if set_phrase_text() has never been
## called. Test-only accessor.
func get_phrase_label() -> Label:
	return _phrase_label


func _on_acknowledge_pressed() -> void:
	acknowledged.emit()


## Swallow ui_cancel/Escape — this screen has exactly one way out: the
## acknowledgment button above (AC8).
func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		var vp := get_viewport()
		if vp:
			vp.set_input_as_handled()
