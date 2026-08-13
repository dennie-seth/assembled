extends SceneTree
## T-0066: IdentityStore persistence tests.
##
## Verifies:
##   - Persistence round-trip: save then load returns the same phrase
##   - Missing-file path: load returns "" when file absent (deliberate — empty
##     string is the first-run signal; the caller must request a new phrase)
##   - NoteClient.request_identity emits identity_received with phrase on 201
##   - NoteClient.request_identity emits identity_received with error state on 5xx
##
## Run headless:
##   godot --headless --script tests/test_identity_store.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const IdentityStore := preload("res://identity_store.gd")

## Temporary path used during tests — never touches the production phrase file.
const TEST_PATH := "user://test_T0066.phrase"
## Port for the in-process mock HTTP server used by identity-request tests.
const MOCK_PORT: int = 19996


## Minimal TCP mock server (same pattern as test_note_client.gd).
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


## Signal capture for identity_received events.
class IdentityCapture:
	var events: Array = []

	func on_identity_received(state: int, http_status: int, phrase: String) -> void:
		events.append({"state": state, "http_status": http_status, "phrase": phrase})


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_round_trip()
	failures += _test_missing_file()
	failures += _test_first_run_notice()

	if ClassDB.class_exists("NoteClient"):
		var mock := MockHttpServer.new()
		if mock.listen(MOCK_PORT):
			failures += _test_identity_request_success(mock)
			failures += _test_identity_request_5xx(mock)
			mock.stop()
		else:
			failures.append(
				"identity_request: could not start mock HTTP server on port %d" % MOCK_PORT
			)
	else:
		failures.append(
			"identity_request: NoteClient not registered — GDExtension did not load"
		)

	# Clean up temp file regardless of test outcome.
	if FileAccess.file_exists(TEST_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))

	if failures.is_empty():
		print("T-0066 PASS: IdentityStore persistence and identity request verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0066 FAIL: " + f)
		quit(1)


## Drive NoteClient (and optional mock) until a signal arrives or wall-time expires.
func _drive(
		client: NoteClient,
		cap: IdentityCapture,
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


## ── Test: persistence round-trip ─────────────────────────────────────────────
## save_phrase then load_phrase must return the identical phrase string.

func _test_round_trip() -> Array[String]:
	var failures: Array[String] = []
	var phrase := "alpha bravo charlie delta echo foxtrot golf hotel"

	var ok := IdentityStore.save_phrase(phrase, TEST_PATH)
	if not ok:
		failures.append("round_trip: save_phrase returned false")
		return failures

	var loaded := IdentityStore.load_phrase(TEST_PATH)
	if loaded != phrase:
		failures.append(
			"round_trip: loaded '%s', expected '%s'" % [loaded, phrase]
		)

	if not IdentityStore.has_phrase(TEST_PATH):
		failures.append("round_trip: has_phrase returned false after save")

	return failures


## ── Test: missing file ────────────────────────────────────────────────────────
## load_phrase on a path that does not exist must return "" and must NOT crash.
## Empty string is the deliberate first-run signal — the caller must request a
## new phrase from the server rather than silently skipping identity.

func _test_missing_file() -> Array[String]:
	var failures: Array[String] = []
	var absent := "user://T0066_absent_xyz987.phrase"

	var result := IdentityStore.load_phrase(absent)
	if result != "":
		failures.append(
			"missing_file: expected empty string, got '%s'" % result
		)

	if IdentityStore.has_phrase(absent):
		failures.append("missing_file: has_phrase returned true for nonexistent file")

	return failures


## ── Test: first-run notice ────────────────────────────────────────────────────
## FIRST_RUN_NOTICE must exist and state plainly that phrase loss is final
## (09-identity.md §1, 18-first-run.md §2).

func _test_first_run_notice() -> Array[String]:
	var failures: Array[String] = []
	var notice: String = IdentityStore.FIRST_RUN_NOTICE

	if notice.is_empty():
		failures.append("first_run_notice: FIRST_RUN_NOTICE is empty")
		return failures

	# Must clearly convey that loss is final — no recovery path exists.
	var keywords := ["no way back", "no password reset", "no support"]
	for kw: String in keywords:
		if not notice.to_lower().contains(kw.to_lower()):
			failures.append(
				"first_run_notice: expected '%s' in FIRST_RUN_NOTICE" % kw
			)

	return failures


## ── Test: request_identity success ───────────────────────────────────────────
## Mock returns 201 {"phrase":"..."}; expects STATE_OK and the exact phrase.

func _test_identity_request_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var expected := "alpha bravo charlie delta echo foxtrot golf hotel"

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var cap := IdentityCapture.new()
	client.identity_received.connect(cap.on_identity_received)

	mock.queue(201, '{"phrase":"%s"}' % expected)
	client.request_identity()
	var completed := _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("identity_success: no identity_received signal within 5 s")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_OK:
		failures.append(
			"identity_success: expected STATE_OK (%d), got %d"
			% [NoteClient.STATE_OK, ev.state]
		)
	if ev.http_status != 201:
		failures.append(
			"identity_success: expected http_status=201, got %d" % ev.http_status
		)
	if ev.phrase != expected:
		failures.append(
			"identity_success: phrase='%s', expected '%s'" % [ev.phrase, expected]
		)

	return failures


## ── Test: request_identity 5xx ────────────────────────────────────────────────
## Mock returns 500; expects STATE_HTTP_5XX and an empty phrase string.

func _test_identity_request_5xx(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: NoteClient = NoteClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)

	var cap := IdentityCapture.new()
	client.identity_received.connect(cap.on_identity_received)

	mock.queue(500, '{"error":0}')
	client.request_identity()
	var completed := _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("identity_5xx: no identity_received signal within 5 s")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != NoteClient.STATE_HTTP_5XX:
		failures.append(
			"identity_5xx: expected STATE_HTTP_5XX (%d), got %d"
			% [NoteClient.STATE_HTTP_5XX, ev.state]
		)
	if ev.phrase != "":
		failures.append(
			"identity_5xx: expected empty phrase on error, got '%s'" % ev.phrase
		)

	return failures
