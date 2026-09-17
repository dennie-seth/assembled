extends SceneTree
## T-0196: Run lifecycle — start / traverse / end (death|quit|disconnect) / restart.
##
## Verifies the RunLifecycle state machine (client/scripts/run_lifecycle.gd):
##   1. start_run() transitions IDLE → RUNNING and emits run_started with archetypes.
##   2. end_run(DEATH) scatters all held items then emits scatter_complete(DEATH).
##   3. end_run(QUIT) scatters all held items then emits scatter_complete(QUIT).
##   4. end_run(DISCONNECT) scatters all held items then emits scatter_complete(DISCONNECT).
##   5. try_again() returns pinned archetypes and returns state to IDLE.
##   6. new_game() clears archetypes and returns state to IDLE.
##   7. end_run() is a no-op when not in RUNNING state (no double-scatter).
##   8. start_run() is a no-op when already RUNNING.
##
## Design refs: 01-vision.md §6 (run ends), 03-net-protocol.md §5 (runs endpoints).
##
## Run headless:
##   cd client && timeout 600 godot --headless --script tests/test_T0196_run_lifecycle.gd
## Exit 0 on PASS, 1 on any failure.

const RunLifecycle := preload("res://scripts/run_lifecycle.gd")

## Three archetypes the mock "server" assembled — {archetype_id, variant_id} pairs.
const FIXTURE_ARCHETYPES: Array = [
	{"archetype_id": 1, "variant_id": 1},
	{"archetype_id": 2, "variant_id": 1},
	{"archetype_id": 3, "variant_id": 1},
]
const FIXTURE_RUN_ID: String = "run-uuid-0196"
const FIXTURE_ITEMS: Array[String] = ["item-aaa", "item-bbb", "item-ccc"]


## Captures signals emitted by RunLifecycle during a test.
class Capture:
	var started_archetypes: Array = []
	var scattered_items: Array[String] = []
	var scatter_complete_causes: Array[int] = []
	var restart_archetypes: Array = []

	func on_run_started(archetypes: Array) -> void:
		started_archetypes = archetypes.duplicate()

	func on_item_scattered(item_id: String) -> void:
		scattered_items.append(item_id)

	func on_scatter_complete(cause: int) -> void:
		scatter_complete_causes.append(cause)

	func on_restart_ready(archetypes: Array) -> void:
		restart_archetypes = archetypes.duplicate()


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_start_run()
	failures += _test_end_run_death()
	failures += _test_end_run_quit()
	failures += _test_end_run_disconnect()
	failures += _test_try_again()
	failures += _test_new_game()
	failures += _test_end_run_noop_when_idle()
	failures += _test_end_run_noop_when_ended()
	failures += _test_start_run_noop_when_running()

	if failures.is_empty():
		print("T-0196 PASS: RunLifecycle state machine verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0196 FAIL: " + f)
		quit(1)


## Build a fresh RunLifecycle wired to a Capture.
func _make_rig() -> Array:
	var rl: RefCounted = RunLifecycle.new()
	var cap: Capture = Capture.new()
	rl.run_started.connect(cap.on_run_started)
	rl.item_scattered.connect(cap.on_item_scattered)
	rl.scatter_complete.connect(cap.on_scatter_complete)
	rl.restart_ready.connect(cap.on_restart_ready)
	return [rl, cap]


## ── Test 1: start_run() ───────────────────────────────────────────────────────
## Expect: state becomes RUNNING, run_started emitted with the 3 archetypes.
func _test_start_run() -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig()
	var rl: RefCounted = rig[0]
	var cap: Capture = rig[1]

	if rl.get_state() != RunLifecycle.RunState.IDLE:
		failures.append("start_run: initial state should be IDLE")

	rl.start_run(FIXTURE_RUN_ID, FIXTURE_ARCHETYPES)

	if rl.get_state() != RunLifecycle.RunState.RUNNING:
		failures.append("start_run: state should be RUNNING after start_run(), got %d" % rl.get_state())

	if cap.started_archetypes.size() != 3:
		failures.append("start_run: run_started should carry 3 archetypes, got %d" % cap.started_archetypes.size())

	if rl.get_run_id() != FIXTURE_RUN_ID:
		failures.append("start_run: run_id mismatch — expected '%s', got '%s'" % [FIXTURE_RUN_ID, rl.get_run_id()])

	if cap.started_archetypes != FIXTURE_ARCHETYPES:
		failures.append("start_run: run_started archetypes do not match fixture")

	return failures


## ── Test 2: end_run(DEATH) ───────────────────────────────────────────────────
## Expect: item_scattered emitted for each held item; scatter_complete(DEATH) fired;
## state becomes ENDED.
func _test_end_run_death() -> Array[String]:
	return _test_end_run_cause("death", RunLifecycle.EndCause.DEATH)


## ── Test 3: end_run(QUIT) ────────────────────────────────────────────────────
func _test_end_run_quit() -> Array[String]:
	return _test_end_run_cause("quit", RunLifecycle.EndCause.QUIT)


## ── Test 4: end_run(DISCONNECT) ──────────────────────────────────────────────
func _test_end_run_disconnect() -> Array[String]:
	return _test_end_run_cause("disconnect", RunLifecycle.EndCause.DISCONNECT)


## Shared helper for tests 2-4.
func _test_end_run_cause(label: String, cause: int) -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig()
	var rl: RefCounted = rig[0]
	var cap: Capture = rig[1]

	rl.start_run(FIXTURE_RUN_ID, FIXTURE_ARCHETYPES)
	rl.set_held_items(FIXTURE_ITEMS)
	rl.end_run(cause)

	if rl.get_state() != RunLifecycle.RunState.ENDED:
		failures.append(
			"end_run_%s: state should be ENDED after end_run(), got %d" % [label, rl.get_state()]
		)

	if cap.scattered_items.size() != FIXTURE_ITEMS.size():
		failures.append(
			"end_run_%s: expected %d item_scattered signals, got %d"
			% [label, FIXTURE_ITEMS.size(), cap.scattered_items.size()]
		)
	else:
		for i: int in range(FIXTURE_ITEMS.size()):
			if cap.scattered_items[i] != FIXTURE_ITEMS[i]:
				failures.append(
					"end_run_%s: item_scattered[%d] = '%s', expected '%s'"
					% [label, i, cap.scattered_items[i], FIXTURE_ITEMS[i]]
				)

	if cap.scatter_complete_causes.size() != 1:
		failures.append(
			"end_run_%s: expected 1 scatter_complete signal, got %d"
			% [label, cap.scatter_complete_causes.size()]
		)
	elif cap.scatter_complete_causes[0] != cause:
		failures.append(
			"end_run_%s: scatter_complete cause=%d, expected %d"
			% [label, cap.scatter_complete_causes[0], cause]
		)

	return failures


## ── Test 5: try_again() ──────────────────────────────────────────────────────
## Expect: state returns to IDLE; restart_ready emits the pinned archetypes.
func _test_try_again() -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig()
	var rl: RefCounted = rig[0]
	var cap: Capture = rig[1]

	rl.start_run(FIXTURE_RUN_ID, FIXTURE_ARCHETYPES)
	rl.end_run(RunLifecycle.EndCause.DEATH)

	var pinned: Array = rl.try_again()

	if rl.get_state() != RunLifecycle.RunState.IDLE:
		failures.append("try_again: state should be IDLE after try_again(), got %d" % rl.get_state())

	if pinned != FIXTURE_ARCHETYPES:
		failures.append("try_again: returned archetypes do not match fixture")

	if cap.restart_archetypes.size() != FIXTURE_ARCHETYPES.size():
		failures.append(
			"try_again: restart_ready should carry %d archetypes, got %d"
			% [FIXTURE_ARCHETYPES.size(), cap.restart_archetypes.size()]
		)

	if cap.restart_archetypes != FIXTURE_ARCHETYPES:
		failures.append("try_again: restart_ready archetypes do not match fixture")

	return failures


## ── Test 6: new_game() ───────────────────────────────────────────────────────
## Expect: state returns to IDLE; restart_ready emits an empty array (fresh assembly).
func _test_new_game() -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig()
	var rl: RefCounted = rig[0]
	var cap: Capture = rig[1]

	rl.start_run(FIXTURE_RUN_ID, FIXTURE_ARCHETYPES)
	rl.end_run(RunLifecycle.EndCause.QUIT)

	rl.new_game()

	if rl.get_state() != RunLifecycle.RunState.IDLE:
		failures.append("new_game: state should be IDLE after new_game(), got %d" % rl.get_state())

	if cap.restart_archetypes.size() != 0:
		failures.append(
			"new_game: restart_ready should carry 0 archetypes (fresh assembly), got %d"
			% cap.restart_archetypes.size()
		)

	if rl.get_archetypes().size() != 0:
		failures.append(
			"new_game: archetypes should be cleared after new_game(), got %d"
			% rl.get_archetypes().size()
		)

	return failures


## ── Test 7: end_run() no-op when IDLE ────────────────────────────────────────
## Expect: no state change; no signals emitted.
func _test_end_run_noop_when_idle() -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig()
	var rl: RefCounted = rig[0]
	var cap: Capture = rig[1]

	rl.end_run(RunLifecycle.EndCause.DEATH)

	if rl.get_state() != RunLifecycle.RunState.IDLE:
		failures.append("noop_idle: state should remain IDLE, got %d" % rl.get_state())

	if cap.scatter_complete_causes.size() != 0:
		failures.append("noop_idle: scatter_complete should not fire from IDLE")

	if cap.scattered_items.size() != 0:
		failures.append("noop_idle: item_scattered should not fire from IDLE")

	return failures


## ── Test 8: end_run() no-op when already ENDED ───────────────────────────────
## Expect: no additional signals; held items do not scatter twice.
func _test_end_run_noop_when_ended() -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig()
	var rl: RefCounted = rig[0]
	var cap: Capture = rig[1]

	rl.start_run(FIXTURE_RUN_ID, FIXTURE_ARCHETYPES)
	rl.set_held_items(FIXTURE_ITEMS)
	rl.end_run(RunLifecycle.EndCause.DEATH)

	# Second call should be a no-op.
	rl.end_run(RunLifecycle.EndCause.QUIT)

	if rl.get_state() != RunLifecycle.RunState.ENDED:
		failures.append("noop_ended: state should remain ENDED, got %d" % rl.get_state())

	if cap.scatter_complete_causes.size() != 1:
		failures.append(
			"noop_ended: scatter_complete should fire exactly once, fired %d times"
			% cap.scatter_complete_causes.size()
		)

	# Items should not scatter twice.
	if cap.scattered_items.size() != FIXTURE_ITEMS.size():
		failures.append(
			"noop_ended: item_scattered fired %d times (expected %d — no double scatter)"
			% [cap.scattered_items.size(), FIXTURE_ITEMS.size()]
		)

	return failures


## ── Test 9: start_run() no-op when already RUNNING ───────────────────────────
## Expect: no state change; run_started not emitted again.
func _test_start_run_noop_when_running() -> Array[String]:
	var failures: Array[String] = []
	var rig: Array = _make_rig()
	var rl: RefCounted = rig[0]
	var cap: Capture = rig[1]

	rl.start_run(FIXTURE_RUN_ID, FIXTURE_ARCHETYPES)
	# Reset capture to detect a spurious second emission.
	cap.started_archetypes = []

	rl.start_run("run-second-attempt", [{"archetype_id": 9, "variant_id": 9}])

	if rl.get_state() != RunLifecycle.RunState.RUNNING:
		failures.append("noop_running: state should remain RUNNING, got %d" % rl.get_state())

	if cap.started_archetypes.size() != 0:
		failures.append("noop_running: run_started should not fire when already RUNNING")

	if rl.get_run_id() != FIXTURE_RUN_ID:
		failures.append("noop_running: run_id should not change when already RUNNING")

	return failures
