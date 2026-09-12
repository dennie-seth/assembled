extends SceneTree
## T-0328 fix round (Codex PR review of PR #372, 2026-09-11): every room's
## perimeter must be fully enclosed by collision except for its declared
## door/ladder openings. The prior commit built collision for the top/left/
## right wall runs but never the bottom — a dead-end room (e.g. Records
## Room) had an open floor a player could walk straight through into
## unconnected space, bypassing the authored connectivity graph entirely.
##
## Verifies, against the live built scene (not just the spec):
##   1. Every solid (non-opening) perimeter segment of every room — top,
##      bottom, left, right — blocks a player attempting to cross it.
##   2. Every declared door/ladder opening still lets a player pass through
##      into the neighboring room.
##   3. Codex's exact reproduction: a player placed at (600, 120) inside
##      Records Room and moved by (0, 80) now collides and does not end up
##      below the room's bottom edge (y=144).
##
## Run headless (from client/):
##   godot --headless --script tests/test_T0328_overview_collision.gd
## Exit 0 = PASS, exit 1 = FAIL.

const SceneScript := preload("res://scenes/signal_tower_overview.gd")

const ALL_SEVEN: Array[String] = [
	"signal_tower.ground_relay",
	"signal_tower.records_room",
	"signal_tower.power_substation",
	"signal_tower.equipment_floor",
	"signal_tower.storage_cache",
	"signal_tower.antenna_shaft",
	"signal_tower.broadcast_deck",
]

const RECORDS_ROOM: String = "signal_tower.records_room"

## How far past a solid wall segment to aim a crossing attempt — comfortably
## more than one tile of wall thickness, so an uncollided player would
## clearly end up outside the room.
const CROSS_DISTANCE_PX: float = 48.0

## How far inside a room's boundary (or an opening's center) to place the
## player before a crossing attempt, clear of the wall tile itself.
const INSET_PX: float = 24.0

var _inst: Node2D
var _layout: RefCounted
var _player: CharacterBody2D


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	var failures: Array[String] = []

	_inst = SceneScript.new()
	root.add_child(_inst)
	await physics_frame
	await physics_frame

	_layout = _inst.get_layout()
	_player = _inst.get_player()
	if _layout == null or _player == null:
		failures.append("setup: scene did not build a layout/player")
		_finish(failures)
		return

	_player.set_physics_process(false)

	failures += _test_every_solid_segment_blocks_crossing()
	failures += _test_every_connection_allows_crossing()
	failures += _test_codex_records_room_bottom_escape_repro()

	_finish(failures)


func _finish(failures: Array[String]) -> void:
	if _inst != null:
		_inst.queue_free()

	if failures.is_empty():
		print("T-0328 PASS: overview collision enclosure verified (3 groups)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0328 FAIL: " + f)
		quit(1)


## Attempts to cross every kept (non-opening) wall segment on every side of
## every room and asserts each attempt collides — the enclosure must hold on
## every wall, not just the sides that already had colliders before this fix.
func _test_every_solid_segment_blocks_crossing() -> Array[String]:
	var failures: Array[String] = []
	var openings: Dictionary = _inst._compute_openings(_layout)

	for tag: String in ALL_SEVEN:
		var size: Vector2i = _layout.get_size_tiles(tag)
		var origin_px: Vector2 = _layout.get_rect_px(tag).position

		for side: String in ["top", "bottom", "left", "right"]:
			var length: int = size.x if (side == "top" or side == "bottom") else size.y
			var kept: Array = _inst._kept_segments(length, openings[tag][side])

			for seg: Array in kept:
				var mid_tile: float = (seg[0] + seg[1]) / 2.0
				var start: Vector2
				var motion: Vector2
				match side:
					"top":
						start = origin_px + Vector2(mid_tile * 16.0, INSET_PX)
						motion = Vector2(0.0, -CROSS_DISTANCE_PX)
					"bottom":
						start = origin_px + Vector2(mid_tile * 16.0, size.y * 16.0 - INSET_PX)
						motion = Vector2(0.0, CROSS_DISTANCE_PX)
					"left":
						start = origin_px + Vector2(INSET_PX, mid_tile * 16.0)
						motion = Vector2(-CROSS_DISTANCE_PX, 0.0)
					"right":
						start = origin_px + Vector2(size.x * 16.0 - INSET_PX, mid_tile * 16.0)
						motion = Vector2(CROSS_DISTANCE_PX, 0.0)

				_player.position = start
				var collision: KinematicCollision2D = _player.move_and_collide(motion)
				if collision == null:
					failures.append(
						(
							"solid_segment: %s %s segment %s did not block crossing "
							+ "(start=%s, motion=%s)"
						) % [tag, side, str(seg), str(start), str(motion)]
					)

	return failures


## Traverses every declared door/ladder connection and asserts the player
## passes through cleanly — connectivity must remain intact now that the
## bottom boundary is enclosed.
func _test_every_connection_allows_crossing() -> Array[String]:
	var failures: Array[String] = []

	for rec: Dictionary in _inst.get_connector_records():
		var marker: Node2D = rec["node"]
		var center: Vector2 = marker.global_position
		var start: Vector2
		var motion: Vector2
		if rec["type"] == "door":
			start = center + Vector2(-INSET_PX, 0.0)
			motion = Vector2(CROSS_DISTANCE_PX, 0.0)
		else:
			start = center + Vector2(0.0, -INSET_PX)
			motion = Vector2(0.0, CROSS_DISTANCE_PX)

		_player.position = start
		var collision: KinematicCollision2D = _player.move_and_collide(motion)
		if collision != null:
			failures.append(
				(
					"connection_open: %s -> %s (%s) blocked at an authored opening "
					+ "(start=%s, motion=%s)"
				) % [rec["from"], rec["to"], rec["type"], str(start), str(motion)]
			)

	return failures


## Codex's exact reproduction (repro_room_escape.gd from the 2026-09-11 PR
## review): before this fix, a player at (600, 120) inside Records Room
## moved by (0, 80) escaped through the open floor with no collision,
## ending at (600, 200) — well below the room's bottom edge (y=144). It
## must now collide and stay at or above y=144.
func _test_codex_records_room_bottom_escape_repro() -> Array[String]:
	var failures: Array[String] = []

	var records_rect: Rect2 = _layout.get_rect_px(RECORDS_ROOM)
	if not records_rect.has_point(Vector2(600, 120)):
		failures.append(
			"repro_setup: (600, 120) is expected to be inside Records Room, rect is %s"
			% str(records_rect)
		)

	_player.position = Vector2(600, 120)
	var collision: KinematicCollision2D = _player.move_and_collide(Vector2(0, 80))

	if collision == null:
		failures.append("repro: expected a collision moving (0, 80) from (600, 120), got none")
	if _player.position.y > 144.0:
		failures.append(
			"repro: player ended at y=%f, must not go below Records Room's bottom edge y=144"
			% _player.position.y
		)

	return failures
