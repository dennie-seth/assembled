## WatcherControllerSideon — side-on Watcher entity for the T-0192 blockout.
##
## Patrols horizontally between two X waypoints on the side-on floor plane.
## Uses three composable V2 sensors (T-0189):
##   - SightConeSensorV2     — blocked by cover props (CoverBreakV2 intervals).
##   - SoundRadiusSensorV2   — omnidirectional; run radius 5× larger than walk.
##   - ProximityPatrolSensorV2 — radial catch; unaffected by cover.
##
## Call check_player() each frame to run all sensors and aggregate detection.
## player_detected signal fires on the FIRST detected → not-detected transition.
##
## cover_props: Array[Vector2] — populate with CoverBreakV2.get_cover_interval()
## values before adding to the scene tree.
class_name WatcherControllerSideon
extends CharacterBody2D

const _SensorScript: GDScript = preload("res://sensor.gd")

## Sight-cone tuning (§11 §4 v5).
const SIGHT_RANGE_TILES: float     = 6.0
## Proximity catch radius: player must be very close to be caught without sight.
const PROXIMITY_CATCH_TILES: float = 1.5
## Sound: walking player detected at 1.5 tiles, running at 5 tiles.
const SOUND_WALK_TILES: float      = 1.5
const SOUND_RUN_TILES: float       = 5.0
## Patrol speed in tiles per second (slow, §11 §1).
const PATROL_SPEED_TILES: float    = 2.0

const TILE_SIZE: float = 16.0

## Left/right patrol boundary X coordinates in world space pixels.
## Set by the room coordinator before this node is added to the scene tree.
var patrol_left_x: float  = 0.0
var patrol_right_x: float = 0.0

## Cover interval props for the sight sensor.  Populate with
## CoverBreakV2.get_cover_interval() before adding to the scene tree.
var cover_props: Array[Vector2] = []

## Emitted once per detection transition (false → true).
signal player_detected

## True when the watcher is currently detecting the player.
var detects_player: bool = false

var _going_right: bool = false  ## starts facing left (toward player entry)
var _sight: Node   ## SightConeSensorV2
var _sound: Node   ## SoundRadiusSensorV2
var _prox: Node    ## ProximityPatrolSensorV2
var _cone_poly: Polygon2D


func _ready() -> void:
	_sight = load("res://sensors/sight_cone_sensor_v2.gd").new()
	_sight.range_tiles      = SIGHT_RANGE_TILES
	_sight.tile_size        = TILE_SIZE
	_sight.entity_plane_x   = position.x
	_sight.entity_facing_dir = -1.0  ## facing left initially
	for interval: Vector2 in cover_props:
		_sight.cover_props.append(interval)
	add_child(_sight)

	_sound = load("res://sensors/sound_radius_sensor_v2.gd").new()
	_sound.walk_radius_tiles = SOUND_WALK_TILES
	_sound.run_radius_tiles  = SOUND_RUN_TILES
	_sound.tile_size         = TILE_SIZE
	_sound.entity_plane_x    = position.x
	add_child(_sound)

	_prox = load("res://sensors/proximity_patrol_sensor_v2.gd").new()
	_prox.catch_radius_tiles = PROXIMITY_CATCH_TILES
	_prox.tile_size          = TILE_SIZE
	_prox.entity_plane_x     = position.x
	add_child(_prox)

	_build_visuals()


func _build_visuals() -> void:
	var body_rect := ColorRect.new()
	body_rect.name = "BodyRect"
	body_rect.color = Color(0.65, 0.2, 0.2)
	body_rect.size = Vector2(12.0, 14.0)
	body_rect.position = Vector2(-6.0, -7.0)
	add_child(body_rect)

	_cone_poly = Polygon2D.new()
	_cone_poly.name = "SightCone"
	_cone_poly.color = Color(1.0, 0.95, 0.3, 0.22)
	add_child(_cone_poly)
	_refresh_cone_poly(-1.0)

	var col_shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = Vector2(12.0, 14.0)
	col_shape.shape = box
	add_child(col_shape)


## Rebuild the sight-cone polygon overlay to reflect current facing direction.
## @param facing_dir  +1.0 = right, -1.0 = left.
func _refresh_cone_poly(facing_dir: float) -> void:
	var half_rad: float = deg_to_rad(50.0)
	var facing: Vector2 = Vector2(facing_dir, 0.0)
	var pts := PackedVector2Array()
	pts.append(Vector2.ZERO)
	for i: int in range(11):
		var a: float = -half_rad + (2.0 * half_rad * float(i)) / 10.0
		pts.append(facing.rotated(a) * (SIGHT_RANGE_TILES * TILE_SIZE))
	_cone_poly.polygon = pts


func _physics_process(_delta: float) -> void:
	var facing_dir: float
	if _going_right:
		velocity.x = PATROL_SPEED_TILES * TILE_SIZE
		facing_dir  = 1.0
		if position.x >= patrol_right_x:
			_going_right = false
	else:
		velocity.x = -PATROL_SPEED_TILES * TILE_SIZE
		facing_dir  = -1.0
		if position.x <= patrol_left_x:
			_going_right = true
	velocity.y = 0.0
	move_and_slide()

	## Sync sensor positions with the body.
	var plane_x: float = position.x
	_sight.entity_plane_x    = plane_x
	_sight.entity_facing_dir = facing_dir
	_sound.entity_plane_x    = plane_x
	_prox.entity_plane_x     = plane_x

	_refresh_cone_poly(facing_dir)


## Check whether the watcher can currently detect the player.
##
## Aggregates sight, sound, and proximity sensors.  Hiding obstacles should be
## passed via [param obstacles] — any obstacle that reports blocks_sensor() true
## suppresses detection for that sensor type before the check is run.
##
## player_detected is emitted on the first frame detection becomes true.
##
## @param player_plane_x  Player's X position on the floor plane in pixels.
## @param player_is_running  True if the player's noise flag is ON (run state).
## @param obstacles  Array of nodes implementing blocks_sensor(type: int) → bool
##                   (e.g. HidingSpotV2 when player IS the occupant).
## @return True if the player is detected this frame.
func check_player(player_plane_x: float, player_is_running: bool, obstacles: Array) -> bool:
	## Update sound sensor noise state each frame.
	_sound.update_movement_state(player_is_running)

	var sight_blocked: bool = _SensorScript.is_detection_blocked(_SensorScript.SIGHT, obstacles)
	var sound_blocked: bool = _SensorScript.is_detection_blocked(_SensorScript.SOUND, obstacles)
	var prox_blocked: bool  = _SensorScript.is_detection_blocked(_SensorScript.PROXIMITY, obstacles)

	var detected: bool = false
	if not sight_blocked and _sight.check(player_plane_x):
		detected = true
	if not sound_blocked and _sound.check(player_plane_x):
		detected = true
	if not prox_blocked and _prox.check(player_plane_x):
		detected = true

	if detected and not detects_player:
		player_detected.emit()
	detects_player = detected
	return detected


## Return the watcher's current facing direction (+1.0 right, -1.0 left).
func get_facing_dir() -> float:
	return 1.0 if _going_right else -1.0
