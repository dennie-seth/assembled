extends SceneTree
## T-0188: PlayerController unit tests — side-on, no-jump model.
##
## Verifies the rebuilt movement contract (§11 §4 v5):
##   - No jump input, jump state, or airborne state exists anywhere
##   - Velocity Y is always 0 for any input combination (floor-plane confinement)
##   - Moving onto a Drop-gap tile → immediate DIE state, no intermediate frame
##   - Die state zeroes velocity and clears noise on the gap-death frame
##   - Stationary player adjacent to (but not on) a gap → no death
##   - Rapid direction-reversal while player is on a gap tile still triggers death
##     (current-position check, not only the candidate position check)
##   - Crossing a ladder/stairs connector emits room_transition signal
##   - room_transition carries the connector's target_room_id verbatim
##   - T-0173 interface preserved: IDLE/MOVE/CROUCH_HIDE/DIE enum values distinct
##   - T-0173 interface preserved: walk/run noise flag semantics
##   - T-0173 interface preserved: DIE overrides CROUCH_HIDE
##
## Run headless (from client/):
##   godot --headless --script tests/test_T0188_player_controller.gd
## Exit 0 on PASS, 1 on any failure.

const PlayerController := preload("res://player_controller.gd")

## Gap geometry: a single tile at col 10 in a 24-col room (x = [160, 176), 16 px tile).
const GAP_RECT: Rect2 = Rect2(160.0, -7.0, 16.0, 14.0)

## Wide synthetic gap used for "candidate enters gap" tests.  Spans x = [70, 190)
## so a player at x=0 walking right for delta=1 s (candidate centre at 80) intersects.
const WIDE_GAP: Rect2 = Rect2(70.0, -7.0, 120.0, 14.0)


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_no_jump_methods()
	failures += _test_floor_plane_velocity_y_always_zero()
	failures += _test_drop_gap_instant_death()
	failures += _test_drop_gap_velocity_and_noise_zeroed()
	failures += _test_adjacent_to_gap_no_death()
	failures += _test_rapid_reversal_on_gap_still_dies()
	failures += _test_ladder_transition_signal_fired()
	failures += _test_ladder_target_room_id_preserved()
	failures += _test_t0173_anim_states_four_distinct_values()
	failures += _test_t0173_noise_flag_preserved()
	failures += _test_t0173_die_overrides_crouch()

	if failures.is_empty():
		print("T-0188 PASS: PlayerController side-on no-jump model verified (11 groups)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0188 FAIL: " + f)
		quit(1)


# ── Helpers ────────────────────────────────────────────────────────────────────

## Instantiate a fresh PlayerController at the given world position.
func _make_pc(x: float = 0.0, y: float = 0.0) -> CharacterBody2D:
	var pc: CharacterBody2D = PlayerController.new()
	pc.position = Vector2(x, y)
	return pc


# ── No jump ────────────────────────────────────────────────────────────────────

## No jump or airborne methods must exist on the controller.
## Regression guard: if a future change re-introduces jump, this fails immediately.
func _test_no_jump_methods() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc()

	for method_name: String in ["apply_jump", "jump", "set_jump", "start_jump", "do_jump"]:
		if pc.has_method(method_name):
			failures.append(
				"no_jump_methods: '%s' must not exist on PlayerController" % method_name
			)

	pc.free()
	return failures


## Velocity Y is zero for every legal input combination — no vertical movement
## within a room (floor-plane confinement, §11 §4 v5).
func _test_floor_plane_velocity_y_always_zero() -> Array[String]:
	var failures: Array[String] = []

	for dir: float in [-1.0, 0.0, 1.0]:
		for run: bool in [false, true]:
			var pc: CharacterBody2D = _make_pc()
			pc.apply_input(dir, run)
			pc.update_state(0.016)
			if not is_zero_approx(pc.velocity.y):
				failures.append(
					"floor_plane_y_zero: velocity.y=%.4f (expected 0) for dir=%.1f run=%s"
					% [pc.velocity.y, dir, str(run)]
				)
			pc.free()

	return failures


# ── Drop-gap instant death ─────────────────────────────────────────────────────

## Walking right so the candidate next-frame position enters the wide gap rect
## must immediately produce DIE — no intermediate state.
##
## Player centre at (0, 0), WIDE_GAP at x=[70,190).
## WALK_SPEED=80, delta=1.0 s → candidate centre x=80 → candidate rect
## Rect2(74,-7,12,14) overlaps WIDE_GAP → DIE.
func _test_drop_gap_instant_death() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc(0.0, 0.0)
	pc.drop_gaps.append(WIDE_GAP)
	pc.apply_input(1.0, false)
	pc.update_state(1.0)

	if pc.anim_state != PlayerController.AnimState.DIE:
		failures.append(
			"drop_gap_instant_death: expected DIE (%d), got %d"
			% [PlayerController.AnimState.DIE, pc.anim_state]
		)

	pc.free()
	return failures


## On the frame that a gap triggers DIE, velocity must be zero and is_loud must
## be false — no glide, no noise emitted post-death.
func _test_drop_gap_velocity_and_noise_zeroed() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc(0.0, 0.0)
	pc.drop_gaps.append(WIDE_GAP)
	pc.apply_input(1.0, true)  # running — would normally set is_loud
	pc.update_state(1.0)

	if not is_zero_approx(pc.velocity.length()):
		failures.append(
			"gap_death_velocity_zero: velocity must be zeroed on die frame, got %.3f"
			% pc.velocity.length()
		)
	if pc.is_loud:
		failures.append("gap_death_noise_off: is_loud must be false on die frame")

	pc.free()
	return failures


## Player stationary on the tile immediately adjacent to a gap must NOT die.
## Only actual overlap (not adjacency) is lethal.
##
## Player centre at x=152 → right body edge at x=158.  GAP_RECT left at x=160.
## Body rect Rect2(146,-7,12,14) does not overlap GAP_RECT Rect2(160,-7,16,14).
func _test_adjacent_to_gap_no_death() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc(152.0, 0.0)
	pc.drop_gaps.append(GAP_RECT)
	pc.apply_input(0.0, false)  # stationary
	pc.update_state(0.016)

	if pc.anim_state == PlayerController.AnimState.DIE:
		failures.append(
			"adjacent_no_death: player adjacent (x=152, right edge=158) to gap (left=160) must not die"
		)

	pc.free()
	return failures


## Rapid direction-reversal while the player's body is already overlapping a gap
## tile must still trigger death.  The current-position rect is evaluated every
## frame, not only the candidate position.
##
## Player centre at x=168 (col 10 centre, squarely on the gap tile).
## Body rect Rect2(162,-7,12,14) overlaps GAP_RECT Rect2(160,-7,16,14).
## Input reversed to left (velocity moving AWAY from gap) — current check fires.
func _test_rapid_reversal_on_gap_still_dies() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc(168.0, 0.0)
	pc.drop_gaps.append(GAP_RECT)
	pc.apply_input(-1.0, false)  # reversed: moving left, away from gap
	pc.update_state(0.016)

	if pc.anim_state != PlayerController.AnimState.DIE:
		failures.append(
			"rapid_reversal_still_dies: player on gap (x=168) with reversed input must enter DIE (%d), got %d"
			% [PlayerController.AnimState.DIE, pc.anim_state]
		)

	pc.free()
	return failures


# ── Ladder / stairs connector ──────────────────────────────────────────────────

## Stepping into a connector area must emit the room_transition signal.
## Vertical room-to-room transition is connector-gated — never a general
## vertical movement capability (§11 §5).
##
## Signal capture uses an Array[String] (reference type) to avoid any
## ambiguity around bool closure-capture semantics in headless GDScript.
func _test_ladder_transition_signal_fired() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc(50.0, 0.0)

	# Use an Array as mutable capture — arrays are reference types.
	var captured: Array[String] = []
	pc.room_transition.connect(func(id: String) -> void: captured.append(id))

	# Connector area that contains the player's position (50, 0).
	pc.room_connectors.append({
		"area": Rect2(40.0, -10.0, 20.0, 20.0),
		"target_room_id": "room_upper"
	})
	pc.update_state(0.016)

	if captured.is_empty():
		failures.append(
			"ladder_signal: room_transition must be emitted when player centre is in connector area"
		)

	pc.free()
	return failures


## The room_transition signal carries the connector's target_room_id verbatim.
## This is the handle the room runtime uses to load the target room's floor plane —
## not a Y-position delta within the current room.
func _test_ladder_target_room_id_preserved() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc(50.0, 0.0)

	var captured: Array[String] = []
	pc.room_transition.connect(func(id: String) -> void: captured.append(id))

	pc.room_connectors.append({
		"area": Rect2(40.0, -10.0, 20.0, 20.0),
		"target_room_id": "basement_corridor"
	})
	pc.update_state(0.016)

	var received_id: String = captured[0] if not captured.is_empty() else ""
	if received_id != "basement_corridor":
		failures.append(
			"ladder_room_id: expected 'basement_corridor', got '%s'" % received_id
		)

	pc.free()
	return failures


# ── T-0173 compatibility ───────────────────────────────────────────────────────

## AnimState enum must have exactly four distinct integer values:
## IDLE, MOVE, CROUCH_HIDE, DIE.  No JUMP or AIRBORNE value may exist.
func _test_t0173_anim_states_four_distinct_values() -> Array[String]:
	var failures: Array[String] = []

	var required: Dictionary = {
		"IDLE":        PlayerController.AnimState.IDLE,
		"MOVE":        PlayerController.AnimState.MOVE,
		"CROUCH_HIDE": PlayerController.AnimState.CROUCH_HIDE,
		"DIE":         PlayerController.AnimState.DIE,
	}

	var seen: Dictionary = {}
	for name: String in required:
		var v: int = required[name]
		if seen.has(v):
			failures.append(
				"t0173_anim_states: duplicate AnimState value %d for '%s'" % [v, name]
			)
		seen[v] = true

	if seen.size() != 4:
		failures.append(
			"t0173_anim_states: expected 4 distinct values, got %d" % seen.size()
		)

	return failures


## Walk / run noise flag semantics from T-0173 are preserved unchanged.
func _test_t0173_noise_flag_preserved() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc()

	# Walking → not loud.
	pc.apply_input(1.0, false)
	pc.update_state(0.016)
	if pc.is_loud:
		failures.append("t0173_noise: walking (run=false) must not set is_loud")

	# Running with direction → loud.
	pc.apply_input(1.0, true)
	pc.update_state(0.016)
	if not pc.is_loud:
		failures.append("t0173_noise: running with direction (run=true) must set is_loud")

	# Stationary with run held → not loud.
	pc.apply_input(0.0, true)
	pc.update_state(0.016)
	if pc.is_loud:
		failures.append("t0173_noise: stationary run (dir=0, run=true) must not set is_loud")

	pc.free()
	return failures


## DIE state priority over CROUCH_HIDE, from T-0173, is preserved.
func _test_t0173_die_overrides_crouch() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = _make_pc()
	pc.apply_crouch(true)
	pc.apply_die()
	pc.update_state(0.016)

	if pc.anim_state != PlayerController.AnimState.DIE:
		failures.append(
			"t0173_die_over_crouch: expected DIE (%d), got %d"
			% [PlayerController.AnimState.DIE, pc.anim_state]
		)

	pc.free()
	return failures
