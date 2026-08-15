extends SceneTree
## T-0173: PlayerController unit tests — anim states, noise flag, walk/run speeds.
##
## Verifies:
##   - Four animation states are distinct enum values (IDLE, MOVE, CROUCH_HIDE, DIE)
##   - Switching walk -> run changes is_loud synchronously with the input change
##   - Crouch-hide anim state is distinct from IDLE and MOVE
##   - Player velocity of exactly zero while run is held does NOT set is_loud
##   - Die state takes priority over all other states
##   - Walk and run use different speed constants
##
## Run headless:
##   godot --headless --script tests/test_player_controller.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const PlayerController := preload("res://player_controller.gd")

## Tolerance for float comparisons.
const EPSILON: float = 0.001


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_anim_state_enum_values_distinct()
	failures += _test_idle_when_no_input()
	failures += _test_move_when_walking()
	failures += _test_walk_not_loud()
	failures += _test_run_loud_when_moving()
	failures += _test_walk_to_run_noise_flag_synchronous()
	failures += _test_no_noise_when_stationary_while_running()
	failures += _test_crouch_hide_distinct_from_idle()
	failures += _test_crouch_hide_distinct_from_move()
	failures += _test_die_priority_over_crouch()
	failures += _test_die_priority_over_move()
	failures += _test_walk_and_run_speeds_differ()

	if failures.is_empty():
		print("T-0173 PASS: PlayerController anim states and noise flag verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0173 FAIL: " + f)
		quit(1)


## ── Test: enum values are all distinct ───────────────────────────────────────
## Ensures the four AnimState constants are separate integers.

func _test_anim_state_enum_values_distinct() -> Array[String]:
	var failures: Array[String] = []
	var values: Array[int] = [
		PlayerController.AnimState.IDLE,
		PlayerController.AnimState.MOVE,
		PlayerController.AnimState.CROUCH_HIDE,
		PlayerController.AnimState.DIE,
	]
	var seen: Dictionary = {}
	for v: int in values:
		if seen.has(v):
			failures.append(
				"enum_distinct: duplicate AnimState value %d" % v
			)
		seen[v] = true
	return failures


## ── Test: idle when no input ──────────────────────────────────────────────────
## Default state with no input applied must be IDLE and not loud.

func _test_idle_when_no_input() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.update_state(0.016)

	if pc.anim_state != PlayerController.AnimState.IDLE:
		failures.append(
			"idle_no_input: expected IDLE (%d), got %d"
			% [PlayerController.AnimState.IDLE, pc.anim_state]
		)
	if pc.is_loud:
		failures.append("idle_no_input: is_loud should be false with no input")

	pc.free()
	return failures


## ── Test: MOVE when walking in a direction ────────────────────────────────────
## apply_input with direction=1.0 and running=false → anim_state MOVE.

func _test_move_when_walking() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_input(1.0, false)
	pc.update_state(0.016)

	if pc.anim_state != PlayerController.AnimState.MOVE:
		failures.append(
			"move_walking: expected MOVE (%d), got %d"
			% [PlayerController.AnimState.MOVE, pc.anim_state]
		)

	pc.free()
	return failures


## ── Test: walk is not loud ────────────────────────────────────────────────────
## Walking (running=false) with non-zero direction must not set is_loud.

func _test_walk_not_loud() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_input(1.0, false)
	pc.update_state(0.016)

	if pc.is_loud:
		failures.append("walk_not_loud: walking must not set is_loud")

	pc.free()
	return failures


## ── Test: run is loud when actually moving ────────────────────────────────────
## apply_input with direction=1.0 and running=true → is_loud true.

func _test_run_loud_when_moving() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_input(1.0, true)
	pc.update_state(0.016)

	if not pc.is_loud:
		failures.append("run_loud_moving: running with direction must set is_loud")

	pc.free()
	return failures


## ── Test: walk → run changes noise flag synchronously ────────────────────────
## Switching from running=false to running=true must update is_loud on the very
## next update_state call — no lag, no buffer.

func _test_walk_to_run_noise_flag_synchronous() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()

	# Start walking — not loud.
	pc.apply_input(1.0, false)
	pc.update_state(0.016)
	if pc.is_loud:
		failures.append(
			"walk_to_run_sync: expected is_loud=false while walking, got true"
		)

	# Switch to run — must be loud immediately after the next update_state.
	pc.apply_input(1.0, true)
	pc.update_state(0.016)
	if not pc.is_loud:
		failures.append(
			"walk_to_run_sync: expected is_loud=true immediately after switching to run"
		)

	pc.free()
	return failures


## ── Test: no noise when stationary while holding run ─────────────────────────
## Running with direction=0 (player not pressing move) must NOT set is_loud.
## Covers the edge case: run button held, but zero velocity, no actual movement.

func _test_no_noise_when_stationary_while_running() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_input(0.0, true)  # run held, no directional input
	pc.update_state(0.016)

	if pc.is_loud:
		failures.append(
			"stationary_run: is_loud must be false when direction=0 even if run is held"
		)
	if pc.anim_state != PlayerController.AnimState.IDLE:
		failures.append(
			"stationary_run: expected IDLE when velocity=0, got %d" % pc.anim_state
		)

	pc.free()
	return failures


## ── Test: CROUCH_HIDE is distinct from IDLE ───────────────────────────────────
## Crouching with no movement input must give CROUCH_HIDE, not IDLE.

func _test_crouch_hide_distinct_from_idle() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_crouch(true)
	pc.update_state(0.016)

	if pc.anim_state == PlayerController.AnimState.IDLE:
		failures.append(
			"crouch_vs_idle: CROUCH_HIDE must not equal IDLE"
		)
	if pc.anim_state != PlayerController.AnimState.CROUCH_HIDE:
		failures.append(
			"crouch_vs_idle: expected CROUCH_HIDE (%d), got %d"
			% [PlayerController.AnimState.CROUCH_HIDE, pc.anim_state]
		)

	pc.free()
	return failures


## ── Test: CROUCH_HIDE is distinct from MOVE ───────────────────────────────────
## Crouching while a direction is held must still yield CROUCH_HIDE, not MOVE.
## The Hiding card grants any sensor-blocking guarantee; this card only owns
## the animation state.

func _test_crouch_hide_distinct_from_move() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_input(1.0, false)
	pc.apply_crouch(true)
	pc.update_state(0.016)

	if pc.anim_state == PlayerController.AnimState.MOVE:
		failures.append(
			"crouch_vs_move: CROUCH_HIDE must not equal MOVE (crouch takes priority)"
		)
	if pc.anim_state != PlayerController.AnimState.CROUCH_HIDE:
		failures.append(
			"crouch_vs_move: expected CROUCH_HIDE (%d), got %d"
			% [PlayerController.AnimState.CROUCH_HIDE, pc.anim_state]
		)

	pc.free()
	return failures


## ── Test: DIE overrides CROUCH_HIDE ──────────────────────────────────────────
## apply_die() must set anim_state to DIE regardless of crouch state.

func _test_die_priority_over_crouch() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_crouch(true)
	pc.apply_die()
	pc.update_state(0.016)

	if pc.anim_state != PlayerController.AnimState.DIE:
		failures.append(
			"die_over_crouch: expected DIE (%d), got %d"
			% [PlayerController.AnimState.DIE, pc.anim_state]
		)

	pc.free()
	return failures


## ── Test: DIE overrides MOVE ──────────────────────────────────────────────────
## apply_die() must set anim_state to DIE regardless of movement state.

func _test_die_priority_over_move() -> Array[String]:
	var failures: Array[String] = []
	var pc: CharacterBody2D = PlayerController.new()
	pc.apply_input(1.0, false)
	pc.apply_die()
	pc.update_state(0.016)

	if pc.anim_state != PlayerController.AnimState.DIE:
		failures.append(
			"die_over_move: expected DIE (%d), got %d"
			% [PlayerController.AnimState.DIE, pc.anim_state]
		)

	pc.free()
	return failures


## ── Test: walk and run use different speed constants ─────────────────────────
## The intended velocity magnitude when walking must be strictly less than when
## running, confirming two distinct speed tiers exist.

func _test_walk_and_run_speeds_differ() -> Array[String]:
	var failures: Array[String] = []

	var walk_pc: CharacterBody2D = PlayerController.new()
	walk_pc.apply_input(1.0, false)
	walk_pc.update_state(0.016)
	var walk_speed: float = walk_pc.velocity.length()
	walk_pc.free()

	var run_pc: CharacterBody2D = PlayerController.new()
	run_pc.apply_input(1.0, true)
	run_pc.update_state(0.016)
	var run_speed: float = run_pc.velocity.length()
	run_pc.free()

	if walk_speed <= EPSILON:
		failures.append(
			"speeds_differ: walk speed should be > 0, got %.3f" % walk_speed
		)
	if run_speed <= walk_speed + EPSILON:
		failures.append(
			"speeds_differ: run speed (%.3f) must be > walk speed (%.3f)"
			% [run_speed, walk_speed]
		)

	return failures
