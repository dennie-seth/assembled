extends SceneTree
## T-0403: four bugfixes against the merged #403 side-on Signal Tower level.
##
##   1. Spawn/camera must start at the BOTTOM of the tower (entry_room), not
##      the top — the authored layout's origins put entry_room at world y 0
##      today; this flips the mapping so entry_room ends up at the greatest
##      world y and broadcast_deck (the tear room) at the least.
##   2. Every door must have a VISIBLE drawable node over its opening.
##   3. Every ladder must have the same, in a colour distinct from doors.
##   4. Walking onto a ladder tile must not glue the player to it — only an
##      explicit E press climbs; walking must move them off it freely.
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless \
##       --script tests/test_T0403_signal_tower_level_sideon_bugfixes.gd
## Exit 0 = PASS, exit 1 = FAIL.

const LevelScript := preload("res://scripts/signal_tower_level_sideon.gd")
const RoomLayoutScript := preload("res://signal_tower/room_layout.gd")
const DEFAULT_LAYOUT_PATH: String = "res://signal_tower/layouts/signal_tower_v1.json"

const GROUND_RELAY: String = "signal_tower.ground_relay"
const RECORDS_ROOM: String = "signal_tower.records_room"
const POWER_SUBSTATION: String = "signal_tower.power_substation"
const EQUIPMENT_FLOOR: String = "signal_tower.equipment_floor"
const STORAGE_CACHE: String = "signal_tower.storage_cache"
const ANTENNA_SHAFT: String = "signal_tower.antenna_shaft"
const BROADCAST_DECK: String = "signal_tower.broadcast_deck"

const ALL_SEVEN: Array[String] = [
	GROUND_RELAY, RECORDS_ROOM, POWER_SUBSTATION, EQUIPMENT_FLOOR,
	STORAGE_CACHE, ANTENNA_SHAFT, BROADCAST_DECK,
]

const MAX_WALK_STEPS: int = 800

var _failures: Array[String] = []


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	_failures += await _test_entry_room_at_world_bottom_tear_at_top()
	_failures += await _test_room_world_rects_match_layout_size()
	_failures += await _test_spawn_and_camera_at_frame_one()
	_failures += await _test_bottom_room_derived_not_hardcoded()

	_failures += await _test_every_door_has_visible_block()
	_failures += await _test_every_ladder_has_visible_block()
	_failures += await _test_door_and_ladder_colours_distinct()

	_failures += await _test_walking_onto_ladder_does_not_glue()
	_failures += await _test_walking_onto_ladder_from_other_side_does_not_glue()
	_failures += await _test_e_press_on_ladder_still_transitions()

	_failures += await _test_antenna_shaft_two_ladders_distinct_visuals()
	_failures += await _test_room_with_door_and_ladder_both_visible()
	_failures += await _test_no_two_connector_triggers_overlap_in_same_room()

	_finish()


func _finish() -> void:
	if _failures.is_empty():
		print("T-0403 PASS: bottom spawn, visible door/ladder blocks, no ladder glue")
		quit(0)
	else:
		for f: String in _failures:
			printerr("T-0403 FAIL: " + f)
		quit(1)


## ── Helpers (mirrors test_T0390_signal_tower_level_sideon.gd) ───────────────

func _build_detached_instance(failures: Array[String]) -> Node2D:
	var inst: Node2D = LevelScript.new()
	inst.build_level()
	if inst.get_layout() == null:
		failures.append("build_instance: build_level() did not produce a loaded RoomLayout")
	return inst


func _free_detached_instance(inst: Node2D) -> void:
	if inst != null:
		inst.free()


func _build_live_instance(failures: Array[String]) -> Node2D:
	var inst: Node2D = LevelScript.new()
	inst.set_physics_process(false)
	root.add_child(inst)
	inst.build_level()
	await physics_frame
	if inst.get_layout() == null:
		failures.append("build_instance: build_level() did not produce a loaded RoomLayout")
	return inst


func _free_instance(inst: Node2D) -> void:
	if inst != null:
		inst.queue_free()


func _walk_into_trigger(
	level: Node2D, player: CharacterBody2D, from_tag: String, to_tag: String, max_steps: int
) -> bool:
	var area: Rect2 = level.get_trigger_area(from_tag, to_tag)
	var target_x: float = area.position.x + area.size.x * 0.5
	var direction: float = 1.0 if target_x >= player.position.x else -1.0
	player.apply_input(direction, true)

	var reached: bool = false
	for i in range(max_steps):
		await physics_frame
		if area.has_point(player.position):
			reached = true
			break
	player.apply_input(0.0, false)
	await physics_frame
	return reached


func _assert_on_screen(inst: Node2D, player: CharacterBody2D, failures: Array[String], context: String) -> void:
	var viewport: Viewport = player.get_viewport()
	if viewport == null:
		failures.append("%s: player has no viewport" % context)
		return

	var xform: Transform2D = viewport.get_canvas_transform()
	var visible_rect: Rect2 = viewport.get_visible_rect()

	var player_screen: Vector2 = xform * player.global_position
	if not visible_rect.has_point(player_screen):
		failures.append(
			"%s: player screen pos %s not inside visible rect %s"
			% [context, str(player_screen), str(visible_rect)]
		)

	var floor_screen: Vector2 = xform * Vector2(player.global_position.x, player.floor_y)
	if not visible_rect.has_point(floor_screen):
		failures.append(
			"%s: floor row screen pos %s not inside visible rect %s"
			% [context, str(floor_screen), str(visible_rect)]
		)


## ── Bug 1: spawn/camera at the bottom of the world ──────────────────────────

func _test_entry_room_at_world_bottom_tear_at_top() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_detached_instance(inst)
		return failures

	var entry_rect: Rect2 = inst.get_room_world_rect(layout.entry_room)
	var tear_rect: Rect2 = inst.get_room_world_rect(layout.tear_room)

	for tag: String in ALL_SEVEN:
		var rect: Rect2 = inst.get_room_world_rect(tag)
		if rect.position.y > entry_rect.position.y:
			failures.append(
				"bottom: entry_room '%s' (y=%.1f) must have the GREATEST world y, but '%s' (y=%.1f) is lower"
				% [layout.entry_room, entry_rect.position.y, tag, rect.position.y]
			)
		if rect.position.y < tear_rect.position.y:
			failures.append(
				"top: tear_room '%s' (y=%.1f) must have the LEAST world y, but '%s' (y=%.1f) is higher"
				% [layout.tear_room, tear_rect.position.y, tag, rect.position.y]
			)

	_free_detached_instance(inst)
	return failures


func _test_room_world_rects_match_layout_size() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_detached_instance(inst)
		return failures

	for tag: String in ALL_SEVEN:
		var world_rect: Rect2 = inst.get_room_world_rect(tag)
		var authored_rect: Rect2 = layout.get_rect_px(tag)
		if not world_rect.size.is_equal_approx(authored_rect.size):
			failures.append(
				"size_match: '%s' world rect size %s must equal layout.get_rect_px() size %s"
				% [tag, str(world_rect.size), str(authored_rect.size)]
			)

	_free_detached_instance(inst)
	return failures


func _test_spawn_and_camera_at_frame_one() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	if player == null:
		failures.append("spawn_frame_one: no player built")
		_free_instance(inst)
		return failures

	if inst.get_current_room_tag() != layout.entry_room:
		failures.append(
			"spawn_frame_one: current room must be entry_room '%s', got '%s'"
			% [layout.entry_room, inst.get_current_room_tag()]
		)

	var entry_rect: Rect2 = inst.get_room_world_rect(layout.entry_room)
	if not entry_rect.has_point(player.position):
		failures.append(
			"spawn_frame_one: player position %s must be inside entry room's world rect %s"
			% [str(player.position), str(entry_rect)]
		)

	_assert_on_screen(inst, player, failures, "spawn_frame_one")

	_free_instance(inst)
	return failures


## Proves the bottom-room resolution is derived from the layout, not
## hardcoded to "ground_relay" — an alternate layout, authored with the SAME
## connectivity graph but different origins/heights, must still put its own
## entry_room at the greatest world y with no code edit.
func _test_bottom_room_derived_not_hardcoded() -> Array[String]:
	var failures: Array[String] = []

	var text: String = FileAccess.get_file_as_string(DEFAULT_LAYOUT_PATH)
	var data: Dictionary = JSON.parse_string(text) as Dictionary
	## Double ground_relay's height and shift every OTHER room down by the
	## same delta — changes which room has the tallest/greatest authored
	## span without touching connectivity or any room's position RELATIVE to
	## its neighbours. The shift matters: the world-y mapping reflects each
	## room about its own authored END row (see _compute_world_rects() in
	## signal_tower_level_sideon.gd), so two rooms that originally shared an
	## end row (ground_relay and records_room both end at row 9, per the
	## floor-row door anchor, finding 5) must still share one after
	## ground_relay grows — growing ground_relay alone, with every other
	## room left in place, would break that shared floor and isn't the
	## "same connectivity graph, different origins/heights" this test means
	## to exercise.
	var rooms: Array = data["rooms"]
	var ground_relay_room: Dictionary = rooms[0]
	var old_h: int = int((ground_relay_room["size"] as Dictionary)["h"])
	var new_h: int = 18
	(ground_relay_room["size"] as Dictionary)["h"] = new_h  # ground_relay: 9 -> 18
	var delta: int = new_h - old_h
	for i in range(1, rooms.size()):
		var origin: Dictionary = (rooms[i] as Dictionary)["origin"]
		origin["y"] = int(origin["y"]) + delta

	var tmp_path: String = "user://test_T0403_alt_layout.json"
	var f := FileAccess.open(tmp_path, FileAccess.WRITE)
	f.store_string(JSON.stringify(data))
	f.close()

	var inst := LevelScript.new()
	inst.build_level(tmp_path)
	if inst.get_layout() == null:
		failures.append("bottom_derived: alt layout failed to load — %s" % inst.get_load_error())
		inst.free()
		DirAccess.remove_absolute(ProjectSettings.globalize_path(tmp_path))
		return failures

	var layout: RefCounted = inst.get_layout()
	var entry_rect: Rect2 = inst.get_room_world_rect(layout.entry_room)
	for tag: String in ALL_SEVEN:
		var rect: Rect2 = inst.get_room_world_rect(tag)
		if rect.position.y > entry_rect.position.y:
			failures.append(
				"bottom_derived: with an alt layout, entry_room must still have the greatest world y "
				+ "(tag '%s' at y=%.1f is lower than entry y=%.1f)" % [tag, rect.position.y, entry_rect.position.y]
			)

	inst.free()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(tmp_path))
	return failures


## ── Bugs 2/3: visible door/ladder blocks ─────────────────────────────────────

func _test_every_door_has_visible_block() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	for conn: Dictionary in inst.get_connector_records():
		if conn["type"] != "door":
			continue
		_assert_connector_visual(inst, conn["from"], conn["to"], failures)

	_free_instance(inst)
	return failures


func _test_every_ladder_has_visible_block() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	for conn: Dictionary in inst.get_connector_records():
		if conn["type"] != "ladder":
			continue
		_assert_connector_visual(inst, conn["from"], conn["to"], failures)

	_free_instance(inst)
	return failures


func _assert_connector_visual(inst: Node2D, from_tag: String, to_tag: String, failures: Array[String]) -> void:
	var visual: CanvasItem = inst.get_connector_visual(from_tag, to_tag)
	if visual == null:
		failures.append("visible_block: no visual node registered for %s -> %s" % [from_tag, to_tag])
		return
	if visual is CollisionShape2D or visual is Area2D or visual is StaticBody2D:
		failures.append(
			"visible_block: %s -> %s visual must be a drawable CanvasItem, not %s"
			% [from_tag, to_tag, visual.get_class()]
		)
	if not visual.is_visible_in_tree():
		failures.append("visible_block: %s -> %s visual must be visible_in_tree()" % [from_tag, to_tag])
	var size: Vector2 = visual.get("size") if visual.get("size") != null else Vector2.ZERO
	if size.x <= 0.0 or size.y <= 0.0:
		failures.append("visible_block: %s -> %s visual must have non-zero size, got %s" % [from_tag, to_tag, str(size)])
	var color: Color = visual.get("color")
	if color.a <= 0.0:
		failures.append("visible_block: %s -> %s visual must be non-transparent" % [from_tag, to_tag])


func _test_door_and_ladder_colours_distinct() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var door_color: Color = Color.WHITE
	var ladder_color: Color = Color.BLACK
	var found_door: bool = false
	var found_ladder: bool = false

	for conn: Dictionary in inst.get_connector_records():
		var visual: CanvasItem = inst.get_connector_visual(conn["from"], conn["to"])
		if visual == null:
			continue
		var color: Color = visual.get("color")
		if conn["type"] == "door" and not found_door:
			door_color = color
			found_door = true
		elif conn["type"] == "ladder" and not found_ladder:
			ladder_color = color
			found_ladder = true

	if not found_door or not found_ladder:
		failures.append("distinct_colours: expected at least one door and one ladder visual")
	elif door_color.is_equal_approx(ladder_color):
		failures.append(
			"distinct_colours: door colour %s must differ from ladder colour %s"
			% [str(door_color), str(ladder_color)]
		)

	## Every connector's own visual must match its declared type's colour —
	## not just "some door differs from some ladder".
	for conn: Dictionary in inst.get_connector_records():
		var visual: CanvasItem = inst.get_connector_visual(conn["from"], conn["to"])
		if visual == null:
			continue
		var color: Color = visual.get("color")
		var expected: Color = door_color if conn["type"] == "door" else ladder_color
		if not color.is_equal_approx(expected):
			failures.append(
				"distinct_colours: %s -> %s (%s) visual colour %s does not match its type's colour %s"
				% [conn["from"], conn["to"], conn["type"], str(color), str(expected)]
			)

	_free_instance(inst)
	return failures


## ── Bug 4: ladders must not glue the player ──────────────────────────────────

func _test_walking_onto_ladder_does_not_glue() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var reached: bool = await _walk_into_trigger(inst, player, GROUND_RELAY, POWER_SUBSTATION, MAX_WALK_STEPS)
	if not reached:
		failures.append("no_glue: failed to walk onto the ground_relay -> power_substation ladder")
		_free_instance(inst)
		return failures

	var on_ladder_pos: Vector2 = player.position
	var room_before: String = inst.get_current_room_tag()
	var changes_before: int = inst.get_room_change_count()

	## Keep walking past the ladder — no E press. The player must be free to
	## leave the trigger area under their own walking input; nothing may pin
	## position.x or auto-transition them. Leave TOWARD the room's own centre
	## (the same convention test_T0390_signal_tower_level_sideon.gd's prompt
	## test uses), not by an area-position sign guess: this specific ladder's
	## opening sits flush against ground_relay's own left wall (T-0328's
	## committed layout — see test_T0390's
	## _test_interaction_prompt_shows_and_hides comment), so a leave direction
	## that ignores the room's actual geometry can walk the player straight
	## into that wall a few px later and never clear the trigger — a false
	## "glue" reading that's really just an unrelated wall collision.
	var area: Rect2 = inst.get_trigger_area(GROUND_RELAY, POWER_SUBSTATION)
	var room_rect: Rect2 = inst.get_room_world_rect(GROUND_RELAY)
	var center_x: float = room_rect.position.x + room_rect.size.x * 0.5
	var leave_direction: float = 1.0 if center_x >= player.position.x else -1.0
	player.apply_input(leave_direction, true)
	var moved_off: bool = false
	for i in range(200):
		await physics_frame
		if not area.has_point(player.position):
			moved_off = true
			break
	player.apply_input(0.0, false)
	await physics_frame

	if not moved_off:
		failures.append("no_glue: player never left the ladder trigger area while walking — position stuck at %s" % str(player.position))
	if is_equal_approx(player.position.x, on_ladder_pos.x):
		failures.append("no_glue: player.position.x did not change while walking off the ladder")
	if inst.get_current_room_tag() != room_before or inst.get_room_change_count() != changes_before:
		failures.append("no_glue: walking off a ladder must not auto-transition rooms")

	_free_instance(inst)
	return failures


## Edge case: walking onto the ladder from the OPPOSITE side (approaching
## from the room's far wall rather than straight from spawn) must free the
## player the same way.
func _test_walking_onto_ladder_from_other_side_does_not_glue() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var area: Rect2 = inst.get_trigger_area(GROUND_RELAY, POWER_SUBSTATION)

	## Walk past the trigger first (to the far side), then approach it from
	## the opposite direction than _test_walking_onto_ladder_does_not_glue.
	player.apply_input(1.0, true)
	for i in range(400):
		await physics_frame
		if player.position.x > area.position.x + area.size.x + 40.0:
			break
	player.apply_input(0.0, false)
	await physics_frame

	player.apply_input(-1.0, true)
	var reached: bool = false
	for i in range(MAX_WALK_STEPS):
		await physics_frame
		if area.has_point(player.position):
			reached = true
			break
	if not reached:
		failures.append("no_glue_other_side: failed to walk onto the ladder from the opposite side")
		_free_instance(inst)
		return failures

	## Leave toward the room's own centre — same reasoning as
	## _test_walking_onto_ladder_does_not_glue(): this ladder's opening sits
	## flush against ground_relay's left wall, so "continue in the same
	## (leftward) direction" would drive the player straight into that wall
	## a few px later, never clearing the trigger, regardless of whether
	## ladder-glue is fixed. Leaving toward the centre isolates the
	## assertion this edge case actually cares about — that arriving from
	## the opposite side doesn't change whether walking off is free.
	var room_rect: Rect2 = inst.get_room_world_rect(GROUND_RELAY)
	var center_x: float = room_rect.position.x + room_rect.size.x * 0.5
	var leave_direction: float = 1.0 if center_x >= player.position.x else -1.0
	player.apply_input(leave_direction, true)
	var moved_off: bool = false
	for i in range(200):
		await physics_frame
		if not area.has_point(player.position):
			moved_off = true
			break
	player.apply_input(0.0, false)
	await physics_frame

	if not moved_off:
		failures.append("no_glue_other_side: player stuck on ladder approached from the opposite side")

	_free_instance(inst)
	return failures


func _test_e_press_on_ladder_still_transitions() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var reached: bool = await _walk_into_trigger(inst, player, GROUND_RELAY, POWER_SUBSTATION, MAX_WALK_STEPS)
	if not reached:
		failures.append("e_still_climbs: failed to reach the ladder trigger")
		_free_instance(inst)
		return failures

	var before_count: int = inst.get_room_change_count()
	player.interact_pressed.emit()
	await physics_frame

	if inst.get_room_change_count() != before_count + 1:
		failures.append("e_still_climbs: pressing E on a ladder must still climb exactly once")
	if inst.get_current_room_tag() != POWER_SUBSTATION:
		failures.append("e_still_climbs: expected to be in power_substation, got '%s'" % inst.get_current_room_tag())

	_free_instance(inst)
	return failures


## ── Edge cases ────────────────────────────────────────────────────────────────

## antenna_shaft hosts two ladders back-to-back (to equipment_floor and to
## broadcast_deck) — both must have their own distinct visible blocks that
## don't sit on top of each other.
func _test_antenna_shaft_two_ladders_distinct_visuals() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var visual_up: CanvasItem = inst.get_connector_visual(ANTENNA_SHAFT, EQUIPMENT_FLOOR)
	var visual_down: CanvasItem = inst.get_connector_visual(ANTENNA_SHAFT, BROADCAST_DECK)
	if visual_up == null or visual_down == null:
		failures.append("antenna_shaft_ladders: both ladder visuals inside antenna_shaft must exist")
		_free_instance(inst)
		return failures

	var rect_up := Rect2(visual_up.position, visual_up.get("size"))
	var rect_down := Rect2(visual_down.position, visual_down.get("size"))
	if rect_up.intersects(rect_down):
		failures.append(
			"antenna_shaft_ladders: the two ladder visuals must not overlap — %s vs %s"
			% [str(rect_up), str(rect_down)]
		)

	_free_instance(inst)
	return failures


## equipment_floor has both a door (to storage_cache) and a ladder (to
## antenna_shaft) — both must be visible and correctly coloured for their
## own type in the same room.
func _test_room_with_door_and_ladder_both_visible() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var door_visual: CanvasItem = inst.get_connector_visual(EQUIPMENT_FLOOR, STORAGE_CACHE)
	var ladder_visual: CanvasItem = inst.get_connector_visual(EQUIPMENT_FLOOR, ANTENNA_SHAFT)
	if door_visual == null or ladder_visual == null:
		failures.append("door_and_ladder_same_room: both the door and ladder visuals in equipment_floor must exist")
		_free_instance(inst)
		return failures

	var door_color: Color = door_visual.get("color")
	var ladder_color: Color = ladder_visual.get("color")
	if door_color.is_equal_approx(ladder_color):
		failures.append("door_and_ladder_same_room: door and ladder visuals in the same room must differ in colour")

	_free_instance(inst)
	return failures


## No two connector trigger areas that share a room may overlap — otherwise
## pressing E while standing in the overlap would be ambiguous. Proves the
## edge case can't structurally arise rather than special-casing a resolution.
func _test_no_two_connector_triggers_overlap_in_same_room() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	if inst.get_layout() == null:
		_free_detached_instance(inst)
		return failures

	var records: Array = inst.get_connector_records()
	for i: int in range(records.size()):
		for j: int in range(i + 1, records.size()):
			var a: Dictionary = records[i]
			var b: Dictionary = records[j]
			for room_pair: Array in [[a["from"], b["from"]], [a["from"], b["to"]], [a["to"], b["from"]], [a["to"], b["to"]]]:
				if room_pair[0] != room_pair[1]:
					continue
				var shared_room: String = room_pair[0]
				var area_a: Rect2 = inst.get_trigger_area(shared_room, a["to"] if a["from"] == shared_room else a["from"])
				var area_b: Rect2 = inst.get_trigger_area(shared_room, b["to"] if b["from"] == shared_room else b["from"])
				if area_a.intersects(area_b):
					failures.append(
						"no_overlap: connectors %s<->%s and %s<->%s both sit in '%s' and overlap"
						% [a["from"], a["to"], b["from"], b["to"], shared_room]
					)

	_free_detached_instance(inst)
	return failures
