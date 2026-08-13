extends SceneTree
## T-0063: NoteClient GDExtension node tests — post/fetch/rate + error states.
##
## Verifies:
##   - fetch_notes / post_note / rate_note emit signals on success (2xx)
##   - timeout surfaces as STATE_TIMEOUT (distinct from HTTP errors)
##   - 4xx responses surface as STATE_HTTP_4XX
##   - 5xx responses surface as STATE_HTTP_5XX
##
## Run headless:
##   godot --headless --script tests/test_note_client.gd
## from client/. Exit 0 on PASS, 1 on any failure.

## Local port for the in-process HTTP mock server.
const MOCK_PORT: int = 19994
## Port with nothing listening — used to trigger a connect timeout.
const TIMEOUT_PORT: int = 19993
## Short connect+transfer timeout so the timeout test completes quickly.
const SHORT_TIMEOUT_MS: int = 200


## Accumulates signal payloads emitted by NoteClient.
class SignalCapture:
	var events: Array = []

	func on_notes_fetched(
			req_id: int, state: int, http_status: int, body: String) -> void:
		events.append({
			"signal": "notes_fetched",
			"req_id": req_id,
			"state": state,
			"http_status": http_status,
			"body": body,
		})

	func on_note_posted(
			req_id: int, state: int, http_status: int, body: String) -> void:
		events.append({
			"signal": "note_posted",
			"req_id": req_id,
			"state": state,
			"http_status": http_status,
			"body": body,
		})

	func on_note_rated(req_id: int, state: int, http_status: int) -> void:
		events.append({
			"signal": "note_rated",
			"req_id": req_id,
			"state": state,
			"http_status": http_status,
		})


## Minimal TCP-backed HTTP mock server.  Queues canned responses; each
## accepted connection reads (and discards) the request then sends the next
## queued response.
class MockHttpServer:
	var _tcp: TCPServer = TCPServer.new()
	## StreamPeerTCP connections that have been accepted but not yet served.
	var _pending: Array = []
	## Queued {status: int, body: String} responses to send.
	var _queue: Array = []

	func listen(port: int) -> bool:
		return _tcp.listen(port, "127.0.0.1") == OK

	func stop() -> void:
		_tcp.stop()

	## Enqueue a canned HTTP response for the next request that arrives.
	func queue(status: int, body: String) -> void:
		_queue.append({"status": status, "body": body})

	## Must be called in the drive loop to accept connections and send replies.
	func pump() -> void:
		while _tcp.is_connection_available():
			_pending.append(_tcp.take_connection())

		var done: Array = []
		for conn: StreamPeerTCP in _pending:
			conn.poll()
			if conn.get_available_bytes() > 0 and _queue.size() > 0:
				# Drain the incoming request (content irrelevant for mocking).
				var _discard = conn.get_data(conn.get_available_bytes())
				var r: Dictionary = _queue.pop_front()
				_send(conn, r.status, r.body)
				done.append(conn)

		for conn: StreamPeerTCP in done:
			_pending.erase(conn)

	func _send(conn: StreamPeerTCP, status: int, body: String) -> void:
		var status_text: String = "OK"
		if status == 201:
			status_text = "Created"
		elif status == 204:
			status_text = "No Content"
		elif status >= 500:
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
		printerr("T-0063 FAIL: NoteClient not registered — GDExtension did not load")
		quit(1)
		return

	var mock: MockHttpServer = MockHttpServer.new()
	if not mock.listen(MOCK_PORT):
		printerr(
			"T-0063 FAIL: could not start mock HTTP server on port %d" % MOCK_PORT
		)
		quit(1)
		return

	var failures: Array[String] = []
	failures += _test_timeout()
	failures += _test_4xx(mock)
	failures += _test_5xx(mock)
	failures += _test_fetch_success(mock)
	failures += _test_post_note_success(mock)
	failures += _test_rate_note_success(mock)

	mock.stop()

	if failures.is_empty():
		print("T-0063 PASS: NoteClient post/fetch/rate and error states verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0063 FAIL: " + f)
		quit(1)


## Drive client (and optionally mock) until a signal is captured or wall-time
## expires.  Returns true if at least one event was captured.
func _drive(
		client: NoteClient,
		cap: SignalCapture,
		mock: MockHttpServer,
		wall_limit_ms: float) -> bool:
	var start_ms: int = Time.get_ticks_msec()
	while float(Time.get_ticks_msec() - start_ms) < wall_limit_ms:
		if mock != null:
			mock.pump()
		client.tick(0.016)
		if cap.events.size() > 0:
			return true
		OS.delay_msec(5)
	return false


## ── Test: timeout ────────────────────────────────────────────────────────────
## Connects to a port with nothing listening; expects STATE_TIMEOUT.

func _test_timeout() -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % TIMEOUT_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var cap: SignalCapture = SignalCapture.new()
	client.notes_fetched.connect(cap.on_notes_fetched)

	client.fetch_notes(1, 1, 10)
	var completed: bool = _drive(client, cap, null, 3000.0)
	client.free()

	if not completed:
		failures.append("timeout: no signal received within 3 s wall time")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_TIMEOUT:
		failures.append(
			"timeout: expected STATE_TIMEOUT (%d), got state=%d"
			% [NoteClient.STATE_TIMEOUT, ev.state]
		)
	if ev.http_status != 0:
		failures.append(
			"timeout: expected http_status=0 on timeout, got %d" % ev.http_status
		)
	return failures


## ── Test: 4xx ────────────────────────────────────────────────────────────────
## Mock returns 422; expects STATE_HTTP_4XX and http_status in [400, 499].

func _test_4xx(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")

	var cap: SignalCapture = SignalCapture.new()
	client.notes_fetched.connect(cap.on_notes_fetched)

	mock.queue(422, '{"error":2001}')
	client.fetch_notes(1, 1, 10)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("4xx: no signal received within 5 s")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_HTTP_4XX:
		failures.append(
			"4xx: expected STATE_HTTP_4XX (%d), got state=%d"
			% [NoteClient.STATE_HTTP_4XX, ev.state]
		)
	if ev.http_status < 400 or ev.http_status >= 500:
		failures.append(
			"4xx: expected http_status in [400,499], got %d" % ev.http_status
		)
	return failures


## ── Test: 5xx ────────────────────────────────────────────────────────────────
## Mock returns 500; expects STATE_HTTP_5XX and http_status >= 500.

func _test_5xx(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")

	var cap: SignalCapture = SignalCapture.new()
	client.notes_fetched.connect(cap.on_notes_fetched)

	mock.queue(500, '{"error":0}')
	client.fetch_notes(1, 1, 10)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("5xx: no signal received within 5 s")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_HTTP_5XX:
		failures.append(
			"5xx: expected STATE_HTTP_5XX (%d), got state=%d"
			% [NoteClient.STATE_HTTP_5XX, ev.state]
		)
	if ev.http_status < 500:
		failures.append(
			"5xx: expected http_status >= 500, got %d" % ev.http_status
		)
	return failures


## ── Test: fetch notes (success) ──────────────────────────────────────────────
## Mock returns 200 with an empty JSON array; expects STATE_OK.

func _test_fetch_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("tok")
	client.set_lease_id("lease")

	var cap: SignalCapture = SignalCapture.new()
	client.notes_fetched.connect(cap.on_notes_fetched)

	mock.queue(200, "[]")
	client.fetch_notes(1, 1, 10)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("fetch_success: no notes_fetched signal received")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_OK:
		failures.append(
			"fetch_success: expected STATE_OK (%d), got %d"
			% [NoteClient.STATE_OK, ev.state]
		)
	if ev.http_status != 200:
		failures.append(
			"fetch_success: expected http_status=200, got %d" % ev.http_status
		)
	return failures


## ── Test: post note (success) ─────────────────────────────────────────────────
## Mock returns 201 with a note id; expects STATE_OK on note_posted signal.

func _test_post_note_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("tok")
	client.set_lease_id("lease")

	var cap: SignalCapture = SignalCapture.new()
	client.note_posted.connect(cap.on_note_posted)

	mock.queue(201, '{"id":"abc-123"}')
	var slots: Array = [21, 49]
	client.post_note(1, 1, 1, slots, "")
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("post_success: no note_posted signal received")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_OK:
		failures.append(
			"post_success: expected STATE_OK (%d), got %d"
			% [NoteClient.STATE_OK, ev.state]
		)
	if ev.http_status != 201:
		failures.append(
			"post_success: expected http_status=201, got %d" % ev.http_status
		)
	return failures


## ── Test: rate note (success) ─────────────────────────────────────────────────
## Mock returns 204 (no content); expects STATE_OK on note_rated signal.

func _test_rate_note_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("tok")
	client.set_lease_id("lease")

	var cap: SignalCapture = SignalCapture.new()
	client.note_rated.connect(cap.on_note_rated)

	mock.queue(204, "")
	client.rate_note("abc-123", 1)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("rate_success: no note_rated signal received")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_OK:
		failures.append(
			"rate_success: expected STATE_OK (%d), got %d"
			% [NoteClient.STATE_OK, ev.state]
		)
	if ev.http_status != 204:
		failures.append(
			"rate_success: expected http_status=204, got %d" % ev.http_status
		)
	return failures
