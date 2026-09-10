## SignalTowerOverview — all seven Signal Tower rooms on one scrollable scene (T-0328).
##
## Renders the archetype's geometry proof: every room from
## res://signal_tower/layouts/signal_tower_v1.json (loaded via RoomLayout, the
## single source of truth for room size/origin/connectivity — never
## hardcoded here) built at its authored world position, using the real
## committed tiles at assets/final/tiles/signal_tower/ (16 px grid, D-16). A
## scrolling camera follows a grey-box placeholder player (the same
## PlayerController convention used by scripts/blockout_room.gd) so the whole
## archetype can be walked and judged as a place.
##
## This is a layout/connectivity proof, not the side-on gameplay runtime —
## the player moves freely in both axes (no floor-plane lock, no gravity) so
## a door (branch, horizontal) and a ladder (main path, vertical) are both
## just openings in a room's wall the player can walk through. Room shells
## are grey-box: perimeter walls + a floor strip, no props wired (T-0328
## scope: geometry and assembly, not the T-0247 prop consolidation). No
## dependency on finished character art — the player is built entirely from
## ColorRect/CollisionShape2D, no sprite or texture asset.
extends Node2D

const _RoomLayoutScript: GDScript = preload("res://signal_tower/room_layout.gd")
const _PlayerScript: GDScript = preload("res://scripts/player_controller.gd")

const LAYOUT_PATH: String = "res://signal_tower/layouts/signal_tower_v1.json"

## Committed Signal Tower tile textures (assets/final/tiles/signal_tower/, D-16).
## Loaded via a relative filesystem path since these live outside the Godot
## project root (client/) — assets/final/ is shared across every subsystem,
## not duplicated into client/.
const WALL_TEXTURE_PATH: String = "res://../assets/final/tiles/signal_tower/wall_16px.png"
const FLOOR_TEXTURE_PATH: String = "res://../assets/final/tiles/signal_tower/floor_16px.png"

const TILE_SIZE: int = 16

## Width, in tiles, of every authored door/ladder opening.
const OPENING_SPAN: int = 2

const DOOR_COLOR: Color = Color(0.7, 0.3, 0.05, 0.85)
const LADDER_COLOR: Color = Color(0.2, 0.55, 0.65, 0.85)

var _layout: RefCounted  ## RoomLayout
var _room_nodes: Dictionary = {}  ## anchor_tag -> Node2D
var _connector_records: Array = []  ## Array[Dictionary{from, to, type, branch, node}]
var _player: CharacterBody2D
var _camera: Camera2D

var _wall_texture: Texture2D
var _floor_texture: Texture2D


func _ready() -> void:
	build_layout()


## Loads the layout spec and builds the full scene tree. Callable directly
## (independent of _ready()) so tests can inspect the built structure without
## a live SceneTree — the same pattern this repo uses for other code-driven
## scenes (see blockout_room.gd's test coverage).
func build_layout() -> void:
	_layout = _RoomLayoutScript.new()
	var err: String = _layout.load_from_path(LAYOUT_PATH)
	if err != "":
		push_error("SignalTowerOverview: failed to load layout — %s" % err)
		_layout = null
		return

	_load_textures()

	var openings: Dictionary = _compute_openings(_layout)
	for tag: String in _layout.get_all_tags():
		_build_room(tag, openings[tag])

	_build_connectors()
	_build_player()
	_build_camera()


## Returns the loaded RoomLayout, or null if loading failed.
func get_layout() -> RefCounted:
	return _layout


## Returns the built room container for [param tag], or null.
func get_room_node(tag: String) -> Node2D:
	return _room_nodes.get(tag, null)


## Returns one record per built connector marker: {from, to, type, branch, node}.
func get_connector_records() -> Array:
	return _connector_records.duplicate()


## Returns the built grey-box player, or null.
func get_player() -> CharacterBody2D:
	return _player


## Returns the built scrolling camera, or null.
func get_camera() -> Camera2D:
	return _camera


# ── Texture loading ────────────────────────────────────────────────────────────

func _load_textures() -> void:
	_wall_texture = _load_texture(WALL_TEXTURE_PATH)
	_floor_texture = _load_texture(FLOOR_TEXTURE_PATH)


func _load_texture(path: String) -> Texture2D:
	var image := Image.new()
	var err: int = image.load(path)
	if err != OK:
		push_error("SignalTowerOverview: failed to load tile texture %s (error %d)" % [path, err])
		return null
	return ImageTexture.create_from_image(image)


# ── Connector geometry ──────────────────────────────────────────────────────────
# A "door" connection is between horizontally-adjacent rooms sharing a
# vertical wall — the opening is a gap in that wall spanning a few tiles of
# height. A "ladder" connection is between vertically-stacked rooms sharing a
# horizontal wall — the opening spans a few tiles of width. Both are derived
# purely from the two rooms' authored rects; no connector position is
# separately authored (single source of truth: room geometry alone).

## Returns geometry for one connection: which side of each room the opening
## falls on (in local-tile terms), the opening's tile-range on each room's
## boundary, and its world-space (px) placement for a connector marker.
func _connection_geometry(conn: Dictionary) -> Dictionary:
	var a_tag: String = conn["from"]
	var b_tag: String = conn["to"]
	var rect_a: Rect2i = _layout.get_rect_tiles(a_tag)
	var rect_b: Rect2i = _layout.get_rect_tiles(b_tag)

	if conn["type"] == "door":
		var y0: int = max(rect_a.position.y, rect_b.position.y)
		var y1: int = min(rect_a.end.y, rect_b.end.y)
		var mid: int = int((y0 + y1) / 2.0)
		var span0: int = max(y0, mid - int(OPENING_SPAN / 2.0))
		var span1: int = min(y1, span0 + OPENING_SPAN)
		var a_is_left: bool = rect_a.position.x < rect_b.position.x
		var world_x: float = float(rect_a.end.x if a_is_left else rect_b.end.x)
		return {
			"a_side": "right" if a_is_left else "left",
			"b_side": "left" if a_is_left else "right",
			"a_range": [span0 - rect_a.position.y, span1 - rect_a.position.y],
			"b_range": [span0 - rect_b.position.y, span1 - rect_b.position.y],
			"world_pos": Vector2(world_x * TILE_SIZE, (span0 + span1) * 0.5 * TILE_SIZE),
			"opening_size_px": Vector2(float(OPENING_SPAN) * 0.5, float(span1 - span0) * TILE_SIZE),
		}
	else:
		var x0: int = max(rect_a.position.x, rect_b.position.x)
		var x1: int = min(rect_a.end.x, rect_b.end.x)
		var midx: int = int((x0 + x1) / 2.0)
		var spanx0: int = max(x0, midx - int(OPENING_SPAN / 2.0))
		var spanx1: int = min(x1, spanx0 + OPENING_SPAN)
		var a_is_top: bool = rect_a.position.y < rect_b.position.y
		var world_y: float = float(rect_a.end.y if a_is_top else rect_b.end.y)
		return {
			"a_side": "bottom" if a_is_top else "top",
			"b_side": "top" if a_is_top else "bottom",
			"a_range": [spanx0 - rect_a.position.x, spanx1 - rect_a.position.x],
			"b_range": [spanx0 - rect_b.position.x, spanx1 - rect_b.position.x],
			"world_pos": Vector2((spanx0 + spanx1) * 0.5 * TILE_SIZE, world_y * TILE_SIZE),
			"opening_size_px": Vector2(float(spanx1 - spanx0) * TILE_SIZE, float(OPENING_SPAN) * 0.5),
		}


## Returns, per anchor tag, the local-tile ranges to leave open on each of the
## room's four sides ("left"/"right"/"top"/"bottom"), derived from every
## connection touching that room.
func _compute_openings(layout: RefCounted) -> Dictionary:
	var openings: Dictionary = {}
	for tag: String in layout.get_all_tags():
		openings[tag] = {"left": [], "right": [], "top": [], "bottom": []}

	for conn: Dictionary in layout.get_connections():
		var geo: Dictionary = _connection_geometry(conn)
		openings[conn["from"]][geo["a_side"]].append(geo["a_range"])
		openings[conn["to"]][geo["b_side"]].append(geo["b_range"])

	return openings


## Returns the kept (non-excluded) [start, end) sub-ranges of [0, length),
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


# ── Room shell construction ──────────────────────────────────────────────────────

func _build_room(tag: String, openings: Dictionary) -> void:
	var size: Vector2i = _layout.get_size_tiles(tag)
	var room_node := Node2D.new()
	room_node.name = tag.replace(".", "_")
	room_node.position = _layout.get_rect_px(tag).position
	add_child(room_node)
	_room_nodes[tag] = room_node

	# Top wall row, full width, minus ladder openings from above.
	for seg: Array in _kept_segments(size.x, openings["top"]):
		_paint_run(room_node, _wall_texture, Vector2i(seg[0], 0), seg[1] - seg[0], true)
		_add_collider(room_node, Vector2i(seg[0], 0), Vector2i(seg[1] - seg[0], 1))

	# Left wall column, full height, minus door openings on the left.
	for seg: Array in _kept_segments(size.y, openings["left"]):
		_paint_run(room_node, _wall_texture, Vector2i(0, seg[0]), seg[1] - seg[0], false)
		_add_collider(room_node, Vector2i(0, seg[0]), Vector2i(1, seg[1] - seg[0]))

	# Right wall column, full height, minus door openings on the right.
	for seg: Array in _kept_segments(size.y, openings["right"]):
		_paint_run(room_node, _wall_texture, Vector2i(size.x - 1, seg[0]), seg[1] - seg[0], false)
		_add_collider(room_node, Vector2i(size.x - 1, seg[0]), Vector2i(1, seg[1] - seg[0]))

	# Floor strip along the bottom interior row, minus ladder openings below.
	for seg: Array in _kept_segments(size.x, openings["bottom"]):
		var start: int = maxi(seg[0], 1)
		var end: int = mini(seg[1], size.x - 1)
		if end > start:
			_paint_run(room_node, _floor_texture, Vector2i(start, size.y - 1), end - start, true)

	var label := Label.new()
	label.text = _layout.get_display_name(tag)
	label.add_theme_font_size_override("font_size", 8)
	label.position = Vector2(TILE_SIZE, TILE_SIZE * 0.25)
	room_node.add_child(label)


## Paints [param count] tiles of [param texture] starting at local tile
## [param start], running horizontally if [param horizontal] else vertically.
func _paint_run(
	room_node: Node2D, texture: Texture2D, start: Vector2i, count: int, horizontal: bool
) -> void:
	if texture == null:
		return
	for i: int in range(count):
		var sprite := Sprite2D.new()
		sprite.texture = texture
		sprite.centered = false
		var cell: Vector2i = start + (Vector2i(i, 0) if horizontal else Vector2i(0, i))
		sprite.position = Vector2(cell) * TILE_SIZE
		room_node.add_child(sprite)


## Adds a StaticBody2D collider matching a run of wall tiles, in local tile
## coordinates, so the grey-box player collides with authored walls.
func _add_collider(room_node: Node2D, start: Vector2i, size_tiles: Vector2i) -> void:
	var body := StaticBody2D.new()
	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	var size_px: Vector2 = Vector2(size_tiles) * TILE_SIZE
	box.size = size_px
	shape.position = Vector2(start) * TILE_SIZE + size_px * 0.5
	shape.shape = box
	body.add_child(shape)
	room_node.add_child(body)


# ── Connector markers ────────────────────────────────────────────────────────────

func _build_connectors() -> void:
	var container := Node2D.new()
	container.name = "Connectors"
	add_child(container)

	for conn: Dictionary in _layout.get_connections():
		var geo: Dictionary = _connection_geometry(conn)
		var marker := Node2D.new()
		marker.position = geo["world_pos"]
		container.add_child(marker)

		var visual := ColorRect.new()
		var size_px: Vector2 = geo["opening_size_px"]
		visual.size = size_px
		visual.position = -size_px * 0.5
		visual.color = LADDER_COLOR if conn["type"] == "ladder" else DOOR_COLOR
		marker.add_child(visual)

		var label := Label.new()
		label.text = "LADDER" if conn["type"] == "ladder" else "DOOR"
		label.add_theme_font_size_override("font_size", 6)
		label.position = Vector2(-size_px.x * 0.5, -size_px.y * 0.5 - 8.0)
		marker.add_child(label)

		_connector_records.append({
			"from": conn["from"],
			"to": conn["to"],
			"type": conn["type"],
			"branch": conn["branch"],
			"node": marker,
		})


# ── Player + camera ──────────────────────────────────────────────────────────────

## Player spawn point, in tiles, relative to Ground Relay's origin — clear of
## the ladder opening on its right/bottom edges.
const PLAYER_SPAWN_LOCAL_TILES: Vector2i = Vector2i(3, 4)

func _build_player() -> void:
	_player = _PlayerScript.new()
	_player.name = "Player"
	var relay_origin_px: Vector2 = _layout.get_rect_px(_layout.entry_room).position
	_player.position = relay_origin_px + Vector2(PLAYER_SPAWN_LOCAL_TILES) * TILE_SIZE
	add_child(_player)


func _build_camera() -> void:
	_camera = Camera2D.new()
	_camera.name = "Camera2D"
	_camera.position_smoothing_enabled = true

	var bounds: Rect2 = _layout.get_bounding_rect_px()
	_camera.limit_left = int(bounds.position.x)
	_camera.limit_top = int(bounds.position.y)
	_camera.limit_right = int(bounds.end.x)
	_camera.limit_bottom = int(bounds.end.y)

	_player.add_child(_camera)
	# Only current-able once actually inside a live tree (real gameplay usage
	# via _ready()) — build_layout() is also called standalone by tests on a
	# detached instance, where make_current() would error.
	if _camera.is_inside_tree():
		_camera.make_current()
