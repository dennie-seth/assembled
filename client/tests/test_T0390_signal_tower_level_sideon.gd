extends SceneTree
## T-0390: Assemble the full side-on Signal Tower level — all seven rooms
## block-outed in order, traversable by the player prefab.
##
## Wires already-merged pieces (RoomLayout/T-0328, SignalTowerChainSideon/
## T-0194, PlayerController/T-0188, FirstRunController/T-0120) into the real
## playable level at res://scenes/signal_tower_level_sideon.tscn. See the
## card body for the full finding list this test enforces; in short:
##   - PlayerController is client/player_controller.gd (T-0188), NOT
##     client/scripts/player_controller.gd (the free-2D T-0184 controller).
##   - Floor-plane lock only — no gravity, no jump, no in-room vertical travel.
##   - Door openings are cut at the shared floor row of both rooms, not the
##     vertical midpoint of their overlap.
##   - Ladder openings must never register as drop_gaps.
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless \
##       --script tests/test_T0390_signal_tower_level_sideon.gd
## Exit 0 = PASS, exit 1 = FAIL.

const LevelScript := preload("res://scripts/signal_tower_level_sideon.gd")
const ChainSideonScript := preload("res://signal_tower/signal_tower_chain_sideon.gd")
const PlayerControllerScript := preload("res://player_controller.gd")
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

## Floor rows named explicitly by the card's finding 5.
const GROUND_RELAY_RECORDS_ROOM_FLOOR_ROW: int = 8
const EQUIPMENT_FLOOR_STORAGE_CACHE_FLOOR_ROW: int = 28

## Generous step ceiling for a running walk across the widest authored room
## (ground_relay, 30 tiles = 480 px) — physics frames, not wall-clock.
const MAX_WALK_STEPS: int = 800

var _inst: Node2D
var _failures: Array[String] = []


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	_failures += _test_scene_and_script_files_exist()
	_failures += _test_no_wrong_player_script_reference()
	_failures += _test_no_debug_warp_method()
	_failures += _test_no_gameplay_constants_declared()
	_failures += _test_no_entity_or_prop_wiring()
	_failures += _test_no_grace_window_code()
	_failures += _test_room_connectors_not_fed()

	_failures += await _test_seven_rooms_built_matching_layout()
	_failures += await _test_grey_box_only()
	_failures += await _test_connector_set_matches_layout()
	_failures += await _test_door_openings_at_floor_row()
	_failures += await _test_no_ladder_in_drop_gaps()
	_failures += await _test_player_is_correct_prefab()
	_failures += await _test_spawn_in_ground_relay_clear_of_connectors()
	_failures += await _test_floor_plane_lock_holds()
	_failures += await _test_wall_segments_all_positive_length()
	_failures += await _test_narrow_and_wide_rooms_closed()
	_failures += await _test_malformed_layout_missing_file()
	_failures += await _test_malformed_layout_missing_origin_size()
	_failures += await _test_layout_unknown_room_tag_connection()
	_failures += await _test_layout_invalid_connection_type()
	_failures += await _test_overlap_alone_does_not_transition()
	_failures += await _test_interact_outside_connector_does_nothing()
	_failures += await _test_interact_inside_connector_transitions_once()
	_failures += await _test_interaction_prompt_visibility()
	_failures += await _test_wrong_side_ladder_resolves_correctly()
	_failures += await _test_dead_end_branches_isolated()
	_failures += await _test_chain_terminus_no_onward_connector()
	_failures += await _test_player_blocked_by_side_wall()
	_failures += await _test_full_critical_path_traversal_and_branches_and_reverse()

	_finish()


func _finish() -> void:
	if _inst != null:
		_inst.queue_free()

	if _failures.is_empty():
		print("T-0390 PASS: signal tower side-on level assembled and traversable")
		quit(0)
	else:
		for f: String in _failures:
			printerr("T-0390 FAIL: " + f)
		quit(1)


## ── Helpers ────────────────────────────────────────────────────────────────

## Builds a fresh level instance and calls build_level() directly, WITHOUT
## adding it to the live tree — _ready() (and the FirstRunController /
## NoteClient it constructs) never fires. Every check that only inspects the
## built node tree (geometry, connectors, spawn point, source guards) uses
## this; the boot contract itself is covered separately by
## tests/test_main_scene_boot.gd, so there is no need to pay the cost of a
## live FirstRunController here — creating dozens of them in one process
## exhausted engine resources during development of this test file.
func _build_detached_instance(failures: Array[String]) -> Node2D:
	var inst: Node2D = LevelScript.new()
	inst.build_level()

	if inst.get_layout() == null:
		failures.append("build_instance: build_level() did not produce a loaded RoomLayout")
	return inst


func _free_detached_instance(inst: Node2D) -> void:
	if inst != null:
		inst.free()


## Builds a fresh, live-tree level instance for the handful of tests that
## genuinely need real physics stepping (move_and_slide, room_transition
## detection) — its own automatic Input polling is disabled since tests
## drive PlayerController.apply_input() directly (the level's own
## _physics_process(), which reads the real Input singleton, would otherwise
## overwrite whatever direction a test just set before the next physics
## frame runs). build_level() is called directly rather than waiting on
## _ready()'s first-run gate — a redundant FirstRunController from _ready()
## still gets constructed (add_child() always fires it), left inert and
## ignored; the boot contract itself is covered by
## tests/test_main_scene_boot.gd. Reserve this for tests that cannot work
## against a detached instance — see _build_detached_instance().
func _build_live_instance(failures: Array[String]) -> Node2D:
	var inst: Node2D = LevelScript.new()
	inst.set_physics_process(false)
	root.add_child(inst)
	inst.build_level()
	await physics_frame
	await physics_frame

	if inst.get_layout() == null:
		failures.append("build_instance: build_level() did not produce a loaded RoomLayout")
	return inst


func _free_instance(inst: Node2D) -> void:
	if inst != null:
		inst.queue_free()


## The union, in world space, of every collider rect built directly under
## [param room_node] — used to verify a room's ACTUAL built extent (not just
## its container node's position) against RoomLayout.get_rect_px(), since a
## room built with a missing wall or floor would still have the right
## container position while covering the wrong area.
func _room_collider_bounds(room_node: Node2D) -> Rect2:
	var result: Rect2 = Rect2()
	var first: bool = true
	for child: Node in room_node.get_children():
		if not (child is StaticBody2D):
			continue
		for shape_node: Node in child.get_children():
			if shape_node is CollisionShape2D:
				var box: RectangleShape2D = (shape_node as CollisionShape2D).shape as RectangleShape2D
				if box == null:
					continue
				var world_pos: Vector2 = room_node.position + child.position
				var r := Rect2(world_pos, box.size)
				if first:
					result = r
					first = false
				else:
					result = result.merge(r)
	return result


## Walks the player toward the trigger connecting from_tag -> to_tag until the
## player's own position actually enters that trigger area (or max_steps is
## exhausted). Drives movement only through apply_input() + physics-frame
## stepping — no direct position assignment. Doors and ladders are press-E
## interactables (T-0390 fix round 2): standing in the area alone must never
## change rooms, so this helper stops at "inside the area", not "room
## changed" — callers that want the transition itself call
## _walk_to_room_via_interact() below.
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


## Walks into the from_tag -> to_tag trigger (see _walk_into_trigger()), then
## presses E by emitting PlayerController.interact_pressed directly — the
## acceptance criterion names this as an accepted stand-in for a synthetic
## KEY_E InputEvent. Returns true only if the level's current room actually
## became to_tag afterward.
func _walk_to_room_via_interact(
	level: Node2D, player: CharacterBody2D, from_tag: String, to_tag: String, max_steps: int
) -> bool:
	var reached: bool = await _walk_into_trigger(level, player, from_tag, to_tag, max_steps)
	if not reached:
		return false
	player.interact_pressed.emit()
	await physics_frame
	return level.get_current_room_tag() == to_tag


## ── Static source guards (no live tree needed) ──────────────────────────────

func _read_level_source() -> String:
	var f := FileAccess.open("res://scripts/signal_tower_level_sideon.gd", FileAccess.READ)
	if f == null:
		return ""
	var text: String = f.get_as_text()
	f.close()
	return text


func _test_scene_and_script_files_exist() -> Array[String]:
	var failures: Array[String] = []

	if not FileAccess.file_exists("res://scenes/signal_tower_level_sideon.tscn"):
		failures.append("files_exist: res://scenes/signal_tower_level_sideon.tscn must exist")
	if not FileAccess.file_exists("res://scripts/signal_tower_level_sideon.gd"):
		failures.append("files_exist: res://scripts/signal_tower_level_sideon.gd must exist")

	var packed: PackedScene = load("res://scenes/signal_tower_level_sideon.tscn") as PackedScene
	if packed == null:
		failures.append("files_exist: scene must load as a valid PackedScene")
		return failures
	var inst: Node = packed.instantiate()
	if inst == null:
		failures.append("files_exist: instantiate() must return a non-null Node")
		return failures
	inst.free()

	return failures


func _test_no_wrong_player_script_reference() -> Array[String]:
	var failures: Array[String] = []
	var text: String = _read_level_source()
	if text == "":
		failures.append("wrong_player_script: could not read level script source")
		return failures

	## Only code lines matter here — the script's own docstring explains, in
	## prose, why the free-2D controller must NOT be used, which necessarily
	## mentions its path.
	for line: String in text.split("\n"):
		var stripped: String = line.strip_edges()
		if stripped.begins_with("#"):
			continue
		if stripped.findn("res://scripts/player_controller.gd") != -1:
			failures.append(
				"wrong_player_script: level script must not preload the free-2D "
				+ "res://scripts/player_controller.gd (T-0184) — use res://player_controller.gd "
				+ "(T-0188, class_name PlayerController) per finding 1"
			)
			break

	return failures


func _test_no_debug_warp_method() -> Array[String]:
	var failures: Array[String] = []
	var text: String = _read_level_source()
	if text == "":
		failures.append("no_debug_warp: could not read level script source")
		return failures

	for needle: String in ["func set_current_room(", "func warp_to(", "func teleport_to("]:
		if text.find(needle) != -1:
			failures.append(
				"no_debug_warp: level script must not expose an arbitrary-room warp method (found '%s')"
				% needle
			)

	return failures


func _test_no_gameplay_constants_declared() -> Array[String]:
	var failures: Array[String] = []
	var text: String = _read_level_source()
	if text == "":
		failures.append("no_gameplay_constants: could not read level script source")
		return failures

	for line: String in text.split("\n"):
		var stripped: String = line.strip_edges()
		if stripped.begins_with("#") or stripped.begins_with("##"):
			continue
		if stripped.findn("GRAVITY") != -1:
			failures.append("no_gameplay_constants: found GRAVITY reference: %s" % stripped)
		if stripped.findn("jump") != -1:
			failures.append("no_gameplay_constants: found jump reference: %s" % stripped)
		if stripped.find("velocity =") != -1 or stripped.find("velocity=") != -1:
			failures.append("no_gameplay_constants: found a direct velocity assignment: %s" % stripped)

	return failures


func _test_no_entity_or_prop_wiring() -> Array[String]:
	var failures: Array[String] = []
	var text: String = _read_level_source()
	if text == "":
		failures.append("no_entity_or_prop: could not read level script source")
		return failures

	for needle: String in [
		"cover_break", "hiding_spot", "item_anchor", "item_door",
		"chain_tear", "create_entity_controller",
	]:
		if text.findn(needle) != -1:
			failures.append(
				"no_entity_or_prop: level script must not reference '%s' — out of scope for this card"
				% needle
			)

	return failures


## Doors and ladders are press-E interactables (T-0390 fix round 2 design
## change): the earlier overlap-triggered design needed a ~0.5s just-used-
## connector suppression window to stop a ladder immediately re-firing on
## arrival. With no overlap firing at all, that window has nothing left to
## suppress and must be gone, not merely unused.
func _test_no_grace_window_code() -> Array[String]:
	var failures: Array[String] = []
	var text: String = _read_level_source()
	if text == "":
		failures.append("no_grace_window: could not read level script source")
		return failures

	for needle: String in [
		"_suppress", "grace_frames", "_apply_connector_suppression", "_on_grace_window_tick",
	]:
		if text.findn(needle) != -1:
			failures.append(
				"no_grace_window: level script must not contain grace/suppression code (found '%s')"
				% needle
			)

	return failures


## _player.room_connectors must stay empty — feeding it is what made
## PlayerController.update_state() emit room_transition on every overlapping
## physics frame, which is exactly the auto-transition behaviour fix round 2
## removes in favour of press-E.
func _test_room_connectors_not_fed() -> Array[String]:
	var failures: Array[String] = []
	var text: String = _read_level_source()
	if text == "":
		failures.append("room_connectors_not_fed: could not read level script source")
		return failures

	if text.findn("room_connectors.assign") != -1 or text.findn("room_connectors =") != -1:
		failures.append(
			"room_connectors_not_fed: level script must not feed _player.room_connectors — "
			+ "transitions happen only through interact_pressed (T-0390 fix round 2)"
		)

	return failures


## ── Geometry: seven rooms at authored positions ─────────────────────────────

func _test_seven_rooms_built_matching_layout() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_detached_instance(inst)
		return failures

	## Iterates the BUILT set, not the canonical tag list — a room built for a
	## tag outside the canonical seven must be caught, not silently ignored
	## because nothing asked about it by name (T-0390 fix round 1, criterion 2).
	var built_tags: Array = inst.get_built_room_tags()

	if built_tags.size() != 7:
		failures.append(
			"seven_rooms: expected exactly 7 built room containers, got %d" % built_tags.size()
		)
	for tag: String in built_tags:
		if not ALL_SEVEN.has(tag):
			failures.append("seven_rooms: unexpected room container built for '%s'" % tag)
	for tag: String in ALL_SEVEN:
		if not built_tags.has(tag):
			failures.append("seven_rooms: no room container built for '%s'" % tag)

	## Per room, the built extent (union of its collider rects) must equal
	## RoomLayout.get_rect_px() in BOTH position and size — a room missing a
	## wall or floor would still pass a position-only check (T-0390 fix round
	## 1, criterion 3).
	for tag: String in ALL_SEVEN:
		var room_node: Node2D = inst.get_room_node(tag)
		if room_node == null:
			continue
		var expected_rect: Rect2 = layout.get_rect_px(tag)
		var actual_rect: Rect2 = _room_collider_bounds(room_node)
		if not actual_rect.position.is_equal_approx(expected_rect.position) or not actual_rect.size.is_equal_approx(expected_rect.size):
			failures.append(
				"room_rect: '%s' built collider bounds %s, expected %s"
				% [tag, str(actual_rect), str(expected_rect)]
			)

	_free_detached_instance(inst)
	return failures


func _test_grey_box_only() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	if inst.get_layout() == null:
		_free_detached_instance(inst)
		return failures

	var text: String = _read_level_source()
	if text.findn("assets/final/") != -1:
		failures.append("grey_box: level script must not reference assets/final/")

	for tag: String in ALL_SEVEN:
		var room_node: Node2D = inst.get_room_node(tag)
		if room_node == null:
			continue
		_assert_no_textured_nodes(room_node, tag, failures)

	_free_detached_instance(inst)
	return failures


func _assert_no_textured_nodes(node: Node, tag: String, failures: Array[String]) -> void:
	for child: Node in node.get_children():
		if child is Sprite2D or child is AnimatedSprite2D or child is TextureRect:
			failures.append(
				"grey_box: room '%s' contains a textured node %s — grey-box only" % [tag, child.get_class()]
			)
		_assert_no_textured_nodes(child, tag, failures)


## ── Connectivity ─────────────────────────────────────────────────────────────

func _test_connector_set_matches_layout() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_detached_instance(inst)
		return failures

	var expected: Array = layout.get_connections()
	var built: Array = inst.get_connector_records()

	if built.size() != expected.size():
		failures.append(
			"connector_count: built %d connector records, layout declares %d connections"
			% [built.size(), expected.size()]
		)

	for conn: Dictionary in expected:
		var found: bool = false
		for rec: Dictionary in built:
			if rec["from"] == conn["from"] and rec["to"] == conn["to"] and rec["type"] == conn["type"]:
				found = true
				break
		if not found:
			failures.append(
				"connector_missing: no built record for %s -> %s (%s)"
				% [conn["from"], conn["to"], conn["type"]]
			)

	var mismatches: Array[String] = layout.find_connectivity_mismatches()
	if not mismatches.is_empty():
		failures.append("connectivity_mismatches: expected none, got %s" % ", ".join(mismatches))

	_free_detached_instance(inst)
	return failures


func _test_door_openings_at_floor_row() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_detached_instance(inst)
		return failures

	var tile_size: int = layout.tile_size_px

	var cases: Array = [
		[GROUND_RELAY, RECORDS_ROOM, GROUND_RELAY_RECORDS_ROOM_FLOOR_ROW],
		[EQUIPMENT_FLOOR, STORAGE_CACHE, EQUIPMENT_FLOOR_STORAGE_CACHE_FLOOR_ROW],
	]

	for c: Array in cases:
		var from_tag: String = c[0]
		var to_tag: String = c[1]
		var expected_row: int = c[2]

		var found_door: Dictionary = {}
		for conn: Dictionary in layout.get_connections():
			if conn["from"] == from_tag and conn["to"] == to_tag and conn["type"] == "door":
				found_door = conn
				break
		if found_door.is_empty():
			failures.append("door_floor_row: no door connection %s -> %s in layout" % [from_tag, to_tag])
			continue

		var geo: Dictionary = inst._door_geometry(found_door)
		var row0: int = int(geo["opening_y0_px"] / tile_size)
		var row1: int = int(geo["opening_y1_px"] / tile_size)
		if not (expected_row >= row0 and expected_row < row1):
			failures.append(
				"door_floor_row: %s -> %s opening rows [%d, %d) must contain floor row %d"
				% [from_tag, to_tag, row0, row1, expected_row]
			)

	_free_detached_instance(inst)
	return failures


func _test_no_ladder_in_drop_gaps() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	if inst.get_layout() == null:
		_free_detached_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	if player == null:
		failures.append("no_ladder_drop_gaps: no player built")
		_free_detached_instance(inst)
		return failures

	if not player.drop_gaps.is_empty():
		for conn: Dictionary in inst.get_connector_records():
			if conn["type"] != "ladder":
				continue
			var trig: Rect2 = inst.get_trigger_area(conn["from"], conn["to"])
			for gap: Rect2 in player.drop_gaps:
				if gap.intersects(trig):
					failures.append(
						"no_ladder_drop_gaps: drop_gaps entry overlaps ladder opening %s -> %s"
						% [conn["from"], conn["to"]]
					)

	_free_detached_instance(inst)
	return failures


## ── Player prefab ─────────────────────────────────────────────────────────

func _test_player_is_correct_prefab() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	if inst.get_layout() == null:
		_free_detached_instance(inst)
		return failures

	var player: Node = inst.get_node_or_null("Player")
	if player == null:
		failures.append("player_prefab: level root must have a direct child named 'Player'")
		_free_detached_instance(inst)
		return failures

	if player.get_script() != PlayerControllerScript:
		failures.append("player_prefab: 'Player' must be an instance of PlayerController (T-0188)")

	if inst.get_player() != player:
		failures.append("player_prefab: get_player() must return the same node as the 'Player' child")

	_free_detached_instance(inst)
	return failures


func _test_spawn_in_ground_relay_clear_of_connectors() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_detached_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	if player == null:
		failures.append("spawn: no player built")
		_free_detached_instance(inst)
		return failures

	var relay_rect: Rect2 = layout.get_rect_px(layout.entry_room)
	if not relay_rect.has_point(player.position):
		failures.append(
			"spawn: player position %s must be inside entry room rect %s"
			% [str(player.position), str(relay_rect)]
		)

	if layout.entry_room != inst.get_current_room_tag():
		failures.append(
			"spawn: current_room_tag must equal layout.entry_room ('%s'), got '%s'"
			% [layout.entry_room, inst.get_current_room_tag()]
		)

	## player.room_connectors stays empty by design (T-0390 fix round 2 —
	## transitions happen only through interact_pressed), so clearance is
	## checked against the level's own trigger areas for every connector that
	## touches the entry room instead.
	if not player.room_connectors.is_empty():
		failures.append(
			"spawn: player.room_connectors must stay empty (press-E interaction, not overlap)"
		)

	for conn: Dictionary in inst.get_connector_records():
		if conn["from"] != layout.entry_room and conn["to"] != layout.entry_room:
			continue
		var from_tag: String = conn["from"] if conn["from"] == layout.entry_room else conn["to"]
		var to_tag: String = conn["to"] if conn["from"] == layout.entry_room else conn["from"]
		var area: Rect2 = inst.get_trigger_area(from_tag, to_tag)
		if area.has_point(player.position):
			failures.append(
				"spawn: player spawn position %s must be clear of connector area %s"
				% [str(player.position), str(area)]
			)

	_free_detached_instance(inst)
	return failures


func _test_floor_plane_lock_holds() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	if player == null:
		failures.append("floor_lock: no player built")
		_free_instance(inst)
		return failures

	var expected_floor_y: float = player.floor_y
	player.apply_input(0.6, true)

	for i in range(60):
		## Simulate a persistent adversarial vertical nudge — proves the
		## floor-plane pin holds even under a vertical force, not merely
		## that nothing happens to ask for one (findings 1-2).
		player.velocity.y = 500.0
		await physics_frame
		if not is_equal_approx(player.position.y, expected_floor_y):
			failures.append(
				"floor_lock: player.position.y drifted to %.3f at step %d, expected floor_y %.3f"
				% [player.position.y, i, expected_floor_y]
			)
			break

	player.apply_input(0.0, false)
	_free_instance(inst)
	return failures


## ── Wall geometry edge cases ─────────────────────────────────────────────────

func _test_wall_segments_all_positive_length() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	if inst.get_layout() == null:
		_free_detached_instance(inst)
		return failures

	for tag: String in ALL_SEVEN:
		var room_node: Node2D = inst.get_room_node(tag)
		if room_node == null:
			continue
		for child: Node in room_node.get_children():
			if not (child is StaticBody2D):
				continue
			for shape_node: Node in child.get_children():
				if shape_node is CollisionShape2D:
					var box: RectangleShape2D = (shape_node as CollisionShape2D).shape as RectangleShape2D
					if box == null:
						continue
					if box.size.x <= 0.0 or box.size.y <= 0.0:
						failures.append(
							"positive_length: room '%s' has a non-positive wall collider size %s"
							% [tag, str(box.size)]
						)

	_free_detached_instance(inst)
	return failures


## Per-side wall/floor coverage, in tiles, that the authored connections
## require for these two rooms — hand-derived from signal_tower_v1.json:
##   antenna_shaft (6x28): top opening cols[1,2) (ladder to equipment_floor),
##     bottom opening cols[4,5) (ladder to broadcast_deck), no side doors —
##     left/right fully closed (28 tiles each); top/bottom 6-1=5 tiles each.
##   ground_relay (30x9): right opening rows[6,9) (door to records_room, 3
##     tiles) -> right closed 9-3=6; bottom (floor) opening cols[1,2) (ladder
##     to power_substation) PLUS the door floor-corner exclusion col[29,30)
##     -> floor 30-1-1=28; top/left have no openings (30 and 9 respectively).
const _NARROW_WIDE_EXPECTED: Dictionary = {
	"signal_tower.antenna_shaft": {"top": 5, "bottom": 5, "left": 28, "right": 28},
	"signal_tower.ground_relay": {"top": 30, "bottom": 28, "left": 9, "right": 6},
}


## Sums built wall/floor collider coverage per perimeter side of [param
## room_node], in tiles. Each of the 4 walls _build_room() constructs has a
## FIXED thin dimension of exactly one tile (top/bottom segments are always
## 1 tile tall; left/right segments are always 1 tile wide) — classifying by
## that thin dimension, rather than by segment length, correctly attributes
## a segment to its side regardless of how an opening split it. A 1x1 corner
## segment satisfies both a horizontal and a vertical thin-dimension test;
## resolved by requiring left/right segments to be MORE than one tile tall,
## since every side actually built by these two rooms is either a lone
## corner tile (correctly counted once, under top/bottom) or many tiles tall
## (unambiguously vertical).
func _side_coverage_tiles(room_node: Node2D, size: Vector2i, tile_size: int) -> Dictionary:
	var covered: Dictionary = {"top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.0}
	var bottom_y: float = float((size.y - 1) * tile_size)
	var right_x: float = float((size.x - 1) * tile_size)

	for child: Node in room_node.get_children():
		if not (child is StaticBody2D):
			continue
		var box: RectangleShape2D = null
		for shape_node: Node in child.get_children():
			if shape_node is CollisionShape2D:
				box = (shape_node as CollisionShape2D).shape as RectangleShape2D
				break
		if box == null:
			continue

		if is_equal_approx(child.position.y, 0.0) and is_equal_approx(box.size.y, float(tile_size)):
			covered["top"] += box.size.x / tile_size
		if is_equal_approx(child.position.y, bottom_y) and is_equal_approx(box.size.y, float(tile_size)):
			covered["bottom"] += box.size.x / tile_size
		if (
			is_equal_approx(child.position.x, 0.0)
			and is_equal_approx(box.size.x, float(tile_size))
			and box.size.y > float(tile_size) + 0.01
		):
			covered["left"] += box.size.y / tile_size
		if (
			is_equal_approx(child.position.x, right_x)
			and is_equal_approx(box.size.x, float(tile_size))
			and box.size.y > float(tile_size) + 0.01
		):
			covered["right"] += box.size.y / tile_size

	return covered


func _test_narrow_and_wide_rooms_closed() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		_free_detached_instance(inst)
		return failures

	for tag: String in _NARROW_WIDE_EXPECTED.keys():
		var room_node: Node2D = inst.get_room_node(tag)
		if room_node == null:
			failures.append("narrow_wide: room '%s' was not built" % tag)
			continue

		var size: Vector2i = layout.get_size_tiles(tag)
		var covered: Dictionary = _side_coverage_tiles(room_node, size, layout.tile_size_px)
		var expected: Dictionary = _NARROW_WIDE_EXPECTED[tag]

		for side: String in ["top", "bottom", "left", "right"]:
			if not is_equal_approx(covered[side], float(expected[side])):
				failures.append(
					"narrow_wide: room '%s' side '%s' covers %.2f tiles, expected %d (missing wall or floor coverage)"
					% [tag, side, covered[side], expected[side]]
				)

	_free_detached_instance(inst)
	return failures


## ── Malformed layout handling ────────────────────────────────────────────────

func _test_malformed_layout_missing_file() -> Array[String]:
	var failures: Array[String] = []
	var inst := LevelScript.new()
	inst.build_level("res://signal_tower/layouts/does_not_exist_T0390.json")

	if inst.get_load_error() == "":
		failures.append("malformed_missing_file: get_load_error() must be non-empty")
	if inst.get_layout() != null:
		failures.append("malformed_missing_file: get_layout() must be null after a failed load")
	if inst.get_room_node(GROUND_RELAY) != null:
		failures.append("malformed_missing_file: no partial geometry may be built")

	inst.free()
	return failures


func _test_malformed_layout_missing_origin_size() -> Array[String]:
	var failures: Array[String] = []

	var text: String = FileAccess.get_file_as_string(DEFAULT_LAYOUT_PATH)
	var data: Dictionary = JSON.parse_string(text) as Dictionary
	(data["rooms"][0] as Dictionary).erase("size")

	var tmp_path: String = "user://test_T0390_missing_size.json"
	var f := FileAccess.open(tmp_path, FileAccess.WRITE)
	f.store_string(JSON.stringify(data))
	f.close()

	var inst := LevelScript.new()
	inst.build_level(tmp_path)

	if inst.get_load_error() == "":
		failures.append("malformed_missing_origin_size: get_load_error() must be non-empty")
	if inst.get_room_node(GROUND_RELAY) != null:
		failures.append("malformed_missing_origin_size: no partial geometry may be built")

	inst.free()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(tmp_path))
	return failures


func _test_layout_unknown_room_tag_connection() -> Array[String]:
	var failures: Array[String] = []

	var text: String = FileAccess.get_file_as_string(DEFAULT_LAYOUT_PATH)
	var data: Dictionary = JSON.parse_string(text) as Dictionary
	(data["connections"][0] as Dictionary)["to"] = "signal_tower.nonexistent_room"

	var tmp_path: String = "user://test_T0390_unknown_tag.json"
	var f := FileAccess.open(tmp_path, FileAccess.WRITE)
	f.store_string(JSON.stringify(data))
	f.close()

	var inst := LevelScript.new()
	inst.build_level(tmp_path)

	if inst.get_load_error() == "":
		failures.append("unknown_room_tag: get_load_error() must be non-empty")
	if inst.get_room_node(GROUND_RELAY) != null:
		failures.append("unknown_room_tag: no partial geometry may be built")

	inst.free()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(tmp_path))
	return failures


func _test_layout_invalid_connection_type() -> Array[String]:
	var failures: Array[String] = []

	var text: String = FileAccess.get_file_as_string(DEFAULT_LAYOUT_PATH)
	var data: Dictionary = JSON.parse_string(text) as Dictionary
	(data["connections"][0] as Dictionary)["type"] = "trapdoor"

	var tmp_path: String = "user://test_T0390_bad_type.json"
	var f := FileAccess.open(tmp_path, FileAccess.WRITE)
	f.store_string(JSON.stringify(data))
	f.close()

	var inst := LevelScript.new()
	inst.build_level(tmp_path)

	if inst.get_load_error() == "":
		failures.append("invalid_connection_type: get_load_error() must be non-empty")
	if inst.get_room_node(GROUND_RELAY) != null:
		failures.append("invalid_connection_type: no partial geometry may be built")

	inst.free()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(tmp_path))
	return failures


## ── Transition mechanics edge cases ──────────────────────────────────────────

## Overlap alone must never transition (T-0390 fix round 2 design change):
## standing inside a connector's trigger area for 10 physics steps, with no
## E press, must leave the current room unchanged.
func _test_overlap_alone_does_not_transition() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var reached: bool = await _walk_into_trigger(inst, player, GROUND_RELAY, POWER_SUBSTATION, MAX_WALK_STEPS)
	if not reached:
		failures.append("overlap_alone: failed to reach the ground_relay -> power_substation trigger area")
		_free_instance(inst)
		return failures

	var before_tag: String = inst.get_current_room_tag()
	var before_count: int = inst.get_room_change_count()
	for i in range(10):
		await physics_frame
	if inst.get_current_room_tag() != before_tag or inst.get_room_change_count() != before_count:
		failures.append(
			"overlap_alone: room changed to '%s' after standing in a connector area for 10 frames "
			+ "with no E press" % inst.get_current_room_tag()
		)

	_free_instance(inst)
	return failures


## Pressing E outside every connector area must do nothing.
func _test_interact_outside_connector_does_nothing() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var before_tag: String = inst.get_current_room_tag()
	var before_count: int = inst.get_room_change_count()

	## Spawn is already asserted clear of every connector area elsewhere
	## (_test_spawn_in_ground_relay_clear_of_connectors) — press E right there.
	player.interact_pressed.emit()
	await physics_frame

	if inst.get_current_room_tag() != before_tag or inst.get_room_change_count() != before_count:
		failures.append("interact_outside: E press outside any connector area must not change rooms")

	_free_instance(inst)
	return failures


## Pressing E inside a connector area must change rooms exactly once.
func _test_interact_inside_connector_transitions_once() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var reached: bool = await _walk_into_trigger(inst, player, GROUND_RELAY, POWER_SUBSTATION, MAX_WALK_STEPS)
	if not reached:
		failures.append("interact_inside: failed to reach the trigger area")
		_free_instance(inst)
		return failures

	var before_count: int = inst.get_room_change_count()
	player.interact_pressed.emit()
	await physics_frame

	if inst.get_room_change_count() != before_count + 1:
		failures.append(
			"interact_inside: expected exactly 1 room change for 1 E press, got %d"
			% (inst.get_room_change_count() - before_count)
		)
	if inst.get_current_room_tag() != POWER_SUBSTATION:
		failures.append(
			"interact_inside: expected to be in power_substation, got '%s'" % inst.get_current_room_tag()
		)

	_free_instance(inst)
	return failures


## The contextual "[E] ..." prompt shows while the player stands in a
## connector's area and disappears once they leave it.
func _test_interaction_prompt_visibility() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	if inst.get_interaction_prompt_visible():
		failures.append("prompt: must not be visible at spawn, which is clear of every connector")

	var reached: bool = await _walk_into_trigger(inst, player, GROUND_RELAY, POWER_SUBSTATION, MAX_WALK_STEPS)
	if not reached:
		failures.append("prompt: failed to reach the trigger area")
		_free_instance(inst)
		return failures

	if not inst.get_interaction_prompt_visible():
		failures.append("prompt: must be visible while standing in a connector area")
	if inst.get_interaction_prompt_text() == "":
		failures.append("prompt: must show non-empty text while in a connector area")

	## Leave back toward the room's own centre, not blindly further in the
	## entry direction — ground_relay's ladder opening sits flush against the
	## room's own left wall (T-0328's committed layout), so continuing further
	## left after arriving there collides with that wall instead of exiting.
	var room_rect: Rect2 = inst.get_layout().get_rect_px(GROUND_RELAY)
	var center_x: float = room_rect.position.x + room_rect.size.x * 0.5
	var leave_direction: float = 1.0 if center_x >= player.position.x else -1.0
	player.apply_input(leave_direction, true)
	var left: bool = false
	for i in range(120):
		await physics_frame
		if not inst.get_interaction_prompt_visible():
			left = true
			break
	player.apply_input(0.0, false)
	await physics_frame

	if not left or inst.get_interaction_prompt_visible():
		failures.append("prompt: must disappear after the player leaves the connector area")

	_free_instance(inst)
	return failures


func _test_wrong_side_ladder_resolves_correctly() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()

	var down_ok: bool = await _walk_to_room_via_interact(inst, player, GROUND_RELAY, POWER_SUBSTATION, MAX_WALK_STEPS)
	if not down_ok:
		failures.append("wrong_side_ladder: failed to descend ground_relay -> power_substation")
		_free_instance(inst)
		return failures

	## Taking the SAME ladder from the opposite side must resolve back to the
	## parent room, not re-descend to a child.
	var up_ok: bool = await _walk_to_room_via_interact(inst, player, POWER_SUBSTATION, GROUND_RELAY, MAX_WALK_STEPS)
	if not up_ok:
		failures.append("wrong_side_ladder: failed to ascend power_substation -> ground_relay")
	elif inst.get_current_room_tag() != GROUND_RELAY:
		failures.append(
			"wrong_side_ladder: expected to resolve to ground_relay, got '%s'"
			% inst.get_current_room_tag()
		)

	_free_instance(inst)
	return failures


func _test_dead_end_branches_isolated() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	if inst.get_layout() == null:
		_free_detached_instance(inst)
		return failures

	for pair: Array in [[RECORDS_ROOM, GROUND_RELAY], [STORAGE_CACHE, EQUIPMENT_FLOOR]]:
		var branch_tag: String = pair[0]
		var parent_tag: String = pair[1]
		var connections_from_branch: int = 0
		for conn: Dictionary in inst.get_connector_records():
			if conn["from"] == branch_tag or conn["to"] == branch_tag:
				connections_from_branch += 1
		if connections_from_branch != 1:
			failures.append(
				"dead_end: '%s' must have exactly 1 connection (to '%s'), found %d"
				% [branch_tag, parent_tag, connections_from_branch]
			)

		var chain: Object = ChainSideonScript.new()
		if chain.get_critical_path().has(branch_tag):
			failures.append("dead_end: '%s' must not appear on the critical path" % branch_tag)

	_free_detached_instance(inst)
	return failures


func _test_chain_terminus_no_onward_connector() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_detached_instance(failures)
	if inst.get_layout() == null:
		_free_detached_instance(inst)
		return failures

	var outgoing: int = 0
	for conn: Dictionary in inst.get_connector_records():
		if conn["from"] == BROADCAST_DECK:
			outgoing += 1
	if outgoing != 0:
		failures.append("chain_terminus: broadcast_deck must have no outgoing connection, found %d" % outgoing)

	var chain: Object = ChainSideonScript.new()
	if chain.get_main_next(BROADCAST_DECK) != "":
		failures.append("chain_terminus: get_main_next(broadcast_deck) must be ''")

	_free_detached_instance(inst)
	return failures


## Pushes the player into ground_relay's left wall — the one perimeter side
## with no declared connection (its door is on the right, to records_room;
## its ladder is on the bottom, to power_substation) — and asserts a plain
## solid wall actually blocks it (T-0390 fix round 1, the real defect: a
## side wall of a room other than broadcast_deck's far wall).
func _test_player_blocked_by_side_wall() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var relay_rect: Rect2 = inst.get_layout().get_rect_px(GROUND_RELAY)
	var run_px_per_frame: float = PlayerControllerScript.RUN_SPEED / float(Engine.physics_ticks_per_second)
	var cross_frames: int = int(ceil(relay_rect.size.x / run_px_per_frame)) + 60

	player.apply_input(-1.0, true)
	for i in range(cross_frames):
		await physics_frame
	player.apply_input(0.0, false)
	await physics_frame

	if inst.get_current_room_tag() != GROUND_RELAY:
		failures.append(
			"wall_collision: walking into ground_relay's left wall left the room (now '%s')"
			% inst.get_current_room_tag()
		)
	if not relay_rect.has_point(player.position):
		failures.append(
			"wall_collision: player position %s left ground_relay's rect %s after walking into its left wall"
			% [str(player.position), str(relay_rect)]
		)

	_free_instance(inst)
	return failures


## ── Full traversal ───────────────────────────────────────────────────────────

func _test_full_critical_path_traversal_and_branches_and_reverse() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = await _build_live_instance(failures)
	if inst.get_layout() == null:
		_free_instance(inst)
		return failures

	var player: CharacterBody2D = inst.get_player()
	var chain: Object = ChainSideonScript.new()
	var critical_path: Array[String] = chain.get_critical_path()

	var visited: Array[String] = [inst.get_current_room_tag()]
	if inst.get_current_room_tag() != critical_path[0]:
		failures.append("traversal: must start in '%s'" % critical_path[0])

	## Forward along the critical path, each hop walked into the connector
	## area and then activated with E (T-0390 fix round 2) — no walking
	## through, no direct position assignment.
	for i in range(critical_path.size() - 1):
		var from_tag: String = critical_path[i]
		var to_tag: String = critical_path[i + 1]
		var ok: bool = await _walk_to_room_via_interact(inst, player, from_tag, to_tag, MAX_WALK_STEPS)
		if not ok:
			failures.append("traversal: failed to walk+interact %s -> %s" % [from_tag, to_tag])
			_free_instance(inst)
			return failures
		visited.append(to_tag)

	if visited != critical_path:
		failures.append(
			"traversal: visited sequence %s does not equal CRITICAL_PATH %s"
			% [str(visited), str(critical_path)]
		)

	if inst.get_current_room_tag() != critical_path.back():
		failures.append("traversal: expected to end at '%s'" % critical_path.back())
		_free_instance(inst)
		return failures

	## Chain terminus wall collision (T-0390 fix round 1, the real defect):
	## broadcast_deck's far wall must actually block the player, not just be
	## absent of an outgoing connector. Hold running input long enough to
	## cross the room's full authored width with margin.
	var deck_rect: Rect2 = inst.get_layout().get_rect_px(BROADCAST_DECK)
	var run_px_per_frame: float = PlayerControllerScript.RUN_SPEED / float(Engine.physics_ticks_per_second)
	var deck_cross_frames: int = int(ceil(deck_rect.size.x / run_px_per_frame)) + 60
	player.apply_input(1.0, true)
	for i in range(deck_cross_frames):
		await physics_frame
	player.apply_input(0.0, false)
	await physics_frame

	if inst.get_current_room_tag() != BROADCAST_DECK:
		failures.append(
			"wall_collision: walking into broadcast_deck's far wall left the room (now '%s')"
			% inst.get_current_room_tag()
		)
	if not deck_rect.has_point(player.position):
		failures.append(
			"wall_collision: player position %s left broadcast_deck's rect %s after walking into its far wall"
			% [str(player.position), str(deck_rect)]
		)

	## Reverse the whole critical path, connector by connector, same press-E
	## mechanism.
	for i in range(critical_path.size() - 1, 0, -1):
		var from_tag: String = critical_path[i]
		var to_tag: String = critical_path[i - 1]
		var ok: bool = await _walk_to_room_via_interact(inst, player, from_tag, to_tag, MAX_WALK_STEPS)
		if not ok:
			failures.append(
				"traversal: failed to walk+interact critical path in reverse %s -> %s" % [from_tag, to_tag]
			)
			_free_instance(inst)
			return failures

	if inst.get_current_room_tag() != critical_path[0]:
		failures.append("traversal: reverse critical path must end back at '%s'" % critical_path[0])

	## Branch: ground_relay -> records_room -> ground_relay.
	var to_records: bool = await _walk_to_room_via_interact(inst, player, GROUND_RELAY, RECORDS_ROOM, MAX_WALK_STEPS)
	if not to_records:
		failures.append("traversal: failed to walk+interact ground_relay -> records_room")
	else:
		var back_from_records: bool = await _walk_to_room_via_interact(
			inst, player, RECORDS_ROOM, GROUND_RELAY, MAX_WALK_STEPS
		)
		if not back_from_records:
			failures.append("traversal: failed to walk+interact records_room -> ground_relay")

	## Walk to equipment_floor to test its branch.
	var to_power: bool = await _walk_to_room_via_interact(inst, player, GROUND_RELAY, POWER_SUBSTATION, MAX_WALK_STEPS)
	if not to_power:
		failures.append("traversal: failed to walk+interact ground_relay -> power_substation (branch setup)")
		_free_instance(inst)
		return failures
	var to_equipment: bool = await _walk_to_room_via_interact(
		inst, player, POWER_SUBSTATION, EQUIPMENT_FLOOR, MAX_WALK_STEPS
	)
	if not to_equipment:
		failures.append("traversal: failed to walk+interact power_substation -> equipment_floor (branch setup)")
		_free_instance(inst)
		return failures

	## Branch: equipment_floor -> storage_cache -> equipment_floor.
	var to_storage: bool = await _walk_to_room_via_interact(inst, player, EQUIPMENT_FLOOR, STORAGE_CACHE, MAX_WALK_STEPS)
	if not to_storage:
		failures.append("traversal: failed to walk+interact equipment_floor -> storage_cache")
	else:
		var back_from_storage: bool = await _walk_to_room_via_interact(
			inst, player, STORAGE_CACHE, EQUIPMENT_FLOOR, MAX_WALK_STEPS
		)
		if not back_from_storage:
			failures.append("traversal: failed to walk+interact storage_cache -> equipment_floor")

	_free_instance(inst)
	return failures
