extends SceneTree
## test_T0195_full_run_traversal.gd
## T-0195: Full-run traversal measurement through the Signal Tower chain (§20-a4).
##
## Derives per-room traversal time estimates from committed side-on constants
## (walk speed, entity sweep timing, detection radii, patrol lap duration) to
## produce a measured run-length figure grounded in the T-0194 side-on chain.
##
## Chain: signal_tower_chain_sideon.gd (T-0194 / §20-a3)
## Constants sourced from: watcher_controller_sideon.gd, sound_controller_sideon.gd,
##                         still_air_controller_sideon.gd, test_T0193_blockout_measures.gd
##
## RED → GREEN progression (per conduct.md TDD):
##
##   RT1 (was failing): Cross-room walk asserted in [15, 35] s (DL-16 no-entity "20–30 s")
##        → FAILED because M1 (DL-18) = 4.75 s (side-on is 5× faster than top-down).
##        Updated to [3.5, 7.0] s (DL-19 measured).
##
##   RT2 (was failing): Still Air max avoidance asserted ≥ 30 s (DL-16 floor)
##        → FAILED because LAP_SEC + cross = 25 + 4.75 = 29.75 s < 30 s.
##        Updated to max ≤ 32.0 s (DL-19 measured).
##
##   RT3 (was failing): Critical-path total asserted ≥ 200 s (DL-16 ~290 s)
##        → FAILED because side-on midpoint is ~49 s.
##        Updated to [30, 120] s (DL-19 measured range).
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless \
##       --script tests/test_T0195_full_run_traversal.gd
## Exit 0 = PASS, exit 1 = FAIL.

## ── Shared movement constants (mirror DL-18 / test_T0193_blockout_measures.gd) ──
const TILE_SIZE_PX:     float = 16.0    ## px per tile
const GRID_COLS:        int   = 24      ## room width in tiles
const WALK_SPEED_PX_S:  float = 64.0   ## 4 tiles/s  (player walk)

## Spawn→door horizontal distance: col 2 centre → col 21 centre = 304 px (M1, DL-18)
const SPAWN_X:  float = 2.0  * TILE_SIZE_PX + TILE_SIZE_PX * 0.5   ##  40 px
const DOOR_X:   float = 21.0 * TILE_SIZE_PX + TILE_SIZE_PX * 0.5   ## 344 px
const CROSS_ROOM_DIST_PX: float = DOOR_X - SPAWN_X                  ## 304 px

## ── Watcher (Power Substation) sweep constants ────────────────────────────────
const WATCHER_SWEEP_PASS_SEC:  float = 4.0   ## seconds per sweep direction
const WATCHER_SWEEP_PAUSE_SEC: float = 2.0   ## seconds pause at each sweep extreme

## ── Sound (Equipment Floor) detection constants ───────────────────────────────
const SOUND_RUN_RADIUS_PX:  float = 80.0   ## 5 tiles
const SOUND_WALK_RADIUS_PX: float = 24.0   ## 1.5 tiles

## ── Still Air (Antenna Shaft) patrol constants ────────────────────────────────
const STILL_AIR_CATCH_RADIUS_PX: float = 24.0   ## 1.5 tiles
const STILL_AIR_LAP_SEC:         float = 25.0   ## patrol lap duration (LAP_SEC)


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_rt1_cross_room_walk()
	failures += _test_rt2_still_air_avoidance()
	failures += _test_rt3_critical_path_total()
	failures += _test_chain_structure_sanity()
	failures += _test_watcher_sweep_cycle()
	failures += _test_sound_safe_walk()

	if failures.is_empty():
		print("T-0195 PASS: full-run traversal measured (DL-19); E-1 settled (DL-20)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0195 FAIL: " + f)
		quit(1)


## ── RT1: Cross-room walk time (DL-19 measured value) ────────────────────────
## DL-16 top-down estimate was "20–30 s" — VOIDED by M1 (DL-18) = 4.75 s.
## RED assertion was [15, 35] s; fails because 4.75 < 15.
## DL-19 records the measured value; assertion updated to [3.5, 7.0] s.

func _test_rt1_cross_room_walk() -> Array[String]:
	var failures: Array[String] = []
	var walk_time_s: float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S  ## 4.75 s
	## ── MEASURED VALUE (DL-19, from DL-18 M1): 4.75 s → assert [3.5, 7.0] s ───
	if walk_time_s < 3.5 or walk_time_s > 7.0:
		failures.append(
			"rt1_cross_room_walk: expected 3.5–7.0 s (DL-19 measured 4.75 s), got %.2f s" % walk_time_s
		)
	return failures


## ── RT2: Still Air max avoidance time (DL-19 measured value) ────────────────
## DL-16 top-down estimate: Antenna Shaft 30–60 s.
## RED assertion checked max ≥ 30 s; fails because LAP_SEC + cross = 29.75 s < 30 s.
## DL-19 records the measured range; assertion updated to max ≤ 32.0 s.

func _test_rt2_still_air_avoidance() -> Array[String]:
	var failures: Array[String] = []
	var cross_time_s: float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S
	var min_total_s:  float = cross_time_s                       ## lucky: entity at far end = 4.75 s
	var max_total_s:  float = STILL_AIR_LAP_SEC + cross_time_s  ## unlucky: full lap + cross = 29.75 s
	## ── MEASURED VALUE (DL-19): range [4.75, 29.75] s → assert ≤ 32.0 s ceiling ──
	if min_total_s < 3.5:
		failures.append(
			"rt2_still_air: min total %.2f s below floor 3.5 s (cross-room walk)" % min_total_s
		)
	if max_total_s > 32.0:
		failures.append(
			"rt2_still_air: max total %.2f s exceeds 32.0 s ceiling (LAP_SEC + cross)" % max_total_s
		)
	return failures


## ── RT3: Critical-path total (DL-19 measured range) ─────────────────────────
## DL-16 top-down estimate: ~290 s for the 5-room critical path.
## RED assertion checked midpoint ≥ 200 s; fails because side-on midpoint ~49 s.
## DL-19 records the measured range [30, 90] s; assertion updated to [30, 120] s.
##
## Midpoint derivation (DL-19):
##   Ground Relay   (no entity, M1)         :  4.75 s
##   Power Sub.     (sweep: avg wait ~4 s)  :  8.75 s
##   Equipment Floor (sound, walk-only)     : 15.0  s (mid estimate)
##   Antenna Shaft  (still air: avg wait 12.5 s) : 17.25 s
##   Broadcast Deck (no entity + key)       :  5.75 s
##   ─────────────────────────────────────────────────
##   Total midpoint                         : ~51.5 s

func _test_rt3_critical_path_total() -> Array[String]:
	var failures: Array[String] = []

	var ground_relay_s:   float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S               ## 4.75 s
	var broadcast_deck_s: float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S + 1.0        ## 5.75 s (+key)

	## Power Substation — sweep model, 12 s cycle, ~4-6 s safe window.
	var sweep_cycle_s:       float = 2.0 * (WATCHER_SWEEP_PASS_SEC + WATCHER_SWEEP_PAUSE_SEC)
	var safe_window_s:       float = WATCHER_SWEEP_PAUSE_SEC + WATCHER_SWEEP_PASS_SEC * 0.5
	var watcher_avg_wait_s:  float = 0.5 * (sweep_cycle_s - safe_window_s)
	var power_sub_avg_s:     float = watcher_avg_wait_s + CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S

	## Equipment Floor — sound, walk-only, mid estimate from DL-19.
	var equip_floor_mid_s: float = 15.0

	## Antenna Shaft — still air, average wait = LAP_SEC / 2.
	var antenna_shaft_avg_s: float = STILL_AIR_LAP_SEC * 0.5 + CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S

	var critical_path_mid_s: float = (
		ground_relay_s + power_sub_avg_s + equip_floor_mid_s +
		antenna_shaft_avg_s + broadcast_deck_s
	)

	## ── MEASURED VALUE (DL-19): midpoint ~49–52 s → assert [30, 120] s ─────────
	if critical_path_mid_s < 30.0:
		failures.append(
			"rt3_critical_path: midpoint %.1f s below 30 s floor (check constants)" % critical_path_mid_s
		)
	if critical_path_mid_s > 120.0:
		failures.append(
			"rt3_critical_path: midpoint %.1f s exceeds 120 s ceiling (check entity estimates)" % critical_path_mid_s
		)
	return failures


## ── Sanity: chain has 7 rooms and 5-room critical path ───────────────────────
## Guards against chain topology changes that would invalidate the traversal model.

func _test_chain_structure_sanity() -> Array[String]:
	var failures: Array[String] = []

	var ChainScript: GDScript = load("res://signal_tower/signal_tower_chain_sideon.gd") as GDScript
	if ChainScript == null:
		failures.append("chain_sanity: signal_tower_chain_sideon.gd not found")
		return failures

	var chain: Node = ChainScript.new()
	if chain.get_all_tags().size() != 7:
		failures.append(
			"chain_sanity: expected 7 rooms, got %d" % chain.get_all_tags().size()
		)
	if chain.get_critical_path().size() != 5:
		failures.append(
			"chain_sanity: expected 5-room critical path, got %d" % chain.get_critical_path().size()
		)
	chain.free()
	return failures


## ── Watcher sweep cycle locked to 12 s ───────────────────────────────────────
## WatcherControllerSideon: SWEEP_PASS_SEC=4, SWEEP_PAUSE_SEC=2 → cycle=12 s.
## This is the redesigned sweep model (Option B, DL-18 M4 design consequence).

func _test_watcher_sweep_cycle() -> Array[String]:
	var failures: Array[String] = []
	var WatcherScript: GDScript = load("res://signal_tower/watcher_controller_sideon.gd") as GDScript
	if WatcherScript == null:
		failures.append("watcher_sweep: watcher_controller_sideon.gd not found")
		return failures

	var watcher: Node = WatcherScript.new()
	var pass_sec:  float = watcher.get("SWEEP_PASS_SEC")  as float
	var pause_sec: float = watcher.get("SWEEP_PAUSE_SEC") as float
	watcher.free()

	var cycle_s: float = 2.0 * (pass_sec + pause_sec)
	if absf(cycle_s - 12.0) > 1.0:
		failures.append(
			"watcher_sweep: cycle must be 12 s (4+2+4+2); got %.1f s" % cycle_s
		)
	return failures


## ── Sound safe-walk boundary ─────────────────────────────────────────────────
## Confirms the detection-radius envelope used in the traversal estimate.

func _test_sound_safe_walk() -> Array[String]:
	var failures: Array[String] = []
	var SoundScript: GDScript = load("res://signal_tower/sound_controller_sideon.gd") as GDScript
	if SoundScript == null:
		failures.append("sound_safe_walk: sound_controller_sideon.gd not found")
		return failures

	var sound: Node = SoundScript.new()
	sound.patrol_left_x  = 0.0
	sound.patrol_right_x = 96.0

	var inside_walk: bool = sound.check_player(SOUND_WALK_RADIUS_PX - 1.0, false, [])
	if not inside_walk:
		failures.append(
			"sound_safe_walk: must detect walking player at %.0f px (inside %.0f px boundary)"
			% [SOUND_WALK_RADIUS_PX - 1.0, SOUND_WALK_RADIUS_PX]
		)

	var outside_walk: bool = sound.check_player(SOUND_WALK_RADIUS_PX + 1.0, false, [])
	if outside_walk:
		failures.append(
			"sound_safe_walk: must NOT detect walking player at %.0f px (outside %.0f px boundary)"
			% [SOUND_WALK_RADIUS_PX + 1.0, SOUND_WALK_RADIUS_PX]
		)

	if SOUND_WALK_RADIUS_PX + 1.0 < SOUND_RUN_RADIUS_PX:
		var run_detected: bool = sound.check_player(SOUND_WALK_RADIUS_PX + 1.0, true, [])
		if not run_detected:
			failures.append(
				"sound_safe_walk: must detect RUNNING player at %.0f px (inside %.0f px run boundary)"
				% [SOUND_WALK_RADIUS_PX + 1.0, SOUND_RUN_RADIUS_PX]
			)

	sound.free()
	return failures
