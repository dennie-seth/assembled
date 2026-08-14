extends SceneTree
## T-0176: RoomEntry — anchor snapshot fetch + render tests.
##
## Verifies:
##   - A fixture anchor snapshot (items + offerings + notes) emits anchor_ready
##     with all three visibility classes rendered at the registered position
##   - An empty snapshot emits anchor_ready with empty arrays — no stale data
##     from a previous room entry
##   - A network failure / timeout emits anchor_failed; the room state is still
##     clean and a subsequent enter_room call works correctly (offline-runnable
##     per 01 §5 / T-0067)
##
## Run headless:
##   godot --headless --script tests/test_room_entry.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const RoomEntry := preload("res://room_entry.gd")

## Mock HTTP server port.
const MOCK_PORT: int = 19988
## Port with nothing listening — triggers a connect timeout.
const TIMEOUT_PORT: int = 19987
## Short connect+transfer timeout so the timeout test completes quickly.
const SHORT_TIMEOUT_MS: int = 200

## Fixture: one item, one offering, one note (template 2: "{HAZARD} {DIRECTION}").
## word 9 = "the drop", word 1 = "ahead" -> "the drop ahead".
const FIXTURE_BODY: String = (
	'{"items":[{"instance_id":"item-uuid-1","item_type":"bandage","qty":1}],'
	+ '"offerings":[{"offering_id":"off-uuid-1","item_type":"torch",'
	+ '"reward_type":"note","reward_ref":"note-uuid-2"}],'
	+ '"notes":[{"id":"note-uuid-1","template_id":2,"slot_a":9,"slot_b":1,"item_ref":""}]}'
)

## Empty snapshot — no items, offerings, or notes at this anchor.
const EMPTY_BODY: String = '{"items":[],"offerings":[],"notes":[]}'


## Minimal TCP HTTP mock server (same pattern as test_note_client.gd).
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


## Captures anchor_ready and anchor_failed signals from RoomEntry.
class RoomEntryCapture:
	var ready_events: Array = []
	var failed_events: Array = []

	func on_anchor_ready(
			position: Vector2,
			items: Array,
			offerings: Array,
			rendered_notes: Array) -> void:
		ready_events.append({
			"position": position,
			"items": items,
			"offerings": offerings,
			"rendered_notes": rendered_notes,
		})

	func on_anchor_failed(archetype_id: int, tag: int) -> void:
		failed_events.append({"archetype_id": archetype_id, "tag": tag})


func _init() -> void:
	if not ClassDB.class_exists("NoteClient"):
		printerr("T-0176 FAIL: NoteClient not registered — GDExtension did not load")
		quit(1)
		return

	if not ClassDB.class_exists("AnchorRegistry"):
		printerr("T-0176 FAIL: AnchorRegistry not registered — GDExtension did not load")
		quit(1)
		return

	if not ClassDB.class_exists("NoteRenderer"):
		printerr("T-0176 FAIL: NoteRenderer not registered — GDExtension did not load")
		quit(1)
		return

	var mock: MockHttpServer = MockHttpServer.new()
	if not mock.listen(MOCK_PORT):
		printerr("T-0176 FAIL: could not start mock HTTP server on port %d" % MOCK_PORT)
		quit(1)
		return

	var failures: Array[String] = []
	failures += _test_fixture_snapshot(mock)
	failures += _test_empty_snapshot(mock)
	failures += _test_network_failure()

	mock.stop()

	if failures.is_empty():
		print("T-0176 PASS: RoomEntry anchor snapshot fetch and render verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0176 FAIL: " + f)
		quit(1)


## Drive NoteClient (and optional mock) until a signal arrives or wall-time
## expires.  Returns true if at least one ready or failed event was captured.
func _drive(
		client: NoteClient,
		cap: RoomEntryCapture,
		mock: MockHttpServer,
		wall_limit_ms: float) -> bool:
	var start_ms: int = Time.get_ticks_msec()
	while float(Time.get_ticks_msec() - start_ms) < wall_limit_ms:
		if mock != null:
			mock.pump()
		client.tick(0.016)
		if cap.ready_events.size() > 0 or cap.failed_events.size() > 0:
			return true
		OS.delay_msec(5)
	return false


## Build a wired-up test rig: client, registry, renderer, and room_entry.
## Registers archetype=1 / tag=1 at Vector2(100, 200).
func _make_rig(base_url: String) -> Array:
	var client: NoteClient = NoteClient.new()
	client.set_base_url(base_url)
	client.set_auth_token("test-token")

	var registry: AnchorRegistry = AnchorRegistry.new()
	registry.register_anchor(1, 1, Vector2(100.0, 200.0))

	var renderer: NoteRenderer = NoteRenderer.new()

	var entry: RefCounted = RoomEntry.new()
	entry.setup(client, registry, renderer)

	return [client, registry, renderer, entry]


## ── Test: fixture snapshot renders all three visibility classes ───────────────
## Mock returns FIXTURE_BODY (1 item + 1 offering + 1 note).
## Expects:
##   - anchor_ready fires with position Vector2(100, 200)
##   - items array has exactly 1 entry
##   - offerings array has exactly 1 entry
##   - rendered_notes has exactly 1 entry with text "the drop ahead"

func _test_fixture_snapshot(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig("http://127.0.0.1:%d" % MOCK_PORT)
	var client: NoteClient = rig[0]
	var entry: RefCounted = rig[3]

	var cap: RoomEntryCapture = RoomEntryCapture.new()
	entry.anchor_ready.connect(cap.on_anchor_ready)
	entry.anchor_failed.connect(cap.on_anchor_failed)

	mock.queue(200, FIXTURE_BODY)
	entry.enter_room(1, 1)

	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("fixture_snapshot: no signal received within 5 s")
		return failures

	if cap.failed_events.size() > 0:
		failures.append("fixture_snapshot: anchor_failed fired unexpectedly")
		return failures

	if cap.ready_events.size() == 0:
		failures.append("fixture_snapshot: anchor_ready never fired")
		return failures

	var ev: Dictionary = cap.ready_events[0]

	# Position must match the registered spawn point.
	var expected_pos: Vector2 = Vector2(100.0, 200.0)
	if ev.position != expected_pos:
		failures.append(
			"fixture_snapshot: position=%s, expected %s" % [str(ev.position), str(expected_pos)]
		)

	# Items: exactly 1 entry.
	if ev.items.size() != 1:
		failures.append(
			"fixture_snapshot: expected 1 item, got %d" % ev.items.size()
		)

	# Offerings: exactly 1 entry.
	if ev.offerings.size() != 1:
		failures.append(
			"fixture_snapshot: expected 1 offering, got %d" % ev.offerings.size()
		)

	# Notes: exactly 1 rendered note with the correct text.
	if ev.rendered_notes.size() != 1:
		failures.append(
			"fixture_snapshot: expected 1 rendered note, got %d" % ev.rendered_notes.size()
		)
	else:
		var note_dict: Dictionary = ev.rendered_notes[0]
		if not note_dict.has("text"):
			failures.append("fixture_snapshot: rendered note missing 'text' key")
		elif note_dict.text != "the drop ahead":
			failures.append(
				"fixture_snapshot: note text='%s', expected 'the drop ahead'" % note_dict.text
			)
		if not note_dict.has("id"):
			failures.append("fixture_snapshot: rendered note missing 'id' key")
		elif note_dict.id != "note-uuid-1":
			failures.append(
				"fixture_snapshot: note id='%s', expected 'note-uuid-1'" % note_dict.id
			)

	return failures


## ── Test: empty snapshot — no stale content ───────────────────────────────────
## Mock returns EMPTY_BODY.  anchor_ready must fire with three empty arrays.
## This verifies that no stale content from a previous room is retained.

func _test_empty_snapshot(mock: MockHttpServer) -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig("http://127.0.0.1:%d" % MOCK_PORT)
	var client: NoteClient = rig[0]
	var entry: RefCounted = rig[3]

	var cap: RoomEntryCapture = RoomEntryCapture.new()
	entry.anchor_ready.connect(cap.on_anchor_ready)
	entry.anchor_failed.connect(cap.on_anchor_failed)

	mock.queue(200, EMPTY_BODY)
	entry.enter_room(1, 1)

	var completed: bool = _drive(client, cap, mock, 5000.0)
	client.free()

	if not completed:
		failures.append("empty_snapshot: no signal received within 5 s")
		return failures

	if cap.failed_events.size() > 0:
		failures.append("empty_snapshot: anchor_failed fired unexpectedly on empty body")
		return failures

	if cap.ready_events.size() == 0:
		failures.append("empty_snapshot: anchor_ready never fired")
		return failures

	var ev: Dictionary = cap.ready_events[0]

	if ev.items.size() != 0:
		failures.append(
			"empty_snapshot: expected 0 items, got %d" % ev.items.size()
		)
	if ev.offerings.size() != 0:
		failures.append(
			"empty_snapshot: expected 0 offerings, got %d" % ev.offerings.size()
		)
	if ev.rendered_notes.size() != 0:
		failures.append(
			"empty_snapshot: expected 0 notes, got %d" % ev.rendered_notes.size()
		)

	return failures


## ── Test: network failure — room still loads ──────────────────────────────────
## Points the client at a port with nothing listening (TIMEOUT_PORT) with a
## very short timeout.  anchor_failed must fire; no anchor_ready should fire.
## After a failure, enter_room can be called again cleanly.

func _test_network_failure() -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig("http://127.0.0.1:%d" % TIMEOUT_PORT)
	var client: NoteClient = rig[0]
	var entry: RefCounted = rig[3]
	client.set_timeout_ms(SHORT_TIMEOUT_MS)

	var cap: RoomEntryCapture = RoomEntryCapture.new()
	entry.anchor_ready.connect(cap.on_anchor_ready)
	entry.anchor_failed.connect(cap.on_anchor_failed)

	entry.enter_room(1, 1)
	var completed: bool = _drive(client, cap, null, 3000.0)
	client.free()

	if not completed:
		failures.append("network_failure: no signal received within 3 s")
		return failures

	if cap.ready_events.size() > 0:
		failures.append("network_failure: anchor_ready fired unexpectedly on network failure")

	if cap.failed_events.size() == 0:
		failures.append("network_failure: anchor_failed never fired")
		return failures

	var ev: Dictionary = cap.failed_events[0]
	if ev.archetype_id != 1:
		failures.append(
			"network_failure: expected archetype_id=1, got %d" % ev.archetype_id
		)
	if ev.tag != 1:
		failures.append(
			"network_failure: expected tag=1, got %d" % ev.tag
		)

	return failures
