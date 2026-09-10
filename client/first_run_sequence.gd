class_name FirstRunSequence
extends RefCounted
## FirstRunSequence — orchestrates the first-run sequence (T-0120).
##
## Drives 18-first-run.md §1-4's ordering: New Game -> identity created
## (POST /v1/identity, T-0094) -> phrase-reveal screen (unskippable) ->
## offline notice if unreachable -> drop into the calm entry room -> baseline
## exploration window -> one-time chroma/clock explanation.
##
## This class owns only the state machine and its signals; HTTP transport is
## the caller-supplied NoteClient (setup()), phrase persistence is
## IdentityStore (T-0066), and ongoing reachability tracking during play is
## the caller's OfflineModeController (T-0067) — bridge its
## server_reachable_changed signal to notify_reachability() so the
## during-play offline indicator (AC5) stays current.
##
## Usage:
##   var seq := FirstRunSequence.new()
##   seq.setup(note_client)
##   seq.phrase_reveal_ready.connect(_on_phrase_reveal_ready)
##   seq.offline_notice_required.connect(_on_offline_notice_required)
##   seq.entry_room_ready.connect(_on_entry_room_ready)
##   seq.chroma_explanation_ready.connect(_on_chroma_explanation_ready)
##   seq.session_end_offline_recap.connect(_on_session_end_offline_recap)
##   seq.offline_indicator_changed.connect(_on_offline_indicator_changed)
##   seq.start_new_game()
##   # ... player acknowledges the phrase screen (and offline notice, if shown) ...
##   seq.acknowledge_phrase()
##   seq.acknowledge_offline()
##   # ... every frame in the entry room ...
##   seq.tick(delta)
##   # ... on session teardown ...
##   seq.end_session()

const IdentityStore := preload("res://identity_store.gd")

## Baseline exploration window (seconds) before the chroma/clock explanation
## is allowed to fire (18-first-run.md §3 — "a few minutes"; exact tuning is
## still FR-3, open). The player must have seen the un-drifted palette first.
const BASELINE_EXPLORATION_SECS: float = 180.0

## Pre-play offline notice (18-first-run.md §4). Same weight-class as the
## phrase screen but a warning, not a rite.
const OFFLINE_NOTICE_TEXT: String = (
	"This universe can't be reached. Nothing that happens here will be remembered."
)

## Session-end recap shown when the session ends while still offline
## (18-first-run.md §4) — prevents a player from reading an unrecorded run as
## a bug.
const SESSION_END_OFFLINE_RECAP_TEXT: String = (
	"This session was never connected to the server. Nothing that happened here was saved."
)

## One-time chroma/clock explanation (18-first-run.md §3). Never states a
## number — the palette drift itself is the only clock.
const CHROMA_EXPLANATION_TEXT: String = (
	"The color of this place isn't decoration. Watch how it changes "
	+ "— that's your only clock, and it never lies."
)

## States of the first-run sequence.
enum State {
	AWAITING_IDENTITY, ## Waiting on POST /v1/identity to complete.
	PHRASE_REVEAL,     ## Phrase saved; screen unskippable until acknowledge_phrase().
	OFFLINE_NOTICE,    ## Identity request found the server unreachable.
	IN_ENTRY_ROOM,     ## Dropped into the calm entry room; baseline window running.
	ENDED,             ## Session has ended.
}

## Emitted once the phrase has been saved to disk and the phrase-reveal
## screen should be shown. `notice_text` names both loss modes distinctly
## (09-identity.md §3a) and already has the save path substituted in.
## @param phrase       The server-issued seed phrase.
## @param notice_text  Full first-run notice copy, ready to display verbatim.
## @param saved_path   OS-level absolute path the phrase was saved to.
signal phrase_reveal_ready(phrase: String, notice_text: String, saved_path: String)

## Emitted when the identity request reached the server but creation failed
## (HTTP 4xx/5xx) — distinct from an unreachable server. No phrase exists.
## @param state        A NoteClient.State value.
## @param http_status  The raw HTTP status code.
signal identity_failed(state: int, http_status: int)

## Emitted when the identity request could not reach the server at all.
## Blocks continuing until acknowledge_offline() is called.
## @param notice_text  Player-readable offline warning.
signal offline_notice_required(notice_text: String)

## Emitted when the player drops into the calm entry room, whether that came
## from acknowledging the phrase screen or the offline notice.
signal entry_room_ready()

## Emitted exactly once, after the baseline exploration window elapses while
## in the entry room. Never fires before entry_room_ready.
## @param text  The one-time chroma/clock explanation copy (no numbers).
signal chroma_explanation_ready(text: String)

## Emitted by end_session() when the session ends while still offline.
## @param text  Player-readable recap stating nothing was saved.
signal session_end_offline_recap(text: String)

## Emitted when the persistent, non-diegetic offline indicator should change
## visibility. Driven by notify_reachability() — wire a live
## OfflineModeController's server_reachable_changed signal to it.
## @param visible  True when the indicator should be shown (unreachable).
signal offline_indicator_changed(visible: bool)

var _state: State = State.AWAITING_IDENTITY
var _reachable: bool = true
var _phrase_path: String = IdentityStore.PHRASE_FILE
var _note_client: NoteClient = null
var _baseline_elapsed: float = 0.0
var _chroma_shown: bool = false


## Wire this sequence to a NoteClient. Call once before start_new_game().
## @param client  Configured NoteClient node.
func setup(client: NoteClient) -> void:
	_note_client = client
	client.identity_received.connect(_on_identity_received)


## Override the phrase save path. Defaults to IdentityStore.PHRASE_FILE;
## tests use this to avoid touching the production save file.
func set_phrase_path(path: String) -> void:
	_phrase_path = path


## Current state of the sequence.
func get_state() -> State:
	return _state


## True if the most recent identity/reachability signal indicated the server
## was reachable. Starts optimistic (true) until proven otherwise.
func is_server_reachable() -> bool:
	return _reachable


## Begin the first-run sequence: request a new identity from the server.
## No-op (with a push_error) if not in AWAITING_IDENTITY.
func start_new_game() -> void:
	if _state != State.AWAITING_IDENTITY:
		push_error("FirstRunSequence.start_new_game: called in state %d — ignoring" % _state)
		return
	_note_client.request_identity()


## Acknowledge the phrase-reveal screen. The only way to leave PHRASE_REVEAL —
## no other method advances past it (18-first-run.md §2). No-op otherwise.
func acknowledge_phrase() -> void:
	if _state != State.PHRASE_REVEAL:
		return
	_enter_room()


## Acknowledge the pre-play offline notice. The only way to leave
## OFFLINE_NOTICE. No-op otherwise.
func acknowledge_offline() -> void:
	if _state != State.OFFLINE_NOTICE:
		return
	_enter_room()


## Advance the baseline exploration timer while in the entry room. A no-op
## outside IN_ENTRY_ROOM or once the chroma explanation has already fired —
## guarantees it fires at most once and never before the room is reached.
## @param delta  Seconds elapsed since the last tick.
func tick(delta: float) -> void:
	if _state != State.IN_ENTRY_ROOM or _chroma_shown:
		return
	_baseline_elapsed += delta
	if _baseline_elapsed >= BASELINE_EXPLORATION_SECS:
		_chroma_shown = true
		chroma_explanation_ready.emit(CHROMA_EXPLANATION_TEXT)


## Report a reachability transition observed during play (bridge from
## OfflineModeController.server_reachable_changed). Emits
## offline_indicator_changed only on an actual change (AC5).
## @param reachable  True if the server is currently reachable.
func notify_reachability(reachable: bool) -> void:
	if reachable == _reachable:
		return
	_reachable = reachable
	offline_indicator_changed.emit(not reachable)


## Conclude the session. Emits session_end_offline_recap if the session ends
## while still offline (18-first-run.md §4). No-op if already ENDED.
func end_session() -> void:
	if _state == State.ENDED:
		return
	if not _reachable:
		session_end_offline_recap.emit(SESSION_END_OFFLINE_RECAP_TEXT)
	_state = State.ENDED


func _enter_room() -> void:
	_state = State.IN_ENTRY_ROOM
	_baseline_elapsed = 0.0
	_chroma_shown = false
	entry_room_ready.emit()


func _build_phrase_notice_text() -> String:
	return IdentityStore.FIRST_RUN_NOTICE.replace("[path]", IdentityStore.resolve_path(_phrase_path))


func _on_identity_received(state: int, http_status: int, phrase: String) -> void:
	# Ignore a stale/duplicate response after the sequence has already moved on.
	if _state != State.AWAITING_IDENTITY:
		return

	match state:
		NoteClient.STATE_OK:
			if phrase.is_empty():
				identity_failed.emit(state, http_status)
				return
			_reachable = true
			# Save BEFORE emitting — the phrase-reveal screen must never be
			# shown ahead of the file actually landing on disk (AC1).
			IdentityStore.save_phrase(phrase, _phrase_path)
			_state = State.PHRASE_REVEAL
			phrase_reveal_ready.emit(
				phrase, _build_phrase_notice_text(), IdentityStore.resolve_path(_phrase_path)
			)
		NoteClient.STATE_TIMEOUT, NoteClient.STATE_NETWORK_ERROR:
			# No phrase could be minted at all — skip straight to the offline
			# notice rather than fabricating a phrase-reveal screen.
			_reachable = false
			_state = State.OFFLINE_NOTICE
			offline_notice_required.emit(OFFLINE_NOTICE_TEXT)
		_:
			# HTTP 4xx/5xx: the server responded, so it is reachable, but
			# identity creation itself failed.
			_reachable = true
			identity_failed.emit(state, http_status)
