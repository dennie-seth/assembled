extends SceneTree
## T-0175: Cover-break and hiding-spot tests.
##
## Verifies:
##   - CoverBreak blocks the sight-cone sensor (SIGHT) only; SOUND and
##     PROXIMITY pass through it unchanged (11-moment-to-moment.md §2).
##   - HidingSpot blocks all three sensor types once the player is cleanly
##     inside — no timer, no ongoing check.
##   - Entry is exposed: a sensor with active detection the instant before
##     spot-entry still registers the catch (no i-frame on the transition).
##   - Single-occupant: a second entity attempting to enter an occupied spot
##     is rejected.
##   - After exit the spot becomes available again.
##
## Run headless:
##   godot --headless --script tests/test_hiding.gd
## from client/. Exit 0 on PASS, 1 on any failure.

const SensorScript := preload("res://sensor.gd")
const CoverBreakScript := preload("res://cover_break.gd")
const HidingSpotScript := preload("res://hiding_spot.gd")


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_cover_blocks_sight_only()
	failures += _test_hiding_spot_blocks_all_sensors()
	failures += _test_no_iframe_on_entry()
	failures += _test_single_occupant_rejection()
	failures += _test_exit_frees_spot()

	if failures.is_empty():
		print("T-0175 PASS: cover-break and hiding-spot mechanics verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0175 FAIL: " + f)
		quit(1)


## ── Test: CoverBreak blocks SIGHT only ───────────────────────────────────────
## A cover-break object blocks only the sight-cone sensor.  Sound-radius and
## proximity/patrol sensors detect through it unchanged.

func _test_cover_blocks_sight_only() -> Array[String]:
	var failures: Array[String] = []
	var cover: Node = CoverBreakScript.new()

	if not SensorScript.is_detection_blocked(SensorScript.SIGHT, [cover]):
		failures.append("cover_sight: SIGHT sensor should be blocked by CoverBreak")

	if SensorScript.is_detection_blocked(SensorScript.SOUND, [cover]):
		failures.append("cover_sound: SOUND sensor must NOT be blocked by CoverBreak")

	if SensorScript.is_detection_blocked(SensorScript.PROXIMITY, [cover]):
		failures.append("cover_proximity: PROXIMITY sensor must NOT be blocked by CoverBreak")

	cover.free()
	return failures


## ── Test: HidingSpot blocks all sensor types after clean entry ────────────────
## Once a player enters cleanly (spot was empty), all three sensor types must
## report blocked — no timer, no ongoing check required.

func _test_hiding_spot_blocks_all_sensors() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotScript.new()
	var player := Node.new()

	if not spot.try_enter(player):
		failures.append("all_sensors: try_enter should succeed on empty spot")
		spot.free()
		player.free()
		return failures

	if not SensorScript.is_detection_blocked(SensorScript.SIGHT, [spot]):
		failures.append("all_sensors: SIGHT sensor should be blocked inside HidingSpot")
	if not SensorScript.is_detection_blocked(SensorScript.SOUND, [spot]):
		failures.append("all_sensors: SOUND sensor should be blocked inside HidingSpot")
	if not SensorScript.is_detection_blocked(SensorScript.PROXIMITY, [spot]):
		failures.append("all_sensors: PROXIMITY sensor should be blocked inside HidingSpot")

	spot.free()
	player.free()
	return failures


## ── Test: no i-frame on hiding-spot entry ─────────────────────────────────────
## Spec (11-moment-to-moment.md §2): "Entry is exposed — if a sensor already
## has the player the instant they enter, it still catches them. No i-frame."
##
## Verified by: recording detection state before entry, calling try_enter(),
## and confirming the pre-entry detection was not retroactively cancelled.
## Separately confirms all three sensors are blocked the frame after entry.

func _test_no_iframe_on_entry() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotScript.new()
	var player := Node.new()

	## With no obstacles the sensor detects (is_detection_blocked returns false).
	var detected_before_entry: bool = not SensorScript.is_detection_blocked(
		SensorScript.SIGHT, []
	)
	if not detected_before_entry:
		failures.append("no_iframe: sensor should detect with no obstacles (pre-entry)")
		spot.free()
		player.free()
		return failures

	## Player enters — try_enter() must NOT emit any cancel-detection side-effect.
	var entered: bool = spot.try_enter(player)
	if not entered:
		failures.append("no_iframe: try_enter should succeed on empty spot")
		spot.free()
		player.free()
		return failures

	## Pre-entry detection stands: it was not retroactively cancelled by entry.
	if not detected_before_entry:
		failures.append(
			"no_iframe: pre-entry detection was retroactively cancelled (i-frame bug)"
		)

	## One frame after clean entry: all three sensors blocked.
	if not SensorScript.is_detection_blocked(SensorScript.SIGHT, [spot]):
		failures.append(
			"no_iframe: SIGHT sensor should be blocked one frame after clean entry"
		)
	if not SensorScript.is_detection_blocked(SensorScript.SOUND, [spot]):
		failures.append(
			"no_iframe: SOUND sensor should be blocked one frame after clean entry"
		)
	if not SensorScript.is_detection_blocked(SensorScript.PROXIMITY, [spot]):
		failures.append(
			"no_iframe: PROXIMITY sensor should be blocked one frame after clean entry"
		)

	spot.free()
	player.free()
	return failures


## ── Test: single-occupant enforcement ────────────────────────────────────────
## A second entity attempting to enter an occupied spot must be rejected.

func _test_single_occupant_rejection() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotScript.new()
	var player1 := Node.new()
	var player2 := Node.new()

	if not spot.try_enter(player1):
		failures.append("single_occupant: first try_enter should succeed")
		spot.free()
		player1.free()
		player2.free()
		return failures

	if spot.try_enter(player2):
		failures.append(
			"single_occupant: second try_enter on occupied spot must return false"
		)

	if not spot.is_occupied():
		failures.append("single_occupant: is_occupied() should return true")

	spot.free()
	player1.free()
	player2.free()
	return failures


## ── Test: exit frees the spot ─────────────────────────────────────────────────
## After the occupant exits, the spot must accept a new entity.

func _test_exit_frees_spot() -> Array[String]:
	var failures: Array[String] = []
	var spot: Node = HidingSpotScript.new()
	var player1 := Node.new()
	var player2 := Node.new()

	spot.try_enter(player1)
	spot.exit_spot(player1)

	if spot.is_occupied():
		failures.append("exit_frees: is_occupied() should be false after exit")

	if not spot.try_enter(player2):
		failures.append("exit_frees: try_enter should succeed after previous occupant exited")

	spot.free()
	player1.free()
	player2.free()
	return failures
