extends SceneTree
## T-0328: Signal Tower room geometry — layout spec + validator tests.
##
## The layout spec (client/signal_tower/layouts/signal_tower_v1.json) authors
## width/height (tiles) and an origin coordinate for every one of the seven
## Signal Tower rooms, per 14-vertical-slice.md §10's shape prose and room
## graph. RoomLayout (client/signal_tower/room_layout.gd) loads and validates
## that spec — this is pure data/logic, no scene tree required.
##
## Verifies:
##   1. The spec file loads without error
##   2. All seven §10 room tags are declared, tile_size_px == 16 (D-16)
##   3. entry_room / tear_room match Ground Relay / Broadcast Deck
##   4. No two rooms' tile rects overlap
##   5. Connectivity (door vs ladder, branch vs main path) matches the
##      canonical §10 graph exactly (SignalTowerChainSideon.MAIN_NEXT / BRANCHES)
##   6. Authored dimensions are consistent with §10's shape prose:
##      Ground Relay is the widest room; Antenna Shaft is far taller than it
##      is wide and is the tallest room; Storage Cache has the smallest floor
##      area
##   7. A layout with two overlapping rooms is correctly reported by
##      find_overlaps() (regression guard on the validator itself)
##   8. A layout missing a canonical connection is correctly reported by
##      find_connectivity_mismatches() (regression guard on the validator itself)
##
## Run headless (from client/):
##   godot --headless --script tests/test_T0328_room_layout.gd
## Exit 0 = PASS, exit 1 = FAIL.

const RoomLayout := preload("res://signal_tower/room_layout.gd")

const LAYOUT_PATH: String = "res://signal_tower/layouts/signal_tower_v1.json"

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


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_spec_loads()
	failures += _test_all_seven_rooms_declared()
	failures += _test_tile_size_is_16()
	failures += _test_entry_and_tear_rooms()
	failures += _test_no_overlaps()
	failures += _test_connectivity_matches_canonical_graph()
	failures += _test_ground_relay_is_widest()
	failures += _test_antenna_shaft_tall_and_narrow()
	failures += _test_storage_cache_is_smallest()
	failures += _test_overlap_detector_catches_synthetic_overlap()
	failures += _test_connectivity_detector_catches_missing_edge()

	if failures.is_empty():
		print("T-0328 PASS: room layout spec + validator verified (11 groups)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0328 FAIL: " + f)
		quit(1)


## Load the real committed spec. Returns a loaded RoomLayout, or null (with a
## failure appended to [param failures]) if loading failed.
func _load_real_layout(failures: Array[String]) -> RefCounted:
	var layout: RefCounted = RoomLayout.new()
	var err: String = layout.load_from_path(LAYOUT_PATH)
	if err != "":
		failures.append("spec_loads: %s" % err)
		return null
	return layout


func _test_spec_loads() -> Array[String]:
	var failures: Array[String] = []
	_load_real_layout(failures)
	return failures


func _test_all_seven_rooms_declared() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	for tag: String in ALL_SEVEN:
		if not layout.has_room(tag):
			failures.append("all_seven: layout is missing room '%s'" % tag)

	var declared: Array = layout.get_all_tags()
	if declared.size() != ALL_SEVEN.size():
		failures.append(
			"all_seven: expected exactly %d rooms, got %d" % [ALL_SEVEN.size(), declared.size()]
		)

	return failures


func _test_tile_size_is_16() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	if layout.tile_size_px != 16:
		failures.append("tile_size: expected 16 (D-16), got %d" % layout.tile_size_px)

	return failures


func _test_entry_and_tear_rooms() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	if layout.entry_room != GROUND_RELAY:
		failures.append("entry_room: expected '%s', got '%s'" % [GROUND_RELAY, layout.entry_room])
	if layout.tear_room != BROADCAST_DECK:
		failures.append("tear_room: expected '%s', got '%s'" % [BROADCAST_DECK, layout.tear_room])

	return failures


func _test_no_overlaps() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	var overlaps: Array[String] = layout.find_overlaps()
	for o: String in overlaps:
		failures.append("no_overlaps: %s" % o)

	return failures


func _test_connectivity_matches_canonical_graph() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	var mismatches: Array[String] = layout.find_connectivity_mismatches()
	for m: String in mismatches:
		failures.append("connectivity: %s" % m)

	return failures


## §10: "Ground Relay — Wide, single-height, open floor." It must be the
## widest room in the archetype.
func _test_ground_relay_is_widest() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	var ground_w: int = layout.get_size_tiles(GROUND_RELAY).x
	for tag: String in ALL_SEVEN:
		if tag == GROUND_RELAY:
			continue
		var w: int = layout.get_size_tiles(tag).x
		if w >= ground_w:
			failures.append(
				"ground_relay_widest: Ground Relay width %d must exceed %s width %d"
				% [ground_w, tag, w]
			)

	return failures


## §10: "Antenna Shaft — Narrow vertical shaft, winding ladder path." It must
## read as tall and narrow: much taller than it is wide, and the tallest room
## in the archetype.
func _test_antenna_shaft_tall_and_narrow() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	var size: Vector2i = layout.get_size_tiles(ANTENNA_SHAFT)
	if size.y <= size.x * 2:
		failures.append(
			"antenna_narrow: height %d must be more than double the width %d" % [size.y, size.x]
		)

	for tag: String in ALL_SEVEN:
		if tag == ANTENNA_SHAFT:
			continue
		var h: int = layout.get_size_tiles(tag).y
		if h >= size.y:
			failures.append(
				"antenna_tallest: Antenna Shaft height %d must exceed %s height %d"
				% [size.y, tag, h]
			)

	return failures


## §10: "Storage Cache — Small, cramped closet." It must have the smallest
## floor area of the seven rooms.
func _test_storage_cache_is_smallest() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = _load_real_layout(failures)
	if layout == null:
		return failures

	var cache_size: Vector2i = layout.get_size_tiles(STORAGE_CACHE)
	var cache_area: int = cache_size.x * cache_size.y
	for tag: String in ALL_SEVEN:
		if tag == STORAGE_CACHE:
			continue
		var s: Vector2i = layout.get_size_tiles(tag)
		var area: int = s.x * s.y
		if area <= cache_area:
			failures.append(
				"storage_smallest: Storage Cache area %d must be smaller than %s area %d"
				% [cache_area, tag, area]
			)

	return failures


## Regression guard: find_overlaps() must actually catch a synthetic overlap
## on a hand-built layout, not just pass because the real spec happens to be clean.
func _test_overlap_detector_catches_synthetic_overlap() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = RoomLayout.new()
	var err: String = layout.load_from_path(LAYOUT_PATH)
	if err != "":
		failures.append("overlap_detector_setup: %s" % err)
		return failures

	# Force Records Room to overlap Ground Relay by moving it on top.
	layout._rooms[RECORDS_ROOM]["origin"] = layout._rooms[GROUND_RELAY]["origin"]

	var overlaps: Array[String] = layout.find_overlaps()
	if overlaps.is_empty():
		failures.append(
			"overlap_detector: expected an overlap once Records Room was moved onto Ground Relay"
		)

	return failures


## Regression guard: find_connectivity_mismatches() must catch a missing edge,
## not just pass because the real spec happens to be complete.
func _test_connectivity_detector_catches_missing_edge() -> Array[String]:
	var failures: Array[String] = []
	var layout: RefCounted = RoomLayout.new()
	var err: String = layout.load_from_path(LAYOUT_PATH)
	if err != "":
		failures.append("connectivity_detector_setup: %s" % err)
		return failures

	layout._connections = layout._connections.filter(
		func(c: Dictionary) -> bool: return c["to"] != ANTENNA_SHAFT
	)

	var mismatches: Array[String] = layout.find_connectivity_mismatches()
	if mismatches.is_empty():
		failures.append(
			"connectivity_detector: expected a mismatch once the Antenna Shaft ladder was removed"
		)

	return failures
