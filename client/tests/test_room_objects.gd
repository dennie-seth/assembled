extends SceneTree
## T-0179: Room interaction vocabulary — item-locked door, switch-locked
## door/gate, lever, ladder.
##
## Verifies:
##   - ItemLockedDoor accepts a matching item and rejects a non-matching one
##   - SwitchLockedGate opens on the correct switch sequence; wrong sequence
##     leaves it closed; solved state is session-tier and can be reset
##   - Lever delays a tied entity (on_delayed called) and emits entity_delayed;
##     double-activate is a no-op
##   - Ladder is always usable and IS_GATED == false
##
## Run headless:
##   godot --headless --script tests/test_room_objects.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const ItemLockedDoor := preload("res://room/item_locked_door.gd")
const SwitchLockedGate := preload("res://room/switch_locked_gate.gd")
const Lever := preload("res://room/lever.gd")
const Ladder := preload("res://room/ladder.gd")


## Mock entity: records every on_delayed() call so tests can assert it.
class MockEntity extends Node:
	var delay_calls: Array[float] = []

	func on_delayed(duration_sec: float) -> void:
		delay_calls.append(duration_sec)


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_item_door_accepted()
	failures += _test_item_door_rejected()
	failures += _test_item_door_already_open()
	failures += _test_gate_correct_sequence()
	failures += _test_gate_wrong_sequence()
	failures += _test_gate_session_tier()
	failures += _test_lever_delays_entity()
	failures += _test_lever_no_double_activate()
	failures += _test_ladder_always_usable()
	failures += _test_ladder_not_gated()

	if failures.is_empty():
		print("T-0179 PASS: Room interaction vocabulary verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0179 FAIL: " + f)
		quit(1)


# ── Item-locked door ──────────────────────────────────────────────────────────

func _test_item_door_accepted() -> Array[String]:
	var failures: Array[String] = []
	var door := ItemLockedDoor.new()
	door.unlock_item_id = "ward_key"

	var result: int = door.use_item("ward_key")
	if result != ItemLockedDoor.UseResult.ACCEPTED:
		failures.append(
			"item_door: matching item should return ACCEPTED, got %d" % result
		)
	if not door.is_open:
		failures.append("item_door: door should be open after matching use")
	door.free()
	return failures


func _test_item_door_rejected() -> Array[String]:
	## Acceptance criterion: an item-locked door rejects a use call carrying
	## an item that does not match its unlock rule.
	var failures: Array[String] = []
	var door := ItemLockedDoor.new()
	door.unlock_item_id = "ward_key"

	var result: int = door.use_item("bandage")
	if result != ItemLockedDoor.UseResult.REJECTED:
		failures.append(
			"item_door: non-matching item should return REJECTED, got %d" % result
		)
	if door.is_open:
		failures.append("item_door: door must remain closed when item does not match")
	door.free()
	return failures


func _test_item_door_already_open() -> Array[String]:
	## Once open the door no longer blocks; any use call returns ACCEPTED.
	var failures: Array[String] = []
	var door := ItemLockedDoor.new()
	door.unlock_item_id = "ward_key"
	door.is_open = true

	var result: int = door.use_item("wrong_item")
	if result != ItemLockedDoor.UseResult.ACCEPTED:
		failures.append(
			"item_door: use on already-open door should return ACCEPTED, got %d" % result
		)
	door.free()
	return failures


# ── Switch-locked gate ────────────────────────────────────────────────────────

func _test_gate_correct_sequence() -> Array[String]:
	var failures: Array[String] = []
	var gate := SwitchLockedGate.new()
	gate.required_sequence = [3, 1, 2]

	gate.activate_switch(3)
	gate.activate_switch(1)
	gate.activate_switch(2)

	if not gate.is_solved:
		failures.append(
			"switch_gate: correct sequence [3,1,2] should set is_solved=true"
		)
	gate.free()
	return failures


func _test_gate_wrong_sequence() -> Array[String]:
	var failures: Array[String] = []
	var gate := SwitchLockedGate.new()
	gate.required_sequence = [3, 1, 2]

	gate.activate_switch(1)
	gate.activate_switch(3)
	gate.activate_switch(2)

	if gate.is_solved:
		failures.append(
			"switch_gate: wrong sequence [1,3,2] must not open gate"
		)
	gate.free()
	return failures


func _test_gate_session_tier() -> Array[String]:
	## Edge case: the solved state is session-tier (10-time-and-progression.md
	## §3) — not permanent. reset_session() simulates server-side decay
	## (T-0127). This card owns the interaction only, not the decay timer.
	var failures: Array[String] = []
	var gate := SwitchLockedGate.new()
	gate.required_sequence = [1, 2]

	gate.activate_switch(1)
	gate.activate_switch(2)
	if not gate.is_solved:
		failures.append("switch_gate/session: expected is_solved=true before reset")

	gate.reset_session()
	if gate.is_solved:
		failures.append(
			"switch_gate/session: is_solved must be false after reset_session() — "
			+ "solved state is session-tier, not permanent"
		)
	gate.free()
	return failures


# ── Lever ─────────────────────────────────────────────────────────────────────

func _test_lever_delays_entity() -> Array[String]:
	## Acceptance criterion: a lever tied to a positioned entity delays that
	## entity's sensor/movement behaviour on activation.
	var failures: Array[String] = []
	var lever := Lever.new()
	var mock := MockEntity.new()
	lever.entity = mock
	lever.delay_duration_sec = 4.0

	var signal_fired: Array = []
	lever.entity_delayed.connect(func(e: Node, dur: float) -> void:
		signal_fired.append({"entity": e, "duration": dur})
	)

	lever.activate()

	if not lever.is_activated:
		failures.append("lever: is_activated should be true after activate()")

	if signal_fired.is_empty():
		failures.append("lever: entity_delayed signal was not emitted on activate()")
	elif signal_fired[0].duration != 4.0:
		failures.append(
			"lever: entity_delayed duration expected 4.0, got %f"
			% signal_fired[0].duration
		)

	if mock.delay_calls.is_empty():
		failures.append("lever: entity.on_delayed() was not called on activate()")
	elif mock.delay_calls[0] != 4.0:
		failures.append(
			"lever: entity.on_delayed got %f, expected 4.0" % mock.delay_calls[0]
		)

	mock.free()
	lever.free()
	return failures


func _test_lever_no_double_activate() -> Array[String]:
	## activate() while already activated is a no-op — on_delayed must be
	## called exactly once.
	var failures: Array[String] = []
	var lever := Lever.new()
	var mock := MockEntity.new()
	lever.entity = mock
	lever.delay_duration_sec = 3.0

	lever.activate()
	lever.activate()

	if mock.delay_calls.size() != 1:
		failures.append(
			"lever: on_delayed should be called exactly once; got %d calls"
			% mock.delay_calls.size()
		)

	mock.free()
	lever.free()
	return failures


# ── Ladder ────────────────────────────────────────────────────────────────────

func _test_ladder_always_usable() -> Array[String]:
	var failures: Array[String] = []
	var ladder := Ladder.new()
	ladder.target_room_id = "room_b2"

	if not ladder.use():
		failures.append("ladder: use() must always return true — never gated")
	ladder.free()
	return failures


func _test_ladder_not_gated() -> Array[String]:
	var failures: Array[String] = []
	if Ladder.IS_GATED:
		failures.append("ladder: IS_GATED must be false — ladders are never gated")
	return failures
