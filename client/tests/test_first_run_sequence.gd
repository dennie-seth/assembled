extends SceneTree
## T-0120: First-run sequence tests.
##
## Verifies the FirstRunSequence state machine (18-first-run.md §1-4):
##   - New Game triggers POST /v1/identity and the phrase is auto-saved to disk
##     BEFORE the phrase-reveal screen is signalled (AC1)
##   - The phrase-reveal screen only advances via acknowledge_phrase() — no
##     other public method bypasses it (AC2, AC8)
##   - The phrase notice names both loss modes distinctly (AC3)
##   - An unreachable identity request shows a pre-play offline notice that
##     only advances via acknowledge_offline() (AC4)
##   - notify_reachability() drives a persistent during-play offline indicator
##     signal (AC5)
##   - end_session() emits a "nothing was saved" recap only when offline (AC6)
##   - The chroma/clock explanation fires exactly once, only after the
##     baseline exploration window elapses in the entry room, and contains no
##     digits (AC7)
##
## Run headless:
##   godot --headless --script tests/test_first_run_sequence.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const FirstRunSequence := preload("res://first_run_sequence.gd")
const IdentityStore := preload("res://identity_store.gd")

## Temporary phrase path — never touches the production save file.
const TEST_PATH := "user://test_T0120.phrase"
const MOCK_PORT: int = 19997
const DEAD_PORT: int = 19998
const SHORT_TIMEOUT_MS: int = 200


## Minimal TCP mock server (same pattern as test_identity_store.gd).
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
				var _discard = conn.get_data(conn.get_available_bytes())
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


## Captures every FirstRunSequence signal.
class Capture:
	var phrase_reveal_events: Array = []   ## [{phrase, notice_text, saved_path}]
	var identity_failed_events: Array = [] ## [{state, http_status}]
	var offline_notice_events: Array = []  ## [String notice_text]
	var entry_room_events: int = 0
	var chroma_events: Array = []          ## [String text]
	var recap_events: Array = []           ## [String text]
	var indicator_events: Array = []       ## [bool visible]
	var save_failed_events: Array = []     ## [{phrase, attempted_path}]

	func on_phrase_reveal_ready(phrase: String, notice_text: String, saved_path: String) -> void:
		phrase_reveal_events.append({"phrase": phrase, "notice_text": notice_text, "saved_path": saved_path})

	func on_phrase_save_failed(phrase: String, attempted_path: String) -> void:
		save_failed_events.append({"phrase": phrase, "attempted_path": attempted_path})

	func on_identity_failed(state: int, http_status: int) -> void:
		identity_failed_events.append({"state": state, "http_status": http_status})

	func on_offline_notice_required(notice_text: String) -> void:
		offline_notice_events.append(notice_text)

	func on_entry_room_ready() -> void:
		entry_room_events += 1

	func on_chroma_explanation_ready(text: String) -> void:
		chroma_events.append(text)

	func on_session_end_offline_recap(text: String) -> void:
		recap_events.append(text)

	func on_offline_indicator_changed(visible: bool) -> void:
		indicator_events.append(visible)


func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("NoteClient"):
		printerr("T-0120 FAIL: NoteClient not registered — GDExtension did not load")
		quit(1)
		return

	var mock := MockHttpServer.new()
	if not mock.listen(MOCK_PORT):
		printerr("T-0120 FAIL: could not start mock HTTP server on port %d" % MOCK_PORT)
		quit(1)
		return

	failures += _test_identity_success_saves_before_reveal(mock)
	failures += _test_save_failure_routes_away_from_reveal(mock)
	failures += _test_both_loss_modes_named(mock)
	failures += _test_no_escape_from_phrase_reveal(mock)
	failures += _test_identity_unreachable_shows_offline_notice()
	failures += _test_identity_5xx_stays_awaiting(mock)
	failures += _test_offline_ack_enters_room()
	failures += _test_chroma_fires_once_after_baseline(mock)
	failures += _test_chroma_never_fires_before_entry_room(mock)
	failures += _test_session_end_offline_recap()
	failures += _test_session_end_online_no_recap(mock)
	failures += _test_notify_reachability_indicator(mock)
	failures += _test_indicator_visible_after_offline_launch()

	mock.stop()

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))

	if failures.is_empty():
		print("T-0120 PASS: first-run sequence verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0120 FAIL: " + f)
		quit(1)


## Drive NoteClient (and optional mock) until predicate() is true or wall-time expires.
func _drive(client: NoteClient, mock: MockHttpServer, wall_limit_ms: float, predicate: Callable) -> bool:
	var start_ms: int = Time.get_ticks_msec()
	while float(Time.get_ticks_msec() - start_ms) < wall_limit_ms:
		if mock != null:
			mock.pump()
		client.tick(0.016)
		if predicate.call():
			return true
		OS.delay_msec(5)
	return false


func _make_seq() -> FirstRunSequence:
	var seq := FirstRunSequence.new()
	seq.set_phrase_path(TEST_PATH)
	return seq


func _connect_capture(seq: FirstRunSequence) -> Capture:
	var cap := Capture.new()
	seq.phrase_reveal_ready.connect(cap.on_phrase_reveal_ready)
	seq.phrase_save_failed.connect(cap.on_phrase_save_failed)
	seq.identity_failed.connect(cap.on_identity_failed)
	seq.offline_notice_required.connect(cap.on_offline_notice_required)
	seq.entry_room_ready.connect(cap.on_entry_room_ready)
	seq.chroma_explanation_ready.connect(cap.on_chroma_explanation_ready)
	seq.session_end_offline_recap.connect(cap.on_session_end_offline_recap)
	seq.offline_indicator_changed.connect(cap.on_offline_indicator_changed)
	return cap


## ── AC1: phrase auto-saved to disk before the phrase-reveal screen fires ──────

func _test_identity_success_saves_before_reveal(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var expected := "alpha bravo charlie delta echo foxtrot golf hotel"

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(201, '{"phrase":"%s"}' % expected)
	seq.start_new_game()
	var completed := _drive(client, mock, 5000.0, func(): return cap.phrase_reveal_events.size() > 0)
	client.free()

	if not completed:
		failures.append("save_before_reveal: phrase_reveal_ready not emitted within 5 s")
		return failures

	var ev: Dictionary = cap.phrase_reveal_events[0]
	if ev.phrase != expected:
		failures.append("save_before_reveal: phrase='%s', expected '%s'" % [ev.phrase, expected])

	# The file must already be on disk by the time the signal is observed.
	var on_disk := IdentityStore.load_phrase(TEST_PATH)
	if on_disk != expected:
		failures.append(
			"save_before_reveal: phrase not on disk when signal fired — got '%s'" % on_disk
		)

	if seq.get_state() != FirstRunSequence.State.PHRASE_REVEAL:
		failures.append("save_before_reveal: expected state PHRASE_REVEAL, got %d" % seq.get_state())

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── AC1: a failed write must never reach the phrase-reveal screen ─────────────

func _test_save_failure_routes_away_from_reveal(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	# A path under a directory that does not exist — FileAccess.open(WRITE)
	# does not create missing parent directories, so this reliably fails.
	const BAD_PATH := "user://T0120_missing_dir/phrase.txt"

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := FirstRunSequence.new()
	seq.set_phrase_path(BAD_PATH)
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(201, '{"phrase":"fiftyone fiftytwo fiftythree fiftyfour fiftyfive fiftysix fiftyseven fiftyeight"}')
	seq.start_new_game()
	var completed := _drive(
		client, mock, 5000.0,
		func(): return cap.save_failed_events.size() > 0 or cap.phrase_reveal_events.size() > 0
	)
	client.free()

	if not completed:
		failures.append("save_failure: neither phrase_save_failed nor phrase_reveal_ready fired within 5 s")
		return failures

	if not cap.phrase_reveal_events.is_empty():
		failures.append("save_failure: phrase_reveal_ready fired despite the write failing")
	if cap.save_failed_events.size() != 1:
		failures.append("save_failure: expected exactly 1 phrase_save_failed, got %d" % cap.save_failed_events.size())
	if seq.get_state() != FirstRunSequence.State.SAVE_FAILED:
		failures.append("save_failure: expected state SAVE_FAILED, got %d" % seq.get_state())

	return failures


## ── AC3: both loss modes named distinctly in the phrase notice ────────────────

func _test_both_loss_modes_named(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(201, '{"phrase":"one two three four five six seven eight"}')
	seq.start_new_game()
	var completed := _drive(client, mock, 5000.0, func(): return cap.phrase_reveal_events.size() > 0)
	client.free()

	if not completed:
		failures.append("loss_modes: phrase_reveal_ready not emitted within 5 s")
		return failures

	var notice: String = cap.phrase_reveal_events[0].notice_text
	var lower := notice.to_lower()
	if not lower.contains("lose the phrase"):
		failures.append("loss_modes: notice missing phrase-loss ending")
	if not lower.contains("universe collapse"):
		failures.append("loss_modes: notice missing universe-collapse ending")

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── AC2/AC8: nothing but acknowledge_phrase() can leave PHRASE_REVEAL ─────────

func _test_no_escape_from_phrase_reveal(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(201, '{"phrase":"nine ten eleven twelve thirteen fourteen fifteen sixteen"}')
	seq.start_new_game()
	var completed := _drive(client, mock, 5000.0, func(): return cap.phrase_reveal_events.size() > 0)
	if not completed:
		failures.append("no_escape: phrase_reveal_ready not emitted within 5 s")
		client.free()
		return failures

	# None of these should advance past PHRASE_REVEAL.
	seq.acknowledge_offline()
	seq.tick(99999.0)
	seq.end_session()

	if seq.get_state() != FirstRunSequence.State.PHRASE_REVEAL:
		failures.append(
			"no_escape: state escaped PHRASE_REVEAL via a non-acknowledgment call (state=%d)"
			% seq.get_state()
		)
	if cap.entry_room_events != 0:
		failures.append("no_escape: entry_room_ready fired without acknowledge_phrase()")
	if not cap.chroma_events.is_empty():
		failures.append("no_escape: chroma_explanation_ready fired without entering the room")

	# Only acknowledge_phrase() may advance the state.
	seq.acknowledge_phrase()
	client.free()

	if seq.get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		failures.append(
			"no_escape: acknowledge_phrase() did not advance to IN_ENTRY_ROOM (state=%d)"
			% seq.get_state()
		)
	if cap.entry_room_events != 1:
		failures.append(
			"no_escape: expected exactly 1 entry_room_ready, got %d" % cap.entry_room_events
		)

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── AC4: unreachable identity request blocks on a pre-play offline notice ────

func _test_identity_unreachable_shows_offline_notice() -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % DEAD_PORT)
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	seq.start_new_game()
	var completed := _drive(client, null, 3000.0, func(): return cap.offline_notice_events.size() > 0)
	client.free()

	if not completed:
		failures.append("offline_notice: offline_notice_required not emitted within 3 s")
		return failures

	if cap.offline_notice_events[0].is_empty():
		failures.append("offline_notice: notice text is empty")
	if seq.get_state() != FirstRunSequence.State.OFFLINE_NOTICE:
		failures.append("offline_notice: expected state OFFLINE_NOTICE, got %d" % seq.get_state())
	if seq.is_server_reachable():
		failures.append("offline_notice: is_server_reachable() true after a network-error identity request")
	if not cap.phrase_reveal_events.is_empty():
		failures.append("offline_notice: phrase_reveal_ready fired despite no identity being created")

	# No escape here either — only acknowledge_offline() should advance.
	seq.acknowledge_phrase()
	if seq.get_state() != FirstRunSequence.State.OFFLINE_NOTICE:
		failures.append("offline_notice: acknowledge_phrase() incorrectly advanced OFFLINE_NOTICE state")

	return failures


## ── identity 5xx: reachable but identity creation failed — no crash, no phrase ─

func _test_identity_5xx_stays_awaiting(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(500, '{"error":0}')
	seq.start_new_game()
	var completed := _drive(client, mock, 5000.0, func(): return cap.identity_failed_events.size() > 0)
	client.free()

	if not completed:
		failures.append("identity_5xx: identity_failed not emitted within 5 s")
		return failures

	var ev: Dictionary = cap.identity_failed_events[0]
	if ev.state != NoteClient.STATE_HTTP_5XX:
		failures.append("identity_5xx: expected STATE_HTTP_5XX, got %d" % ev.state)
	if seq.get_state() != FirstRunSequence.State.AWAITING_IDENTITY:
		failures.append("identity_5xx: expected state AWAITING_IDENTITY, got %d" % seq.get_state())
	if not seq.is_server_reachable():
		failures.append("identity_5xx: is_server_reachable() false after a 5xx (server did respond)")

	return failures


## ── acknowledge_offline() advances OFFLINE_NOTICE -> IN_ENTRY_ROOM ────────────

func _test_offline_ack_enters_room() -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % DEAD_PORT)
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	seq.start_new_game()
	var completed := _drive(client, null, 3000.0, func(): return cap.offline_notice_events.size() > 0)
	client.free()

	if not completed:
		failures.append("offline_ack: offline_notice_required not emitted within 3 s")
		return failures

	seq.acknowledge_offline()
	if seq.get_state() != FirstRunSequence.State.IN_ENTRY_ROOM:
		failures.append("offline_ack: expected IN_ENTRY_ROOM after acknowledge_offline(), got %d" % seq.get_state())
	if cap.entry_room_events != 1:
		failures.append("offline_ack: expected exactly 1 entry_room_ready, got %d" % cap.entry_room_events)

	return failures


## ── AC7: chroma explanation fires exactly once after the baseline window ─────

func _test_chroma_fires_once_after_baseline(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(201, '{"phrase":"seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour"}')
	seq.start_new_game()
	_drive(client, mock, 5000.0, func(): return cap.phrase_reveal_events.size() > 0)
	client.free()
	seq.acknowledge_phrase()

	# Below the baseline window: must not fire yet.
	seq.tick(1.0)
	seq.tick(1.0)
	if not cap.chroma_events.is_empty():
		failures.append("chroma_once: fired before the baseline exploration window elapsed")

	# Cross the threshold: must fire exactly once.
	seq.tick(FirstRunSequence.BASELINE_EXPLORATION_SECS)
	if cap.chroma_events.size() != 1:
		failures.append("chroma_once: expected exactly 1 emission crossing the threshold, got %d" % cap.chroma_events.size())
	elif cap.chroma_events[0].is_empty():
		failures.append("chroma_once: emitted text is empty")
	else:
		var text: String = cap.chroma_events[0]
		for i in range(10):
			if text.contains(str(i)):
				failures.append("chroma_once: explanation text contains a digit ('%d') — must never show a number" % i)
				break

	# Further ticks must not re-fire it.
	seq.tick(FirstRunSequence.BASELINE_EXPLORATION_SECS)
	if cap.chroma_events.size() != 1:
		failures.append("chroma_once: fired more than once (%d total)" % cap.chroma_events.size())

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── chroma explanation never fires before the player is in the entry room ────

func _test_chroma_never_fires_before_entry_room(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	# Still in AWAITING_IDENTITY — ticking a huge delta must be a no-op.
	seq.tick(999999.0)
	if not cap.chroma_events.is_empty():
		failures.append("chroma_never_early: fired while state was AWAITING_IDENTITY")

	mock.queue(201, '{"phrase":"twentyfive twentysix twentyseven twentyeight twentynine thirty thirtyone thirtytwo"}')
	seq.start_new_game()
	_drive(client, mock, 5000.0, func(): return cap.phrase_reveal_events.size() > 0)
	client.free()

	# In PHRASE_REVEAL, still not the entry room — must not fire.
	seq.tick(999999.0)
	if not cap.chroma_events.is_empty():
		failures.append("chroma_never_early: fired while state was PHRASE_REVEAL")

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── AC6: session-end recap fires only when the session ends offline ──────────

func _test_session_end_offline_recap() -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % DEAD_PORT)
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	seq.start_new_game()
	_drive(client, null, 3000.0, func(): return cap.offline_notice_events.size() > 0)
	client.free()
	seq.acknowledge_offline()

	seq.end_session()
	if cap.recap_events.size() != 1:
		failures.append("session_end_offline: expected exactly 1 recap, got %d" % cap.recap_events.size())
	elif cap.recap_events[0].is_empty():
		failures.append("session_end_offline: recap text is empty")
	if seq.get_state() != FirstRunSequence.State.ENDED:
		failures.append("session_end_offline: expected state ENDED, got %d" % seq.get_state())

	return failures


func _test_session_end_online_no_recap(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(201, '{"phrase":"thirtythree thirtyfour thirtyfive thirtysix thirtyseven thirtyeight thirtynine forty"}')
	seq.start_new_game()
	_drive(client, mock, 5000.0, func(): return cap.phrase_reveal_events.size() > 0)
	client.free()
	seq.acknowledge_phrase()

	seq.end_session()
	if not cap.recap_events.is_empty():
		failures.append("session_end_online: recap fired despite being reachable")

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── AC5: notify_reachability() drives the persistent offline indicator ───────

func _test_notify_reachability_indicator(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	mock.queue(201, '{"phrase":"fortyone fortytwo fortythree fortyfour fortyfive fortysix fortyseven fortyeight"}')
	seq.start_new_game()
	_drive(client, mock, 5000.0, func(): return cap.phrase_reveal_events.size() > 0)
	client.free()
	seq.acknowledge_phrase()

	# _enter_room() (triggered by acknowledge_phrase() above) emits the
	# indicator's initial state as soon as the room is reached (AC5 fix) — a
	# baseline event this test must account for before driving transitions.
	var base: int = cap.indicator_events.size()
	if base != 1 or cap.indicator_events[0] != false:
		failures.append(
			"indicator: expected exactly 1 initial event [false] (online, hidden) on room entry, got %s"
			% [cap.indicator_events]
		)

	seq.notify_reachability(false)
	if cap.indicator_events.size() != base + 1 or cap.indicator_events[base] != true:
		failures.append("indicator: expected indicator visible after going offline, got %s" % [cap.indicator_events])
	if seq.is_server_reachable():
		failures.append("indicator: is_server_reachable() true after notify_reachability(false)")

	seq.notify_reachability(false)
	if cap.indicator_events.size() != base + 1:
		failures.append("indicator: redundant notify_reachability(false) re-emitted the signal")

	seq.notify_reachability(true)
	if cap.indicator_events.size() != base + 2 or cap.indicator_events[base + 1] != false:
		failures.append("indicator: expected a further event false (indicator hidden) after reconnecting")

	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
	return failures


## ── AC5 regression: launch offline -> acknowledge_offline -> indicator visible ──
## The bug this guards: notify_reachability() only emits on a *change*, and
## _reachable was already false by the time OFFLINE_NOTICE was reached — so a
## player who launches offline and acknowledges never saw the indicator at
## all. The suite was green before this test existed because every other
## indicator test only exercised the online -> offline transition.

func _test_indicator_visible_after_offline_launch() -> Array[String]:
	var failures: Array[String] = []

	var client := NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % DEAD_PORT)
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var seq := _make_seq()
	seq.setup(client)
	var cap := _connect_capture(seq)

	seq.start_new_game()
	var completed := _drive(client, null, 3000.0, func(): return cap.offline_notice_events.size() > 0)
	client.free()

	if not completed:
		failures.append("indicator_offline_launch: offline_notice_required not emitted within 3 s")
		return failures

	seq.acknowledge_offline()

	if cap.indicator_events.is_empty():
		failures.append("indicator_offline_launch: offline_indicator_changed never fired on room entry")
	elif cap.indicator_events[-1] != true:
		failures.append(
			"indicator_offline_launch: expected the indicator visible on room entry while offline, got %s"
			% [cap.indicator_events]
		)

	return failures
