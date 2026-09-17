class_name OfflineIndicator
extends CanvasLayer
## OfflineIndicator — small persistent, non-diegetic during-play offline
## indicator (T-0120 AC5; 18-first-run.md §4).
##
## The one deliberate exception to the no-HUD aspiration. Visual spec is
## still open (18-first-run.md §10 FR-4) — this is a placeholder label, not
## final art. Bind FirstRunSequence.offline_indicator_changed to
## set_visible_offline() to keep it current.

var _label: Label
var _built: bool = false


func _ready() -> void:
	layer = 90
	build_ui()


## Build the placeholder label and start hidden. Idempotent, and safe to call
## directly without adding this node to a live SceneTree — see
## BlockingNoticeScreen.build_ui() for why tests use this path instead of
## depending on add_child()-triggered _ready() timing.
func build_ui() -> void:
	if _built:
		return
	_built = true

	_label = Label.new()
	_label.name = "OfflineLabel"
	_label.text = "OFFLINE — nothing here will be saved"
	_label.position = Vector2(4.0, 196.0)
	_label.add_theme_font_size_override("font_size", 8)
	_label.modulate = Color(1.0, 0.55, 0.2)
	add_child(_label)

	visible = false


## Show or hide the indicator. Bind to FirstRunSequence.offline_indicator_changed.
func set_visible_offline(offline_visible: bool) -> void:
	build_ui()
	visible = offline_visible
