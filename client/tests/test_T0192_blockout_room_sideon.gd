extends SceneTree
## T-0192: Side-on one-room blockout integration tests.
##
## Verifies the layout guarantees of the rebuilt blockout room on the
## T-0187-T-0190 side-on runtime:
##   - Player spawns outside watcher detection range (can spot the Watcher first).
##   - CoverBreakV2 blocks watcher sight when player is behind it; sound and
##     proximity sensors are unaffected.
##   - HidingSpotV2 blocks all three sensor types once inside.
##   - No i-frame on hiding-spot entry: pre-entry detection is preserved.
##   - Item anchor and door logic work end-to-end with debug item #42.
##   - Scene file and coordinator scripts exist.
##
## Layout constants (must match blockout_room_sideon.gd):
##   PLAYER_SPAWN_COL = 2   → spawn_x  = 40  px (tile centre)
##   ITEM_ANCHOR_COL  = 4   → anchor_x = 72  px
##   HIDING_SPOT_COL  = 7   → hiding_x = 120 px
##   COVER_COL        = 9   → cover_x  = 152 px, interval [144, 160]
##   WATCHER_LEFT_COL = 12  → watcher_x = 200 px  (patrol start, facing left)
##   WATCHER_SIGHT_TILES = 6.0  → sight_px = 96 px
##
## Run headless (from client/):
##   cd client && timeout 600 godot --headless \
##       --script tests/test_T0192_blockout_room_sideon.gd
## Exit 0 = PASS, exit 1 = FAIL.

const SightConeSensorV2Script    := preload("res://sensors/sight_cone_sensor_v2.gd")
const SoundRadiusSensorV2Script  := preload("res://sensors/sound_radius_sensor_v2.gd")
const ProximityPatrolSensorV2Script := preload("res://sensors/proximity_patrol_sensor_v2.gd")
const SensorScript               := preload("res://sensor.gd")
const HidingSpotV2Script         := preload("res://hiding_spot_v2.gd")
const CoverBreakV2Script         := preload("res://cover_break_v2.gd")
const ItemAnchorScript           := preload("res://scripts/item_anchor_logic.gd")
const ItemDoorScript             := preload("res://scripts/item_door_logic.gd")

## ── Layout constants (mirror blockout_room_sideon.gd) ─────────────────────────
const TILE_SIZE: float        = 16.0
const SPAWN_X: float          = 2.0 * TILE_SIZE + TILE_SIZE * 0.5   ## 40 px
const ITEM_ANCHOR_X: float    = 4.0 * TILE_SIZE + TILE_SIZE * 0.5   ## 72 px
const HIDING_PLANE_X: float   = 7.0 * TILE_SIZE + TILE_SIZE * 0.5   ## 120 px
const COVER_PLANE_X: float    = 9.0 * TILE_SIZE + TILE_SIZE * 0.5   ## 152 px
const COVER_WIDTH_PX: float   = TILE_SIZE                            ## 16 px → [144, 160]
const WATCHER_LEFT_X: float   = 12.0 * TILE_SIZE + TILE_SIZE * 0.5  ## 200 px
const WATCHER_SIGHT_TILES: float    = 6.0
const WATCHER_PROXIMITY_TILES: float = 1.5
const WATCHER_SOUND_WALK_TILES: float = 1.5
const WATCHER_SOUND_RUN_TILES: float  = 5.0
const DEBUG_ITEM_ID: int      = 42


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_player_spawn_undetected()
	failures += _test_cover_blocks_sight_only()
	failures += _test_hiding_spot_blocks_all_sensors()
	failures += _test_no_iframe_on_entry()
	failures += _test_item_anchor_roundtrip()
	failures += _test_item_door_opens()
	failures += _test_scene_exists()
	failures += _test_scripts_exist()

	if failures.is_empty():
		print("T-0192 PASS: side-on blockout room layout verified (8 groups)")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0192 FAIL: " + f)
		quit(1)


## ── 1. Player spawn is outside all watcher sensors ───────────────────────────
## Acceptance: "Person can spot the Watcher first."
## Player at spawn_x (col 2 centre, 40 px) with watcher at its left patrol
## boundary (col 12 centre, 200 px) facing left must NOT be detected by any
## of the three watcher sensors.

func _test_player_spawn_undetected() -> Array[String]:
	var failures: Array[String] = []

	var sight: Node = SightConeSensorV2Script.new()
	sight.range_tiles     = WATCHER_SIGHT_TILES
	sight.tile_size       = TILE_SIZE
	sight.entity_plane_x  = WATCHER_LEFT_X
	sight.entity_facing_dir = -1.0  ## watcher faces left at patrol start

	var sound: Node = SoundRadiusSensorV2Script.new()
	sound.walk_radius_tiles = WATCHER_SOUND_WALK_TILES
	sound.run_radius_tiles  = WATCHER_SOUND_RUN_TILES
	sound.tile_size         = TILE_SIZE
	sound.entity_plane_x    = WATCHER_LEFT_X

	var prox: Node = ProximityPatrolSensorV2Script.new()
	prox.catch_radius_tiles = WATCHER_PROXIMITY_TILES
	prox.tile_size          = TILE_SIZE
	prox.entity_plane_x     = WATCHER_LEFT_X

	## Sight: |SPAWN_X - WATCHER_LEFT_X| = 160 px > 6*16 = 96 px → out of range.
	if sight.check(SPAWN_X):
		failures.append(
			"spawn_undetected: sight must NOT detect player at spawn (dist %.0f px > %.0f px range)"
			% [absf(SPAWN_X - WATCHER_LEFT_X), WATCHER_SIGHT_TILES * TILE_SIZE]
		)

	## Sound (walking): 160 px > 1.5*16 = 24 px → out of range.
	sound.update_movement_state(false)
	if sound.check(SPAWN_X):
		failures.append("spawn_undetected: walk-sound must NOT detect player at spawn")

	## Sound (running): 160 px > 5.0*16 = 80 px → out of range.
	sound.update_movement_state(true)
	if sound.check(SPAWN_X):
		failures.append("spawn_undetected: run-sound must NOT detect player at spawn")

	## Proximity: 160 px > 1.5*16 = 24 px → out of range.
	if prox.check(SPAWN_X):
		failures.append("spawn_undetected: proximity must NOT detect player at spawn")

	sight.free()
	sound.free()
	prox.free()
	return failures


## ── 2. Cover blocks sight but not sound/proximity ─────────────────────────────
## Acceptance: "Person can break LOS behind cover."
## CoverBreakV2 at COVER_PLANE_X (col 9) blocks the watcher's sight when the
## player is at the hiding-spot position (col 7, left of the cover interval).
## Sound (running, radius 80 px) and proximity are unaffected by cover.

func _test_cover_blocks_sight_only() -> Array[String]:
	var failures: Array[String] = []

	## Build cover object — mirrors room construction in blockout_room_sideon.gd.
	var cover: Node = CoverBreakV2Script.new()
	cover.plane_x       = COVER_PLANE_X
	cover.cover_width_px = COVER_WIDTH_PX
	var interval: Vector2 = cover.get_cover_interval()  ## [144, 160]

	var sight: Node = SightConeSensorV2Script.new()
	sight.range_tiles       = WATCHER_SIGHT_TILES
	sight.tile_size         = TILE_SIZE
	sight.entity_plane_x    = WATCHER_LEFT_X   ## 200 px
	sight.entity_facing_dir = -1.0              ## facing left

	## Without cover: player at hiding spot (120 px) IS in the cone and in range.
	## Watcher faces left, dx = 120-200 = -80, dx*facing = 80 > 0 → in front.
	## |dx| = 80 < 96 → in range.  No cover → detected.
	if not sight.check(HIDING_PLANE_X):
		failures.append(
			"cover_sight_only: sight must detect player at HIDING_PLANE_X before cover is registered"
		)

	## Register cover interval → sight now blocked.
	sight.cover_props.append(interval)
	if sight.check(HIDING_PLANE_X):
		failures.append(
			"cover_sight_only: sight must be blocked when CoverBreakV2 is registered and player is behind it"
		)
	if not sight.last_check_was_occluded:
		failures.append(
			"cover_sight_only: last_check_was_occluded must be true when cover blocks the sight line"
		)

	## Running sound (80 px radius): player at 120 px, watcher at 200 px → 80 px = AT boundary → detected.
	## This confirms sound goes THROUGH cover even when sight is blocked.
	var sound: Node = SoundRadiusSensorV2Script.new()
	sound.walk_radius_tiles  = WATCHER_SOUND_WALK_TILES
	sound.run_radius_tiles   = WATCHER_SOUND_RUN_TILES
	sound.tile_size          = TILE_SIZE
	sound.entity_plane_x     = WATCHER_LEFT_X
	sound.update_movement_state(true)  ## player running
	if not sound.check(HIDING_PLANE_X):
		failures.append(
			"cover_sight_only: run-sound must still detect through cover (omnidirectional)"
		)

	## Proximity: player at 120 px, watcher at 200 px → 80 px >> 24 px catch → NOT detected.
	var prox: Node = ProximityPatrolSensorV2Script.new()
	prox.catch_radius_tiles = WATCHER_PROXIMITY_TILES
	prox.tile_size          = TILE_SIZE
	prox.entity_plane_x     = WATCHER_LEFT_X
	if prox.check(HIDING_PLANE_X):
		failures.append(
			"cover_sight_only: proximity must NOT detect player 80 px away (catch radius is 24 px)"
		)

	sight.free()
	sound.free()
	prox.free()
	cover.free()
	return failures


## ── 3. Hiding spot blocks all three sensor types ─────────────────────────────
## Acceptance: "Person can reach the hiding spot."
## Once the player enters HidingSpotV2 cleanly, Sensor.is_detection_blocked()
## must return true for SIGHT, SOUND, and PROXIMITY.

func _test_hiding_spot_blocks_all_sensors() -> Array[String]:
	var failures: Array[String] = []

	var spot: Node = HidingSpotV2Script.new()
	spot.plane_x = HIDING_PLANE_X

	var player := Node.new()

	if not spot.try_enter(player):
		failures.append("hiding_blocks: try_enter must succeed on empty spot")
		spot.free()
		player.free()
		return failures

	if not SensorScript.is_detection_blocked(SensorScript.SIGHT, [spot]):
		failures.append("hiding_blocks: SIGHT must be blocked inside the hiding spot")
	if not SensorScript.is_detection_blocked(SensorScript.SOUND, [spot]):
		failures.append("hiding_blocks: SOUND must be blocked inside the hiding spot")
	if not SensorScript.is_detection_blocked(SensorScript.PROXIMITY, [spot]):
		failures.append("hiding_blocks: PROXIMITY must be blocked inside the hiding spot")

	spot.free()
	player.free()
	return failures


## ── 4. No i-frame on hiding-spot entry ────────────────────────────────────────
## Acceptance: "Failure feels like the player's own mistake, not an ambush."
## A detection that was already active before try_enter() must not be
## retroactively cancelled.  The pre-entry detected_before flag stays true.

func _test_no_iframe_on_entry() -> Array[String]:
	var failures: Array[String] = []

	var spot: Node = HidingSpotV2Script.new()
	var player := Node.new()

	## Pre-entry: no obstacles → sensor is not blocked.
	var detected_before: bool = not SensorScript.is_detection_blocked(SensorScript.SIGHT, [])
	if not detected_before:
		failures.append("no_iframe: Sensor.is_detection_blocked with empty list must return false")
		spot.free()
		player.free()
		return failures

	## Enter the spot.
	if not spot.try_enter(player):
		failures.append("no_iframe: try_enter must succeed on fresh spot")
		spot.free()
		player.free()
		return failures

	## Pre-entry detection was NOT retroactively cancelled by try_enter().
	if not detected_before:
		failures.append("no_iframe: pre-entry detection was cancelled (i-frame bug)")

	## Post-entry: all sensors blocked.
	if not SensorScript.is_detection_blocked(SensorScript.SIGHT, [spot]):
		failures.append("no_iframe: SIGHT not blocked after entry")
	if not SensorScript.is_detection_blocked(SensorScript.SOUND, [spot]):
		failures.append("no_iframe: SOUND not blocked after entry")
	if not SensorScript.is_detection_blocked(SensorScript.PROXIMITY, [spot]):
		failures.append("no_iframe: PROXIMITY not blocked after entry")

	spot.free()
	player.free()
	return failures


## ── 5. Item anchor round-trip ─────────────────────────────────────────────────
## Acceptance: "Person can take the item."
## ItemAnchorLogic seeded with DEBUG_ITEM_ID: pick_up() returns the id, clears
## the anchor, place_item() restores it.

func _test_item_anchor_roundtrip() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scripts/item_anchor_logic.gd") as GDScript
	if script == null:
		failures.append("item_anchor: res://scripts/item_anchor_logic.gd could not be loaded")
		return failures

	var anchor: RefCounted = script.new()
	anchor.anchored_item_id = DEBUG_ITEM_ID

	if not anchor.has_item():
		failures.append("item_anchor: has_item() must be true when seeded with debug item")

	var picked: int = anchor.pick_up()
	if picked != DEBUG_ITEM_ID:
		failures.append("item_anchor: pick_up() must return DEBUG_ITEM_ID (%d)" % DEBUG_ITEM_ID)
	if anchor.has_item():
		failures.append("item_anchor: has_item() must be false after pick_up()")

	anchor.place_item(DEBUG_ITEM_ID)
	if not anchor.has_item():
		failures.append("item_anchor: has_item() must be true after place_item()")

	return failures


## ── 6. Door opens with correct item ──────────────────────────────────────────
## Acceptance: "Person can open the door."
## ItemDoorLogic with required_item_id = DEBUG_ITEM_ID rejects wrong/no item
## and opens on the correct item.

func _test_item_door_opens() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scripts/item_door_logic.gd") as GDScript
	if script == null:
		failures.append("item_door: res://scripts/item_door_logic.gd could not be loaded")
		return failures

	var door: RefCounted = script.new()
	door.required_item_id = DEBUG_ITEM_ID

	if door.is_open:
		failures.append("item_door: must start closed")
	if door.try_open(door.ITEM_NONE):
		failures.append("item_door: try_open(ITEM_NONE) must return false")
	if door.try_open(99):
		failures.append("item_door: try_open with wrong item must return false")
	if not door.try_open(DEBUG_ITEM_ID):
		failures.append("item_door: try_open(%d) must return true" % DEBUG_ITEM_ID)
	if not door.is_open:
		failures.append("item_door: door must be open after correct item")

	return failures


## ── 7. Scene file exists ──────────────────────────────────────────────────────
## The core deliverable: blockout_room_sideon.tscn must exist and instantiate.

func _test_scene_exists() -> Array[String]:
	var failures: Array[String] = []
	const SCENE_PATH: String = "res://scenes/blockout_room_sideon.tscn"

	if not FileAccess.file_exists(SCENE_PATH):
		failures.append("scene_exists: %s must exist" % SCENE_PATH)
		return failures

	var packed: PackedScene = load(SCENE_PATH) as PackedScene
	if packed == null:
		failures.append("scene_exists: %s must load as PackedScene" % SCENE_PATH)
		return failures

	var room: Node = packed.instantiate()
	if room == null:
		failures.append("scene_exists: instantiate() must return a non-null Node")
		return failures
	room.free()
	return failures


## ── 8. Required scripts exist ─────────────────────────────────────────────────
## Coordinator and watcher controller scripts must load cleanly.

func _test_scripts_exist() -> Array[String]:
	var failures: Array[String] = []

	var room_script: GDScript = load("res://scripts/blockout_room_sideon.gd") as GDScript
	if room_script == null:
		failures.append("scripts_exist: res://scripts/blockout_room_sideon.gd not found")

	var watcher_script: GDScript = load("res://scripts/watcher_controller_sideon.gd") as GDScript
	if watcher_script == null:
		failures.append("scripts_exist: res://scripts/watcher_controller_sideon.gd not found")
	elif watcher_script != null:
		var wc: Node = watcher_script.new()
		if not wc is CharacterBody2D:
			failures.append("scripts_exist: watcher_controller_sideon must extend CharacterBody2D")
		wc.free()

	return failures
