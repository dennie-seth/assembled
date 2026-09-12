## Authored Signal Tower geometry (T-0328).
##
## Loads a committed layout spec (client/signal_tower/layouts/*.json) that
## gives every room a size (tiles) and an origin coordinate, plus the
## door/ladder connections between them. Pure data + validation — no nodes,
## no rendering. A future variant is a second JSON file, never a code edit
## (see 14-vertical-slice.md §10 and 16-level-design.md §4: connectivity and
## room dimensions are free to vary per variant).
##
## The overview scene (res://scenes/signal_tower_overview.gd) reads this to
## build the actual scene tree; tests read it to assert the acceptance
## criteria directly against the spec.
class_name RoomLayout
extends RefCounted

const _ChainSideonScript: GDScript = preload("res://signal_tower/signal_tower_chain_sideon.gd")

## Canonical Signal Tower entry/tear rooms (14-vertical-slice.md §10).
const EXPECTED_ENTRY_ROOM: String = "signal_tower.ground_relay"
const EXPECTED_TEAR_ROOM: String = "signal_tower.broadcast_deck"

var tile_size_px: int = 16
var entry_room: String = ""
var tear_room: String = ""

## anchor_tag -> {anchor_tag, display_name, origin: Vector2i, size: Vector2i, shape_reasoning}
var _rooms: Dictionary = {}

## Array[Dictionary{from, to, type, branch}]
var _connections: Array = []


## Load and parse a layout spec from a res:// JSON path.
## @return "" on success, or a human-readable error string on failure
##         (missing file, invalid JSON, or a malformed room/connection entry).
func load_from_path(path: String) -> String:
	if not FileAccess.file_exists(path):
		return "layout file not found: %s" % path

	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if file == null:
		return "layout file could not be opened: %s" % path
	var text: String = file.get_as_text()
	file.close()

	var parsed: Variant = JSON.parse_string(text)
	if not (parsed is Dictionary):
		return "layout file is not a valid JSON object: %s" % path

	return _load_from_dict(parsed as Dictionary)


func _load_from_dict(data: Dictionary) -> String:
	tile_size_px = int(data.get("tile_size_px", 16))
	entry_room = str(data.get("entry_room", ""))
	tear_room = str(data.get("tear_room", ""))

	_rooms.clear()
	var raw_rooms: Array = data.get("rooms", [])
	for room_data: Variant in raw_rooms:
		if not (room_data is Dictionary):
			return "room entry is not a JSON object"
		var room_dict: Dictionary = room_data as Dictionary
		var tag: String = str(room_dict.get("anchor_tag", ""))
		if tag == "":
			return "room entry missing anchor_tag"
		if not room_dict.has("origin") or not room_dict.has("size"):
			return "room '%s' missing origin/size" % tag

		var origin_dict: Dictionary = room_dict["origin"]
		var size_dict: Dictionary = room_dict["size"]
		_rooms[tag] = {
			"anchor_tag": tag,
			"display_name": str(room_dict.get("display_name", tag)),
			"origin": Vector2i(int(origin_dict.get("x", 0)), int(origin_dict.get("y", 0))),
			"size": Vector2i(int(size_dict.get("w", 0)), int(size_dict.get("h", 0))),
			"shape_reasoning": str(room_dict.get("shape_reasoning", "")),
		}

	_connections.clear()
	var raw_connections: Array = data.get("connections", [])
	for conn_data: Variant in raw_connections:
		if not (conn_data is Dictionary):
			return "connection entry is not a JSON object"
		var conn_dict: Dictionary = conn_data as Dictionary
		_connections.append({
			"from": str(conn_dict.get("from", "")),
			"to": str(conn_dict.get("to", "")),
			"type": str(conn_dict.get("type", "")),
			"branch": bool(conn_dict.get("branch", false)),
		})

	return ""


## Returns all declared room anchor tags.
func get_all_tags() -> Array:
	return _rooms.keys()


## Returns true if a room with the given anchor tag was declared.
func has_room(tag: String) -> bool:
	return _rooms.has(tag)


## Returns the room's authored origin, in tile units.
func get_origin_tiles(tag: String) -> Vector2i:
	return _rooms[tag]["origin"]


## Returns the room's authored size, in tiles.
func get_size_tiles(tag: String) -> Vector2i:
	return _rooms[tag]["size"]


## Returns the room's display name.
func get_display_name(tag: String) -> String:
	return _rooms[tag]["display_name"]


## Returns the authored one-line justification for the room's dimensions.
func get_shape_reasoning(tag: String) -> String:
	return _rooms[tag]["shape_reasoning"]


## Returns the room's world-space rectangle, in tile units.
func get_rect_tiles(tag: String) -> Rect2i:
	return Rect2i(get_origin_tiles(tag), get_size_tiles(tag))


## Returns the room's world-space rectangle, in pixels (tile_size_px per tile).
func get_rect_px(tag: String) -> Rect2:
	var rect: Rect2i = get_rect_tiles(tag)
	return Rect2(Vector2(rect.position) * tile_size_px, Vector2(rect.size) * tile_size_px)


## Returns the union of every room's pixel rect — the full archetype's bounds.
func get_bounding_rect_px() -> Rect2:
	var bounds: Rect2 = Rect2()
	var first: bool = true
	for tag: String in get_all_tags():
		var rect: Rect2 = get_rect_px(tag)
		if first:
			bounds = rect
			first = false
		else:
			bounds = bounds.merge(rect)
	return bounds


## Returns a duplicate of the declared connections list.
func get_connections() -> Array:
	return _connections.duplicate(true)


## Returns descriptive strings for every pair of rooms whose tile rects
## overlap with non-zero area. Empty result = the layout has no overlaps.
func find_overlaps() -> Array[String]:
	var failures: Array[String] = []
	var tags: Array = get_all_tags()
	for i: int in range(tags.size()):
		for j: int in range(i + 1, tags.size()):
			var a: String = tags[i]
			var b: String = tags[j]
			var rect_a: Rect2i = get_rect_tiles(a)
			var rect_b: Rect2i = get_rect_tiles(b)
			if rect_a.intersects(rect_b):
				failures.append(
					"overlap: %s %s intersects %s %s" % [a, str(rect_a), b, str(rect_b)]
				)
	return failures


## Cross-checks the loaded rooms/connections against the canonical §10 room
## graph (SignalTowerChainSideon.ALL_TAGS / MAIN_NEXT / BRANCHES) — the same
## graph the side-on gameplay systems already use. Returns a list of mismatch
## descriptions; empty = the spec matches the graph exactly.
func find_connectivity_mismatches() -> Array[String]:
	var failures: Array[String] = []
	var chain: Object = _ChainSideonScript.new()
	var canonical_tags: Array = chain.get_all_tags()

	for tag: String in canonical_tags:
		if not has_room(tag):
			failures.append("missing room for canonical tag '%s'" % tag)
	for tag: String in get_all_tags():
		if not canonical_tags.has(tag):
			failures.append("layout declares unknown room tag '%s'" % tag)

	if entry_room != EXPECTED_ENTRY_ROOM:
		failures.append(
			"entry_room='%s', expected '%s'" % [entry_room, EXPECTED_ENTRY_ROOM]
		)
	if tear_room != EXPECTED_TEAR_ROOM:
		failures.append(
			"tear_room='%s', expected '%s'" % [tear_room, EXPECTED_TEAR_ROOM]
		)

	var expected_ladders: Dictionary = {}
	for tag: String in canonical_tags:
		var next_tag: String = chain.get_main_next(tag)
		if next_tag != "":
			expected_ladders["%s|%s" % [tag, next_tag]] = true

	var expected_doors: Dictionary = {}
	for tag: String in canonical_tags:
		for branch_tag: String in chain.get_branches_from(tag):
			expected_doors["%s|%s" % [tag, branch_tag]] = true

	var got_ladders: Dictionary = {}
	var got_doors: Dictionary = {}
	for conn: Dictionary in get_connections():
		var key: String = "%s|%s" % [conn["from"], conn["to"]]
		match conn["type"]:
			"ladder":
				got_ladders[key] = true
			"door":
				got_doors[key] = true
			_:
				failures.append("connection %s has unknown type '%s'" % [key, conn["type"]])

	for key: String in expected_ladders:
		if not got_ladders.has(key):
			failures.append("missing expected ladder connection %s" % key)
	for key: String in got_ladders:
		if not expected_ladders.has(key):
			failures.append("unexpected ladder connection %s" % key)

	for key: String in expected_doors:
		if not got_doors.has(key):
			failures.append("missing expected door connection %s" % key)
	for key: String in got_doors:
		if not expected_doors.has(key):
			failures.append("unexpected door connection %s" % key)

	return failures
