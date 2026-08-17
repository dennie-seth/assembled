extends SceneTree
## T-0174: Sensor kit — sight cone, sound radius, proximity/patrol.
##
## Three composable sensor nodes tested in isolation with fixture positions.
## No real physics — occluders and movement state are injected via callables
## and setters so the suite runs fully headless.
##
## Run headless:
##   godot --headless --script tests/test_sensors.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const SightConeSensor := preload("res://sensors/sight_cone_sensor.gd")
const SoundRadiusSensor := preload("res://sensors/sound_radius_sensor.gd")
const ProximityPatrolSensor := preload("res://sensors/proximity_patrol_sensor.gd")

func _init() -> void:
	var failures: Array[String] = []
	failures += _test_sight_cone()
	failures += _test_sound_radius()
	failures += _test_proximity_patrol()

	if failures.is_empty():
		print("T-0174 PASS: sight cone, sound radius, and proximity/patrol sensors verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0174 FAIL: " + f)
		quit(1)


## ── Sight Cone ────────────────────────────────────────────────────────────────
## Entity at origin, facing +X (angle 0).  Cone half-angle 45° → total 90° FOV.
## Range 6 tiles.  Tile size 16 px.

func _test_sight_cone() -> Array[String]:
	var failures: Array[String] = []
	var sensor: SightConeSensor = SightConeSensor.new()
	sensor.cone_half_angle_deg = 45.0
	sensor.range_tiles = 6.0
	sensor.tile_size = 16.0
	sensor.entity_position = Vector2.ZERO
	sensor.entity_facing_angle = 0.0  # facing right (+X)

	# Target directly in front, within range (3 tiles).
	var target_front := Vector2(3.0 * 16.0, 0.0)
	if not sensor.check(target_front):
		failures.append("sight_cone: target 3 tiles in front should be detected")

	# Target beyond range (7 tiles).
	var target_far := Vector2(7.0 * 16.0, 0.0)
	if sensor.check(target_far):
		failures.append("sight_cone: target beyond range (7 tiles) should NOT be detected")

	# Target at exact range boundary (6 tiles) — must be detected.
	var target_at_range := Vector2(6.0 * 16.0, 0.0)
	if not sensor.check(target_at_range):
		failures.append("sight_cone: target at exact range boundary (6 tiles) should be detected")

	# Target 90° off-angle (directly to side) — outside cone.
	var target_side := Vector2(0.0, 3.0 * 16.0)
	if sensor.check(target_side):
		failures.append("sight_cone: target 90° off-axis should NOT be detected")

	# Target at 44° — just inside the 45° half-cone.
	var angle_44 := deg_to_rad(44.0)
	var target_44 := Vector2(cos(angle_44), sin(angle_44)) * (3.0 * 16.0)
	if not sensor.check(target_44):
		failures.append("sight_cone: target at 44° (inside half-cone) should be detected")

	# Target at 46° — just outside the 45° half-cone.
	var angle_46 := deg_to_rad(46.0)
	var target_46 := Vector2(cos(angle_46), sin(angle_46)) * (3.0 * 16.0)
	if sensor.check(target_46):
		failures.append("sight_cone: target at 46° (outside half-cone) should NOT be detected")

	# Occluder blocks everything: target in cone/range but geometry blocks it.
	sensor.occluder_fn = func(_f: Vector2, _t: Vector2) -> bool: return true
	if sensor.check(target_front):
		failures.append("sight_cone: fully-blocked occluder should prevent detection")
	if not sensor.last_check_was_occluded:
		failures.append("sight_cone: last_check_was_occluded must be true when geometry blocks")

	# Clear occluder: target visible again.
	sensor.occluder_fn = func(_f: Vector2, _t: Vector2) -> bool: return false
	if not sensor.check(target_front):
		failures.append("sight_cone: target should be detected again with clear occluder")
	if sensor.last_check_was_occluded:
		failures.append("sight_cone: last_check_was_occluded must be false when unoccluded")

	# Tilemap-style wall occlusion: wall at x = 2 tiles blocks sight beyond it.
	# Entity at (0,0), wall_x = 2 tiles × 16 px = 32 px.
	# Target at (4 tiles, 0) = behind wall → blocked.
	# Target at (1 tile, 0) = in front of wall → visible.
	var wall_px: float = 2.0 * 16.0
	sensor.occluder_fn = func(from: Vector2, to: Vector2) -> bool:
		return to.x > wall_px and from.x <= wall_px
	var target_behind_wall := Vector2(4.0 * 16.0, 0.0)
	if sensor.check(target_behind_wall):
		failures.append("sight_cone: target behind tilemap wall should NOT be detected")
	if not sensor.last_check_was_occluded:
		failures.append("sight_cone: last_check_was_occluded must be true for wall-blocked target")
	var target_before_wall := Vector2(1.0 * 16.0, 0.0)
	if not sensor.check(target_before_wall):
		failures.append("sight_cone: target in front of wall should still be detected")

	# last_check_was_occluded is only set by geometry, not by angle/range misses.
	sensor.occluder_fn = Callable()  # reset
	var _ignored := sensor.check(target_far)  # miss by range, not geometry
	if sensor.last_check_was_occluded:
		failures.append("sight_cone: last_check_was_occluded must be false on range miss (not a geometry block)")

	sensor.free()
	return failures


## ── Sound Radius ─────────────────────────────────────────────────────────────
## Walk radius 1.5 tiles, run radius 5 tiles.  Omnidirectional, no occluder.

func _test_sound_radius() -> Array[String]:
	var failures: Array[String] = []
	var sensor: SoundRadiusSensor = SoundRadiusSensor.new()
	sensor.walk_radius_tiles = 1.5
	sensor.run_radius_tiles = 5.0
	sensor.tile_size = 16.0
	sensor.entity_position = Vector2.ZERO

	# Walking player within walk radius (1 tile).
	sensor.update_movement_state(false)  # walk
	var target_near := Vector2(1.0 * 16.0, 0.0)  # 1 tile — inside walk_radius 1.5
	if not sensor.check(target_near):
		failures.append("sound_radius: walking player within walk_radius should be detected")

	# Walking player outside walk radius but inside run radius (3 tiles).
	var target_3t := Vector2(3.0 * 16.0, 0.0)  # 3 tiles — outside walk=1.5, inside run=5
	sensor.update_movement_state(false)
	if sensor.check(target_3t):
		failures.append("sound_radius: walking player outside walk_radius should NOT be detected")

	# Running player within run radius (3 tiles).
	sensor.update_movement_state(true)  # run
	if not sensor.check(target_3t):
		failures.append("sound_radius: running player within run_radius should be detected")

	# Running player beyond run radius (6 tiles).
	var target_6t := Vector2(6.0 * 16.0, 0.0)  # 6 tiles — beyond run_radius=5
	if sensor.check(target_6t):
		failures.append("sound_radius: running player beyond run_radius should NOT be detected")

	# Sound radius is omnidirectional — detects equally in any direction.
	sensor.update_movement_state(true)
	var target_behind := Vector2(-3.0 * 16.0, 0.0)  # 3 tiles behind
	if not sensor.check(target_behind):
		failures.append("sound_radius: sensor must be omnidirectional (target behind should be detected)")

	# Stationary player within walk radius — treated as walking (ambient noise).
	sensor.update_movement_state(false)  # stopped/walking
	if not sensor.check(target_near):
		failures.append("sound_radius: stationary player within walk_radius should be detected")

	# Edge case: single-frame run→stop transition must NOT drop the trigger.
	# Frame N: player running. Frame N+1: player stops. check() must still fire.
	sensor.update_movement_state(true)   # frame N: running
	sensor.update_movement_state(false)  # frame N+1: stops
	if not sensor.check(target_3t):
		failures.append("sound_radius: sensor must still trigger the frame after player stops running (no dropped trigger on single-frame state change)")

	# Sound radius has no occluder_fn — it must not expose geometry filtering.
	if sensor.get("occluder_fn") != null:
		failures.append("sound_radius: SoundRadiusSensor must NOT expose occluder_fn (sound is omnidirectional, never blocked)")

	sensor.free()
	return failures


## ── Proximity / Patrol ────────────────────────────────────────────────────────
## 2-waypoint route: (0,0) ↔ (10 tiles, 0).  Catch radius 1.5 tiles.
## No line-of-sight check — triggers regardless of geometry between entity and player.

func _test_proximity_patrol() -> Array[String]:
	var failures: Array[String] = []
	var sensor: ProximityPatrolSensor = ProximityPatrolSensor.new()
	sensor.catch_radius_tiles = 1.5
	sensor.tile_size = 16.0
	sensor.waypoints = [Vector2(0.0, 0.0), Vector2(10.0 * 16.0, 0.0)]
	sensor.patrol_speed_tiles_per_sec = 4.0
	sensor.entity_position = Vector2.ZERO

	# Player within catch radius at entity start position.
	var target_close := Vector2(1.0 * 16.0, 0.0)  # 1 tile — inside catch_radius=1.5
	if not sensor.check(target_close):
		failures.append("proximity_patrol: player within catch_radius should be detected")

	# Player outside catch radius.
	var target_outside := Vector2(3.0 * 16.0, 0.0)  # 3 tiles — beyond catch=1.5
	if sensor.check(target_outside):
		failures.append("proximity_patrol: player outside catch_radius should NOT be detected")

	# No LOS check: the sensor has no occluder_fn — geometry is irrelevant.
	if sensor.get("occluder_fn") != null:
		failures.append("proximity_patrol: ProximityPatrolSensor must NOT expose occluder_fn (no LOS)")

	# Advance along patrol route (1 second × 4 tiles/s = 4 tiles forward).
	sensor.advance(1.0)
	var pos_after: Vector2 = sensor.entity_position
	if not (pos_after.x > 0.0):
		failures.append("proximity_patrol: entity should have advanced along patrol route")

	# After advancing 4 tiles, player at entity's new position is detected.
	var target_at_entity := pos_after + Vector2(16.0, 0.0)  # 1 tile ahead of entity
	if not sensor.check(target_at_entity):
		failures.append("proximity_patrol: player near entity's patrol position should be detected after advance")

	# Patrol loop: advance far enough to complete multiple loops; entity stays on route.
	sensor.advance(10.0)  # advance 40 more tiles — crosses several waypoints
	var looped_pos: Vector2 = sensor.entity_position
	var min_x: float = -1.0  # small tolerance
	var max_x: float = 10.0 * 16.0 + 1.0
	if looped_pos.x < min_x or looped_pos.x > max_x:
		failures.append(
			"proximity_patrol: entity must stay on patrol route after looping (got x=%.1f)" % looped_pos.x
		)

	# Y coordinate must stay on the route (horizontal route, y=0).
	if not is_equal_approx(looped_pos.y, 0.0):
		failures.append(
			"proximity_patrol: entity y must remain 0.0 on horizontal route (got y=%.1f)" % looped_pos.y
		)

	# Sensors are independently usable — no cross-sensor import or dependency needed.
	# Verified implicitly by the fact that this test instantiates ProximityPatrolSensor
	# with no reference to SightConeSensor or SoundRadiusSensor.

	sensor.free()
	return failures
