class_name FirstRunController
extends Node
## FirstRunController — the "New Game" entry point (T-0120 RE-SCOPE).
##
## FirstRunSequence (client/first_run_sequence.gd) is a pure state machine
## with no way for a player to ever see it — nothing constructed it, and
## nothing rendered anything it emitted. This class is that wiring: it owns
## the NoteClient + OfflineModeController the sequence needs, and drives the
## presentation layer (three BlockingNoticeScreens — phrase, offline notice,
## and identity/save error — one OfflineIndicator, and a TransientNotice for
## each of the chroma explanation and the session-end recap) off the
## sequence's signals (18-first-run.md §1-4).
##
## Two things beyond the sequence's own signals are this class's
## responsibility, not the state machine's:
##   - A periodic liveness probe (HEARTBEAT_INTERVAL_SECS) on the owned
##     NoteClient while in the entry room, so OfflineModeController's
##     server_reachable_changed actually has a producer during play (AC5) —
##     without this, the during-play indicator would only ever reflect
##     whatever was true at the moment the room was entered.
##   - Holding an OS close request open long enough to show the session-end
##     recap when ending offline (AC6), then completing the quit once it's
##     dismissed. FirstRunSequence.end_session() has no caller of its own;
##     this is the real lifecycle trigger for it.
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

## Placeholder liveness interval (seconds) driving the during-play offline
## indicator (AC5) via a lightweight GET /v1/notes probe on the owned
## NoteClient. Exact tuning is open, the same way FirstRunSequence's own
## BASELINE_EXPLORATION_SECS is — a dedicated heartbeat endpoint
## (POST /v1/session/heartbeat, 03-net-protocol.md §5) would replace this
## once the client has a session layer to hang it off; there isn't one yet,
## and OfflineModeController listens for NoteClient.notes_fetched
## specifically (offline_mode.gd:44-45), so this reuses that channel. The
## archetype/tag/limit arguments are placeholders — only the completion
## state matters here, never the response body.
const HEARTBEAT_INTERVAL_SECS: float = 10.0

## Default chroma-marker path used by configure_for_test() when the caller
## doesn't supply one. Exposed so tests can clean it up between runs — see
## configure_for_test()'s docs for why every test-built controller must
## avoid the real FirstRunSequence.CHROMA_SHOWN_FILE default.
const DEFAULT_TEST_CHROMA_MARKER_PATH := "user://test_T0120_default_chroma_marker.marker"

var _sequence: FirstRunSequence
var _note_client: NoteClient
var _offline_mode: OfflineModeController
var _phrase_screen: BlockingNoticeScreen
var _offline_screen: BlockingNoticeScreen
var _error_screen: BlockingNoticeScreen
var _indicator: OfflineIndicator
var _chroma_notice: TransientNotice
var _recap_notice: TransientNotice
var _phrase_path: String = IdentityStore.PHRASE_FILE
var _chroma_marker_path: String = FirstRunSequence.CHROMA_SHOWN_FILE
var _heartbeat_elapsed: float = 0.0
var _pending_quit: bool = false
var _was_auto_accept_quit: bool = true


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
	_sequence.set_chroma_marker_path(_chroma_marker_path)
	_sequence.setup(_note_client)
	_sequence.phrase_reveal_ready.connect(_on_phrase_reveal_ready)
	_sequence.identity_failed.connect(_on_identity_failed)
	_sequence.phrase_save_failed.connect(_on_phrase_save_failed)
	_sequence.offline_notice_required.connect(_on_offline_notice_required)
	_sequence.entry_room_ready.connect(_on_entry_room_ready)
	_sequence.chroma_explanation_ready.connect(_on_chroma_explanation_ready)
	_sequence.session_end_offline_recap.connect(_on_session_end_offline_recap)
	_offline_mode.server_reachable_changed.connect(_sequence.notify_reachability)

	_indicator = OfflineIndicator.new()
	_indicator.build_ui()
	add_child(_indicator)
	_sequence.offline_indicator_changed.connect(_indicator.set_visible_offline)


## Override the phrase save path and chroma-marker path before initialize()
## runs, and the NoteClient's base URL/timeout once it exists. Test-only
## hook — production callers never need it (defaults apply). An explicit
## per-test chroma_marker_path matters even for tests that don't care about
## the chroma explanation: user:// files persist on disk between separate
## `godot --headless` invocations, so leaving this at its production default
## would let one test run's baseline-window crossing leak into every other
## test (and every other test *file*) that also leaves it at the default.
func configure_for_test(
		phrase_path: String,
		base_url: String,
		timeout_ms: int = 0,
		chroma_marker_path: String = DEFAULT_TEST_CHROMA_MARKER_PATH
) -> void:
	_phrase_path = phrase_path
	_chroma_marker_path = chroma_marker_path
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


func get_error_screen() -> BlockingNoticeScreen:
	return _error_screen


func get_offline_indicator() -> OfflineIndicator:
	return _indicator


func get_chroma_notice() -> TransientNotice:
	return _chroma_notice


func get_recap_notice() -> TransientNotice:
	return _recap_notice


## True while an OS close request is being held open pending dismissal of
## the session-end recap it triggered (AC6). False the rest of the time,
## including once the recap has been dismissed and the quit has completed.
func is_close_request_pending() -> bool:
	return _pending_quit


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
	if _sequence == null:
		return
	_sequence.tick(delta)

	if _sequence.get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		return
	_heartbeat_elapsed += delta
	if _heartbeat_elapsed >= HEARTBEAT_INTERVAL_SECS:
		_heartbeat_elapsed = 0.0
		_note_client.fetch_notes(0, 0, 1)


## Handle an OS close request (AC6). Ends the session; if that leaves a
## recap on screen (the session was offline), holds the quit open until the
## player dismisses it. Otherwise completes immediately — there is nothing
## to show for a session that was never unsaved.
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_handle_close_request()


func _handle_close_request() -> void:
	if _sequence == null or _sequence.get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		# Nothing to recap outside the entry room — either still on a
		# blocking screen (which is already holding the quit open itself,
		# see BlockingNoticeScreen._block_window_close()) or the session has
		# already ended. Let the OS close normally.
		return

	# is_inside_tree() guards get_tree() the same way BlockingNoticeScreen's
	# own window-close handling does — a controller built directly for a
	# test (see FirstRunController.configure_for_test()) is never added to a
	# live SceneTree, and get_tree() on a node outside one is an engine
	# error, not a null it fails quietly on.
	var tree: SceneTree = get_tree() if is_inside_tree() else null
	if tree:
		_was_auto_accept_quit = tree.auto_accept_quit
		tree.auto_accept_quit = false
	_pending_quit = true

	end_session()

	if _recap_notice == null:
		# Online — nothing to show; complete the quit immediately.
		_finish_close_request()


func _finish_close_request() -> void:
	_pending_quit = false
	var tree: SceneTree = get_tree() if is_inside_tree() else null
	if tree:
		tree.auto_accept_quit = _was_auto_accept_quit
		tree.quit()


func _on_phrase_reveal_ready(phrase: String, notice_text: String, _saved_path: String) -> void:
	_phrase_screen = BlockingNoticeScreen.new()
	_phrase_screen.build_ui()
	# The phrase itself, in its own control — distinct from the warning copy
	# below, which only ever talks about the phrase (Codex re-review,
	# 2026-09-11). save_phrase() has already succeeded by the time
	# phrase_reveal_ready fires (FirstRunSequence._on_identity_received()),
	# so save-before-display ordering holds regardless of this call order.
	_phrase_screen.set_phrase_text(phrase)
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
	# Seed OfflineModeController with what the sequence already knows about
	# reachability (from the launch-time identity request outcome, which
	# OfflineModeController never observes on its own — it only listens to
	# NoteClient.notes_fetched, driven by the heartbeat below). Without this,
	# the two would start out of sync whenever the launch was offline, and
	# the first successful heartbeat would look like "no change" from
	# OfflineModeController's point of view and never emit
	# server_reachable_changed at all — pinning the indicator (and a false
	# session-end recap) for the rest of the session even once genuinely
	# back online (AC5/AC6).
	_offline_mode.seed_reachable(_sequence.is_server_reachable())
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
	if _pending_quit:
		_recap_notice.dismissed.connect(_finish_close_request)


## identity_failed (4xx/5xx) and phrase_save_failed both leave
## FirstRunSequence in a dead end with no consumer otherwise — see
## acknowledge_error()'s docs. Reuses BlockingNoticeScreen at the same
## "warning, continue anyway" weight class as the offline notice, since
## there is nothing more specific to offer the player and no retry path.
func _on_identity_failed(state: int, http_status: int) -> void:
	if state == NoteClient.STATE_OK:
		# Reached the server, got a 2xx, but the body had no parseable
		# phrase — a malformed response, not a rejected request. HTTP status
		# would just be a misleading "201" here, so don't quote it.
		_show_error_screen(
			"The server's response didn't include an identity. Nothing has been saved for this session — you can continue, but this session's progress won't be recorded."
		)
		return
	_show_error_screen(
		"The server couldn't create your identity (HTTP %d). Nothing has been saved for this session — you can continue, but this session's progress won't be recorded."
		% http_status
	)


func _on_phrase_save_failed(_phrase: String, attempted_path: String) -> void:
	_show_error_screen(
		"Your phrase couldn't be saved to %s. Nothing has been saved for this session — you can continue, but this session's progress won't be recorded."
		% attempted_path
	)


func _show_error_screen(notice_text: String) -> void:
	_error_screen = BlockingNoticeScreen.new()
	_error_screen.acknowledge_button_text = "[ Continue anyway ]"
	_error_screen.build_ui()
	_error_screen.set_notice_text(notice_text)
	_error_screen.acknowledged.connect(_on_error_acknowledged)
	add_child(_error_screen)


func _on_error_acknowledged() -> void:
	_sequence.acknowledge_error()
	_error_screen.queue_free()
	_error_screen = null
