extends SceneTree
## T-0189: Sensor kit rebuild — side-on floor plane geometry + horizontal-occlusion cover.
##
## Three composable V2 sensor nodes tested in isolation against the §11 §4 v5
## side-on model.  Positions are expressed as floor-plane X coordinates (floats),
## not 2D Vectors.  Cover is horizontal occlusion by foreground props on the
## shared plane — it blocks sight only, never sound or proximity.
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless --script tests/test_T0189_sensors.gd
## Exit 0 on PASS, 1 on any failure.

const SightConeSensorV2 := preload("res://sensors/sight_cone_sensor_v2.gd")
const SoundRadiusSensorV2 := preload("res://sensors/sound_radius_sensor_v2.gd")
const ProximityPatrolSensorV2 := preload("res://sensors/proximity_patrol_sensor_v2.gd")


func _init() -> void:
	var failures: Array[String] = []
	failures += _test_sight_cone_basics()
	failures += _test_cover_blocks_sight_only()
	failures += _test_cover_removal_restores_sight()
	failures += _test_drop_gap_not_an_occluder()
	failures += _test_cover_prop_at_zero_offset()
	failures += _test_two_overlapping_props_block_once()
	failures += _test_sound_radius_v2()
	failures += _test_proximity_patrol_v2()
	failures += _test_sight_cone_signals()

	if failures.is_empty():
		print("T-0189 PASS: side-on sensor kit (sight cone, sound radius, proximity/patrol) verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0189 FAIL: " + f)
		quit(1)


## ── Sight Cone V2 Basics ─────────────────────────────────────────────────────
## Entity at plane_x=0, facing right (+1).  Range 6 tiles × 16 px/tile = 96 px.

func _test_sight_cone_basics() -> Array[String]:
	var failures: Array[String] = []
	var sensor := SightConeSensorV2.new()
	sensor.range_tiles = 6.0
	sensor.tile_size = 16.0
	sensor.entity_plane_x = 0.0
	sensor.entity_facing_dir = 1.0  # facing right (+X)

	# Player 3 tiles ahead — should detect.
	if not sensor.check(3.0 * 16.0):
		failures.append("sight_v2: player 3 tiles ahead should be detected")

	# Player behind entity (left) — should NOT detect.
	if sensor.check(-3.0 * 16.0):
		failures.append("sight_v2: player behind entity should NOT be detected")

	# Player beyond range (7 tiles) — should NOT detect.
	if sensor.check(7.0 * 16.0):
		failures.append("sight_v2: player beyond range (7 tiles) should NOT be detected")

	# Player at exact range boundary (6 tiles) — should detect.
	if not sensor.check(6.0 * 16.0):
		failures.append("sight_v2: player at exact range boundary (6 tiles) should be detected")

	# Facing left: player to the left should detect.
	sensor.entity_facing_dir = -1.0
	if not sensor.check(-3.0 * 16.0):
		failures.append("sight_v2: facing left, player to the left should be detected")

	# Facing left: player to the right should NOT detect.
	if sensor.check(3.0 * 16.0):
		failures.append("sight_v2: facing left, player to the right should NOT be detected")

	# Room geometry occluder blocks sight (preserved from T-0174).
	sensor.entity_facing_dir = 1.0
	sensor.occluder_fn = func(_f: float, _t: float) -> bool: return true
	if sensor.check(3.0 * 16.0):
		failures.append("sight_v2: geometry occluder should prevent detection")
	if not sensor.last_check_was_occluded:
		failures.append("sight_v2: last_check_was_occluded must be true when geometry blocks")

	# Clear occluder — target visible again.
	sensor.occluder_fn = func(_f: float, _t: float) -> bool: return false
	if not sensor.check(3.0 * 16.0):
		failures.append("sight_v2: target should be detected again with clear occluder")
	if sensor.last_check_was_occluded:
		failures.append("sight_v2: last_check_was_occluded must be false when unoccluded")

	# Range miss: last_check_was_occluded must stay false (not a geometry/cover block).
	sensor.occluder_fn = Callable()
	var _ignored := sensor.check(7.0 * 16.0)
	if sensor.last_check_was_occluded:
		failures.append("sight_v2: last_check_was_occluded must be false on range miss")

	sensor.free()
	return failures


## ── Cover blocks sight only ──────────────────────────────────────────────────
## Entity at x=0, player at x=5 tiles (80 px).
## Cover prop occupies x=[32, 48] px (tiles 2-3), between entity and player.
## Expected: sight blocked, sound and proximity NOT blocked.

func _test_cover_blocks_sight_only() -> Array[String]:
	var failures: Array[String] = []

	var sight := SightConeSensorV2.new()
	sight.range_tiles = 6.0
	sight.tile_size = 16.0
	sight.entity_plane_x = 0.0
	sight.entity_facing_dir = 1.0

	var sound := SoundRadiusSensorV2.new()
	sound.walk_radius_tiles = 6.0  # wide — player at 5 tiles is in range
	sound.run_radius_tiles = 6.0
	sound.tile_size = 16.0
	sound.entity_plane_x = 0.0

	var patrol := ProximityPatrolSensorV2.new()
	patrol.catch_radius_tiles = 6.0  # wide — player at 5 tiles is in range
	patrol.tile_size = 16.0
	patrol.entity_plane_x = 0.0

	var player_x: float = 5.0 * 16.0  # 80 px
	var prop := Vector2(32.0, 48.0)  # cover prop: x=[32,48] px

	# Without cover: sight detects.
	if not sight.check(player_x):
		failures.append("cover: sight must detect player before any cover prop is added")

	# Add cover prop to sight sensor only.
	sight.cover_props.append(prop)

	# Sight is blocked by the foreground prop.
	if sight.check(player_x):
		failures.append("cover: sight must be blocked by a foreground prop between entity and player")
	if not sight.last_check_was_occluded:
		failures.append("cover: last_check_was_occluded must be true when cover prop blocks")

	# Sound radius is not blocked by foreground props — omnidirectional.
	sound.update_movement_state(false)
	if not sound.check(player_x):
		failures.append("cover: sound radius must NOT be blocked by foreground props (omnidirectional)")

	# Proximity/patrol is not blocked by foreground props — no LOS.
	if not patrol.check(player_x):
		failures.append("cover: proximity/patrol must NOT be blocked by foreground props (no LOS)")

	sight.free()
	sound.free()
	patrol.free()
	return failures


## ── Cover removal restores sight ─────────────────────────────────────────────
## Removing a cover prop (or player stepping in front of it) restores detection
## with no stale blocked-state carryover.

func _test_cover_removal_restores_sight() -> Array[String]:
	var failures: Array[String] = []
	var sensor := SightConeSensorV2.new()
	sensor.range_tiles = 6.0
	sensor.tile_size = 16.0
	sensor.entity_plane_x = 0.0
	sensor.entity_facing_dir = 1.0

	var player_x: float = 5.0 * 16.0  # 80 px
	var prop := Vector2(32.0, 48.0)   # cover prop at tiles 2-3

	# Add prop — sight blocked.
	sensor.cover_props.append(prop)
	if sensor.check(player_x):
		failures.append("cover_removal: sight must be blocked with cover prop present")

	# Remove prop — sight restores with no stale state.
	sensor.cover_props.clear()
	if not sensor.check(player_x):
		failures.append("cover_removal: sight must restore immediately when cover prop is removed")
	if sensor.last_check_was_occluded:
		failures.append("cover_removal: last_check_was_occluded must be false after cover prop removed")

	# Player stepping in front of the prop (entity=0, prop=[32,48], player now at 1 tile=16 px).
	# Segment is [0, 16]; prop [32, 48] does not overlap — sight must detect.
	sensor.cover_props.append(prop)  # re-add prop
	var player_before_prop: float = 1.0 * 16.0  # 16 px — between entity and prop
	if not sensor.check(player_before_prop):
		failures.append("cover_removal: sight must detect player that is in front of (before) the cover prop")

	sensor.free()
	return failures


## ── Drop gap is NOT an occluder ──────────────────────────────────────────────
## Drop gaps are authored floor-tile absences (T-0187).  They are movement
## hazards only.  Unless a cover prop is separately placed at that column, sensors
## see straight through a Drop gap — it is not registered in cover_props.

func _test_drop_gap_not_an_occluder() -> Array[String]:
	var failures: Array[String] = []

	var sight := SightConeSensorV2.new()
	sight.range_tiles = 6.0
	sight.tile_size = 16.0
	sight.entity_plane_x = 0.0
	sight.entity_facing_dir = 1.0
	# Drop gap at tile 2 (x=[32,48]) is deliberately NOT added to cover_props.

	var sound := SoundRadiusSensorV2.new()
	sound.walk_radius_tiles = 6.0
	sound.run_radius_tiles = 6.0
	sound.tile_size = 16.0
	sound.entity_plane_x = 0.0

	var patrol := ProximityPatrolSensorV2.new()
	patrol.catch_radius_tiles = 6.0
	patrol.tile_size = 16.0
	patrol.entity_plane_x = 0.0

	var player_x: float = 5.0 * 16.0  # 80 px — on the far side of the gap

	# Sight sees through the gap.
	if not sight.check(player_x):
		failures.append("drop_gap: sight must detect through a Drop gap (gap is not an occluder)")
	if sight.last_check_was_occluded:
		failures.append("drop_gap: last_check_was_occluded must be false — Drop gap is not geometry")

	# Sound sees through the gap.
	sound.update_movement_state(false)
	if not sound.check(player_x):
		failures.append("drop_gap: sound must detect through a Drop gap")

	# Patrol sees through the gap.
	if not patrol.check(player_x):
		failures.append("drop_gap: proximity/patrol must detect through a Drop gap")

	sight.free()
	sound.free()
	patrol.free()
	return failures


## ── Cover prop at zero horizontal offset ─────────────────────────────────────
## A prop whose X range collapses to exactly the entity's position, or exactly
## the player's position, must not crash and must not produce a false-negative
## in the occlusion check.

func _test_cover_prop_at_zero_offset() -> Array[String]:
	var failures: Array[String] = []
	var sensor := SightConeSensorV2.new()
	sensor.range_tiles = 6.0
	sensor.tile_size = 16.0
	sensor.entity_plane_x = 0.0
	sensor.entity_facing_dir = 1.0

	var player_x: float = 3.0 * 16.0  # 48 px

	# Prop at entity's exact X position (zero-width interval at x=0).
	sensor.cover_props.append(Vector2(0.0, 0.0))
	if not sensor.check(player_x):
		failures.append("zero_offset: prop at entity's own X must not cause a false-negative")

	# Prop at player's exact X position (zero-width interval at x=48).
	sensor.cover_props.clear()
	sensor.cover_props.append(Vector2(player_x, player_x))
	if not sensor.check(player_x):
		failures.append("zero_offset: prop at player's own X must not cause a false-negative")

	# No division is performed in the cover check, so reaching this point confirms
	# no divide-by-zero crash for either endpoint case.
	sensor.free()
	return failures


## ── Two overlapping props block sight exactly once ───────────────────────────
## Two foreground props whose X intervals overlap must block the sight cone
## as a single obstruction — no double-blocking side effect or gap.

func _test_two_overlapping_props_block_once() -> Array[String]:
	var failures: Array[String] = []
	var sensor := SightConeSensorV2.new()
	sensor.range_tiles = 6.0
	sensor.tile_size = 16.0
	sensor.entity_plane_x = 0.0
	sensor.entity_facing_dir = 1.0

	var player_x: float = 5.0 * 16.0  # 80 px

	# Two overlapping props between entity (0) and player (80).
	sensor.cover_props.append(Vector2(32.0, 48.0))  # tiles 2-3
	sensor.cover_props.append(Vector2(40.0, 56.0))  # overlapping interval

	# Sight must be blocked (not detected) — exactly once (bool result).
	if sensor.check(player_x):
		failures.append("two_props: overlapping cover props must block sight (detection must be false)")
	if not sensor.last_check_was_occluded:
		failures.append("two_props: last_check_was_occluded must be true with overlapping cover props")

	# A second check with same state must give the same result — no double-toggle.
	if sensor.check(player_x):
		failures.append("two_props: second consecutive check with overlapping props must still block")

	sensor.free()
	return failures


## ── Sound Radius V2 — side-on floor plane ────────────────────────────────────
## Omnidirectional.  Distance is horizontal (|Δx| on the floor plane).
## Walk/run radii and single-frame run→stop guarantee preserved from T-0174.

func _test_sound_radius_v2() -> Array[String]:
	var failures: Array[String] = []
	var sensor := SoundRadiusSensorV2.new()
	sensor.walk_radius_tiles = 1.5
	sensor.run_radius_tiles = 5.0
	sensor.tile_size = 16.0
	sensor.entity_plane_x = 0.0

	# Walking player 1 tile away — inside walk radius (1.5 tiles).
	sensor.update_movement_state(false)
	if not sensor.check(1.0 * 16.0):
		failures.append("sound_v2: walking player within walk_radius should be detected")

	# Walking player 3 tiles away — outside walk radius, inside run radius.
	if sensor.check(3.0 * 16.0):
		failures.append("sound_v2: walking player outside walk_radius should NOT be detected")

	# Running player 3 tiles away — inside run radius (5 tiles).
	sensor.update_movement_state(true)
	if not sensor.check(3.0 * 16.0):
		failures.append("sound_v2: running player within run_radius should be detected")

	# Running player 6 tiles away — outside run radius.
	if sensor.check(6.0 * 16.0):
		failures.append("sound_v2: running player beyond run_radius should NOT be detected")

	# Omnidirectional: player to the LEFT also detected while running.
	sensor.update_movement_state(true)
	if not sensor.check(-3.0 * 16.0):
		failures.append("sound_v2: sensor must detect in any direction (omnidirectional)")

	# Single-frame run→stop: run radius still applies on the transition frame.
	sensor.update_movement_state(true)   # frame N: running
	sensor.update_movement_state(false)  # frame N+1: stopped
	if not sensor.check(3.0 * 16.0):
		failures.append("sound_v2: sensor must still trigger on the frame after player stops running")

	# Sound sensor must NOT expose occluder_fn or cover_props.
	if sensor.get("occluder_fn") != null:
		failures.append("sound_v2: SoundRadiusSensorV2 must NOT expose occluder_fn")
	if sensor.get("cover_props") != null:
		failures.append("sound_v2: SoundRadiusSensorV2 must NOT expose cover_props")

	sensor.free()
	return failures


## ── Proximity / Patrol V2 — side-on floor plane ──────────────────────────────
## Patrol route is a list of X positions.  No LOS, no cover, no geometry blocking.

func _test_proximity_patrol_v2() -> Array[String]:
	var failures: Array[String] = []
	var sensor := ProximityPatrolSensorV2.new()
	sensor.catch_radius_tiles = 1.5
	sensor.tile_size = 16.0
	sensor.waypoints = [0.0, 10.0 * 16.0]  # X positions: 0 px and 160 px
	sensor.patrol_speed_tiles_per_sec = 4.0
	sensor.entity_plane_x = 0.0

	# Player 1 tile away — within catch radius (1.5 tiles).
	if not sensor.check(1.0 * 16.0):
		failures.append("patrol_v2: player within catch_radius should be detected")

	# Player 3 tiles away — outside catch radius.
	if sensor.check(3.0 * 16.0):
		failures.append("patrol_v2: player outside catch_radius should NOT be detected")

	# No LOS: sensor must NOT expose occluder_fn.
	if sensor.get("occluder_fn") != null:
		failures.append("patrol_v2: ProximityPatrolSensorV2 must NOT expose occluder_fn")

	# No cover: sensor must NOT expose cover_props.
	if sensor.get("cover_props") != null:
		failures.append("patrol_v2: ProximityPatrolSensorV2 must NOT expose cover_props")

	# Advance 1 second at 4 tiles/s — entity moves 4 tiles (64 px) rightward.
	sensor.advance(1.0)
	if not (sensor.entity_plane_x > 0.0):
		failures.append("patrol_v2: entity must advance along patrol route after advance()")

	# Player 1 tile ahead of entity's new position must be detected.
	var target_near: float = sensor.entity_plane_x + 16.0
	if not sensor.check(target_near):
		failures.append("patrol_v2: player near entity's new patrol position should be detected")

	# Patrol loop: advance 10 more seconds — entity stays within the route bounds.
	sensor.advance(10.0)
	var looped_x: float = sensor.entity_plane_x
	if looped_x < -1.0 or looped_x > 10.0 * 16.0 + 1.0:
		failures.append(
			"patrol_v2: entity must stay on patrol route after looping (got x=%.1f)" % looped_x
		)

	sensor.free()
	return failures


## ── Sight cone signals ───────────────────────────────────────────────────────
## target_detected emitted on not-detected → detected transition (once).
## target_cleared emitted on detected → not-detected transition.

func _test_sight_cone_signals() -> Array[String]:
	var failures: Array[String] = []
	var sensor := SightConeSensorV2.new()
	sensor.range_tiles = 6.0
	sensor.tile_size = 16.0
	sensor.entity_plane_x = 0.0
	sensor.entity_facing_dir = 1.0

	# Arrays are reference types — safe to mutate from inside lambdas (value types like
	# int are captured by value in GDScript closures and would give a stale copy).
	var detected_vals: Array[float] = []
	var cleared_events: Array[bool] = []
	sensor.target_detected.connect(func(x: float) -> void: detected_vals.append(x))
	sensor.target_cleared.connect(func() -> void: cleared_events.append(true))

	var player_x: float = 3.0 * 16.0  # 48 px, in range

	# First check: not-detected → detected — signal must fire.
	sensor.check(player_x)
	if detected_vals.is_empty():
		failures.append("signals: target_detected must be emitted on first detection")

	# Second consecutive detection: no duplicate signal.
	var count_before: int = detected_vals.size()
	sensor.check(player_x)
	if detected_vals.size() != count_before:
		failures.append("signals: target_detected must NOT re-fire while already detected")

	# Player moves out of range — target_cleared must fire.
	sensor.check(7.0 * 16.0)  # beyond 6-tile range
	if cleared_events.is_empty():
		failures.append("signals: target_cleared must be emitted when player leaves detection range")

	sensor.free()
	return failures
