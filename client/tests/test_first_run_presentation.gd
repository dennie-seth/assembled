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

const MOCK_PORT: int = 19996
const DEAD_PORT: int = 19995
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


func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("NoteClient"):
		printerr("T-0120-presentation FAIL: NoteClient not registered — GDExtension did not load")
		quit(1)
		return

	failures += _test_full_rect_anchors()
	failures += _test_acknowledge_paths()
	failures += _test_blocks_window_close()
	failures += _test_offline_indicator_visibility()
	failures += _test_transient_notice_show_hide()
	failures += _test_transient_notice_dismiss_on_input()

	var mock := MockHttpServer.new()
	if not mock.listen(MOCK_PORT):
		printerr("T-0120-presentation FAIL: could not start mock HTTP server on port %d" % MOCK_PORT)
		quit(1)
		return

	failures += _test_controller_shows_phrase_screen_and_relays_entry(mock)
	failures += _test_controller_offline_launch_shows_indicator(mock)
	failures += _test_controller_chroma_notice_after_baseline(mock)
	failures += _test_controller_offline_session_end_recap()

	mock.stop()

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))

	if failures.is_empty():
		print("T-0120-presentation PASS: first-run presentation layer verified")
		quit(0)
	else:
		for f: String in failures:
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
