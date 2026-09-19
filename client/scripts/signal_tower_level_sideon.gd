## SignalTowerLevelSideon — the real playable seven-room Signal Tower (T-0390).
##
## Wires already-merged pieces together: RoomLayout (T-0328) for room
## geometry, SignalTowerChainSideon (T-0194) for the canonical connectivity
## cross-check, PlayerController (T-0188, res://player_controller.gd — NOT
## res://scripts/player_controller.gd, the free-2D T-0184 controller) for
## floor-locked side-on movement, and FirstRunController (T-0120) for the
## existing boot sequence. Grey-box only: no props, no final art, no entity
## controllers — those are T-0247/T-0235/entity-behaviour cards.
##
## Every room is built at its authored world position
## (RoomLayout.get_rect_px), all seven coexisting in one continuous
## coordinate space — the same convention scenes/signal_tower_overview.gd
## uses. A "room transition" is bookkeeping (current room tag + floor_y)
## plus a placement clear of the connector that triggered it, not a scene
## swap: PlayerController is floor-plane-locked (no vertical movement inside
## a room), so the only way to reach a different floor_y is through one of
## these transitions.
extends Node2D

const _RoomLayoutScript: GDScript = preload("res://signal_tower/room_layout.gd")
const _PlayerScript: GDScript = preload("res://player_controller.gd")
const _FirstRunControllerScript: GDScript = preload("res://scripts/first_run_controller.gd")

const DEFAULT_LAYOUT_PATH: String = "res://signal_tower/layouts/signal_tower_v1.json"

## Door opening height, in tiles, anchored at the shared floor row (T-0390
## planner finding 5) — not the vertical midpoint of the two rooms' overlap.
const DOOR_OPENING_TILES: int = 3
## Ladder opening width, in tiles. Deliberately narrower than
## signal_tower_overview.gd's OPENING_SPAN (2) — antenna_shaft's interior is
## only 4 tiles wide and hosts two ladders back-to-back (T-0328's narrow-shaft
## edge case), so a 2-tile opening for each would consume the entire interior
## with no gap left for a landing clear of either trigger (T-0390).
const LADDER_OPENING_TILES: int = 1
## Thickness, along the crossing axis, of a door trigger area.
const DOOR_TRIGGER_DEPTH_PX: float = 16.0
## Extra clearance placed past a trigger's far edge when landing a player —
## keeps the reciprocal connector from immediately re-firing (finding: the
## ladder-ping-pong edge case).
const CONNECTOR_CLEARANCE_PX: float = 16.0
## Vertical band, centred on a room's floor_y, a ladder trigger occupies.
const LADDER_TRIGGER_HEIGHT_PX: float = 16.0

## Extra safety margin, in physics frames, added on top of a room-width-
## derived grace window — see _grace_frames_for_room().
const REENTRY_GRACE_MARGIN_FRAMES: int = 10

const _WALL_COLOR: Color = Color(0.28, 0.28, 0.28)
const _FLOOR_COLOR: Color = Color(0.22, 0.22, 0.22)

var _layout: RefCounted  ## RoomLayout
var _room_nodes: Dictionary = {}  ## anchor_tag -> Node2D
var _connector_records: Array = []  ## Array[Dictionary{from, to, type, branch}]
## "<from_tag>|<to_tag>" -> Rect2 — the trigger area, inside from_tag, that
## fires a transition to to_tag.
var _trigger_by_pair: Dictionary = {}
## "<from_tag>|<to_tag>" -> {"position": Vector2, "floor_y": float} — where
## the player lands, and its new floor_y, when transitioning from_tag -> to_tag.
var _arrivals: Dictionary = {}
var _pending_room_connectors: Array = []
var _connector_count_by_room: Dictionary = {}  ## anchor_tag -> int

var _player: CharacterBody2D
var _first_run: Node
var _room_built: bool = false
var _current_room_tag: String = ""
var _room_change_count: int = 0
var _load_error: String = ""

## The "<room>|<target>" connector key currently filtered out of
## _player.room_connectors, and how many physics frames until it's restored —
## see _on_player_room_transition()'s grace-suppression comment.
var _suppressed_connector_key: String = ""
var _suppress_frames_remaining: int = 0


func _ready() -> void:
	## Decoupled from _physics_process (tests build a live instance with
	## set_physics_process(false), driving physics via direct apply_input() +
	## awaited physics_frame calls instead) so grace suppression still expires
	## on schedule under that harness.
	get_tree().physics_frame.connect(_on_grace_window_tick)

	## Geometry + the Player node are built synchronously here, not gated
	## behind entry_room_ready: tests/test_main_scene_compiles.gd loads
	## run/main_scene, lets it run a handful of frames with no first-run
	## screen ever acknowledged, and requires a "Player" child to already
	## exist — it (deliberately) never drives FirstRunController's async
	## identity round-trip. Live keyboard input stays gated behind
	## entry_room_ready via _room_built below, so a first-run blocking
	## screen still fully owns player control until it's cleared — only
	## the timing of *when the room is built* changes, not who can move
	## the player while a screen is up.
	build_level()

	_first_run = _FirstRunControllerScript.new()
	add_child(_first_run)
	_first_run.entry_room_ready.connect(_on_first_run_entry_room_ready)
	_first_run.start_new_game()


func _on_first_run_entry_room_ready() -> void:
	_room_built = true


## The FirstRunController this scene's _ready() constructed — the boot
## contract tests/test_main_scene_boot.gd checks against every main scene.
func get_first_run_controller() -> Node:
	return _first_run


## Loads [param layout_path], cross-checks it against the canonical room
## graph, and — only if both succeed — builds all seven rooms, every
## connector, and the player. Callable directly, independent of _ready()
## (same pattern as signal_tower_overview.gd's build_layout()), so tests can
## drive a deliberately broken path without a live SceneTree.
func build_level(layout_path: String = DEFAULT_LAYOUT_PATH) -> void:
	_load_error = ""
	_room_nodes = {}
	_connector_records = []
	_trigger_by_pair = {}
	_arrivals = {}
	_pending_room_connectors = []

	_suppressed_connector_key = ""
	_suppress_frames_remaining = 0

	_layout = _RoomLayoutScript.new()
	var err: String = _layout.load_from_path(layout_path)
	if err != "":
		push_error("SignalTowerLevelSideon: failed to load layout — %s" % err)
		_load_error = err
		_layout = null
		return

	var mismatches: Array[String] = _layout.find_connectivity_mismatches()
	if not mismatches.is_empty():
		var joined: String = "; ".join(mismatches)
		push_error("SignalTowerLevelSideon: layout fails connectivity cross-check — %s" % joined)
		_load_error = joined
		_layout = null
		return

	_connector_count_by_room = {}
	for conn: Dictionary in _layout.get_connections():
		_connector_count_by_room[conn["from"]] = _connector_count_by_room.get(conn["from"], 0) + 1
		_connector_count_by_room[conn["to"]] = _connector_count_by_room.get(conn["to"], 0) + 1

	var openings: Dictionary = {}
	for tag: String in _layout.get_all_tags():
		openings[tag] = {"left": [], "right": [], "top": [], "bottom": []}

	## Two passes: geometry first (every connection's opening + ladder trigger
	## x-range), then room construction, then connector registration — landing
	## placement (_register_connector) needs every OTHER ladder trigger
	## sharing a room already known, not just the connection being processed,
	## to keep a landing clear of both walls and neighbouring triggers (see
	## _pick_ladder_landing_x()).
	var conn_geos: Array = []
	var ladder_ranges_by_room: Dictionary = {}  ## anchor_tag -> Array[Vector2(x0_px, x1_px)]
	var ladder_index: int = 0
	for conn: Dictionary in _layout.get_connections():
		var geo: Dictionary
		if conn["type"] == "door":
			geo = _door_geometry(conn)
			## A door's opening is anchored at the floor row (finding 5), so it
			## always reaches the corner where its side wall meets the
			## perpendicular floor strip. The floor strip is carved
			## independently of the side wall's own opening, so without an
			## explicit exclusion here it would still plug that corner solid —
			## carve the matching single column out of the floor strip too.
			_add_door_floor_corner_exclusion(openings, conn["from"], geo["a_side"])
			_add_door_floor_corner_exclusion(openings, conn["to"], geo["b_side"])
		else:
			geo = _ladder_geometry(conn, ladder_index)
			ladder_index += 1
			var trigger_range := Vector2(geo["opening_x0_px"], geo["opening_x1_px"])
			ladder_ranges_by_room.get_or_add(conn["from"], []).append(trigger_range)
			ladder_ranges_by_room.get_or_add(conn["to"], []).append(trigger_range)
		openings[conn["from"]][geo["a_side"]].append(geo["a_range"])
		openings[conn["to"]][geo["b_side"]].append(geo["b_range"])
		conn_geos.append({"conn": conn, "geo": geo})

	for tag: String in _layout.get_all_tags():
		_room_nodes[tag] = _build_room(tag, openings[tag])

	for entry: Dictionary in conn_geos:
		_register_connector(entry["conn"], entry["geo"], ladder_ranges_by_room)

	_build_player()


## Returns the loaded RoomLayout, or null if the last build_level() call failed.
func get_layout() -> RefCounted:
	return _layout


## Returns the load/validation failure from the last build_level() call, or
## "" if it succeeded.
func get_load_error() -> String:
	return _load_error


## Returns the built room container for [param tag], or null.
func get_room_node(tag: String) -> Node2D:
	return _room_nodes.get(tag, null)


## Returns one record per declared connection: {from, to, type, branch}.
func get_connector_records() -> Array:
	return _connector_records.duplicate(true)


## Returns the world-space trigger area inside [param from_tag] that fires a
## transition to [param to_tag], or an empty Rect2 if no such connector exists.
func get_trigger_area(from_tag: String, to_tag: String) -> Rect2:
	return _trigger_by_pair.get("%s|%s" % [from_tag, to_tag], Rect2())


## Returns the built player, or null.
func get_player() -> CharacterBody2D:
	return _player


## Returns the anchor tag of the room the player currently occupies.
func get_current_room_tag() -> String:
	return _current_room_tag


## Returns how many times _on_player_room_transition() actually changed rooms
## (re-entrant signal emissions while already in the target room don't count).
func get_room_change_count() -> int:
	return _room_change_count


# ── Room geometry ────────────────────────────────────────────────────────────

func _floor_row_global(tag: String) -> int:
	var rect: Rect2i = _layout.get_rect_tiles(tag)
	return rect.position.y + rect.size.y - 1


func _floor_y_px(tag: String) -> float:
	return float(_floor_row_global(tag)) * float(_layout.tile_size_px)


## World-space [x_min, x_max) of [param tag]'s INTERIOR columns — inset one
## tile from its own left/right walls, matching _ladder_geometry()'s own
## interior inset so a landing point placed within these bounds never spawns
## inside a wall collider.
func _room_interior_x_bounds(tag: String) -> Vector2:
	var rect: Rect2i = _layout.get_rect_tiles(tag)
	var tile_size: int = _layout.tile_size_px
	return Vector2(float((rect.position.x + 1) * tile_size), float((rect.end.x - 1) * tile_size))


## Chooses where a ladder's arrival point lands inside [param tag]: past the
## opening's right edge by CONNECTOR_CLEARANCE_PX if that stays clear of both
## the room's own walls and every OTHER ladder trigger already registered in
## that room ([param other_ranges_in_room]); otherwise past the left edge
## under the same test; otherwise (room too narrow for either) the room's own
## midpoint, clamped inside its walls, as a last resort.
##
## Needed because PlayerController's connector check is unconditional
## position overlap with no notion of "which side did the player come from"
## (T-0390) — a landing that spawns inside a wall gets shoved by physics on
## the very next move_and_slide(), and a landing inside ANOTHER trigger's
## zone fires that connector immediately, neither of which is a legitimate
## room-to-room hop.
func _pick_ladder_landing_x(tag: String, x0_px: float, x1_px: float, other_ranges_in_room: Array) -> float:
	var bounds: Vector2 = _room_interior_x_bounds(tag)
	var right: float = x1_px + CONNECTOR_CLEARANCE_PX
	var left: float = x0_px - CONNECTOR_CLEARANCE_PX
	if right <= bounds.y and not _x_in_any_range(right, other_ranges_in_room):
		return right
	if left >= bounds.x and not _x_in_any_range(left, other_ranges_in_room):
		return left
	return clampf((bounds.x + bounds.y) * 0.5, bounds.x, bounds.y)


func _x_in_any_range(x: float, ranges: Array) -> bool:
	for r: Vector2 in ranges:
		if x >= r.x and x < r.y:
			return true
	return false


## Door opening geometry: the opening is anchored at the shared floor row of
## both connected rooms, not the vertical midpoint of their overlap — the
## committed layout deliberately floor-aligns every door pair (T-0390
## planner finding 5).
func _door_geometry(conn: Dictionary) -> Dictionary:
	var a_tag: String = conn["from"]
	var b_tag: String = conn["to"]
	var rect_a: Rect2i = _layout.get_rect_tiles(a_tag)
	var rect_b: Rect2i = _layout.get_rect_tiles(b_tag)
	var tile_size: int = _layout.tile_size_px

	var y0: int = maxi(rect_a.position.y, rect_b.position.y)
	var y1: int = mini(rect_a.end.y, rect_b.end.y)
	var floor_row: int = _floor_row_global(a_tag)
	var span1: int = clampi(floor_row + 1, y0, y1)
	var span0: int = clampi(span1 - DOOR_OPENING_TILES, y0, y1)

	var a_is_left: bool = rect_a.position.x < rect_b.position.x
	var boundary_x: int = rect_a.end.x if a_is_left else rect_b.end.x

	return {
		"a_side": "right" if a_is_left else "left",
		"b_side": "left" if a_is_left else "right",
		"a_range": [span0 - rect_a.position.y, span1 - rect_a.position.y],
		"b_range": [span0 - rect_b.position.y, span1 - rect_b.position.y],
		"boundary_x_px": float(boundary_x * tile_size),
		"opening_y0_px": float(span0 * tile_size),
		"opening_y1_px": float(span1 * tile_size),
	}


## Carves the single floor-strip column under a door's side-wall opening in
## [param tag] (the column at its left or right edge, per [param side]) — see
## the call site's comment on why the floor strip needs its own matching cut.
func _add_door_floor_corner_exclusion(openings: Dictionary, tag: String, side: String) -> void:
	var size: Vector2i = _layout.get_size_tiles(tag)
	var col: int = 0 if side == "left" else size.x - 1
	openings[tag]["bottom"].append([col, col + 1])


## Ladder opening geometry. Two ladders sharing a room (equipment_floor and
## antenna_shaft each touch two — one ascending, one descending) alternate
## which end of the x-overlap they claim, by ladder index in declaration
## order, so their trigger bands never collide inside the shared room — every
## ladder connection in this layout is a sequential hop on one linear chain,
## so any two that share a room are always adjacent in that ordering.
func _ladder_geometry(conn: Dictionary, ladder_index: int) -> Dictionary:
	var a_tag: String = conn["from"]
	var b_tag: String = conn["to"]
	var rect_a: Rect2i = _layout.get_rect_tiles(a_tag)
	var rect_b: Rect2i = _layout.get_rect_tiles(b_tag)
	var tile_size: int = _layout.tile_size_px

	## Confine the opening to each room's INTERIOR columns (inset 1 tile from
	## its own left/right walls) — using the raw rect overlap can place the
	## opening flush against a room's own side wall (e.g. antenna_shaft is
	## exactly as wide as its overlap with equipment_floor), where the side
	## wall's collider — built independently of this "bottom"/"top" opening —
	## would still block the gap regardless of the floor-strip carve-out.
	var interior_a: Vector2i = Vector2i(rect_a.position.x + 1, rect_a.end.x - 1)
	var interior_b: Vector2i = Vector2i(rect_b.position.x + 1, rect_b.end.x - 1)
	var x0: int = maxi(interior_a.x, interior_b.x)
	var x1: int = mini(interior_a.y, interior_b.y)
	var spanx0: int
	var spanx1: int
	if ladder_index % 2 == 0:
		spanx0 = x0
		spanx1 = mini(x1, x0 + LADDER_OPENING_TILES)
	else:
		spanx1 = x1
		spanx0 = maxi(x0, x1 - LADDER_OPENING_TILES)

	var a_is_top: bool = rect_a.position.y < rect_b.position.y
	var boundary_y: int = rect_a.end.y if a_is_top else rect_b.end.y

	return {
		"a_side": "bottom" if a_is_top else "top",
		"b_side": "top" if a_is_top else "bottom",
		"a_range": [spanx0 - rect_a.position.x, spanx1 - rect_a.position.x],
		"b_range": [spanx0 - rect_b.position.x, spanx1 - rect_b.position.x],
		"boundary_y_px": float(boundary_y * tile_size),
		"opening_x0_px": float(spanx0 * tile_size),
		"opening_x1_px": float(spanx1 * tile_size),
	}


## Returns the kept (non-opening) [start, end) sub-ranges of [0, length),
## given a list of [start, end) ranges to exclude.
func _kept_segments(length: int, excluded: Array) -> Array:
	var cuts: Array = excluded.duplicate(true)
	cuts.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0])

	var segments: Array = []
	var cursor: int = 0
	for cut: Array in cuts:
		var start: int = clampi(cut[0], 0, length)
		var end: int = clampi(cut[1], 0, length)
		if start > cursor:
			segments.append([cursor, start])
		cursor = maxi(cursor, end)
	if cursor < length:
		segments.append([cursor, length])
	return segments


## Builds one room's grey-box shell: perimeter walls on top/left/right, and a
## floor strip along the bottom interior row (which is also the room's bottom
## perimeter boundary) — each minus its declared openings.
func _build_room(tag: String, openings: Dictionary) -> Node2D:
	var size: Vector2i = _layout.get_size_tiles(tag)
	var origin_px: Vector2 = _layout.get_rect_px(tag).position
	var tile_size: int = _layout.tile_size_px

	var room_node := Node2D.new()
	room_node.name = tag.replace(".", "_")
	room_node.position = origin_px
	add_child(room_node)

	for seg: Array in _kept_segments(size.x, openings["top"]):
		_add_wall(room_node, Vector2i(seg[0], 0), Vector2i(seg[1] - seg[0], 1), tile_size, _WALL_COLOR)
	for seg: Array in _kept_segments(size.y, openings["left"]):
		_add_wall(room_node, Vector2i(0, seg[0]), Vector2i(1, seg[1] - seg[0]), tile_size, _WALL_COLOR)
	for seg: Array in _kept_segments(size.y, openings["right"]):
		_add_wall(
			room_node, Vector2i(size.x - 1, seg[0]), Vector2i(1, seg[1] - seg[0]), tile_size, _WALL_COLOR
		)
	for seg: Array in _kept_segments(size.x, openings["bottom"]):
		_add_wall(
			room_node, Vector2i(seg[0], size.y - 1), Vector2i(seg[1] - seg[0], 1), tile_size, _FLOOR_COLOR
		)

	return room_node


## Adds a StaticBody2D + CollisionShape2D + ColorRect wall/floor segment at
## the given tile-space rect, local to [param room_node].
func _add_wall(
	room_node: Node2D, tile_pos: Vector2i, tile_count: Vector2i, tile_size: int, color: Color
) -> void:
	var size_px: Vector2 = Vector2(tile_count) * tile_size

	var body := StaticBody2D.new()
	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = size_px
	shape.position = size_px * 0.5
	shape.shape = box
	body.add_child(shape)

	var visual := ColorRect.new()
	visual.size = size_px
	visual.color = color
	body.add_child(visual)

	body.position = Vector2(tile_pos) * tile_size
	room_node.add_child(body)


# ── Connectors ────────────────────────────────────────────────────────────────

## Registers both directions of one declared connection: a trigger area and
## an arrival point in each of the two connected rooms. [param ladder_ranges_by_room]
## is every ladder trigger's world x-range, grouped by the room it lives in
## (built across ALL connections before this is called) — used to keep a
## ladder's own landing clear of both that room's walls and any OTHER ladder
## trigger sharing the room (see _pick_ladder_landing_x()).
func _register_connector(conn: Dictionary, geo: Dictionary, ladder_ranges_by_room: Dictionary = {}) -> void:
	var a_tag: String = conn["from"]
	var b_tag: String = conn["to"]

	var area_a: Rect2
	var area_b: Rect2
	var arrival_b: Vector2  ## landing point inside b_tag when going a -> b
	var arrival_a: Vector2  ## landing point inside a_tag when going b -> a

	if conn["type"] == "door":
		var y0_px: float = geo["opening_y0_px"]
		var y1_px: float = geo["opening_y1_px"]
		var height_px: float = y1_px - y0_px
		var x_px: float = geo["boundary_x_px"]
		if geo["a_side"] == "right":
			area_a = Rect2(x_px - DOOR_TRIGGER_DEPTH_PX, y0_px, DOOR_TRIGGER_DEPTH_PX, height_px)
			area_b = Rect2(x_px, y0_px, DOOR_TRIGGER_DEPTH_PX, height_px)
			arrival_b = Vector2(x_px + DOOR_TRIGGER_DEPTH_PX + CONNECTOR_CLEARANCE_PX, _floor_y_px(b_tag))
			arrival_a = Vector2(x_px - DOOR_TRIGGER_DEPTH_PX - CONNECTOR_CLEARANCE_PX, _floor_y_px(a_tag))
		else:
			area_a = Rect2(x_px, y0_px, DOOR_TRIGGER_DEPTH_PX, height_px)
			area_b = Rect2(x_px - DOOR_TRIGGER_DEPTH_PX, y0_px, DOOR_TRIGGER_DEPTH_PX, height_px)
			arrival_b = Vector2(x_px - DOOR_TRIGGER_DEPTH_PX - CONNECTOR_CLEARANCE_PX, _floor_y_px(b_tag))
			arrival_a = Vector2(x_px + DOOR_TRIGGER_DEPTH_PX + CONNECTOR_CLEARANCE_PX, _floor_y_px(a_tag))
	else:
		var x0_px: float = geo["opening_x0_px"]
		var x1_px: float = geo["opening_x1_px"]
		var width_px: float = x1_px - x0_px
		var half_h: float = LADDER_TRIGGER_HEIGHT_PX * 0.5
		var floor_a: float = _floor_y_px(a_tag)
		var floor_b: float = _floor_y_px(b_tag)
		area_a = Rect2(x0_px, floor_a - half_h, width_px, LADDER_TRIGGER_HEIGHT_PX)
		area_b = Rect2(x0_px, floor_b - half_h, width_px, LADDER_TRIGGER_HEIGHT_PX)
		arrival_b = Vector2(
			_pick_ladder_landing_x(b_tag, x0_px, x1_px, ladder_ranges_by_room.get(b_tag, [])), floor_b
		)
		arrival_a = Vector2(
			_pick_ladder_landing_x(a_tag, x0_px, x1_px, ladder_ranges_by_room.get(a_tag, [])), floor_a
		)

	_pending_room_connectors.append(
		{"area": area_a, "target_room_id": b_tag, "key": "%s|%s" % [a_tag, b_tag]}
	)
	_pending_room_connectors.append(
		{"area": area_b, "target_room_id": a_tag, "key": "%s|%s" % [b_tag, a_tag]}
	)

	_trigger_by_pair["%s|%s" % [a_tag, b_tag]] = area_a
	_trigger_by_pair["%s|%s" % [b_tag, a_tag]] = area_b

	_arrivals["%s|%s" % [a_tag, b_tag]] = {"position": arrival_b, "floor_y": _floor_y_px(b_tag)}
	_arrivals["%s|%s" % [b_tag, a_tag]] = {"position": arrival_a, "floor_y": _floor_y_px(a_tag)}

	_connector_records.append({
		"from": a_tag, "to": b_tag, "type": conn["type"], "branch": conn.get("branch", false),
	})


# ── Player ───────────────────────────────────────────────────────────────────

func _build_player() -> void:
	_player = _PlayerScript.new()
	_player.name = "Player"
	_player.room_connectors.assign(_pending_room_connectors)

	_current_room_tag = _layout.entry_room
	_player.floor_y = _floor_y_px(_current_room_tag)
	_player.position = _spawn_position()
	_player.room_transition.connect(_on_player_room_transition)

	add_child(_player)


## Spawn point inside the layout's entry room, derived from its authored
## rect — horizontal centre, at the room's own floor row.
func _spawn_position() -> Vector2:
	var rect: Rect2 = _layout.get_rect_px(_layout.entry_room)
	return Vector2(rect.position.x + rect.size.x * 0.5, _floor_y_px(_layout.entry_room))


## Handles PlayerController.room_transition. Fires on every physics frame the
## player's centre is inside a connector area — idempotent by construction:
## once _current_room_tag already equals target_room_id, re-emissions are a
## no-op.
func _on_player_room_transition(target_room_id: String) -> void:
	if target_room_id == "" or target_room_id == _current_room_tag:
		return
	var key: String = "%s|%s" % [_current_room_tag, target_room_id]
	if not _arrivals.has(key):
		return

	var arrival: Dictionary = _arrivals[key]
	var previous_tag: String = _current_room_tag
	_current_room_tag = target_room_id
	_player.floor_y = arrival["floor_y"]
	_player.position = arrival["position"]
	_room_change_count += 1

	## PlayerController's overlap check (§161-171) is unconditional and
	## position-only — it has no notion of travel direction or intent. A room
	## with more than two connectors can have one sandwiched, along the
	## floor-row line, between this arrival point and another connector the
	## player needs to reach (T-0390: equipment_floor's ladder-then-door
	## layout — the ladder back up to power_substation sits between the
	## landing spot and both the ladder down to antenna_shaft and the door to
	## storage_cache). Without this, simply walking onward immediately re-
	## triggers the connector just used. Suppress only that one connector,
	## only long enough to walk clear of the room, and only where a genuine
	## sandwich is possible — a two-connector room (e.g. ground_relay <->
	## power_substation) has nothing to be sandwiched behind, so an immediate
	## deliberate reversal there (the "wrong-side ladder" edge case) is never
	## suppressed.
	if _connector_count_by_room.get(target_room_id, 0) > 2:
		_suppressed_connector_key = "%s|%s" % [target_room_id, previous_tag]
		_suppress_frames_remaining = _grace_frames_for_room(target_room_id)
		_apply_connector_suppression()


## See _on_player_room_transition()'s grace-suppression comment. Long enough
## to cross [param tag]'s full authored width at the player's slowest
## (walking) speed, plus a fixed margin — derived from the layout and
## PlayerController.WALK_SPEED rather than a fixed constant, so it stays
## correct if the authored room sizes ever change.
func _grace_frames_for_room(tag: String) -> int:
	var width_px: float = _layout.get_rect_px(tag).size.x
	var fps: float = float(Engine.physics_ticks_per_second)
	var px_per_frame: float = _PlayerScript.WALK_SPEED / fps
	return int(ceil(width_px / px_per_frame)) + REENTRY_GRACE_MARGIN_FRAMES


## Applies (or lifts) the current suppression to the live player's
## room_connectors. Filtering a copy of _pending_room_connectors rather than
## mutating it in place keeps the unfiltered list intact for restoration.
func _apply_connector_suppression() -> void:
	if _suppress_frames_remaining > 0 and _suppressed_connector_key != "":
		var filtered: Array[Dictionary] = []
		for c: Dictionary in _pending_room_connectors:
			if c.get("key", "") != _suppressed_connector_key:
				filtered.append(c)
		_player.room_connectors.assign(filtered)
	else:
		_suppressed_connector_key = ""
		_player.room_connectors.assign(_pending_room_connectors)


## Connected to SceneTree.physics_frame in _ready() — ticks the grace window
## regardless of whether this level's own _physics_process is enabled (tests
## disable it, driving physics via direct apply_input() + awaited
## physics_frame calls instead of the level's automatic Input polling).
func _on_grace_window_tick() -> void:
	if _suppress_frames_remaining <= 0:
		return
	_suppress_frames_remaining -= 1
	if _suppress_frames_remaining == 0:
		_apply_connector_suppression()


func _physics_process(_delta: float) -> void:
	if not _room_built or _player == null:
		return

	var direction: float = 0.0
	if Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D):
		direction += 1.0
	if Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A):
		direction -= 1.0
	var running: bool = Input.is_key_pressed(KEY_SHIFT)
	_player.apply_input(direction, running)
