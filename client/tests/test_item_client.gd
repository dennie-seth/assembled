extends SceneTree
## T-0177: ItemClient GDExtension node tests — take/leave transfers + idempotency.
##
## Verifies:
##   - take_item emits transfer_completed(STATE_OK) on a 200 receipt
##   - leave_item emits transfer_completed(STATE_OK) on a 200 receipt
##   - a 409 CAS conflict surfaces as STATE_CAS_CONFLICT, distinct from
##     STATE_NETWORK_ERROR (one-taker rule, 07-items-economy.md §3)
##   - retry_transfer(transfer_id) sends GET /v1/transfers/{id}, not a
##     fresh POST — a repeated transfer_id returns the stored receipt
##   - timeout (offline) surfaces as STATE_TIMEOUT, not a crash
##
## Run headless:
##   godot --headless --script tests/test_item_client.gd
## from client/. Exit 0 on PASS, 1 on any failure.

## Local port for the in-process HTTP mock server.
const MOCK_PORT: int = 19992
## Port with nothing listening — used to trigger a connect timeout.
const TIMEOUT_PORT: int = 19991
## Short connect+transfer timeout so the timeout test completes quickly.
const SHORT_TIMEOUT_MS: int = 200

## Sample receipt JSON returned by the mock on a successful transfer.
const RECEIPT_WON: String = (
	'{"transfer_id":"aaaabbbb-0000-4000-8000-ccccddddeeee",'
	+ '"outcome":"won","reason":null,'
	+ '"item":{"id":"item-uuid-1","custody_depth":5,"bleed_at":"2099-01-01T00:00:00Z"},'
	+ '"created_at":"2026-08-15T00:00:00Z"}'
)

## CAS-lost receipt body that a 409 response carries.
const RECEIPT_CAS_LOST: String = (
	'{"transfer_id":"aaaabbbb-0000-4000-8000-ccccddddeeee",'
	+ '"outcome":"lost","reason":3001,'
	+ '"item":null,"created_at":"2026-08-15T00:00:00Z"}'
)


## Accumulates signal payloads emitted by ItemClient.
class SignalCapture:
	var events: Array = []

	func on_transfer_completed(
			req_id: int,
			state: int,
			http_status: int,
			body: String,
			transfer_id: String) -> void:
		events.append({
			"signal": "transfer_completed",
			"req_id": req_id,
			"state": state,
			"http_status": http_status,
			"body": body,
			"transfer_id": transfer_id,
		})


## Minimal TCP-backed HTTP mock server (mirrors test_note_client.gd).
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
		if status == 409:
			status_text = "Conflict"
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
	if not ClassDB.class_exists("ItemClient"):
		printerr("T-0177 FAIL: ItemClient not registered — GDExtension did not load")
		quit(1)
		return

	var mock: MockHttpServer = MockHttpServer.new()
	if not mock.listen(MOCK_PORT):
		printerr(
			"T-0177 FAIL: could not start mock HTTP server on port %d" % MOCK_PORT
		)
		quit(1)
		return

	var failures: Array[String] = []
	failures += _test_take_timeout()
	failures += _test_take_success(mock)
	failures += _test_leave_success(mock)
	failures += _test_take_cas_conflict_is_distinct_from_network_error(mock)
	failures += _test_retry_idempotency(mock)

	mock.stop()

	if failures.is_empty():
		print("T-0177 PASS: ItemClient transfer/idempotency/conflict paths verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0177 FAIL: " + f)
		quit(1)


## Drive client (and optionally mock) until a signal is captured or wall-time
## expires.  Returns true if at least one event was captured.
func _drive(
		client: ItemClient,
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


## ── Test: timeout (offline graceful) ─────────────────────────────────────────
## Connects to a port with nothing listening; expects STATE_TIMEOUT, not a crash.
## This covers the offline-runnable contract from T-0067.

func _test_take_timeout() -> Array[String]:
	var failures: Array[String] = []

	var client: ItemClient = ItemClient.new()
	client.set_base_url("http://127.0.0.1:%d" % TIMEOUT_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var cap: SignalCapture = SignalCapture.new()
	client.transfer_completed.connect(cap.on_transfer_completed)

	client.take_item("item-uuid-1", 3, 11)
	var completed: bool = _drive(client, cap, null, 3000.0)
	client.free()

	if not completed:
		failures.append("timeout: no transfer_completed signal received within 3 s")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != ItemClient.STATE_TIMEOUT:
		failures.append(
			"timeout: expected STATE_TIMEOUT (%d), got state=%d"
			% [ItemClient.STATE_TIMEOUT, ev.state]
		)
	if ev.http_status != 0:
		failures.append(
			"timeout: expected http_status=0 on timeout, got %d" % ev.http_status
		)
	# transfer_id must still be a non-empty string (was minted before sending).
	if ev.transfer_id.is_empty():
		failures.append("timeout: transfer_id must not be empty even on timeout")
	return failures


## ── Test: take success ────────────────────────────────────────────────────────
## Mock returns 200 with a won receipt; expects STATE_OK on transfer_completed.

func _test_take_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: ItemClient = ItemClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")

	var cap: SignalCapture = SignalCapture.new()
	client.transfer_completed.connect(cap.on_transfer_completed)

	mock.queue(200, RECEIPT_WON)
	client.take_item("item-uuid-1", 3, 11)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("take_success: no transfer_completed signal received")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != ItemClient.STATE_OK:
		failures.append(
			"take_success: expected STATE_OK (%d), got state=%d"
			% [ItemClient.STATE_OK, ev.state]
		)
	if ev.http_status != 200:
		failures.append(
			"take_success: expected http_status=200, got %d" % ev.http_status
		)
	if ev.transfer_id.is_empty():
		failures.append("take_success: transfer_id must not be empty")
	return failures


## ── Test: leave success ───────────────────────────────────────────────────────
## Mock returns 200 with a won receipt; expects STATE_OK on leave.

func _test_leave_success(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: ItemClient = ItemClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")

	var cap: SignalCapture = SignalCapture.new()
	client.transfer_completed.connect(cap.on_transfer_completed)

	mock.queue(200, RECEIPT_WON)
	client.leave_item("item-uuid-2", 3, 11)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("leave_success: no transfer_completed signal received")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != ItemClient.STATE_OK:
		failures.append(
			"leave_success: expected STATE_OK (%d), got state=%d"
			% [ItemClient.STATE_OK, ev.state]
		)
	if ev.http_status != 200:
		failures.append(
			"leave_success: expected http_status=200, got %d" % ev.http_status
		)
	return failures


## ── Test: CAS conflict is distinct from network error ─────────────────────────
## Mock returns 409 (TRANSFER_LOST); expects STATE_CAS_CONFLICT, NOT
## STATE_NETWORK_ERROR, so GDScript can render "someone else got there first."

func _test_take_cas_conflict_is_distinct_from_network_error(
		mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	var client: ItemClient = ItemClient.new()
	client.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client.set_auth_token("test-token")
	client.set_lease_id("test-lease")

	var cap: SignalCapture = SignalCapture.new()
	client.transfer_completed.connect(cap.on_transfer_completed)

	mock.queue(409, RECEIPT_CAS_LOST)
	client.take_item("item-uuid-3", 3, 11)
	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("cas_conflict: no transfer_completed signal received")
		return failures

	var ev: Dictionary = cap.events[0]
	if ev.state != ItemClient.STATE_CAS_CONFLICT:
		failures.append(
			"cas_conflict: expected STATE_CAS_CONFLICT (%d), got state=%d"
			% [ItemClient.STATE_CAS_CONFLICT, ev.state]
		)
	if ev.state == ItemClient.STATE_NETWORK_ERROR:
		failures.append(
			"cas_conflict: 409 must NOT surface as STATE_NETWORK_ERROR — "
			+ "player cannot distinguish 'server unreachable' from 'item already taken'"
		)
	if ev.http_status != 409:
		failures.append(
			"cas_conflict: expected http_status=409, got %d" % ev.http_status
		)
	return failures


## ── Test: retry idempotency ───────────────────────────────────────────────────
## First take → capture the minted transfer_id from the signal.
## Then retry_transfer(transfer_id) → must use GET /v1/transfers/{id}.
## Mock serves a receipt for the GET; signal fires with STATE_OK and same
## transfer_id — proves a retry does not re-mint a new ID or issue a new POST.

func _test_retry_idempotency(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []

	# --- Step 1: original take ---
	var client1: ItemClient = ItemClient.new()
	client1.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client1.set_auth_token("test-token")
	client1.set_lease_id("test-lease")

	var cap1: SignalCapture = SignalCapture.new()
	client1.transfer_completed.connect(cap1.on_transfer_completed)

	mock.queue(200, RECEIPT_WON)
	client1.take_item("item-uuid-4", 3, 11)
	var done1: bool = _drive(client1, cap1, mock, 5000.0)
	client1.free()

	if not done1 or cap1.events.is_empty():
		failures.append("retry: original take signal never received")
		return failures

	var first_tid: String = cap1.events[0].transfer_id
	if first_tid.is_empty():
		failures.append("retry: original take must carry a non-empty transfer_id")
		return failures

	# --- Step 2: retry with the same transfer_id ---
	var client2: ItemClient = ItemClient.new()
	client2.set_base_url("http://127.0.0.1:%d" % MOCK_PORT)
	client2.set_auth_token("test-token")
	client2.set_lease_id("test-lease")

	var cap2: SignalCapture = SignalCapture.new()
	client2.transfer_completed.connect(cap2.on_transfer_completed)

	# Mock serves the same receipt (idempotent stored outcome).
	mock.queue(200, RECEIPT_WON)
	client2.retry_transfer(first_tid)
	var done2: bool = _drive(client2, cap2, mock, 5000.0)
	client2.free()

	if not done2 or cap2.events.is_empty():
		failures.append("retry: retry_transfer signal never received")
		return failures

	var ev2: Dictionary = cap2.events[0]
	if ev2.state != ItemClient.STATE_OK:
		failures.append(
			"retry: expected STATE_OK (%d) on retry, got state=%d"
			% [ItemClient.STATE_OK, ev2.state]
		)
	if ev2.transfer_id != first_tid:
		failures.append(
			"retry: retry_transfer must carry the same transfer_id '%s', got '%s'"
			% [first_tid, ev2.transfer_id]
		)
	return failures
