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
## INITIALLY FAILING (RED) — assertions use DL-16 top-down estimates as starting
## hypotheses. The three failing assertions are listed below; each is voided by the
## measurement and replaced with the correct value in the GREEN commit.
##
##   RT1: Cross-room walk time asserted in [15, 35] s (DL-16 no-entity: "20–30 s").
##        Fails because M1 (DL-18) = 4.75 s — side-on walk is 5× faster than the
##        top-down estimate.
##
##   RT2: Still Air max avoidance asserted ≥ 30 s (DL-16 Antenna Shaft: "30–60 s").
##        Fails because StillAirControllerSideon.LAP_SEC = 25 s → maximum wait is
##        one full lap (25 s) + cross-room (4.75 s) = 29.75 s < 30 s.
##
##   RT3: Critical-path total asserted ≥ 200 s (DL-16 estimated ~290 s for 5 rooms).
##        Fails because side-on constants give a critical-path midpoint of ~49 s.
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


## ── RT1: Cross-room walk time — INITIALLY FAILING ────────────────────────────
## DL-16 top-down estimate: no-entity room traversal 20–30 s.
## Assertion uses the DL-16 range [15, 35] s — FAILS because M1 = 4.75 s.
## Will be updated to [3.5, 7.0] s after measurement.

func _test_rt1_cross_room_walk() -> Array[String]:
	var failures: Array[String] = []
	var walk_time_s: float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S  ## 4.75 s
	## ── DL-16 top-down estimate (FAILING — voided by M1 = 4.75 s) ──────────────
	if walk_time_s < 15.0 or walk_time_s > 35.0:
		failures.append(
			"rt1_cross_room_walk: DL-16 estimated 15–35 s, measured %.2f s — "
			+ "update to measured [3.5, 7.0] s range after DL-19" % walk_time_s
		)
	return failures


## ── RT2: Still Air max avoidance time — INITIALLY FAILING ────────────────────
## DL-16 top-down estimate: Antenna Shaft 30–60 s.
## Assertion checks max avoidance ≥ 30 s — FAILS because LAP_SEC + cross = 29.75 s.
## Will be updated to [4.75, 32.0] s after measurement.

func _test_rt2_still_air_avoidance() -> Array[String]:
	var failures: Array[String] = []
	var cross_time_s: float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S
	var max_total_s:  float = STILL_AIR_LAP_SEC + cross_time_s  ## 25 + 4.75 = 29.75 s
	## ── DL-16 top-down estimate (FAILING — max = 29.75 s < 30 s floor) ─────────
	if max_total_s < 30.0:
		failures.append(
			"rt2_still_air: DL-16 estimated floor ≥ 30 s; LAP_SEC + cross = %.2f s — "
			+ "update to [4.75, 32.0] s range after DL-19" % max_total_s
		)
	return failures


## ── RT3: Critical-path total — INITIALLY FAILING ─────────────────────────────
## DL-16 top-down estimate: ~290 s for the 5-room critical path.
## Assertion checks midpoint ≥ 200 s — FAILS because side-on midpoint is ~49 s.
## Will be updated to [30, 120] s after measurement.

func _test_rt3_critical_path_total() -> Array[String]:
	var failures: Array[String] = []

	var ground_relay_s:   float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S               ## 4.75 s
	var broadcast_deck_s: float = CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S + 1.0        ## 5.75 s

	var sweep_cycle_s:       float = 2.0 * (WATCHER_SWEEP_PASS_SEC + WATCHER_SWEEP_PAUSE_SEC)
	var safe_window_s:       float = WATCHER_SWEEP_PAUSE_SEC + WATCHER_SWEEP_PASS_SEC * 0.5
	var watcher_avg_wait_s:  float = 0.5 * (sweep_cycle_s - safe_window_s)
	var power_sub_avg_s:     float = watcher_avg_wait_s + CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S

	var equip_floor_mid_s: float = 15.0
	var antenna_shaft_avg_s: float = STILL_AIR_LAP_SEC * 0.5 + CROSS_ROOM_DIST_PX / WALK_SPEED_PX_S

	var critical_path_mid_s: float = (
		ground_relay_s + power_sub_avg_s + equip_floor_mid_s +
		antenna_shaft_avg_s + broadcast_deck_s
	)

	## ── DL-16 top-down estimate (FAILING — midpoint ~49 s, not ≥ 200 s) ────────
	if critical_path_mid_s < 200.0:
		failures.append(
			"rt3_critical_path: DL-16 estimated ~290 s; measured midpoint %.1f s — "
			+ "update to [30, 120] s range after DL-19" % critical_path_mid_s
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
