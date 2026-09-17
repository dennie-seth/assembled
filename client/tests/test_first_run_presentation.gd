extends SceneTree
## T-0120 (RE-SCOPE): first-run presentation layer — headless test suite.
##
## Two prior implementer/reviewer cycles left FirstRunSequence (see
## test_first_run_sequence.gd) as a well-factored, fully-tested state machine
## with nothing constructing it and nothing rendering what it emits — "a
## missing layer, not bad code." This file verifies the layer that was
## missing:
##
##   - BlockingNoticeScreen: full-rect anchors (AC2/AC4), a single
##     acknowledgment path, and that ui_cancel/Escape does not dismiss it
##     (AC8) — tested against the screen's actual _unhandled_input handler,
##     not only against FirstRunSequence's own methods, per the reviewer's
##     note that AC8 "can only be verified once a real input layer exists."
##     A window-close request is defeated the same way (auto_accept_quit).
##   - OfflineIndicator: visible exactly while offline (AC5).
##   - TransientNotice: a non-blocking, dismiss-on-any-input note — backs the
##     chroma explanation (AC7) and the session-end-still-offline recap (AC6).
##     Unlike BlockingNoticeScreen these don't gate anything and don't defeat
##     ui_cancel/window-close; a signal firing with nothing rendered from it
##     is the exact class of bug this card exists to close (see AC5's history
##     above), and chroma_explanation_ready/session_end_offline_recap had zero
##     consumers until this pass.
##   - FirstRunController: actually constructs FirstRunSequence and wires it
##     to the screens above end-to-end, reachable from something other than
##     the state machine's own test file (AC1-AC5, AC8), including the exact
##     regression the reviewer flagged: launch offline -> acknowledge_offline
##     -> indicator visible; and now also wires chroma_explanation_ready and
##     session_end_offline_recap to a TransientNotice (AC6, AC7).
##
## Run headless:
##   godot --headless --script tests/test_first_run_presentation.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const BlockingNoticeScreen := preload("res://scripts/blocking_notice_screen.gd")
const OfflineIndicator := preload("res://scripts/offline_indicator.gd")
const TransientNotice := preload("res://scripts/transient_notice.gd")
const FirstRunController := preload("res://scripts/first_run_controller.gd")
const FirstRunSequence := preload("res://first_run_sequence.gd")
const IdentityStore := preload("res://identity_store.gd")

const MOCK_PORT: int = 19996
const DEAD_PORT: int = 19995
## Dedicated port for the heartbeat-drop test, which deliberately stops its
## server mid-test to simulate an outage — kept separate from MOCK_PORT so
## that doesn't affect any test running after it.
const HEARTBEAT_MOCK_PORT: int = 19994
## Dedicated port for the launch-offline-then-recovers test: starts with
## nothing listening (server down at launch), then a mock is started on this
## exact port mid-test to simulate the server coming back up.
const RECOVERY_PORT: int = 19993
## Dedicated port for the identity-failure + heartbeat regression test below.
const UNSAVED_STATE_PORT: int = 19992
const SHORT_TIMEOUT_MS: int = 200
const TEST_PATH := "user://test_T0120_presentation.phrase"


## Minimal TCP mock server (same pattern as test_first_run_sequence.gd — kept
## as an independent copy per-file rather than shared, so a hang in one
## headless script can never be traced to a cross-file dependency, T-0117).
class MockHttpServer:
	var _tcp: TCPServer = TCPServer.new()
	var _pending: Array = []
	var _queue: Array = []

	func listen(port: int) -> bool:
		return _tcp.listen(port, "127.0.0.1") == OK

	func stop() -> void:
		_tcp.stop()

	func queue(status: int, body: String) -> void:
		_queue.append({"status": status, "body": body})

	func pump() -> void:
		while _tcp.is_connection_available():
			_pending.append(_tcp.take_connection())

		var done: Array = []
		for conn: StreamPeerTCP in _pending:
			conn.poll()
			if conn.get_available_bytes() > 0 and _queue.size() > 0:
				var _discard: Array = conn.get_data(conn.get_available_bytes())
				var r: Dictionary = _queue.pop_front()
				_send(conn, r.status, r.body)
				done.append(conn)

		for conn: StreamPeerTCP in done:
			_pending.erase(conn)

	func _send(conn: StreamPeerTCP, status: int, body: String) -> void:
		var status_text := "OK"
		if status >= 500:
			status_text = "Internal Server Error"
		elif status >= 400:
			status_text = "Client Error"
		elif status == 201:
			status_text = "Created"
		var raw: String = (
			"HTTP/1.1 %d %s\r\n"
			+ "Content-Type: application/json\r\n"
			+ "Content-Length: %d\r\n"
			+ "Connection: close\r\n"
			+ "\r\n"
			+ "%s"
		) % [status, status_text, body.length(), body]
		conn.put_data(raw.to_utf8_buffer())


## Accumulated across _init() (synchronous tests) and _process() (the one
## test below that needs a real engine frame for Control layout to resolve —
## see _start_layout_readability_test()'s docs on why that one can't run
## synchronously like every other test in this file).
var _failures: Array[String] = []
var _pending_layout_check: bool = false


func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("NoteClient"):
		printerr("T-0120-presentation FAIL: NoteClient not registered — GDExtension did not load")
		quit(1)
		return

	# user:// files persist on disk between separate `godot --headless`
	# invocations — clean the shared test chroma marker before this run so a
	# leftover from a previous run of this same script can't seed
	# _chroma_shown = true and break _test_controller_chroma_notice_after_baseline.
	if FileAccess.file_exists(FirstRunController.DEFAULT_TEST_CHROMA_MARKER_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(FirstRunController.DEFAULT_TEST_CHROMA_MARKER_PATH))

	failures += _test_full_rect_anchors()
	failures += _test_acknowledge_paths()
	failures += _test_blocks_window_close()
	failures += _test_offline_indicator_visibility()
	failures += _test_transient_notice_show_hide()
	failures += _test_transient_notice_dismiss_on_input()
	failures += _test_transient_notice_dismissed_signal()

	var mock := MockHttpServer.new()
	if not mock.listen(MOCK_PORT):
		printerr("T-0120-presentation FAIL: could not start mock HTTP server on port %d" % MOCK_PORT)
		quit(1)
		return

	failures += _test_controller_shows_phrase_screen_and_relays_entry(mock)
	failures += _test_controller_offline_launch_shows_indicator(mock)
	failures += _test_controller_chroma_notice_after_baseline(mock)
	failures += _test_controller_offline_session_end_recap()
	failures += _test_controller_returning_player_skips_identity_request(mock)
	failures += _test_controller_identity_error_shows_screen_and_continues(mock)
	failures += _test_controller_save_failure_shows_screen_and_continues(mock)
	failures += _test_controller_indicator_follows_midsession_heartbeat_drop()
	failures += _test_controller_indicator_stays_visible_after_offline_launch_heartbeat()
	failures += _test_controller_close_request_recap_then_completes()
	failures += _test_controller_close_request_online_completes_immediately(mock)
	failures += _test_controller_phrase_screen_displays_phrase(mock)
	failures += _test_controller_heartbeat_after_identity_failure_keeps_unsaved_state()

	mock.stop()

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	if FileAccess.file_exists(FirstRunController.DEFAULT_TEST_CHROMA_MARKER_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(FirstRunController.DEFAULT_TEST_CHROMA_MARKER_PATH))

	_failures = failures
	_start_layout_readability_test()


## _process() picks up after _start_layout_readability_test() adds a screen to
## the live tree — Control anchor/offset layout (and therefore autowrap
## height, which is what this test actually needs to measure) does not
## resolve until the engine processes a real frame; see
## _start_layout_readability_test()'s own docs.
func _process(_delta: float) -> bool:
	if not _pending_layout_check:
		return false
	_pending_layout_check = false
	_failures += _finish_layout_readability_test()
	_finish()
	return true


func _finish() -> void:
	if _failures.is_empty():
		print("T-0120-presentation PASS: first-run presentation layer verified")
		quit(0)
	else:
		for f: String in _failures:
			printerr("T-0120-presentation FAIL: " + f)
		quit(1)


## Drive a controller's NoteClient (manually — see the design note in
## test_chroma_shader.gd and FirstRunController.initialize() docs on why
## these headless tests never rely on Node._process() auto-driving anything)
## until predicate() is true or wall-time expires.
func _drive_controller(
		controller: FirstRunController, mock: MockHttpServer, wall_limit_ms: float, predicate: Callable
) -> bool:
	var start_ms: int = Time.get_ticks_msec()
	while float(Time.get_ticks_msec() - start_ms) < wall_limit_ms:
		if mock != null:
			mock.pump()
		controller.get_note_client().tick(0.016)
		if predicate.call():
			return true
		OS.delay_msec(5)
	return false


## ── BlockingNoticeScreen: full-rect anchors (AC2/AC4) ─────────────────────────

func _test_full_rect_anchors() -> Array[String]:
	var failures: Array[String] = []
	var screen := BlockingNoticeScreen.new()
	screen.build_ui()

	var root: Control = screen.get_node("Root")
	if root == null:
		failures.append("full_rect: Root control not found")
	elif (
		root.anchor_left != 0.0 or root.anchor_top != 0.0
		or root.anchor_right != 1.0 or root.anchor_bottom != 1.0
	):
		failures.append(
			"full_rect: Root anchors are not full-rect (left=%f top=%f right=%f bottom=%f)"
			% [root.anchor_left, root.anchor_top, root.anchor_right, root.anchor_bottom]
		)

	var background: Control = screen.get_node("Root/Background")
	if background == null:
		failures.append("full_rect: Background control not found")
	elif (
		background.anchor_left != 0.0 or background.anchor_top != 0.0
		or background.anchor_right != 1.0 or background.anchor_bottom != 1.0
	):
		failures.append("full_rect: Background anchors are not full-rect")

	screen.free()
	return failures


## ── BlockingNoticeScreen: only the button acknowledges; ui_cancel does not ────
## AC8's "no escape via any input" is tested here against the screen's real
## _unhandled_input handler and a real InputEventKey, not only against
## FirstRunSequence's own methods (already covered in test_first_run_sequence.gd).

func _test_acknowledge_paths() -> Array[String]:
	var failures: Array[String] = []
	var screen := BlockingNoticeScreen.new()
	screen.build_ui()

	# A single-element Array, not a plain int: GDScript lambda closures over a
	# local capture value types by value, so a bare `var ack_count := 0` with
	# `func(): ack_count += 1` would silently mutate a copy and never move.
	var ack_count := [0]
	screen.acknowledged.connect(func(): ack_count[0] += 1)

	var esc_event := InputEventKey.new()
	esc_event.keycode = KEY_ESCAPE
	esc_event.pressed = true
	if not esc_event.is_action_pressed("ui_cancel"):
		failures.append("acknowledge_paths: fixture bug — Escape does not resolve to ui_cancel in this project's InputMap")
	screen._unhandled_input(esc_event)
	if ack_count[0] != 0:
		failures.append("acknowledge_paths: ui_cancel/Escape must not emit acknowledged")

	var button: Button = screen.get_node("Root/AcknowledgeButton")
	if button == null:
		failures.append("acknowledge_paths: AcknowledgeButton not found")
	else:
		button.emit_signal("pressed")
		if ack_count[0] != 1:
			failures.append(
				"acknowledge_paths: pressing the acknowledgment button must emit acknowledged exactly once, got %d"
				% ack_count[0]
			)

	screen.free()
	return failures


## ── BlockingNoticeScreen: an OS window-close request is defeated ─────────────

func _test_blocks_window_close() -> Array[String]:
	var failures: Array[String] = []
	var original: bool = self.auto_accept_quit
	self.auto_accept_quit = true

	# Pass this test script's own SceneTree (`self`) directly rather than via
	# get_tree()/Engine.get_main_loop(): during a --script run's own _init(),
	# this SceneTree is not yet registered as the engine's live main loop, so
	# neither of those resolves — exactly why the production code takes the
	# tree as an explicit parameter instead of looking it up internally.
	var screen := BlockingNoticeScreen.new()
	screen.build_ui()
	screen._block_window_close(self)

	if self.auto_accept_quit:
		failures.append("blocks_window_close: auto_accept_quit must be turned off while the screen is active")

	screen._unblock_window_close(self)
	if not self.auto_accept_quit:
		failures.append("blocks_window_close: auto_accept_quit must be restored once the screen is gone")

	self.auto_accept_quit = original
	screen.free()
	return failures


## ── OfflineIndicator: visible exactly while offline (AC5) ────────────────────

func _test_offline_indicator_visibility() -> Array[String]:
	var failures: Array[String] = []
	var indicator := OfflineIndicator.new()
	indicator.build_ui()

	if indicator.visible:
		failures.append("offline_indicator: must start hidden")

	indicator.set_visible_offline(true)
	if not indicator.visible:
		failures.append("offline_indicator: set_visible_offline(true) must show it")

	indicator.set_visible_offline(false)
	if indicator.visible:
		failures.append("offline_indicator: set_visible_offline(false) must hide it")

	indicator.free()
	return failures


## ── FirstRunController: phrase screen appears and relays entry_room_ready ────

func _test_controller_shows_phrase_screen_and_relays_entry(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % MOCK_PORT)

	mock.queue(201, '{"phrase":"one two three four five six seven eight"}')
	controller.start_new_game()
	var completed := _drive_controller(
		controller, mock, 5000.0, func(): return controller.get_phrase_screen() != null
	)

	if not completed:
		failures.append("controller_phrase: phrase screen never appeared within 5 s")
		controller.free()
		return failures

	var screen := controller.get_phrase_screen()
	if not (screen is BlockingNoticeScreen):
		failures.append("controller_phrase: phrase screen is not a BlockingNoticeScreen")

	# Array wrapper, not a plain bool — see _test_acknowledge_paths() for why
	# a bare local captured by a lambda would never actually flip.
	var relayed := [false]
	controller.entry_room_ready.connect(func(): relayed[0] = true)
	screen.acknowledged.emit()

	if not relayed[0]:
		failures.append("controller_phrase: acknowledging the phrase screen must relay entry_room_ready")
	if controller.get_phrase_screen() != null:
		failures.append("controller_phrase: phrase screen must be torn down after acknowledgment")
	if controller.get_sequence().get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		failures.append("controller_phrase: sequence must reach IN_ENTRY_ROOM after acknowledgment")

	controller.free()
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── FirstRunController: the exact AC5 regression, end-to-end ─────────────────
## launch offline -> acknowledge_offline -> indicator visible, through the
## real presentation layer (not just FirstRunSequence's own signals).

func _test_controller_offline_launch_shows_indicator(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % DEAD_PORT, SHORT_TIMEOUT_MS)

	controller.start_new_game()
	var completed := _drive_controller(
		controller, null, 3000.0, func(): return controller.get_offline_screen() != null
	)

	if not completed:
		failures.append("controller_offline: offline screen never appeared within 3 s")
		controller.free()
		return failures

	var screen := controller.get_offline_screen()
	var indicator := controller.get_offline_indicator()
	var relayed := [false]
	controller.entry_room_ready.connect(func(): relayed[0] = true)
	screen.acknowledged.emit()

	if not relayed[0]:
		failures.append("controller_offline: acknowledging the offline notice must relay entry_room_ready")
	if controller.get_offline_screen() != null:
		failures.append("controller_offline: offline screen must be torn down after acknowledgment")
	if indicator == null or not indicator.visible:
		failures.append(
			"controller_offline: offline indicator must be visible on room entry while offline (AC5)"
		)

	controller.free()
	return failures


## ── TransientNotice: shows on demand, hides on demand ─────────────────────────

func _test_transient_notice_show_hide() -> Array[String]:
	var failures: Array[String] = []
	var notice := TransientNotice.new()
	notice.build_ui()

	if notice.visible:
		failures.append("transient_notice: must start hidden")

	notice.show_text("hello")
	if not notice.visible:
		failures.append("transient_notice: show_text() must make it visible")

	notice.hide_notice()
	if notice.visible:
		failures.append("transient_notice: hide_notice() must hide it")

	notice.free()
	return failures


## ── TransientNotice: any key/click input dismisses it, but it doesn't defeat ──
## anything the way BlockingNoticeScreen does — it is a note, not a rite.

func _test_transient_notice_dismiss_on_input() -> Array[String]:
	var failures: Array[String] = []
	var notice := TransientNotice.new()
	notice.build_ui()
	notice.show_text("watch the color")

	var key_event := InputEventKey.new()
	key_event.keycode = KEY_SPACE
	key_event.pressed = true
	notice._unhandled_input(key_event)

	if notice.visible:
		failures.append("transient_notice: any key press must dismiss it")

	notice.free()
	return failures


## ── TransientNotice: emits `dismissed` — the hook FirstRunController's ───────
## close-request handling (AC6) needs to know when it is safe to complete a
## pending OS quit that was held open to show the session-end recap.

func _test_transient_notice_dismissed_signal() -> Array[String]:
	var failures: Array[String] = []
	var notice := TransientNotice.new()
	notice.build_ui()
	notice.show_text("watch the color")

	var dismiss_count := [0]
	notice.dismissed.connect(func(): dismiss_count[0] += 1)

	notice.hide_notice()
	if dismiss_count[0] != 1:
		failures.append("transient_notice_dismissed: hide_notice() must emit dismissed exactly once, got %d" % dismiss_count[0])

	notice.hide_notice()
	if dismiss_count[0] != 1:
		failures.append("transient_notice_dismissed: hiding an already-hidden notice must not re-emit dismissed")

	notice.free()
	return failures


## ── FirstRunController: chroma explanation renders after the baseline ────────
## window elapses (AC7) — chroma_explanation_ready had zero consumers before
## this pass, so the explanation fired but nothing was ever shown.

func _test_controller_chroma_notice_after_baseline(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % MOCK_PORT)

	mock.queue(201, '{"phrase":"alpha beta gamma delta epsilon zeta eta theta"}')
	controller.start_new_game()
	var completed := _drive_controller(
		controller, mock, 5000.0, func(): return controller.get_phrase_screen() != null
	)
	if not completed:
		failures.append("controller_chroma: phrase screen never appeared within 5 s")
		controller.free()
		return failures

	controller.get_phrase_screen().acknowledged.emit()

	if controller.get_chroma_notice() != null:
		failures.append("controller_chroma: must not appear before the baseline window elapses")

	# Drive the sequence's own timer directly rather than waiting 180 s of
	# wall-clock — tick() only cares about accumulated delta, not real time.
	controller.get_sequence().tick(200.0)

	if controller.get_chroma_notice() == null or not controller.get_chroma_notice().visible:
		failures.append("controller_chroma: chroma explanation must be shown once the baseline window elapses")

	controller.free()
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── FirstRunController: session-end recap renders when ending offline (AC6) ──
## session_end_offline_recap had zero consumers before this pass, so the
## recap fired but nothing was ever shown to the player.

func _test_controller_offline_session_end_recap() -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % DEAD_PORT, SHORT_TIMEOUT_MS)

	controller.start_new_game()
	var completed := _drive_controller(
		controller, null, 3000.0, func(): return controller.get_offline_screen() != null
	)
	if not completed:
		failures.append("controller_recap: offline screen never appeared within 3 s")
		controller.free()
		return failures

	controller.get_offline_screen().acknowledged.emit()

	if controller.get_recap_notice() != null:
		failures.append("controller_recap: must not appear before the session actually ends")

	controller.end_session()

	if controller.get_recap_notice() == null or not controller.get_recap_notice().visible:
		failures.append("controller_recap: session-end recap must be shown when ending while offline")

	controller.free()
	return failures


## ── FirstRunController: a returning player (phrase already saved) must ───────
## reach the room with no network round trip and without disturbing the file
## a first controller instance already wrote — the exact AC1 regression the
## reviewer found (save_phrase() truncates on every write).

func _test_controller_returning_player_skips_identity_request(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	# First "launch": mints and saves a phrase.
	var first := FirstRunController.new()
	first.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % MOCK_PORT)
	mock.queue(201, '{"phrase":"return alpha return beta return gamma return delta"}')
	first.start_new_game()
	var minted := _drive_controller(
		first, mock, 5000.0, func(): return first.get_phrase_screen() != null
	)
	if not minted:
		failures.append("controller_returning: first launch never reached the phrase screen within 5 s")
		first.free()
		return failures
	first.get_phrase_screen().acknowledged.emit()
	first.free()

	var saved := IdentityStore.load_phrase(TEST_PATH)

	# "Second launch": a fresh controller, same phrase path, same mock (which
	# has nothing queued) — if this issues a request at all, this test can't
	# tell it apart from a slow server, so the real assertion is synchronous.
	var second := FirstRunController.new()
	second.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % MOCK_PORT)
	second.start_new_game()

	if second.get_sequence().get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		failures.append(
			"controller_returning: second launch expected IN_ENTRY_ROOM synchronously, got %d"
			% second.get_sequence().get_state()
		)
	if second.get_phrase_screen() != null:
		failures.append("controller_returning: second launch must not show the phrase screen again")
	if IdentityStore.load_phrase(TEST_PATH) != saved:
		failures.append("controller_returning: second launch must not modify the already-saved phrase")

	second.free()
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── FirstRunController: identity_failed (4xx/5xx) must not blank-screen ──────
## the player forever. Before this fix, nothing consumed identity_failed, and
## blockout_room.gd's own entry_room_ready gate meant that was a permanent
## blank screen with no way forward.

func _test_controller_identity_error_shows_screen_and_continues(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % MOCK_PORT)

	mock.queue(500, '{"error":0}')
	controller.start_new_game()
	var completed := _drive_controller(
		controller, mock, 5000.0, func(): return controller.get_error_screen() != null
	)
	if not completed:
		failures.append("controller_identity_error: error screen never appeared within 5 s")
		controller.free()
		return failures

	var relayed := [false]
	controller.entry_room_ready.connect(func(): relayed[0] = true)
	controller.get_error_screen().acknowledged.emit()

	if not relayed[0]:
		failures.append("controller_identity_error: acknowledging the error screen must relay entry_room_ready")
	if controller.get_error_screen() != null:
		failures.append("controller_identity_error: error screen must be torn down after acknowledgment")
	if controller.get_sequence().get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		failures.append("controller_identity_error: sequence must reach IN_ENTRY_ROOM after acknowledgment")

	controller.free()
	return failures


## ── FirstRunController: phrase_save_failed must likewise not blank-screen ────

func _test_controller_save_failure_shows_screen_and_continues(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	const BAD_PATH := "user://T0120_presentation_missing_dir/phrase.txt"

	var controller := FirstRunController.new()
	controller.configure_for_test(BAD_PATH, "http://127.0.0.1:%d" % MOCK_PORT)

	mock.queue(201, '{"phrase":"return five return six return seven return eight"}')
	controller.start_new_game()
	var completed := _drive_controller(
		controller, mock, 5000.0, func(): return controller.get_error_screen() != null
	)
	if not completed:
		failures.append("controller_save_error: error screen never appeared within 5 s")
		controller.free()
		return failures

	controller.get_error_screen().acknowledged.emit()

	if controller.get_sequence().get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		failures.append("controller_save_error: sequence must reach IN_ENTRY_ROOM after acknowledgment")

	controller.free()
	return failures


## ── FirstRunController: the offline indicator must follow a REAL mid-session ──
## reachability drop, detected through a periodic heartbeat probe on the
## controller's own NoteClient — not a direct notify_reachability() call.
## Before this fix, OfflineModeController's server_reachable_changed had no
## production emitter at all (it only fires from NoteClient.notes_fetched,
## and nothing ever called fetch_notes() in production), so the indicator was
## frozen at whatever it read on room entry for the entire rest of the
## session. Also proves AC17's converse (Review FAIL, 2026-09-12): for a
## session that was always genuinely saveable (identity minted successfully),
## the warning DOES clear once a later heartbeat proves the network is back —
## the "never clears via heartbeat alone" rule in
## _test_controller_indicator_stays_visible_after_offline_launch_heartbeat()
## applies specifically to a session that was never saveable to begin with.

func _test_controller_indicator_follows_midsession_heartbeat_drop() -> Array[String]:
	var failures: Array[String] = []

	# Its own dedicated mock/port: this test deliberately stops its server
	# mid-test to simulate an outage, which must not affect any test that
	# runs after it and shares the module-level `mock`.
	var heartbeat_mock := MockHttpServer.new()
	if not heartbeat_mock.listen(HEARTBEAT_MOCK_PORT):
		failures.append("controller_heartbeat: could not start dedicated mock HTTP server on port %d" % HEARTBEAT_MOCK_PORT)
		return failures

	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % HEARTBEAT_MOCK_PORT, SHORT_TIMEOUT_MS)

	heartbeat_mock.queue(201, '{"phrase":"heartbeat one heartbeat two heartbeat three heartbeat four"}')
	controller.start_new_game()
	var reached_phrase := _drive_controller(
		controller, heartbeat_mock, 5000.0, func(): return controller.get_phrase_screen() != null
	)
	if not reached_phrase:
		failures.append("controller_heartbeat: phrase screen never appeared within 5 s")
		controller.free()
		heartbeat_mock.stop()
		return failures

	controller.get_phrase_screen().acknowledged.emit()

	var indicator := controller.get_offline_indicator()
	if indicator == null or indicator.visible:
		failures.append("controller_heartbeat: indicator must not be visible while the server is reachable")

	# Take the mock server down to simulate a mid-session outage, then fire
	# the heartbeat exactly like _process() would once HEARTBEAT_INTERVAL_SECS
	# has elapsed. No direct notify_reachability() call anywhere in this test.
	heartbeat_mock.stop()
	controller._process(FirstRunController.HEARTBEAT_INTERVAL_SECS)
	var went_offline := _drive_controller(
		controller, null, 3000.0, func(): return indicator.visible
	)

	if not went_offline:
		failures.append(
			"controller_heartbeat: offline indicator must follow a mid-session reachability drop detected by the periodic heartbeat (AC5)"
		)

	# The network comes back. This session's identity was minted successfully
	# (the phrase screen above), so _session_saveable was never set false —
	# unlike the launch-offline case, a heartbeat proving reachability here
	# really does mean the session is genuinely saveable again, and the
	# warning must clear (AC17's converse: the distinction cuts both ways).
	heartbeat_mock.listen(HEARTBEAT_MOCK_PORT)
	heartbeat_mock.queue(200, '[]')
	controller._process(FirstRunController.HEARTBEAT_INTERVAL_SECS)
	var recovered := _drive_controller(
		controller, heartbeat_mock, 3000.0, func(): return not indicator.visible
	)

	if not recovered:
		failures.append(
			"controller_heartbeat: offline indicator must clear once a heartbeat succeeds again for a session that was always saveable (AC17)"
		)

	controller.free()
	heartbeat_mock.stop()
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── FirstRunController: launch offline, then the server comes back — the ────
## indicator must NOT clear on a heartbeat alone (AC17, Review FAIL
## 2026-09-12). A launch-offline session never minted an identity — nothing
## was ever saveable for it — so a heartbeat proving the network is back
## reachable is not the same as the session becoming saveable again; the
## indicator doubles as the unsaved-session warning and must keep warning for
## the rest of this session regardless of network recovery. This inverts the
## test's own prior assertion, which is the exact regression the reviewer
## found: `_test_controller_indicator_clears_after_offline_launch_recovers`
## used to assert the indicator cleared here, which is precisely what AC17
## forbids ("no heartbeat response ... clears the unsaved-session warning ...
## until a real identity recovery succeeds" — there is no identity-recovery
## path in this flow, so it must never clear).

func _test_controller_indicator_stays_visible_after_offline_launch_heartbeat() -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % RECOVERY_PORT, SHORT_TIMEOUT_MS)

	controller.start_new_game()
	var went_offline := _drive_controller(
		controller, null, 3000.0, func(): return controller.get_offline_screen() != null
	)
	if not went_offline:
		failures.append("controller_recovers: offline screen never appeared within 3 s")
		controller.free()
		return failures

	controller.get_offline_screen().acknowledged.emit()

	var indicator := controller.get_offline_indicator()
	if indicator == null or not indicator.visible:
		failures.append("controller_recovers: indicator must be visible on room entry while offline")

	# The network comes back: start listening on the exact port this
	# controller is already configured for, then fire the heartbeat exactly
	# like _process() would.
	var recovery_mock := MockHttpServer.new()
	if not recovery_mock.listen(RECOVERY_PORT):
		failures.append("controller_recovers: could not start recovery mock HTTP server on port %d" % RECOVERY_PORT)
		controller.free()
		return failures
	recovery_mock.queue(200, '[]')

	var heartbeat_events := [0]
	controller.get_note_client().notes_fetched.connect(
		func(_req: int, _state: int, _status: int, _body: String): heartbeat_events[0] += 1
	)

	controller._process(FirstRunController.HEARTBEAT_INTERVAL_SECS)
	var heartbeat_done := _drive_controller(
		controller, recovery_mock, 3000.0, func(): return heartbeat_events[0] > 0
	)

	if not heartbeat_done:
		failures.append("controller_recovers: heartbeat request to the recovery mock never completed within 3 s")
	elif not indicator.visible:
		failures.append(
			"controller_recovers: a heartbeat alone must not clear the unsaved-session warning after a launch-offline session (AC17) — nothing was ever saved this session"
		)

	controller.free()
	recovery_mock.stop()
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── FirstRunController: an OS close request while ending offline shows the ───
## recap (AC6) and holds the quit open until it is dismissed. Before this
## fix, end_session() had no production caller anywhere — the only call
## sites in the whole branch were tests — so a real player could never
## trigger the recap at all.

func _test_controller_close_request_recap_then_completes() -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % DEAD_PORT, SHORT_TIMEOUT_MS)

	controller.start_new_game()
	var completed := _drive_controller(
		controller, null, 3000.0, func(): return controller.get_offline_screen() != null
	)
	if not completed:
		failures.append("controller_close_recap: offline screen never appeared within 3 s")
		controller.free()
		return failures

	controller.get_offline_screen().acknowledged.emit()

	if controller.get_recap_notice() != null:
		failures.append("controller_close_recap: must not appear before an actual OS close request")

	controller._notification(Node.NOTIFICATION_WM_CLOSE_REQUEST)

	if controller.get_recap_notice() == null or not controller.get_recap_notice().visible:
		failures.append(
			"controller_close_recap: an OS close request while ending offline must show the session-end recap (AC6) before quitting"
		)
	elif not controller.is_close_request_pending():
		failures.append("controller_close_recap: the close request must stay pending until the recap is dismissed")
	else:
		controller.get_recap_notice().dismissed.emit()
		if controller.is_close_request_pending():
			failures.append("controller_close_recap: dismissing the recap must complete the pending close request")

	controller.free()
	return failures


## ── FirstRunController: an online close request completes immediately ───────
## (no recap to show — nothing about this session was ever unsaved).

func _test_controller_close_request_online_completes_immediately(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % MOCK_PORT)

	mock.queue(201, '{"phrase":"river stone moth ember quiet drift north gate"}')
	controller.start_new_game()
	var completed := _drive_controller(
		controller, mock, 5000.0, func(): return controller.get_phrase_screen() != null
	)
	if not completed:
		failures.append("controller_close_online: phrase screen never appeared within 5 s")
		controller.free()
		return failures

	controller.get_phrase_screen().acknowledged.emit()
	controller._notification(Node.NOTIFICATION_WM_CLOSE_REQUEST)

	if controller.get_recap_notice() != null:
		failures.append("controller_close_online: no recap is shown for a session that was never offline")
	if controller.is_close_request_pending():
		failures.append("controller_close_online: an online close request must complete immediately, not stay pending")

	controller.free()
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── FirstRunController: the phrase-reveal screen must show the phrase ────────
## itself (Codex re-review, 2026-09-11, P2) — before this fix,
## _on_phrase_reveal_ready() ignored the phrase argument entirely and only
## ever rendered notice_text (the warning + saved path), so a player was
## asked to acknowledge "This phrase is you" without ever seeing it.

func _test_controller_phrase_screen_displays_phrase(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % MOCK_PORT)

	var phrase := "quartz river lantern hollow drift ember north gate"
	mock.queue(201, '{"phrase":"%s"}' % phrase)
	controller.start_new_game()
	var completed := _drive_controller(
		controller, mock, 5000.0, func(): return controller.get_phrase_screen() != null
	)
	if not completed:
		failures.append("controller_phrase_text: phrase screen never appeared within 5 s")
		controller.free()
		return failures

	var screen := controller.get_phrase_screen()
	var phrase_label := screen.get_phrase_label()
	if phrase_label == null or not phrase_label.text.contains(phrase):
		failures.append("controller_phrase_text: the phrase-reveal screen must visibly display the phrase itself")

	var notice_label := screen.get_notice_label()
	if notice_label == null:
		failures.append("controller_phrase_text: notice label not found")
	elif notice_label.text.contains(phrase):
		failures.append(
			"controller_phrase_text: the phrase must be its own control, separate from the warning text"
		)

	controller.free()
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── FirstRunController regression: a heartbeat response after an identity ────
## failure must never clear the unsaved-session state (Codex re-review,
## 2026-09-11, P1). OfflineModeController correctly treats ANY HTTP response —
## including a 401 or 503 — as network-reachable; that's a real and separate
## distinction from a timeout/network error. But acknowledge_error() leaves
## FirstRunSequence with no valid identity for this session, and a later
## heartbeat succeeding at the network layer must never be read as "the
## session is saveable again." Before this fix, notify_reachability(true)
## overwrote the same _reachable field is_server_reachable() and
## end_session()'s recap decision both read, clearing both — reproduced by
## Codex as: identity 503 -> acknowledge -> heartbeat 401 -> reachable=true ->
## end session -> no recap, despite the player never having an identity. Also
## asserts the persistent offline indicator — which IS the unsaved-session
## warning (Review FAIL, 2026-09-12: a prior fix cleared the recap but left
## the indicator driven by raw reachability, so the warning was never shown
## for this entire scenario) — is visible both right after the failure and
## after the heartbeat.

func _test_controller_heartbeat_after_identity_failure_keeps_unsaved_state() -> Array[String]:
	var failures: Array[String] = []

	var identity_mock := MockHttpServer.new()
	if not identity_mock.listen(UNSAVED_STATE_PORT):
		failures.append("controller_unsaved: could not start mock HTTP server on port %d" % UNSAVED_STATE_PORT)
		return failures

	var controller := FirstRunController.new()
	controller.configure_for_test(TEST_PATH, "http://127.0.0.1:%d" % UNSAVED_STATE_PORT)

	identity_mock.queue(503, '{"error":0}')
	controller.start_new_game()
	var completed := _drive_controller(
		controller, identity_mock, 5000.0, func(): return controller.get_error_screen() != null
	)
	if not completed:
		failures.append("controller_unsaved: error screen never appeared within 5 s")
		controller.free()
		identity_mock.stop()
		return failures

	controller.get_error_screen().acknowledged.emit()

	if controller.get_sequence().is_server_reachable():
		failures.append("controller_unsaved: is_server_reachable() must be false right after an identity failure")

	var indicator := controller.get_offline_indicator()
	if indicator == null or not indicator.visible:
		failures.append(
			"controller_unsaved: the unsaved-session warning indicator must be visible right after an identity failure (AC17)"
		)

	var heartbeat_events := [0]
	controller.get_note_client().notes_fetched.connect(
		func(_req: int, _state: int, _status: int, _body: String): heartbeat_events[0] += 1
	)

	identity_mock.queue(401, '')
	controller._process(FirstRunController.HEARTBEAT_INTERVAL_SECS)
	var heartbeat_done := _drive_controller(
		controller, identity_mock, 3000.0, func(): return heartbeat_events[0] > 0
	)
	if not heartbeat_done:
		failures.append("controller_unsaved: heartbeat request to the mock server never completed within 3 s")
		controller.free()
		identity_mock.stop()
		return failures

	if controller.get_sequence().is_server_reachable():
		failures.append("controller_unsaved: a 401 heartbeat response must not clear the unsaved-session state")
	if indicator == null or not indicator.visible:
		failures.append(
			"controller_unsaved: the unsaved-session warning indicator must still be visible after the 401 heartbeat (AC17/AC18)"
		)

	controller.end_session()
	if controller.get_recap_notice() == null or not controller.get_recap_notice().visible:
		failures.append("controller_unsaved: ending the session must still show the nothing-was-saved recap")

	controller.free()
	identity_mock.stop()
	return failures


## ── BlockingNoticeScreen: all first-run copy must be readable at the game's ───
## configured 384x216 logical viewport, with the acknowledgment button in its
## own area the text never overlaps — even with a long save path (Codex
## re-review, 2026-09-11, P1: measured the old fixed-offset label overflowing
## to y=411 while the button started at y=184). Needs a real engine frame —
## unlike every other test in this file, which never adds a node to the live
## tree at all: a Label's autowrap-driven minimum size (and therefore whether
## the notice copy actually needs to scroll) isn't resolved until the layout
## system processes the node inside a real Viewport, and this headless
## `--script` run's own root Window doesn't apply project.godot's configured
## 384x216 viewport size until its first processed frame either (verified
## empirically against this exact Godot build). See test_main_scene_boot.gd's
## identical note on _ready()/layout timing in this harness.
##
## Covers all three BlockingNoticeScreen instances the controller actually
## builds (Review FAIL, 2026-09-12: the prior version of this test exercised
## only the phrase-reveal screen) — the phrase-reveal screen (with the long
## save path FIRST_RUN_NOTICE substitutes in), the offline-notice screen
## (no path — the offline path fires before any identity/phrase exists), and
## the identity/save-error screen (with a long save path, mirroring
## FirstRunController._on_phrase_save_failed()'s copy verbatim — kept as a
## literal here rather than importing a production constant so this test
## doesn't depend on FirstRunController's private wording beyond what a
## player would actually see; if that format string changes, this literal
## must be updated to match).

const LAYOUT_TEST_LONG_PATH := (
	"/home/exampleuser/.local/share/godot/app_userdata/assembled-client/"
	+ "very/deeply/nested/save/directory/identity.phrase"
)
const LAYOUT_TEST_PHRASE := "alpha bravo charlie delta echo foxtrot golf hotel"

## Must match FirstRunController._on_phrase_save_failed()'s format string.
const LAYOUT_TEST_SAVE_FAILED_NOTICE_FORMAT := (
	"Your phrase couldn't be saved to %s. Nothing has been saved for this session — "
	+ "you can continue, but this session's progress won't be recorded."
)

## One entry per blocking screen this game actually shows a player, each with
## its own expected copy/phrase/overflow expectation. Built in
## _start_layout_readability_test(), measured in
## _finish_layout_readability_test() once a real frame has resolved layout.
var _layout_screens: Array[Dictionary] = []


func _start_layout_readability_test() -> void:
	var phrase_screen := BlockingNoticeScreen.new()
	root.add_child(phrase_screen)
	phrase_screen.set_phrase_text(LAYOUT_TEST_PHRASE)
	phrase_screen.set_notice_text(IdentityStore.FIRST_RUN_NOTICE.replace("[path]", LAYOUT_TEST_LONG_PATH))

	var offline_screen := BlockingNoticeScreen.new()
	offline_screen.acknowledge_button_text = "[ Continue anyway ]"
	root.add_child(offline_screen)
	offline_screen.set_notice_text(FirstRunSequence.OFFLINE_NOTICE_TEXT)

	var error_screen := BlockingNoticeScreen.new()
	error_screen.acknowledge_button_text = "[ Continue anyway ]"
	root.add_child(error_screen)
	error_screen.set_notice_text(LAYOUT_TEST_SAVE_FAILED_NOTICE_FORMAT % LAYOUT_TEST_LONG_PATH)

	_layout_screens = [
		{
			"label": "phrase_reveal",
			"screen": phrase_screen,
			"notice": IdentityStore.FIRST_RUN_NOTICE.replace("[path]", LAYOUT_TEST_LONG_PATH),
			"phrase": LAYOUT_TEST_PHRASE,
			"expect_overflow": true,
		},
		{
			"label": "offline_notice",
			"screen": offline_screen,
			"notice": FirstRunSequence.OFFLINE_NOTICE_TEXT,
			"phrase": "",
			"expect_overflow": false,
		},
		{
			"label": "identity_error",
			"screen": error_screen,
			"notice": LAYOUT_TEST_SAVE_FAILED_NOTICE_FORMAT % LAYOUT_TEST_LONG_PATH,
			"phrase": "",
			"expect_overflow": true,
		},
	]
	_pending_layout_check = true


func _finish_layout_readability_test() -> Array[String]:
	var failures: Array[String] = []
	var viewport_size: Vector2 = root.get_visible_rect().size

	for entry: Dictionary in _layout_screens:
		failures += _check_screen_layout(
			entry.screen, entry.notice, entry.phrase, entry.expect_overflow, entry.label, viewport_size
		)
		entry.screen.free()

	_layout_screens = []
	return failures


## Shared bounds/overlap/copy check for one blocking screen at the 384x216
## logical viewport. @param expected_phrase empty means this screen has no
## phrase label to check (the offline and identity-error screens never call
## set_phrase_text()). @param expect_overflow asserts the fixture actually
## exercises the scroll area (a long save path taller than the visible
## area) — without this guard the no-overlap check could pass trivially for
## copy that was never going to overlap anything regardless of layout.
func _check_screen_layout(
		screen: BlockingNoticeScreen,
		expected_notice: String,
		expected_phrase: String,
		expect_overflow: bool,
		label: String,
		viewport_size: Vector2
) -> Array[String]:
	var failures: Array[String] = []

	var scroll: ScrollContainer = screen.get_scroll_container()
	var button: Button = screen.get_node("Root/AcknowledgeButton")
	if scroll == null or button == null:
		failures.append("layout_384x216[%s]: scroll container or acknowledge button not found" % label)
		return failures

	var scroll_rect := scroll.get_rect()
	var button_rect := button.get_rect()

	if (
		scroll_rect.position.x < 0.0 or scroll_rect.position.y < 0.0
		or scroll_rect.end.x > viewport_size.x or scroll_rect.end.y > viewport_size.y
	):
		failures.append(
			"layout_384x216[%s]: scroll area %s exceeds the %s viewport" % [label, scroll_rect, viewport_size]
		)
	if (
		button_rect.position.x < 0.0 or button_rect.position.y < 0.0
		or button_rect.end.x > viewport_size.x or button_rect.end.y > viewport_size.y
	):
		failures.append(
			"layout_384x216[%s]: acknowledge button %s exceeds the %s viewport" % [label, button_rect, viewport_size]
		)
	if scroll_rect.intersects(button_rect):
		failures.append(
			"layout_384x216[%s]: scroll area %s overlaps the acknowledge button %s" % [label, scroll_rect, button_rect]
		)

	var notice_label := screen.get_notice_label()
	if notice_label == null or notice_label.text != expected_notice:
		failures.append("layout_384x216[%s]: full notice copy must be present verbatim, not truncated" % label)
	elif expect_overflow and notice_label.size.y <= scroll_rect.size.y:
		# Confirms this test actually exercises the overflow a long save path
		# creates — if this stops being true, the "no overlap" assertion
		# above would pass trivially for the wrong reason.
		failures.append(
			"layout_384x216[%s]: fixture bug — the long-path notice text must be taller than the scroll area to exercise scrolling" % label
		)

	if not expected_phrase.is_empty():
		var phrase_label := screen.get_phrase_label()
		if phrase_label == null or not phrase_label.text.contains(expected_phrase):
			failures.append("layout_384x216[%s]: full phrase must be present verbatim, not truncated" % label)

	return failures
