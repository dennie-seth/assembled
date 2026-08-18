extends SceneTree
## test_T0193_blockout_measures.gd
## T-0193: Six-measure record for the T-0192 side-on one-room blockout (§20-a2).
##
## Derives all six measures analytically from blockout geometry constants already
## committed in T-0192.  No Godot physics or scene instantiation required.
##
##   M1. Cross-room walk time (spawn → door, no entity)   — ~4.75 s
##   M2. Watcher patrol cycle                             — INITIALLY FAILING (see below)
##   M3. Tiles of warning at spawn                        — 4 tiles uncovered / 6.5 tiles behind cover
##   M4. Unavoidable detection on crossing path           — INITIALLY FAILING (see below)
##   M5. Cover vs hiding as two distinct guarantees       — yes (sound passes cover)
##   M6. Floor plane reads as room (not corridor)         — yes (aspect ratio 1.85:1)
##
## INITIALLY FAILING assertions — corrected in the same commit as DL-18:
##
##   M2: Asserts the OLD 14 §10 top-down patrol-cycle estimate (~12 s: "~4 s pass,
##       ~2 s pause at each end" × 2 directions).  The measured value from the
##       side-on blockout code is 6.0 s (3 s/direction, 0 s pause).  This FAILS
##       until DL-18 and §10 are updated.
##
##   M4: Asserts the OPTIMISTIC hypothesis — player crosses from hiding spot
##       (col 7, 120 px) to door (col 21, 344 px) without detection, starting
##       the moment the Watcher turns left at col 18 (296 px).  The simulation
##       finds sight-detection at t ≈ 0.83 s, when the player is at col 10.8
##       (173 px), still 171 px short of the door.  This FAILS, confirming
##       unavoidable detection; the assertion is corrected after DL-18.
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless \
##       --script tests/test_T0193_blockout_measures.gd
## Exit 0 = PASS, exit 1 = FAIL.

const SightConeSensorV2Script    := preload("res://sensors/sight_cone_sensor_v2.gd")
const SoundRadiusSensorV2Script  := preload("res://sensors/sound_radius_sensor_v2.gd")
const CoverBreakV2Script         := preload("res://cover_break_v2.gd")

## ── Layout constants (mirror blockout_room_sideon.gd) ─────────────────────────
const TILE_SIZE: float  = 16.0
const GRID_COLS: int    = 24
const GRID_ROWS: int    = 13

## Floor-plane X positions (tile-centre formula: col * TILE_SIZE + TILE_SIZE * 0.5)
const SPAWN_X: float        = 2.0 * TILE_SIZE + TILE_SIZE * 0.5   ##  40 px  (col 2)
const HIDING_X: float       = 7.0 * TILE_SIZE + TILE_SIZE * 0.5   ## 120 px  (col 7)
const COVER_PLANE_X: float  = 9.0 * TILE_SIZE + TILE_SIZE * 0.5   ## 152 px  (col 9 centre)
const COVER_MIN: float      = 9.0 * TILE_SIZE                      ## 144 px  (cover left edge)
const COVER_MAX: float      = 9.0 * TILE_SIZE + TILE_SIZE          ## 160 px  (cover right edge)
const WATCHER_LEFT_X: float = 12.0 * TILE_SIZE + TILE_SIZE * 0.5  ## 200 px  (col 12)
const WATCHER_RIGHT_X: float= 18.0 * TILE_SIZE + TILE_SIZE * 0.5  ## 296 px  (col 18)
const DOOR_X: float         = 21.0 * TILE_SIZE + TILE_SIZE * 0.5  ## 344 px  (col 21)

## ── Speed constants (mirror player_controller.gd / watcher_controller_sideon.gd) ──
const WALK_SPEED_PX_S: float    = 64.0   ## 4 tiles/s
const PATROL_SPEED_PX_S: float  = 32.0   ## 2 tiles/s (watcher physical patrol)
const SIGHT_RANGE_TILES: float  = 6.0
const SOUND_WALK_TILES: float   = 1.5
const SOUND_RUN_TILES: float    = 5.0


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_m1_cross_room_walk()
	failures += _test_m2_patrol_cycle()
	failures += _test_m3_warning_tiles()
	failures += _test_m4_crossing_detection()
	failures += _test_m5_cover_vs_hiding()
	failures += _test_m6_floor_plane_aspect()

	if failures.is_empty():
		print("T-0193 PASS: six blockout measures recorded (DL-18)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0193 FAIL: " + f)
		quit(1)


## ── M1: Cross-room walk time ──────────────────────────────────────────────────
## Spawn (col 2, 40 px) → door (col 21, 344 px) at WALK_SPEED, no entity.
## Expected: (344 − 40) / 64 = 4.75 s.

func _test_m1_cross_room_walk() -> Array[String]:
	var failures: Array[String] = []
	var distance_px: float   = DOOR_X - SPAWN_X           ## 304 px
	var walk_time_s: float   = distance_px / WALK_SPEED_PX_S  ## 4.75 s
	if walk_time_s < 3.5 or walk_time_s > 7.0:
		failures.append(
			"m1_walk_time: expected 3.5–7.0 s, got %.2f s" % walk_time_s
		)
	return failures


## ── M2: Watcher patrol cycle (INITIALLY FAILING) ─────────────────────────────
## Blockout code: patrol span 6 tiles = 96 px / 32 px·s⁻¹ = 3.0 s per direction,
## 0 s pause at each end.  Full cycle = 6.0 s.
##
## 14 §10 pre-DL-18 said "~4 s pass, ~2 s pause at each end" → implied 12 s cycle.
## This test asserts the OLD 12 s value and FAILS, exposing the mismatch.
## After DL-18 and §10 are updated, change 12.0 → 6.0 in the assertion.

func _test_m2_patrol_cycle() -> Array[String]:
	var failures: Array[String] = []
	var patrol_span_px: float = WATCHER_RIGHT_X - WATCHER_LEFT_X  ## 96 px (6 tiles)
	var cycle_s: float = 2.0 * patrol_span_px / PATROL_SPEED_PX_S  ## 6.0 s measured
	## ── OLD TOP-DOWN VALUE (FAILS against actual 6 s) — change to 6.0 after DL-18 ──
	if absf(cycle_s - 12.0) > 0.5:
		failures.append(
			"m2_patrol_cycle: old 14§10 estimate 12.0 s ≠ measured %.1f s — "
			+ "void the top-down value and record 6.0 s in DL-18" % cycle_s
		)
	return failures


## ── M3: Tiles of warning at spawn ────────────────────────────────────────────
## Watcher at left patrol (col 12, 200 px), facing left.
## Sight left edge (without cover): 200 − 96 = 104 px (col 6.5).
## Gap from spawn (40 px) to sight edge: 64 px = 4 tiles.
## Cover at [144, 160] shields the player up to col 9; spawn-to-cover = 6.5 tiles.

func _test_m3_warning_tiles() -> Array[String]:
	var failures: Array[String] = []
	var sight_edge_px: float          = WATCHER_LEFT_X - SIGHT_RANGE_TILES * TILE_SIZE  ## 104 px
	var uncovered_warning_tiles: float = (sight_edge_px - SPAWN_X) / TILE_SIZE          ## 4 tiles
	var covered_warning_tiles: float   = (COVER_MIN - SPAWN_X) / TILE_SIZE              ## 6.5 tiles
	if uncovered_warning_tiles < 3.0:
		failures.append(
			"m3_warning_tiles: uncovered approach must be ≥ 3 tiles, got %.1f" % uncovered_warning_tiles
		)
	if covered_warning_tiles < 5.0:
		failures.append(
			"m3_warning_tiles: cover-protected approach must be ≥ 5 tiles, got %.1f" % covered_warning_tiles
		)
	return failures


## ── M4: Unavoidable detection on crossing path (INITIALLY FAILING) ───────────
## OPTIMISTIC HYPOTHESIS: player crosses from hiding (120 px) to door (344 px)
## without detection, starting the moment the Watcher turns left at col 18 (296 px).
##
## Simulation: player moves right at WALK_SPEED (64 px/s), watcher moves left at
## PATROL_SPEED (32 px/s).  Once the player is past the cover right edge (160 px),
## detection is tested each step using a SightConeSensorV2 (no cover registered,
## since the player is now to the right of the cover).
##
## MEASURED OUTCOME: detection triggers at t ≈ 0.83 s (player ≈ 173 px, col 10.8),
## sight_edge = 200 − 32 × 0.833 = 173 px meets player position.
##
## The OPTIMISTIC assertion below (detected_at_t < 0, i.e. no detection) FAILS.
## After DL-18: replace assertion with "detected_at_t in [0.7, 1.0] s".

func _test_m4_crossing_detection() -> Array[String]:
	var failures: Array[String] = []

	var player_x: float  = HIDING_X        ## 120 px — exits hiding spot
	var watcher_x: float = WATCHER_RIGHT_X  ## 296 px — just turned left

	var sight: Node = SightConeSensorV2Script.new()
	sight.range_tiles       = SIGHT_RANGE_TILES
	sight.tile_size         = TILE_SIZE
	sight.entity_plane_x    = watcher_x
	sight.entity_facing_dir = -1.0  ## watcher facing left

	var dt: float = 0.001
	var t: float = 0.0
	var detected_at_t: float = -1.0

	while player_x < DOOR_X and t < 5.0:
		t += dt
		player_x  += WALK_SPEED_PX_S   * dt
		watcher_x -= PATROL_SPEED_PX_S * dt

		## Only check sight once the player has moved past the cover right edge.
		## (Behind cover, sight is blocked — the interesting zone is past it.)
		if player_x > COVER_MAX:
			sight.entity_plane_x = watcher_x
			if sight.check(player_x):
				detected_at_t = t
				break

	sight.free()

	## ── OPTIMISTIC assertion (FAILS — confirms unavoidable detection) ──────────
	## Replace this block with the confirmed-detection check after DL-18 is committed.
	if detected_at_t >= 0.0:
		failures.append(
			"m4_crossing_detection: OPTIMISTIC HYPOTHESIS FAILED — "
			+ "sight detection at t=%.3f s (player ≈ %.1f px) before reaching door — "
			+ "document in DL-18 and update this assertion" % [detected_at_t, player_x]
		)
	return failures


## ── M5: Cover vs hiding as two distinct guarantees ───────────────────────────
## Behind cover (col 9), player at hiding spot (col 7, 120 px):
##   - Sight: BLOCKED (cover [144, 160] occludes line to watcher at 200 px)
##   - Sound (running, 80 px = 5-tile boundary): DETECTED (distance = 80 px ≤ 80 px)
## Inside hiding spot (HidingSpotV2): ALL sensors blocked (verified in T-0192 test).
## This test confirms the sight/sound distinction behind cover only.

func _test_m5_cover_vs_hiding() -> Array[String]:
	var failures: Array[String] = []

	var cover: Node = CoverBreakV2Script.new()
	cover.plane_x        = COVER_PLANE_X   ## 152 px (col 9 centre)
	cover.cover_width_px = TILE_SIZE        ## 16 px → interval [144, 160]
	var interval: Vector2 = cover.get_cover_interval()

	## Sight is blocked when cover is registered.
	var sight: Node = SightConeSensorV2Script.new()
	sight.range_tiles       = SIGHT_RANGE_TILES
	sight.tile_size         = TILE_SIZE
	sight.entity_plane_x    = WATCHER_LEFT_X   ## 200 px
	sight.entity_facing_dir = -1.0
	sight.cover_props.append(interval)

	if sight.check(HIDING_X):
		failures.append(
			"m5_cover_vs_hiding: sight must be BLOCKED at hiding spot (120 px) "
			+ "when cover [144, 160] is registered"
		)

	## Run-sound passes through cover (distance = 80 px = 5-tile run boundary).
	var sound: Node = SoundRadiusSensorV2Script.new()
	sound.walk_radius_tiles = SOUND_WALK_TILES
	sound.run_radius_tiles  = SOUND_RUN_TILES
	sound.tile_size         = TILE_SIZE
	sound.entity_plane_x    = WATCHER_LEFT_X  ## 200 px
	sound.update_movement_state(true)          ## player running

	if not sound.check(HIDING_X):
		failures.append(
			"m5_cover_vs_hiding: run-sound must still DETECT at hiding spot "
			+ "(80 px = 5-tile boundary, omnidirectional, unaffected by cover)"
		)

	sight.free()
	sound.free()
	cover.free()
	return failures


## ── M6: Floor plane reads as room (not corridor) ─────────────────────────────
## Grid: 24 × 13 tiles → aspect ratio 24/13 ≈ 1.85.
## A corridor reads as ≥ 3:1 with no lateral object interest.
## Objects span cols 4–21 (17 columns) with distributed lateral interest.

func _test_m6_floor_plane_aspect() -> Array[String]:
	var failures: Array[String] = []
	var aspect: float = float(GRID_COLS) / float(GRID_ROWS)  ## ≈ 1.846
	if aspect < 1.5:
		failures.append(
			"m6_floor_plane: aspect ratio %.2f < 1.5 — too square to read as a room" % aspect
		)
	if aspect >= 3.0:
		failures.append(
			"m6_floor_plane: aspect ratio %.2f ≥ 3.0 — reads as corridor, not room" % aspect
		)
	return failures
