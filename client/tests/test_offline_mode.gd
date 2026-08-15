extends SceneTree
## T-0067: Offline/degraded mode tests.
##
## Verifies that:
##   - notes_available fires with empty body when server is unreachable (timeout)
##   - is_server_reachable() returns false after a timeout, true after STATE_OK
##   - request_completion() returns false offline and emits completion_blocked
##     with a non-empty player-readable reason string
##   - request_completion() returns true when the server is reachable
##
## Run headless:
##   godot --headless --script tests/test_offline_mode.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const OfflineModeController = preload("res://offline_mode.gd")

## Port with nothing listening — triggers connect/transfer timeout.
const DEAD_PORT: int = 19991
## In-process mock HTTP server port for online tests.
const MOCK_PORT: int = 19992
## Short timeout so the offline tests complete quickly.
const SHORT_TIMEOUT_MS: int = 200


## Captures signals emitted by OfflineModeController.
class OfflineCapture:
	var notes_events: Array = []      ## [{body: String}]
	var reachable_events: Array = []  ## [bool]
	var blocked_events: Array = []    ## [String reason]

	func on_notes_available(body: String) -> void:
		notes_events.append({"body": body})

	func on_server_reachable_changed(reachable: bool) -> void:
		reachable_events.append(reachable)

	func on_completion_blocked(reason: String) -> void:
		blocked_events.append(reason)


## Minimal TCP-backed HTTP mock server.  Queues canned responses; each
## accepted connection reads (and discards) the request then sends the next
## queued response.  Mirrors MockHttpServer in test_note_client.gd.
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
		var status_text: String = "OK"
		if status >= 500:
			status_text = "Internal Server Error"
		elif status >= 400:
			status_text = "Client Error"
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
	if not ClassDB.class_exists("NoteClient"):
		printerr("T-0067 FAIL: NoteClient not registered — GDExtension did not load")
		quit(1)
		return

	var mock: MockHttpServer = MockHttpServer.new()
	if not mock.listen(MOCK_PORT):
		printerr(
			"T-0067 FAIL: could not start mock HTTP server on port %d" % MOCK_PORT
		)
		quit(1)
		return

	var failures: Array[String] = []
	failures += _test_notes_silent_on_timeout()
	failures += _test_server_unreachable_after_timeout()
	failures += _test_notes_available_on_success(mock)
	failures += _test_server_reachable_after_success(mock)
	failures += _test_completion_blocked_offline()
	failures += _test_completion_allowed_online(mock)

	mock.stop()

	if failures.is_empty():
		print("T-0067 PASS: offline/degraded mode verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0067 FAIL: " + f)
		quit(1)


## Drive client (and optionally mock) until notes_available fires or wall-time
## expires.  Returns true if at least one notes_available event was captured.
func _drive(
		client: NoteClient,
		cap: OfflineCapture,
		mock: MockHttpServer,
		wall_limit_ms: float) -> bool:
	var start_ms: int = Time.get_ticks_msec()
	while float(Time.get_ticks_msec() - start_ms) < wall_limit_ms:
		if mock != null:
			mock.pump()
		client.tick(0.016)
		if cap.notes_events.size() > 0:
			return true
		OS.delay_msec(5)
	return false


## ── Test: notes silently absent on timeout ────────────────────────────────────
## When the server is unreachable the controller must emit notes_available("")
## rather than surfacing the error state.  No error signal is expected.

func _test_notes_silent_on_timeout() -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % DEAD_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var ctrl = OfflineModeController.new()
	ctrl.attach_note_client(client)
	var cap: OfflineCapture = OfflineCapture.new()
	ctrl.notes_available.connect(cap.on_notes_available)

	client.fetch_notes(1, 1, 10)
	var completed: bool = _drive(client, cap, null, 3000.0)
	client.free()

	if not completed:
		failures.append(
			"silent timeout: notes_available not emitted within 3 s wall time"
		)
		return failures

	var ev: Dictionary = cap.notes_events[0]
	if ev.body != "":
		failures.append(
			"silent timeout: expected empty body (notes absent), got '%s'" % ev.body
		)
	return failures


## ── Test: server unreachable after timeout ────────────────────────────────────
## is_server_reachable() must return false after a timeout.

func _test_server_unreachable_after_timeout() -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % DEAD_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var ctrl = OfflineModeController.new()
	ctrl.attach_note_client(client)
	var cap: OfflineCapture = OfflineCapture.new()
	ctrl.notes_available.connect(cap.on_notes_available)

	client.fetch_notes(1, 1, 10)
	_drive(client, cap, null, 3000.0)
	client.free()

	if ctrl.is_server_reachable():
		failures.append(
			"unreachable after timeout: is_server_reachable() returned true after timeout"
		)
	return failures


## ── Test: notes_available fires with server body on success ──────────────────
## When the server responds 200, notes_available must fire (even if body is "[]").

func _test_notes_available_on_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("tok")
	client.set_lease_id("lease")

	var ctrl = OfflineModeController.new()
	ctrl.attach_note_client(client)
	var cap: OfflineCapture = OfflineCapture.new()
	ctrl.notes_available.connect(cap.on_notes_available)

	mock.queue(200, "[]")
	client.fetch_notes(1, 1, 10)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("success: notes_available not emitted within 5 s")
	return failures


## ── Test: server reachable after 200 OK ──────────────────────────────────────
## is_server_reachable() must return true after a successful fetch.

func _test_server_reachable_after_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("tok")
	client.set_lease_id("lease")

	var ctrl = OfflineModeController.new()
	ctrl.attach_note_client(client)
	var cap: OfflineCapture = OfflineCapture.new()
	ctrl.notes_available.connect(cap.on_notes_available)

	mock.queue(200, "[]")
	client.fetch_notes(1, 1, 10)
	_drive(client, cap, mock, 5000.0)
	client.free()

	if not ctrl.is_server_reachable():
		failures.append(
			"reachable after success: is_server_reachable() returned false after 200 OK"
		)
	return failures


## ── Test: completion blocked offline ─────────────────────────────────────────
## request_completion() must return false and emit completion_blocked with a
## non-empty reason string when the server is unreachable.

func _test_completion_blocked_offline() -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % DEAD_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var ctrl = OfflineModeController.new()
	ctrl.attach_note_client(client)
	var cap: OfflineCapture = OfflineCapture.new()
	ctrl.notes_available.connect(cap.on_notes_available)
	ctrl.completion_blocked.connect(cap.on_completion_blocked)

	# Drive a fetch so the controller learns the server is unreachable.
	client.fetch_notes(1, 1, 10)
	_drive(client, cap, null, 3000.0)
	client.free()

	# Now attempt completion while offline.
	var result: bool = ctrl.request_completion()

	if result:
		failures.append(
			"completion blocked: request_completion() returned true when offline"
		)
	if cap.blocked_events.is_empty():
		failures.append(
			"completion blocked: completion_blocked signal not emitted"
		)
	elif cap.blocked_events[0].is_empty():
		failures.append(
			"completion blocked: completion_blocked reason is an empty string"
		)
	return failures


## ── Test: completion allowed online ──────────────────────────────────────────
## request_completion() must return true after a successful fetch confirms the
## server is reachable.

func _test_completion_allowed_online(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("tok")
	client.set_lease_id("lease")

	var ctrl = OfflineModeController.new()
	ctrl.attach_note_client(client)
	var cap: OfflineCapture = OfflineCapture.new()
	ctrl.notes_available.connect(cap.on_notes_available)

	# Drive a successful fetch so the controller knows the server is reachable.
	mock.queue(200, "[]")
	client.fetch_notes(1, 1, 10)
	_drive(client, cap, mock, 5000.0)
	client.free()

	var result: bool = ctrl.request_completion()
	if not result:
		failures.append(
			"completion allowed: request_completion() returned false when online"
		)
	return failures
