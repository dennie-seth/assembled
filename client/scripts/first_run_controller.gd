class_name FirstRunController
extends Node
## FirstRunController — the "New Game" entry point (T-0120 RE-SCOPE).
##
## FirstRunSequence (client/first_run_sequence.gd) is a pure state machine
## with no way for a player to ever see it — nothing constructed it, and
## nothing rendered anything it emitted. This class is that wiring: it owns
## the NoteClient + OfflineModeController the sequence needs, and drives the
## presentation layer (two BlockingNoticeScreens, one OfflineIndicator, and a
## TransientNotice for each of the chroma explanation and the session-end
## recap) off the sequence's signals (18-first-run.md §1-4).
##
## Usage: add as a child of whatever scene should host the first-run flow,
## connect to entry_room_ready to know when it's safe to start normal
## gameplay, then call start_new_game(). See client/scripts/blockout_room.gd
## for the concrete wiring into the client's current main scene.

const FirstRunSequence := preload("res://first_run_sequence.gd")
const IdentityStore := preload("res://identity_store.gd")
const OfflineModeController := preload("res://offline_mode.gd")
const BlockingNoticeScreen := preload("res://scripts/blocking_notice_screen.gd")
const OfflineIndicator := preload("res://scripts/offline_indicator.gd")
const TransientNotice := preload("res://scripts/transient_notice.gd")

## Emitted once every blocking first-run screen has been cleared and the
## player should be dropped into the calm entry room.
signal entry_room_ready()

var _sequence: FirstRunSequence
var _note_client: NoteClient
var _offline_mode: OfflineModeController
var _phrase_screen: BlockingNoticeScreen
var _offline_screen: BlockingNoticeScreen
var _indicator: OfflineIndicator
var _chroma_notice: TransientNotice
var _recap_notice: TransientNotice
var _phrase_path: String = IdentityStore.PHRASE_FILE


func _ready() -> void:
	initialize()


## Construct the sequence, its NoteClient, and the presentation layer.
## Idempotent, and safe to call directly without adding this node to a live
## SceneTree — tests use this path rather than depending on
## add_child()-triggered _ready() timing (see test_chroma_shader.gd's design
## note on the same hazard in this headless test harness).
func initialize() -> void:
	if _sequence != null:
		return

	_note_client = NoteClient.new()
	add_child(_note_client)

	_offline_mode = OfflineModeController.new()
	_offline_mode.attach_note_client(_note_client)

	_sequence = FirstRunSequence.new()
	_sequence.set_phrase_path(_phrase_path)
	_sequence.setup(_note_client)
	_sequence.phrase_reveal_ready.connect(_on_phrase_reveal_ready)
	_sequence.offline_notice_required.connect(_on_offline_notice_required)
	_sequence.entry_room_ready.connect(_on_entry_room_ready)
	_sequence.chroma_explanation_ready.connect(_on_chroma_explanation_ready)
	_sequence.session_end_offline_recap.connect(_on_session_end_offline_recap)
	_offline_mode.server_reachable_changed.connect(_sequence.notify_reachability)

	_indicator = OfflineIndicator.new()
	_indicator.build_ui()
	add_child(_indicator)
	_sequence.offline_indicator_changed.connect(_indicator.set_visible_offline)


## Override the phrase save path before initialize() runs, and the
## NoteClient's base URL/timeout once it exists. Test-only hook — production
## callers never need it (defaults apply).
func configure_for_test(phrase_path: String, base_url: String, timeout_ms: int = 0) -> void:
	_phrase_path = phrase_path
	initialize()
	_note_client.set_base_url(base_url)
	if timeout_ms > 0:
		_note_client.set_timeout_ms(timeout_ms)


func get_note_client() -> NoteClient:
	return _note_client


func get_sequence() -> FirstRunSequence:
	return _sequence


func get_phrase_screen() -> BlockingNoticeScreen:
	return _phrase_screen


func get_offline_screen() -> BlockingNoticeScreen:
	return _offline_screen


func get_offline_indicator() -> OfflineIndicator:
	return _indicator


func get_chroma_notice() -> TransientNotice:
	return _chroma_notice


func get_recap_notice() -> TransientNotice:
	return _recap_notice


## Begin the first-run sequence: request a new identity from the server.
func start_new_game() -> void:
	initialize()
	_sequence.start_new_game()


## Conclude the session — forwards to FirstRunSequence.end_session() so an
## offline session gets its "nothing was saved" recap (AC6).
func end_session() -> void:
	if _sequence != null:
		_sequence.end_session()


func _process(delta: float) -> void:
	if _sequence != null:
		_sequence.tick(delta)


func _on_phrase_reveal_ready(_phrase: String, notice_text: String, _saved_path: String) -> void:
	_phrase_screen = BlockingNoticeScreen.new()
	_phrase_screen.build_ui()
	_phrase_screen.set_notice_text(notice_text)
	_phrase_screen.acknowledged.connect(_on_phrase_acknowledged)
	add_child(_phrase_screen)


func _on_phrase_acknowledged() -> void:
	_sequence.acknowledge_phrase()
	_phrase_screen.queue_free()
	_phrase_screen = null


func _on_offline_notice_required(notice_text: String) -> void:
	_offline_screen = BlockingNoticeScreen.new()
	_offline_screen.acknowledge_button_text = "[ Continue anyway ]"
	_offline_screen.build_ui()
	_offline_screen.set_notice_text(notice_text)
	_offline_screen.acknowledged.connect(_on_offline_acknowledged)
	add_child(_offline_screen)


func _on_offline_acknowledged() -> void:
	_sequence.acknowledge_offline()
	_offline_screen.queue_free()
	_offline_screen = null


func _on_entry_room_ready() -> void:
	entry_room_ready.emit()


func _on_chroma_explanation_ready(text: String) -> void:
	_chroma_notice = TransientNotice.new()
	_chroma_notice.build_ui()
	_chroma_notice.show_text(text)
	add_child(_chroma_notice)


func _on_session_end_offline_recap(text: String) -> void:
	_recap_notice = TransientNotice.new()
	_recap_notice.build_ui()
	_recap_notice.show_text(text)
	add_child(_recap_notice)
