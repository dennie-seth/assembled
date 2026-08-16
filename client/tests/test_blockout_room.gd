extends SceneTree
## T-0184: One-room blockout logic validation tests (§16-a).
##
## Tests the pure-logic RefCounted classes that drive the blockout room:
##   - PlayerState         — four animation states and binary walk/run noise flag
##   - WatcherSensor       — sight-cone detection geometry (cone + cover blocking)
##   - HidingSpotLogic     — entry safety with no invincibility frame
##   - ItemDoorLogic       — item-locked door rejects wrong/absent item
##   - ItemAnchorLogic     — pick-up and leave semantics
##
## All classes live in client/scripts/ and are loaded at runtime (not preloaded)
## so this script reports concrete failures when the impl files are absent
## rather than crashing at parse time. That is the red state in TDD.
##
## Run headless (from client/):
##   godot --headless --script tests/test_blockout_room.gd
## Exit 0 = PASS, exit 1 = FAIL.

func _init() -> void:
	var failures: Array[String] = []

	failures += _test_player_state()
	failures += _test_watcher_sensor_cone()
	failures += _test_watcher_sensor_cover()
	failures += _test_hiding_spot_logic()
	failures += _test_item_door_logic()
	failures += _test_item_anchor_logic()
	failures += _test_scene_exists()
	failures += _test_controller_scripts_exist()

	if failures.is_empty():
		print("T-0184 PASS: blockout room logic verified (8 groups)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0184 FAIL: " + f)
		quit(1)


## Load a script by res:// path. Returns null and appends a failure entry if absent.
func _load_or_fail(path: String, failures: Array[String]) -> GDScript:
	var s: GDScript = load(path) as GDScript
	if s == null:
		failures.append("could not load %s — implementation not yet present (expected in red phase)" % path)
	return s


# ── PlayerState ───────────────────────────────────────────────────────────────
## §11 §4 — walk/run noise is a binary flag off movement state, not a meter.
## Requires AnimState enum {IDLE, WALK, RUN, HIDE} and is_running bool property.

func _test_player_state() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = _load_or_fail("res://scripts/player_state.gd", failures)
	if script == null:
		return failures

	var ps: RefCounted = script.new()

	# Initial state is IDLE, not running.
	if ps.state != ps.AnimState.IDLE:
		failures.append("player_state: initial state should be IDLE")
	if ps.is_running:
		failures.append("player_state: is_running should be false at start")

	# Not moving, not running -> IDLE, noise off.
	ps.set_movement(false, false)
	if ps.state != ps.AnimState.IDLE:
		failures.append("player_state: not moving should produce IDLE")
	if ps.is_running:
		failures.append("player_state: IDLE should have noise flag false")

	# Moving, not running -> WALK, noise off.
	ps.set_movement(true, false)
	if ps.state != ps.AnimState.WALK:
		failures.append("player_state: moving without run key should produce WALK")
	if ps.is_running:
		failures.append("player_state: WALK should have noise flag false")
	if ps.get_noise_flag():
		failures.append("player_state: get_noise_flag() should be false while walking")

	# Moving + running -> RUN, noise ON.
	ps.set_movement(true, true)
	if ps.state != ps.AnimState.RUN:
		failures.append("player_state: moving with run key should produce RUN")
	if not ps.is_running:
		failures.append("player_state: RUN should have noise flag true")
	if not ps.get_noise_flag():
		failures.append("player_state: get_noise_flag() should be true while running")

	# enter_hiding() -> HIDE, noise off, movement calls ignored while hidden.
	ps.enter_hiding()
	if ps.state != ps.AnimState.HIDE:
		failures.append("player_state: enter_hiding() should produce HIDE")
	if ps.is_running:
		failures.append("player_state: HIDE should have noise flag false")
	ps.set_movement(true, true)  # movement call while hidden — must be ignored
	if ps.state != ps.AnimState.HIDE:
		failures.append("player_state: set_movement while hiding must not change state")

	# exit_hiding() -> IDLE, noise off.
	ps.exit_hiding()
	if ps.state != ps.AnimState.IDLE:
		failures.append("player_state: exit_hiding() should produce IDLE")
	if ps.is_running:
		failures.append("player_state: is_running must be false after exit_hiding")

	return failures


# ── WatcherSensor — cone geometry ─────────────────────────────────────────────
## §11 §1 — Watcher uses sight-cone only; detection requires angle + range.

func _test_watcher_sensor_cone() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = _load_or_fail("res://scripts/watcher_sensor.gd", failures)
	if script == null:
		return failures

	var ws: RefCounted = script.new()
	# Default: 45° half-angle (90° total), 80px range.
	ws.cone_half_angle = 45.0
	ws.cone_range = 80.0

	var watcher_pos := Vector2(200.0, 100.0)
	var facing_right := Vector2(1.0, 0.0)

	# Player directly in front, within range -> detected.
	var player_in_front_near := Vector2(260.0, 100.0)  # 60px ahead
	if not ws.is_player_in_cone(watcher_pos, facing_right, player_in_front_near):
		failures.append("watcher_cone: player 60px ahead (in 80px range) should be in cone")

	# Player directly in front, at exactly the range limit -> detected.
	var player_at_limit := Vector2(280.0, 100.0)  # exactly 80px
	if not ws.is_player_in_cone(watcher_pos, facing_right, player_at_limit):
		failures.append("watcher_cone: player at exactly 80px range should be detected")

	# Player directly in front, beyond range -> not detected.
	var player_out_of_range := Vector2(290.0, 100.0)  # 90px ahead
	if ws.is_player_in_cone(watcher_pos, facing_right, player_out_of_range):
		failures.append("watcher_cone: player 90px ahead (past 80px range) should not be detected")

	# Player at 90° to facing direction (to the side) -> not detected.
	var player_to_side := Vector2(200.0, 160.0)  # directly below, 60px
	if ws.is_player_in_cone(watcher_pos, facing_right, player_to_side):
		failures.append("watcher_cone: player directly to side (90°) should not be in cone")

	# Player directly behind -> not detected.
	var player_behind := Vector2(140.0, 100.0)  # 60px behind
	if ws.is_player_in_cone(watcher_pos, facing_right, player_behind):
		failures.append("watcher_cone: player directly behind should not be in cone")

	# Player within range but at exactly the cone boundary angle.
	# At 45° half-angle, diagonal forward: (cos45, sin45) * 60 = (42.4, 42.4)
	# The player is AT the boundary so cos(angle) == cos(half_angle) -> should be detected.
	var diag_dist := 60.0
	var player_at_boundary := watcher_pos + Vector2(
		diag_dist * cos(deg_to_rad(45.0)),
		diag_dist * sin(deg_to_rad(45.0))
	)
	if not ws.is_player_in_cone(watcher_pos, facing_right, player_at_boundary):
		failures.append("watcher_cone: player at exact boundary angle (45°) should be detected (inclusive)")

	# Player just outside cone at 46°.
	var player_outside_cone := watcher_pos + Vector2(
		diag_dist * cos(deg_to_rad(46.0)),
		diag_dist * sin(deg_to_rad(46.0))
	)
	if ws.is_player_in_cone(watcher_pos, facing_right, player_outside_cone):
		failures.append("watcher_cone: player at 46° (1° past half-angle) should not be in cone")

	# Watcher facing left — player must be behind (relative to facing) to escape.
	var facing_left := Vector2(-1.0, 0.0)
	var player_left_of_watcher := Vector2(140.0, 100.0)  # 60px to the left
	if not ws.is_player_in_cone(watcher_pos, facing_left, player_left_of_watcher):
		failures.append("watcher_cone: player 60px ahead of left-facing watcher should be in cone")

	return failures


# ── WatcherSensor — cover blocking ────────────────────────────────────────────
## §11 §2 — Cover blocks sight; hiding spot blocks everything.
## Cover-break blocks the SIGHT CONE only; sound and proximity still work
## (this test validates only the LOS clear/blocked split).

func _test_watcher_sensor_cover() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = _load_or_fail("res://scripts/watcher_sensor.gd", failures)
	if script == null:
		return failures

	var ws: RefCounted = script.new()
	ws.cone_half_angle = 45.0
	ws.cone_range = 160.0  # wide range so geometry is the only variable

	var watcher_pos := Vector2(200.0, 100.0)
	var facing_right := Vector2(1.0, 0.0)
	var player_pos := Vector2(320.0, 100.0)  # 120px ahead, in cone

	# No cover -> LOS clear -> detected.
	var no_cover: Array = []
	if not ws.can_detect(watcher_pos, facing_right, player_pos, no_cover):
		failures.append("watcher_cover: no cover should allow detection")

	# Cover rect between watcher and player blocks LOS.
	# Cover column from x=250 to x=270, y=50 to y=150.
	var blocking_cover: Array = [Rect2(Vector2(250.0, 50.0), Vector2(20.0, 100.0))]
	if ws.can_detect(watcher_pos, facing_right, player_pos, blocking_cover):
		failures.append("watcher_cover: cover column between watcher and player should block detection")

	# Cover rect NOT between watcher and player (off to the side) -> LOS still clear.
	var side_cover: Array = [Rect2(Vector2(250.0, 200.0), Vector2(20.0, 50.0))]
	if not ws.can_detect(watcher_pos, facing_right, player_pos, side_cover):
		failures.append("watcher_cover: cover off to the side should not block LOS")

	# Edge case: detection instant before hiding spot entry — no i-frame.
	# If player is still in the watcher's cone at the moment of entry, they are caught.
	# This is modelled at the HidingSpotLogic level: try_enter(detected=true) -> CAUGHT.
	# Here we confirm WatcherSensor.can_detect remains true for a player-position that
	# would be in the cone, even if that position is the hiding spot's entrance.
	var hiding_spot_entrance := Vector2(340.0, 100.0)  # still in cone, past the cover gap
	if not ws.can_detect(watcher_pos, facing_right, hiding_spot_entrance, no_cover):
		failures.append("watcher_cover: watcher should detect player at hiding spot entrance (no i-frame)")

	return failures


# ── HidingSpotLogic ───────────────────────────────────────────────────────────
## §11 §2 — Full guarantee once inside cleanly; no i-frame on entry.

func _test_hiding_spot_logic() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = _load_or_fail("res://scripts/hiding_spot_logic.gd", failures)
	if script == null:
		return failures

	var hs: RefCounted = script.new()

	# Hiding spot always blocks all sensors.
	if not hs.blocks_all_sensors():
		failures.append("hiding_spot: blocks_all_sensors() must always return true")

	# Not occupied initially.
	if hs.is_occupied:
		failures.append("hiding_spot: is_occupied must be false before any entry")

	# Clean entry (no sensor had player) -> SAFE, now occupied.
	var result_clean: int = hs.try_enter(false)
	if result_clean != hs.EntryResult.SAFE:
		failures.append("hiding_spot: try_enter(false) should return SAFE")
	if not hs.is_occupied:
		failures.append("hiding_spot: is_occupied must be true after clean entry")

	# Exit clears occupancy.
	hs.exit()
	if hs.is_occupied:
		failures.append("hiding_spot: is_occupied must be false after exit()")

	# Entry while sensor has player -> CAUGHT, NOT occupied (catch happens outside).
	var result_caught: int = hs.try_enter(true)
	if result_caught != hs.EntryResult.CAUGHT:
		failures.append("hiding_spot: try_enter(true) should return CAUGHT (no i-frame on entry)")
	if hs.is_occupied:
		failures.append("hiding_spot: is_occupied must NOT become true when entry is caught")

	return failures


# ── ItemDoorLogic ─────────────────────────────────────────────────────────────
## §11 §5 — Item-locked door opened by the debug-granted item from T-0171 only.

func _test_item_door_logic() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = _load_or_fail("res://scripts/item_door_logic.gd", failures)
	if script == null:
		return failures

	var door: RefCounted = script.new()
	door.required_item_id = 42

	# Door starts closed.
	if door.is_open:
		failures.append("item_door: door must start closed")

	# Wrong item -> rejected.
	if door.try_open(99):
		failures.append("item_door: try_open with wrong item must return false")
	if door.is_open:
		failures.append("item_door: door must stay closed after wrong item")

	# No item held (ITEM_NONE = -1) -> rejected.
	if door.try_open(door.ITEM_NONE):
		failures.append("item_door: try_open with no item (ITEM_NONE) must return false")
	if door.is_open:
		failures.append("item_door: door must stay closed when no item held")

	# Correct item -> opens.
	if not door.try_open(42):
		failures.append("item_door: try_open with correct item must return true")
	if not door.is_open:
		failures.append("item_door: door must be open after correct item used")

	# Already open -> returns true (idempotent).
	if not door.try_open(door.ITEM_NONE):
		failures.append("item_door: try_open on already-open door must return true (idempotent)")

	return failures


# ── ItemAnchorLogic ───────────────────────────────────────────────────────────
## T-0176/T-0177 — one anchor, pick-up and leave, same mechanism as any anchor.

func _test_item_anchor_logic() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = _load_or_fail("res://scripts/item_anchor_logic.gd", failures)
	if script == null:
		return failures

	var anchor: RefCounted = script.new()
	anchor.anchored_item_id = 42  # seeded with debug item

	# Anchor reports item available.
	if not anchor.has_item():
		failures.append("item_anchor: has_item() must be true when seeded")

	# Pick up returns the item ID and clears anchor.
	var picked: int = anchor.pick_up()
	if picked != 42:
		failures.append("item_anchor: pick_up() must return the seeded item id (42)")
	if anchor.has_item():
		failures.append("item_anchor: has_item() must be false after pick_up()")

	# Pick up from empty anchor returns ITEM_NONE.
	var empty_pick: int = anchor.pick_up()
	if empty_pick != anchor.ITEM_NONE:
		failures.append("item_anchor: pick_up() on empty anchor must return ITEM_NONE (-1)")

	# Place item restores availability.
	anchor.place_item(42)
	if not anchor.has_item():
		failures.append("item_anchor: has_item() must be true after place_item()")
	if anchor.anchored_item_id != 42:
		failures.append("item_anchor: anchored_item_id must match placed item id")

	# Pick up again confirms round-trip.
	var repick: int = anchor.pick_up()
	if repick != 42:
		failures.append("item_anchor: second pick_up() after place_item() must return 42")

	return failures


# ── Scene existence ────────────────────────────────────────────────────────────
## Verifies that the authored blockout room scene file exists and loads as a
## PackedScene — the core deliverable the VALIDATION pass checks for.

func _test_scene_exists() -> Array[String]:
	var failures: Array[String] = []
	if not FileAccess.file_exists("res://scenes/blockout_room.tscn"):
		failures.append("blockout_room.tscn: scene file must exist at res://scenes/blockout_room.tscn")
		return failures
	var packed: PackedScene = load("res://scenes/blockout_room.tscn") as PackedScene
	if packed == null:
		failures.append("blockout_room.tscn: must load as a valid PackedScene")
		return failures
	var room: Node = packed.instantiate()
	if room == null:
		failures.append("blockout_room.tscn: instantiate() must return a non-null Node")
		return failures
	room.free()
	return failures


# ── Controller scripts exist ───────────────────────────────────────────────────
## Verifies that PlayerController and WatcherController scripts exist —
## these drive the scene's player and watcher entities.

func _test_controller_scripts_exist() -> Array[String]:
	var failures: Array[String] = []
	var player_script: GDScript = _load_or_fail("res://scripts/player_controller.gd", failures)
	var watcher_script: GDScript = _load_or_fail("res://scripts/watcher_controller.gd", failures)
	var room_script: GDScript = _load_or_fail("res://scripts/blockout_room.gd", failures)
	# Verify player_controller instantiates (extends CharacterBody2D).
	if player_script != null:
		var pc: Node = player_script.new()
		if not pc is CharacterBody2D:
			failures.append("player_controller: must extend CharacterBody2D")
		pc.free()
	# Verify watcher_controller instantiates (extends CharacterBody2D).
	if watcher_script != null:
		var wc: Node = watcher_script.new()
		if not wc is CharacterBody2D:
			failures.append("watcher_controller: must extend CharacterBody2D")
		wc.free()
	# Room script existence is already checked by _load_or_fail.
	if room_script != null:
		pass
	return failures
