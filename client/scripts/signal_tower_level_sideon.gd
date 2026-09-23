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
## Every room is built at its WORLD position (get_room_world_rect() — T-0403
## bug 1: the authored RoomLayout.get_rect_px() reflected so entry_room ends
## up at the greatest world y, at the bottom of the tower, and tear_room at
## the least, at the top, with the chain climbing upward in between), all
## seven coexisting in one continuous coordinate space. RoomLayout's own
## authored coordinates are untouched — this is a presentation-layer remap,
## not an edit to the source-of-truth layout data, so scenes/signal_tower_overview.gd
## (which still reads RoomLayout.get_rect_px() directly) is unaffected.
## Doors and ladders are press-E interactables (T-0390 fix round 2,
## @DennieSeth): PlayerController.room_connectors is deliberately left empty
## so its own overlap check never fires room_transition — standing in a
## connector's area does nothing by itself. Pressing E (PlayerController's
## interact_pressed signal, T-0188) is routed to _on_player_interact(),
## which looks up whichever connector area the player is currently standing
## in and performs the transition: bookkeeping (current room tag + floor_y)
## plus a landing placement, not a scene swap — PlayerController is
## floor-plane-locked (no vertical movement inside a room), so the only way
## to reach a different floor_y is through one of these transitions.
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

## Player body size, matching PlayerController's documented 12x14 body
## (client/player_controller.gd _HALF_W/_HALF_H) — T-0188 leaves collision
## shape construction to the room runtime, so this level builds one for the
## node it already configures (floor_y, room_connectors, position).
const _PLAYER_BODY_WIDTH_PX: float = 12.0
const _PLAYER_BODY_HEIGHT_PX: float = 14.0

const _WALL_COLOR: Color = Color(0.28, 0.28, 0.28)
const _FLOOR_COLOR: Color = Color(0.22, 0.22, 0.22)
## Grey-box player body colour — deliberately not final art (finding 8).
const _PLAYER_BODY_COLOR: Color = Color(0.85, 0.72, 0.2)
## Door visible-block colour (T-0403 bug 2) — warm brown-grey, distinct from
## the ladder colour below so the two are tellable apart at a glance.
const _DOOR_VISUAL_COLOR: Color = Color(0.55, 0.42, 0.18)
## Ladder visible-block colour (T-0403 bug 3) — cool blue-grey.
const _LADDER_VISUAL_COLOR: Color = Color(0.3, 0.5, 0.62)

var _layout: RefCounted  ## RoomLayout
var _room_nodes: Dictionary = {}  ## anchor_tag -> Node2D
var _connector_records: Array = []  ## Array[Dictionary{from, to, type, branch}]
## anchor_tag -> Rect2i — every room's WORLD-space tile rect (T-0403 bottom-up
## remap: entry_room ends up at the greatest world y, tear_room at the least),
## computed once per build_level() by _compute_world_rects(). Authored origins
## stay untouched in _layout itself — this is a presentation-layer remap, not
## an edit to the source-of-truth layout data.
var _world_rect_tiles_by_tag: Dictionary = {}
## "<from_tag>|<to_tag>" -> Rect2 — the trigger area, inside from_tag, that
## fires a transition to to_tag.
var _trigger_by_pair: Dictionary = {}
## "<from_tag>|<to_tag>" -> {"position": Vector2, "floor_y": float} — where
## the player lands, and its new floor_y, when transitioning from_tag -> to_tag.
var _arrivals: Dictionary = {}
## "<from_tag>|<to_tag>" -> "door"/"ladder" — the connection type, used by the
## contextual interact prompt to choose its verb.
var _connector_type_by_pair: Dictionary = {}
## "<from_tag>|<to_tag>" -> CanvasItem — both directions of one connector map
## to the SAME visible block (T-0403 bugs 2/3), one physical opening.
var _connector_visual_by_pair: Dictionary = {}
## Unique visible-block nodes, one per connector — kept separately from
## _connector_visual_by_pair (which stores each node under both direction
## keys) so build_level()'s idempotent rebuild frees each node exactly once.
var _connector_visual_nodes: Array = []

var _player: CharacterBody2D
var _camera: Camera2D
var _prompt_label: Label
var _first_run: Node
var _room_built: bool = false
var _current_room_tag: String = ""
var _room_change_count: int = 0
var _load_error: String = ""


func _ready() -> void:
	## Decoupled from _physics_process (tests build a live instance with
	## set_physics_process(false), driving physics via direct apply_input() +
	## awaited physics_frame calls instead) so the interact prompt still
	## tracks the player under that harness too.
	get_tree().physics_frame.connect(_update_interaction_prompt)

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
	## Idempotent: frees any previously-built room/player nodes first. Without
	## this, calling build_level() a second time on an already-_ready() (and
	## thus already-built) instance — as tests/test_main_scene_boot.gd-style
	## live-tree harnesses do — leaves the first build's nodes orphaned but
	## still live in the tree, including a second, physically-live
	## PlayerController with its own collision shape, silently colliding with
	## the one callers actually track via get_player().
	for room_node: Node2D in _room_nodes.values():
		if is_instance_valid(room_node):
			room_node.free()
	if is_instance_valid(_player):
		_player.free()
	if is_instance_valid(_prompt_label):
		_prompt_label.free()
	for visual: Node in _connector_visual_nodes:
		if is_instance_valid(visual):
			visual.free()

	_load_error = ""
	_room_nodes = {}
	_connector_records = []
	_world_rect_tiles_by_tag = {}
	_trigger_by_pair = {}
	_arrivals = {}
	_connector_type_by_pair = {}
	_connector_visual_by_pair = {}
	_connector_visual_nodes = []

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

	_world_rect_tiles_by_tag = _compute_world_rects(_layout)

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
		## A ladder never carves the FLOOR ("bottom") strip, even when
		## a_side/b_side resolves to "bottom" for whichever room sits below
		## its neighbour — only the "top" (ceiling) side, if any, gets a
		## visual gap. Climbing is E-press only, never a physical
		## walk-through (see _on_player_interact()), so a ladder needs no
		## floor opening to function — but PlayerController is a
		## GROUNDED-mode CharacterBody2D pinned to floor_y every frame, and
		## a real floor gap mid-room is a ledge it cannot walk across
		## (confirmed T-0403: equipment_floor's own floor gap, from its
		## ladder down to power_substation, physically stopped the player
		## dead partway across while walking on toward the antenna_shaft
		## connector on the room's far side). Doors are unaffected — they
		## are only ever "left"/"right" and are meant to be walked through.
		if not (conn["type"] == "ladder" and geo["a_side"] == "bottom"):
			openings[conn["from"]][geo["a_side"]].append(geo["a_range"])
		if not (conn["type"] == "ladder" and geo["b_side"] == "bottom"):
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


## Returns the tags of every room container actually built — the built set,
## not the canonical tag list, so a stray room built for a tag outside the
## canonical seven is observable by a caller that iterates this instead of
## the tag list.
func get_built_room_tags() -> Array:
	return _room_nodes.keys()


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


## Returns the camera following the player, or null.
func get_camera() -> Camera2D:
	return _camera


## Returns the interaction prompt's current world-space position, or
## Vector2.ZERO if it hasn't been built yet.
func get_interaction_prompt_global_position() -> Vector2:
	return _prompt_label.global_position if _prompt_label != null else Vector2.ZERO


## Returns the anchor tag of the room the player currently occupies.
func get_current_room_tag() -> String:
	return _current_room_tag


## Returns how many times _on_player_interact() actually changed rooms.
func get_room_change_count() -> int:
	return _room_change_count


## Returns [param tag]'s WORLD-space pixel rect (T-0403 bug 1): the authored
## RoomLayout.get_rect_px() remapped so entry_room ends up at the greatest
## world y (bottom of the tower) and tear_room at the least (top), with the
## chain climbing upward in between. Same size as the authored rect — only
## the y origin changes. See _compute_world_rects().
func get_room_world_rect(tag: String) -> Rect2:
	return _world_rect_px(tag)


## Returns the visible drawable block (T-0403 bugs 2/3) marking the door or
## ladder connecting [param from_tag] and [param to_tag], or null if no such
## connector exists. One physical block per connector — looking it up by
## either direction returns the same node.
func get_connector_visual(from_tag: String, to_tag: String) -> CanvasItem:
	return _connector_visual_by_pair.get("%s|%s" % [from_tag, to_tag], null)


# ── Room geometry ────────────────────────────────────────────────────────────

## Reflects every room's authored tile rect about the vertical centre of the
## layout's own bounding box, keeping x and each room's size untouched — only
## the y origin moves. This is what puts entry_room at the greatest world y
## (bottom) and tear_room at the least (top) with everything in between
## climbing upward in the same order the authored connectivity already
## chains them (T-0403 bug 1, reading B): a reflection is order-reversing, so
## a chain that was authored top-to-bottom comes out bottom-to-top in world
## space with no per-room special-casing and no hardcoded tag.
func _compute_world_rects(layout: RefCounted) -> Dictionary:
	var tags: Array = layout.get_all_tags()
	var y_min: int = 0
	var y_max: int = 0
	var first: bool = true
	for tag: String in tags:
		var rect: Rect2i = layout.get_rect_tiles(tag)
		if first:
			y_min = rect.position.y
			y_max = rect.end.y
			first = false
		else:
			y_min = mini(y_min, rect.position.y)
			y_max = maxi(y_max, rect.end.y)

	var result: Dictionary = {}
	for tag: String in tags:
		var rect: Rect2i = layout.get_rect_tiles(tag)
		var world_origin_y: int = y_min + y_max - rect.end.y
		result[tag] = Rect2i(Vector2i(rect.position.x, world_origin_y), rect.size)
	return result


func _world_rect_tiles(tag: String) -> Rect2i:
	return _world_rect_tiles_by_tag[tag]


func _world_rect_px(tag: String) -> Rect2:
	var rect: Rect2i = _world_rect_tiles(tag)
	return Rect2(Vector2(rect.position) * _layout.tile_size_px, Vector2(rect.size) * _layout.tile_size_px)


func _floor_row_global(tag: String) -> int:
	var rect: Rect2i = _world_rect_tiles(tag)
	return rect.position.y + rect.size.y - 1


func _floor_y_px(tag: String) -> float:
	return float(_floor_row_global(tag)) * float(_layout.tile_size_px)


## World-space [x_min, x_max) of [param tag]'s INTERIOR columns — inset one
## tile from its own left/right walls, matching _ladder_geometry()'s own
## interior inset so a landing point placed within these bounds never spawns
## inside a wall collider.
func _room_interior_x_bounds(tag: String) -> Vector2:
	var rect: Rect2i = _world_rect_tiles(tag)
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


## Returns [param rect]'s own DOOR_OPENING_TILES-tall window, ending at
## (and including) [param floor_row], clamped within rect's own [position.y,
## end.y) — the rows a player standing in that specific room actually
## occupies at its floor. Shared by both sides of _door_geometry() so
## neither room's share of a door's span can land outside its own box.
func _door_floor_window(rect: Rect2i, floor_row: int) -> Vector2i:
	var span1: int = clampi(floor_row + 1, rect.position.y, rect.end.y)
	var span0: int = clampi(span1 - DOOR_OPENING_TILES, rect.position.y, rect.end.y)
	return Vector2i(span0, span1)


## Door opening geometry: the opening is anchored at the shared floor row of
## both connected rooms, not the vertical midpoint of their overlap — the
## committed layout deliberately floor-aligns every door pair (T-0390
## planner finding 5).
func _door_geometry(conn: Dictionary) -> Dictionary:
	var a_tag: String = conn["from"]
	var b_tag: String = conn["to"]
	var rect_a: Rect2i = _world_rect_tiles(a_tag)
	var rect_b: Rect2i = _world_rect_tiles(b_tag)
	var tile_size: int = _layout.tile_size_px

	## Each room's own DOOR_OPENING_TILES window, anchored at ITS OWN floor
	## row and clamped within ITS OWN extent, then UNIONED — not a_tag's
	## window alone. Post-T-0403 world remap, two rooms tied at the same
	## authored end row (finding 5's floor-sharing pairs) no longer
	## necessarily share a world FLOOR row too: get_room_world_rect() ties
	## their world ORIGIN (top), not their floor, when their heights differ
	## (e.g. ground_relay h=9 vs records_room h=7) — so a_tag's floor and
	## b_tag's floor can now sit a few rows apart. Anchoring the opening to
	## a_tag's floor alone left b_tag's own share of the span clamped to
	## whatever fell inside its shorter box — which, worked out, landed
	## entirely BELOW b_tag's own floor_y (the room's solid floor tile
	## itself, not the rows above it the player's body actually occupies),
	## carving a gap the player could stand next to but never physically
	## reach (confirmed T-0403: ground_relay <-> records_room). Unioning
	## each room's own floor-anchored window guarantees both sides open at
	## the height their own player body actually walks through, even though
	## the two floors no longer align — a small step across the doorway,
	## not a legitimate but unreachable hole.
	var window_a: Vector2i = _door_floor_window(rect_a, _floor_row_global(a_tag))
	var window_b: Vector2i = _door_floor_window(rect_b, _floor_row_global(b_tag))
	var span0: int = mini(window_a.x, window_b.x)
	var span1: int = maxi(window_a.y, window_b.y)

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
	var rect_a: Rect2i = _world_rect_tiles(a_tag)
	var rect_b: Rect2i = _world_rect_tiles(b_tag)
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
	var origin_px: Vector2 = get_room_world_rect(tag).position
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

	_trigger_by_pair["%s|%s" % [a_tag, b_tag]] = area_a
	_trigger_by_pair["%s|%s" % [b_tag, a_tag]] = area_b

	_arrivals["%s|%s" % [a_tag, b_tag]] = {"position": arrival_b, "floor_y": _floor_y_px(b_tag)}
	_arrivals["%s|%s" % [b_tag, a_tag]] = {"position": arrival_a, "floor_y": _floor_y_px(a_tag)}

	_connector_type_by_pair["%s|%s" % [a_tag, b_tag]] = conn["type"]
	_connector_type_by_pair["%s|%s" % [b_tag, a_tag]] = conn["type"]

	## The visible block (T-0403 bugs 2/3) covers the union of both trigger
	## areas — for a door that's a plate straddling the shared wall boundary;
	## for a ladder, since area_a/area_b sit at each room's own floor_y, the
	## union spans the full vertical run connecting the two floors, reading
	## as a ladder shaft. Deliberately just a ColorRect: no collision shape,
	## no Area2D/StaticBody2D, so it never blocks or captures the player
	## (T-0403 bug 4) — walking is free; only an explicit E press climbs.
	var visual_color: Color = _DOOR_VISUAL_COLOR if conn["type"] == "door" else _LADDER_VISUAL_COLOR
	_add_connector_visual(a_tag, b_tag, area_a.merge(area_b), visual_color)

	_connector_records.append({
		"from": a_tag, "to": b_tag, "type": conn["type"], "branch": conn.get("branch", false),
	})


## Builds the drawable, non-colliding visible block for one connector and
## registers it under both direction keys of _connector_visual_by_pair.
func _add_connector_visual(a_tag: String, b_tag: String, rect: Rect2, color: Color) -> void:
	var visual := ColorRect.new()
	visual.name = "ConnectorVisual_%s_%s" % [a_tag.replace(".", "_"), b_tag.replace(".", "_")]
	visual.position = rect.position
	visual.size = rect.size
	visual.color = color
	add_child(visual)

	_connector_visual_nodes.append(visual)
	_connector_visual_by_pair["%s|%s" % [a_tag, b_tag]] = visual
	_connector_visual_by_pair["%s|%s" % [b_tag, a_tag]] = visual


# ── Player ───────────────────────────────────────────────────────────────────

func _build_player() -> void:
	_player = _PlayerScript.new()
	_player.name = "Player"
	## room_connectors stays empty (T-0390 fix round 2) — doors and ladders
	## are press-E interactables, not overlap triggers. Feeding it here would
	## make PlayerController.update_state() emit room_transition on every
	## physics frame the player merely stands in a connector's area.

	## PlayerController (T-0188) builds no CollisionShape2D of its own — without
	## one, every wall/floor StaticBody2D this level builds is inert against the
	## player. Not centred on position: floor_y is the TOP edge of the floor
	## row (see _floor_y_px()), so the shape is offset upward by its full
	## height, putting its bottom edge (the player's feet) exactly on floor_y
	## rather than half-sinking into the floor collider.
	var collision := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = Vector2(_PLAYER_BODY_WIDTH_PX, _PLAYER_BODY_HEIGHT_PX)
	collision.shape = box
	collision.position = Vector2(0.0, -_PLAYER_BODY_HEIGHT_PX * 0.5)
	_player.add_child(collision)

	## Grey-box visual body (T-0390 fix round 3, P1 b) — a plain ColorRect, no
	## Sprite2D/TextureRect and no final-art texture path (finding 8). ColorRect's
	## position is its TOP-LEFT, unlike CollisionShape2D's centred convention
	## above, so its bottom edge (not a shared offset) is what's placed at
	## floor_y: top-left x is -half width to stay horizontally centred, and
	## top-left y is -full height so the bottom edge sits at y = 0 (floor_y).
	var body := ColorRect.new()
	body.name = "Body"
	body.size = Vector2(_PLAYER_BODY_WIDTH_PX, _PLAYER_BODY_HEIGHT_PX)
	body.position = Vector2(-_PLAYER_BODY_WIDTH_PX * 0.5, -_PLAYER_BODY_HEIGHT_PX)
	body.color = _PLAYER_BODY_COLOR
	_player.add_child(body)

	_current_room_tag = _layout.entry_room
	_player.floor_y = _floor_y_px(_current_room_tag)
	_player.position = _spawn_position()
	_player.interact_pressed.connect(_on_player_interact)

	## _player must already be inside the tree before Camera2D.make_current()
	## is legal to call (Camera2D errors "!enabled || !is_inside_tree()"
	## otherwise) — add_child(_player) here, before building the camera,
	## rather than at the end of this function as the pre-camera code did.
	## _build_detached_instance()-style tests call build_level() on an
	## instance never added to any SceneTree; _player then never enters the
	## tree either, so the is_inside_tree() guard below simply leaves the
	## camera constructed but not current for those — geometry-only tests
	## never look at it.
	add_child(_player)

	## Camera2D (T-0390 fix round 3, P1 a) — child of the player so it tracks
	## position automatically with no extra per-frame code, clamped every
	## room transition to the active room's own rect (_update_camera_limits())
	## so a room wider/taller than the 384x216 viewport pans instead of
	## showing area outside the room, and a room smaller than the viewport
	## centres instead of showing the neighbouring room through open walls.
	_camera = Camera2D.new()
	_camera.name = "Camera2D"
	_player.add_child(_camera)
	if _camera.is_inside_tree():
		_camera.make_current()
	_update_camera_limits(_current_room_tag)

	_build_prompt()


## Spawn point inside the layout's entry room, derived from its WORLD rect
## (T-0403 bug 1) — horizontal centre, at the room's own floor row.
func _spawn_position() -> Vector2:
	var rect: Rect2 = get_room_world_rect(_layout.entry_room)
	return Vector2(rect.position.x + rect.size.x * 0.5, _floor_y_px(_layout.entry_room))


## Clamps the following camera to [param tag]'s own WORLD rect (T-0403 bug
## 1), so a room wider or taller than the viewport pans instead of showing
## whatever lies past the room's walls. Called once at spawn and again on
## every room transition (_on_player_interact()) — the room the player is
## logically in is the only thing that changes; the camera itself stays a
## permanent child of the player.
func _update_camera_limits(tag: String) -> void:
	if _camera == null:
		return
	var rect: Rect2 = get_room_world_rect(tag)
	_camera.limit_left = int(rect.position.x)
	_camera.limit_top = int(rect.position.y)
	_camera.limit_right = int(rect.position.x + rect.size.x)
	_camera.limit_bottom = int(rect.position.y + rect.size.y)
	_camera.reset_smoothing()


## The contextual "[E] ..." prompt Label, hidden until the player stands in a
## connector's area. World-space positioned (tracks the player directly)
## rather than a CanvasLayer overlay — sufficient for a grey-box level with
## no camera/viewport concerns of its own.
func _build_prompt() -> void:
	_prompt_label = Label.new()
	_prompt_label.name = "InteractionPrompt"
	_prompt_label.visible = false
	add_child(_prompt_label)


## Handles PlayerController.interact_pressed (E/Space). Finds whichever
## connector area the player is currently standing in and performs the
## transition — bookkeeping (current room tag + floor_y) plus a landing
## placement, not a scene swap. Does nothing if the player isn't standing in
## any connector's area (T-0390 fix round 2: overlap alone never transitions,
## only an explicit E press does).
func _on_player_interact() -> void:
	var key: String = _connector_key_at_player()
	if key == "":
		return
	if not _arrivals.has(key):
		return

	var arrival: Dictionary = _arrivals[key]
	var target_room_id: String = key.split("|")[1]
	_current_room_tag = target_room_id
	_player.floor_y = arrival["floor_y"]
	_player.position = arrival["position"]
	_update_camera_limits(_current_room_tag)
	_room_change_count += 1


## Returns the "<from_tag>|<to_tag>" key of the connector trigger the player
## is currently standing inside, scoped to the room the player is logically
## in (_current_room_tag) so a connector whose area happens to be reachable
## from the wrong logical side is never picked. Returns "" if the player is
## not standing in any connector belonging to their current room. Shared by
## _on_player_interact() and _update_interaction_prompt() so the prompt and
## the E handler always agree on what "inside a connector" means.
func _connector_key_at_player() -> String:
	if _player == null:
		return ""
	var prefix: String = _current_room_tag + "|"
	for key: String in _trigger_by_pair.keys():
		if not (key as String).begins_with(prefix):
			continue
		var area: Rect2 = _trigger_by_pair[key]
		if area.has_point(_player.position):
			return key
	return ""


## Connected to SceneTree.physics_frame in _ready() — updates regardless of
## whether this level's own _physics_process is enabled (tests disable it,
## driving physics via direct apply_input() + awaited physics_frame calls
## instead of the level's automatic Input polling).
func _update_interaction_prompt() -> void:
	if _player == null or _prompt_label == null:
		return
	var key: String = _connector_key_at_player()
	if key == "":
		_prompt_label.visible = false
		return
	var conn_type: String = _connector_type_by_pair.get(key, "")
	_prompt_label.text = "[E] Climb" if conn_type == "ladder" else "[E] Enter"
	_prompt_label.position = _player.position + Vector2(-20.0, -24.0)
	_prompt_label.visible = true


## Returns whether the contextual interact prompt is currently visible.
func get_interaction_prompt_visible() -> bool:
	return _prompt_label != null and _prompt_label.visible


## Returns the contextual interact prompt's current text, or "" if it has
## none (or hasn't been built yet).
func get_interaction_prompt_text() -> String:
	return _prompt_label.text if _prompt_label != null else ""


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
