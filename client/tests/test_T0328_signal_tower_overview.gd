extends SceneTree
## T-0328: Signal Tower overview scene — all seven rooms on one scrollable
## scene, grey-box placeholder player.
##
## Verifies:
##   1. res://scenes/signal_tower_overview.tscn exists and instantiates cleanly
##      (smoke test — same shape as test_blockout_room.gd's scene check)
##   2. build_layout() (called independently of _ready(), same pattern this repo
##      uses for testing code-driven scenes without a live SceneTree) produces
##      one room container per §10 anchor tag, positioned at the spec's authored
##      origin in world px
##   3. One connector marker node exists per authored connection (door/ladder),
##      each carrying its from/to/type so connectivity can be checked by
##      inspecting the built scene, not only the raw spec
##   4. A Camera2D exists with scroll limits covering the full archetype
##      bounding box — nothing is clipped off-scene
##   5. A single movable player node exists, built from the same grey-box
##      PlayerController used elsewhere (client/scripts/player_controller.gd),
##      spawned inside Ground Relay
##   6. The player's visuals are plain ColorRect/CollisionShape2D nodes only —
##      no Sprite2D/AnimatedSprite2D/texture reference — confirming zero
##      dependency on finished character art
##   7. The scene script's source never references the character walk sheet
##      (static regression guard against accidentally wiring in character art)
##
## Run headless (from client/):
##   godot --headless --script tests/test_T0328_signal_tower_overview.gd
## Exit 0 = PASS, exit 1 = FAIL.

const SceneScript := preload("res://scenes/signal_tower_overview.gd")

const GROUND_RELAY: String = "signal_tower.ground_relay"
const ALL_SEVEN: Array[String] = [
	GROUND_RELAY,
	"signal_tower.records_room",
	"signal_tower.power_substation",
	"signal_tower.equipment_floor",
	"signal_tower.storage_cache",
	"signal_tower.antenna_shaft",
	"signal_tower.broadcast_deck",
]


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_scene_file_smoke()
	failures += _test_all_rooms_built_at_authored_positions()
	failures += _test_connectors_built_for_every_connection()
	failures += _test_camera_limits_cover_full_archetype()
	failures += _test_player_exists_and_spawns_in_ground_relay()
	failures += _test_player_visuals_are_greybox_only()
	failures += _test_no_character_art_reference_in_source()

	if failures.is_empty():
		print("T-0328 PASS: signal tower overview scene verified (7 groups)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0328 FAIL: " + f)
		quit(1)


## Build a fresh, un-treed scene instance and call build_layout() directly —
## the established pattern in this repo for testing a code-driven scene's
## constructed node tree without a live SceneTree/physics context.
func _build_instance(failures: Array[String]) -> Node2D:
	var inst: Node2D = SceneScript.new()
	inst.build_layout()
	if inst.get_layout() == null:
		failures.append("build_instance: build_layout() did not produce a loaded RoomLayout")
	return inst


func _test_scene_file_smoke() -> Array[String]:
	var failures: Array[String] = []

	if not FileAccess.file_exists("res://scenes/signal_tower_overview.tscn"):
		failures.append(
			"scene_smoke: res://scenes/signal_tower_overview.tscn must exist"
		)
		return failures

	var packed: PackedScene = load("res://scenes/signal_tower_overview.tscn") as PackedScene
	if packed == null:
		failures.append("scene_smoke: signal_tower_overview.tscn must load as a valid PackedScene")
		return failures

	var inst: Node = packed.instantiate()
	if inst == null:
		failures.append("scene_smoke: instantiate() must return a non-null Node")
		return failures

	inst.free()
	return failures


func _test_all_rooms_built_at_authored_positions() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		inst.free()
		return failures

	for tag: String in ALL_SEVEN:
		var room_node: Node2D = inst.get_room_node(tag)
		if room_node == null:
			failures.append("room_built: no room node built for '%s'" % tag)
			continue

		var expected_pos: Vector2 = layout.get_rect_px(tag).position
		if not room_node.position.is_equal_approx(expected_pos):
			failures.append(
				"room_position: '%s' at %s, expected %s"
				% [tag, str(room_node.position), str(expected_pos)]
			)

	inst.free()
	return failures


func _test_connectors_built_for_every_connection() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		inst.free()
		return failures

	var expected_connections: Array = layout.get_connections()
	var built_connectors: Array = inst.get_connector_records()

	if built_connectors.size() != expected_connections.size():
		failures.append(
			"connector_count: built %d connector markers, spec declares %d connections"
			% [built_connectors.size(), expected_connections.size()]
		)

	for conn: Dictionary in expected_connections:
		var found: bool = false
		for rec: Dictionary in built_connectors:
			if rec["from"] == conn["from"] and rec["to"] == conn["to"] and rec["type"] == conn["type"]:
				found = true
				break
		if not found:
			failures.append(
				"connector_missing: no built marker for %s -> %s (%s)"
				% [conn["from"], conn["to"], conn["type"]]
			)

	inst.free()
	return failures


func _test_camera_limits_cover_full_archetype() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		inst.free()
		return failures

	var camera: Camera2D = inst.get_camera()
	if camera == null:
		failures.append("camera: no Camera2D built")
		inst.free()
		return failures

	var bounds: Rect2 = layout.get_bounding_rect_px()

	if camera.limit_left > int(bounds.position.x):
		failures.append(
			"camera_limits: limit_left=%d must be <= bounds left %d"
			% [camera.limit_left, int(bounds.position.x)]
		)
	if camera.limit_top > int(bounds.position.y):
		failures.append(
			"camera_limits: limit_top=%d must be <= bounds top %d"
			% [camera.limit_top, int(bounds.position.y)]
		)
	if camera.limit_right < int(bounds.end.x):
		failures.append(
			"camera_limits: limit_right=%d must be >= bounds right %d"
			% [camera.limit_right, int(bounds.end.x)]
		)
	if camera.limit_bottom < int(bounds.end.y):
		failures.append(
			"camera_limits: limit_bottom=%d must be >= bounds bottom %d"
			% [camera.limit_bottom, int(bounds.end.y)]
		)

	inst.free()
	return failures


func _test_player_exists_and_spawns_in_ground_relay() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_instance(failures)
	var layout: RefCounted = inst.get_layout()
	if layout == null:
		inst.free()
		return failures

	var player: CharacterBody2D = inst.get_player()
	if player == null:
		failures.append("player: no player node built")
		inst.free()
		return failures

	var relay_rect: Rect2 = layout.get_rect_px(GROUND_RELAY)
	if not relay_rect.has_point(player.position):
		failures.append(
			"player_spawn: player position %s must be inside Ground Relay rect %s"
			% [str(player.position), str(relay_rect)]
		)

	inst.free()
	return failures


func _test_player_visuals_are_greybox_only() -> Array[String]:
	var failures: Array[String] = []
	var inst: Node2D = _build_instance(failures)
	if inst.get_layout() == null:
		inst.free()
		return failures

	var player: CharacterBody2D = inst.get_player()
	if player == null:
		failures.append("player_visuals: no player node built")
		inst.free()
		return failures

	for child: Node in player.get_children():
		if child is Sprite2D or child is AnimatedSprite2D or child is TextureRect:
			failures.append(
				(
					"player_visuals: player must not use textured/sprite nodes (found %s) — "
					+ "grey-box only, no character art dependency"
				) % child.get_class()
			)

	inst.free()
	return failures


## Static guard: the scene script must never reference the finished character
## walk sheet — this card ships and is complete with zero character sprites.
func _test_no_character_art_reference_in_source() -> Array[String]:
	var failures: Array[String] = []

	var f := FileAccess.open("res://scenes/signal_tower_overview.gd", FileAccess.READ)
	if f == null:
		failures.append("source_guard: could not read signal_tower_overview.gd for inspection")
		return failures
	var text: String = f.get_as_text()
	f.close()

	if text.findn("player_walk_sheet") != -1:
		failures.append(
			"source_guard: signal_tower_overview.gd must not reference player_walk_sheet — "
			+ "this card has no dependency on finished character art"
		)

	return failures
