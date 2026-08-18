extends SceneTree
## T-0190: Hiding — floor-anchored cover-break and hiding spots (side-on plane).
##
## Rebuilds T-0175 mechanics for the §11 §4 v5 side-on geometry:
##   - CoverBreakV2: floor-anchored at a fixed plane_x; blocks sight only via
##     horizontal occlusion (same cover_props mechanism as T-0189 prop cover).
##   - HidingSpotV2: floor-anchored at a fixed plane_x; single-occupant; blocks
##     all three sensor types (SIGHT, SOUND, PROXIMITY) once cleanly inside;
##     no timer, no ongoing check.  No i-frame on entry.
##   - Both objects are independent of FloorPlaneRuntime hazard geometry — a spot
##     or cover object placed at the same plane_x as a Drop gap does not affect
##     the Drop's detection.
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless --script tests/test_T0190_hiding.gd
## Exit 0 on PASS, 1 on any failure.

const SightConeSensorV2Script := preload("res://sensors/sight_cone_sensor_v2.gd")
const SoundRadiusSensorV2Script := preload("res://sensors/sound_radius_sensor_v2.gd")
const ProximityPatrolSensorV2Script := preload("res://sensors/proximity_patrol_sensor_v2.gd")
const SensorScript := preload("res://sensor.gd")
const CoverBreakV2Script := preload("res://cover_break_v2.gd")
const HidingSpotV2Script := preload("res://hiding_spot_v2.gd")
const FloorPlaneRuntimeScript := preload("res://scenes/floor_plane_runtime.gd")

## Floor row index in the authored room grid (matches T-0187 and test_floor_plane.gd).
const FLOOR_ROW: int = 12
## Pixels per tile (must match the project tilemap).
const TILE_SIZE: float = 16.0
## Total authored tile columns (matches FloorPlaneRuntime.AUTHORED_COLS).
const AUTHORED_COLS: int = 24


func _init() -> void:
	var failures: Array[String] = []
	failures += _test_cover_break_v2_floor_anchored()
	failures += _test_cover_break_v2_blocks_sight_only()
	failures += _test_hiding_spot_v2_floor_anchored()
	failures += _test_hiding_spot_v2_blocks_all_sensors()
	failures += _test_no_iframe_on_entry_v2()
	failures += _test_single_occupant_rejection_v2()
	failures += _test_drop_gap_independence_hiding_spot()
	failures += _test_drop_gap_independence_cover_break()

	if failures.is_empty():
		print("T-0190 PASS: floor-anchored cover-break and hiding spots verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0190 FAIL: " + f)
		quit(1)


## ── CoverBreakV2: floor-anchored ─────────────────────────────────────────────
## CoverBreakV2 is placed at a fixed position on the floor plane (plane_x).
## Its horizontal occlusion interval is derived from plane_x and cover_width_px.

func _test_cover_break_v2_floor_anchored() -> Array[String]:
	var failures: Array[String] = []
	var cover: Node = CoverBreakV2Script.new()
	cover.plane_x = 5.0 * TILE_SIZE  # tile 5 → 80 px

	var interval: Vector2 = cover.get_cover_interval()
	var expected_min: float = cover.plane_x - cover.cover_width_px * 0.5
	var expected_max: float = cover.plane_x + cover.cover_width_px * 0.5
	if not is_equal_approx(interval.x, expected_min):
		failures.append(
			"cover_v2_anchored: interval.x=%.1f expected %.1f" % [interval.x, expected_min]
		)
	if not is_equal_approx(interval.y, expected_max):
		failures.append(
			"cover_v2_anchored: interval.y=%.1f expected %.1f" % [interval.y, expected_max]
		)
	# Interval must be centred on plane_x.
	var mid: float = (interval.x + interval.y) * 0.5
	if not is_equal_approx(mid, cover.plane_x):
		failures.append(
			"cover_v2_anchored: interval midpoint=%.1f must equal plane_x=%.1f" % [mid, cover.plane_x]
		)

	cover.free()
	return failures


## ── CoverBreakV2: blocks sight only via horizontal occlusion ──────────────────
## Mirrors T-0189's _test_cover_blocks_sight_only: the CoverBreakV2's cover
## interval is registered as a cover_prop on SightConeSensorV2 and blocks sight.
## Sound and proximity sensors are unaffected (they have no cover_props).

func _test_cover_break_v2_blocks_sight_only() -> Array[String]:
	var failures: Array[String] = []

	var sight: Node = SightConeSensorV2Script.new()
	sight.range_tiles = 6.0
	sight.tile_size = TILE_SIZE
	sight.entity_plane_x = 0.0
	sight.entity_facing_dir = 1.0

	var sound: Node = SoundRadiusSensorV2Script.new()
	sound.walk_radius_tiles = 6.0
	sound.run_radius_tiles = 6.0
	sound.tile_size = TILE_SIZE
	sound.entity_plane_x = 0.0

	var patrol: Node = ProximityPatrolSensorV2Script.new()
	patrol.catch_radius_tiles = 6.0
	patrol.tile_size = TILE_SIZE
	patrol.entity_plane_x = 0.0

	# CoverBreakV2 floor-anchored midway between entity (x=0) and player (x=5 tiles).
	var cover: Node = CoverBreakV2Script.new()
	cover.plane_x = 2.5 * TILE_SIZE  # 40 px
	cover.cover_width_px = TILE_SIZE  # 1-tile-wide object

	var player_x: float = 5.0 * TILE_SIZE  # 80 px

	# Without cover registered: sight detects.
	if not sight.check(player_x):
		failures.append("cover_v2_sight_only: sight must detect player before cover interval is registered")

	# Register CoverBreakV2's interval with the sight sensor (horizontal-occlusion mechanism).
	var interval: Vector2 = cover.get_cover_interval()
	sight.cover_props.append(interval)

	# Sight is now blocked — cover interval spans the entity→player segment.
	if sight.check(player_x):
		failures.append(
			"cover_v2_sight_only: sight must be blocked when cover interval overlaps entity→player segment"
		)
	if not sight.last_check_was_occluded:
		failures.append(
			"cover_v2_sight_only: last_check_was_occluded must be true when cover is registered"
		)

	# Sound radius is unaffected — omnidirectional, no cover_props.
	sound.update_movement_state(false)
	if not sound.check(player_x):
		failures.append(
			"cover_v2_sight_only: sound radius must NOT be blocked by CoverBreakV2 (omnidirectional)"
		)

	# Proximity/patrol is unaffected — no LOS, no cover_props.
	if not patrol.check(player_x):
		failures.append(
			"cover_v2_sight_only: proximity/patrol must NOT be blocked by CoverBreakV2 (no LOS)"
		)

	sight.free()
	sound.free()
	patrol.free()
	cover.free()
	return failures


## ── HidingSpotV2: floor-anchored ─────────────────────────────────────────────
## HidingSpotV2 is placed at a fixed position on the floor plane via plane_x.

func _test_hiding_spot_v2_floor_anchored() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotV2Script.new()
	spot.plane_x = 8.0 * TILE_SIZE  # tile 8 → 128 px

	if not is_equal_approx(spot.plane_x, 8.0 * TILE_SIZE):
		failures.append(
			"spot_v2_anchored: plane_x=%.1f expected %.1f" % [spot.plane_x, 8.0 * TILE_SIZE]
		)
	if spot.is_occupied():
		failures.append("spot_v2_anchored: fresh spot must not be occupied")

	spot.free()
	return failures


## ── HidingSpotV2: blocks all sensors once cleanly inside ─────────────────────
## Once the player enters cleanly (spot was empty), all three sensor types must
## report blocked via Sensor.is_detection_blocked(). No timer, no ongoing check.

func _test_hiding_spot_v2_blocks_all_sensors() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotV2Script.new()
	var player := Node.new()

	if not spot.try_enter(player):
		failures.append("spot_v2_all_sensors: try_enter should succeed on empty spot")
		spot.free()
		player.free()
		return failures

	if not SensorScript.is_detection_blocked(SensorScript.SIGHT, [spot]):
		failures.append("spot_v2_all_sensors: SIGHT sensor must be blocked inside HidingSpotV2")
	if not SensorScript.is_detection_blocked(SensorScript.SOUND, [spot]):
		failures.append("spot_v2_all_sensors: SOUND sensor must be blocked inside HidingSpotV2")
	if not SensorScript.is_detection_blocked(SensorScript.PROXIMITY, [spot]):
		failures.append("spot_v2_all_sensors: PROXIMITY sensor must be blocked inside HidingSpotV2")

	spot.free()
	player.free()
	return failures


## ── No i-frame on entry ───────────────────────────────────────────────────────
## Spec (11-moment-to-moment.md §2): "Entry is exposed — if a sensor already has
## the player the instant they enter, it still catches them. No i-frame."
##
## Verified by: recording detection state before entry, calling try_enter(), and
## confirming the pre-entry detection was not retroactively cancelled.
## Separately confirms all three sensors are blocked one frame after entry.

func _test_no_iframe_on_entry_v2() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotV2Script.new()
	var player := Node.new()

	# Pre-entry: no obstacles → sensor detects (is_detection_blocked returns false).
	var detected_before_entry: bool = not SensorScript.is_detection_blocked(SensorScript.SIGHT, [])
	if not detected_before_entry:
		failures.append("no_iframe_v2: sensor should detect with no obstacles (pre-entry)")
		spot.free()
		player.free()
		return failures

	# Player enters — try_enter() must NOT emit any cancel-detection side-effect.
	var entered: bool = spot.try_enter(player)
	if not entered:
		failures.append("no_iframe_v2: try_enter should succeed on empty spot")
		spot.free()
		player.free()
		return failures

	# Pre-entry detection stands; it was not retroactively cancelled by try_enter().
	if not detected_before_entry:
		failures.append(
			"no_iframe_v2: pre-entry detection was retroactively cancelled (i-frame bug)"
		)

	# One frame after clean entry: all three sensors blocked.
	if not SensorScript.is_detection_blocked(SensorScript.SIGHT, [spot]):
		failures.append("no_iframe_v2: SIGHT sensor must be blocked one frame after clean entry")
	if not SensorScript.is_detection_blocked(SensorScript.SOUND, [spot]):
		failures.append("no_iframe_v2: SOUND sensor must be blocked one frame after clean entry")
	if not SensorScript.is_detection_blocked(SensorScript.PROXIMITY, [spot]):
		failures.append("no_iframe_v2: PROXIMITY sensor must be blocked one frame after clean entry")

	spot.free()
	player.free()
	return failures


## ── Single-occupant rejection ─────────────────────────────────────────────────
## A second entity attempting to enter an occupied spot must be rejected.
## Single-occupant guarantee is unchanged from T-0175, rebuilt on the new plane.

func _test_single_occupant_rejection_v2() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotV2Script.new()
	var player1 := Node.new()
	var player2 := Node.new()

	if not spot.try_enter(player1):
		failures.append("single_occupant_v2: first try_enter should succeed")
		spot.free()
		player1.free()
		player2.free()
		return failures

	if spot.try_enter(player2):
		failures.append(
			"single_occupant_v2: second try_enter on occupied spot must return false"
		)
	if not spot.is_occupied():
		failures.append("single_occupant_v2: is_occupied() must return true after entry")
	if spot.get_occupant() != player1:
		failures.append("single_occupant_v2: get_occupant() must return the first occupant")

	# After exit the spot becomes available again.
	spot.exit_spot(player1)
	if spot.is_occupied():
		failures.append("single_occupant_v2: is_occupied() must be false after exit")
	if not spot.try_enter(player2):
		failures.append("single_occupant_v2: try_enter must succeed after previous occupant exited")

	spot.free()
	player1.free()
	player2.free()
	return failures


## ── Drop gap independence: HidingSpotV2 ──────────────────────────────────────
## A HidingSpotV2 placed at the same plane_x as a Drop gap column must not
## affect FloorPlaneRuntime's hazard classification.  Hiding geometry and hazard
## geometry are independent even when co-located (depends on T-0187).

func _test_drop_gap_independence_hiding_spot() -> Array[String]:
	var failures: Array[String] = []

	const DROP_COL: int = 10
	var layer: TileMapLayer = _make_floor_layer_with_drop(DROP_COL)
	var fpr: RefCounted = FloorPlaneRuntimeScript.new()
	fpr.scan(layer, FLOOR_ROW)

	# Place a HidingSpotV2 at the exact pixel X of the Drop column.
	var spot: Node = HidingSpotV2Script.new()
	spot.plane_x = float(DROP_COL) * TILE_SIZE

	# FloorPlaneRuntime must still classify the column as a Drop.
	if not fpr.is_drop_at_column(DROP_COL):
		failures.append(
			"drop_indep_spot: is_drop_at_column(%d) must still be true with HidingSpotV2 at same X"
			% DROP_COL
		)

	# HidingSpotV2 must expose no method that could register with FloorPlaneRuntime.
	if spot.has_method("register_as_floor_tile") or spot.has_method("mark_solid"):
		failures.append(
			"drop_indep_spot: HidingSpotV2 must not expose floor-registration methods"
		)

	layer.free()
	spot.free()
	return failures


## ── Drop gap independence: CoverBreakV2 ──────────────────────────────────────
## A CoverBreakV2 placed at the same plane_x as a Drop gap column must not
## affect FloorPlaneRuntime's hazard classification.

func _test_drop_gap_independence_cover_break() -> Array[String]:
	var failures: Array[String] = []

	const DROP_COL: int = 5
	var layer: TileMapLayer = _make_floor_layer_with_drop(DROP_COL)
	var fpr: RefCounted = FloorPlaneRuntimeScript.new()
	fpr.scan(layer, FLOOR_ROW)

	# Place a CoverBreakV2 at the exact pixel X of the Drop column.
	var cover: Node = CoverBreakV2Script.new()
	cover.plane_x = float(DROP_COL) * TILE_SIZE

	# FloorPlaneRuntime must still classify the column as a Drop.
	if not fpr.is_drop_at_column(DROP_COL):
		failures.append(
			"drop_indep_cover: is_drop_at_column(%d) must still be true with CoverBreakV2 at same X"
			% DROP_COL
		)

	# CoverBreakV2 must expose no method that could register with FloorPlaneRuntime.
	if cover.has_method("register_as_floor_tile") or cover.has_method("mark_solid"):
		failures.append(
			"drop_indep_cover: CoverBreakV2 must not expose floor-registration methods"
		)

	layer.free()
	cover.free()
	return failures


## ── Helper: build a TileMapLayer with all solid columns except one Drop ───────
## All AUTHORED_COLS columns are solid at FLOOR_ROW except [param drop_col].
## The caller must call layer.free() when done.
func _make_floor_layer_with_drop(drop_col: int) -> TileMapLayer:
	var ts := TileSet.new()
	ts.tile_size = Vector2i(16, 16)
	var src := TileSetAtlasSource.new()
	ts.add_source(src, 0)
	var layer := TileMapLayer.new()
	layer.tile_set = ts
	for col: int in range(AUTHORED_COLS):
		if col != drop_col:
			layer.set_cell(Vector2i(col, FLOOR_ROW), 0, Vector2i(0, 0))
	return layer
