## WatcherController — CharacterBody2D Watcher entity for the blockout room.
## Slow patrol between two horizontal waypoints; uses WatcherSensor for sight-cone
## detection geometry (cone + cover blocking). Exactly one Watcher in the room.
## §11 §1, T-0174, T-0178.
class_name WatcherController
extends CharacterBody2D

## Slow patrol speed per spec §11 §1 (about 2 tiles/s).
const PATROL_SPEED: float = 32.0

## Sight-cone tuning — feeds §11 §1 M-2 sensor params.
## Half-angle 50° (total 100°) gives a wide but not wrap-around cone.
## Range 96px = 6 tiles: player has ~6-tile warning approach distance.
const CONE_HALF_ANGLE: float = 50.0
const CONE_RANGE: float = 96.0

## Left/right patrol boundary X coordinates in world space (set by room).
var patrol_left: float = 0.0
var patrol_right: float = 0.0

## Cover Rect2 array for sight-line blocking (set by room before adding to tree).
var cover_rects: Array = []

## True when the watcher is currently detecting the player.
var detects_player: bool = false

## Emitted once per detection transition (not held every frame).
signal player_detected

var _going_right: bool = true
var _sensor: RefCounted  ## WatcherSensor instance
var _cone_poly: Polygon2D

func _ready() -> void:
	var sensor_script: GDScript = load("res://scripts/watcher_sensor.gd") as GDScript
	_sensor = sensor_script.new()
	_sensor.cone_half_angle = CONE_HALF_ANGLE
	_sensor.cone_range = CONE_RANGE
	_build_visuals()

## Build placeholder visuals: red-brown box + semi-transparent cone polygon.
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
	_refresh_cone(Vector2.RIGHT)

	var col_shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = Vector2(12.0, 14.0)
	col_shape.shape = box
	add_child(col_shape)

## Rebuild the cone polygon to reflect current facing direction.
func _refresh_cone(facing: Vector2) -> void:
	var half_rad: float = deg_to_rad(CONE_HALF_ANGLE)
	var pts := PackedVector2Array()
	pts.append(Vector2.ZERO)
	var steps: int = 10
	for i: int in range(steps + 1):
		var a: float = -half_rad + (2.0 * half_rad * i) / float(steps)
		pts.append(facing.rotated(a) * CONE_RANGE)
	_cone_poly.polygon = pts

func _physics_process(_delta: float) -> void:
	var facing: Vector2
	if _going_right:
		velocity.x = PATROL_SPEED
		facing = Vector2.RIGHT
		if position.x >= patrol_right:
			_going_right = false
	else:
		velocity.x = -PATROL_SPEED
		facing = Vector2.LEFT
		if position.x <= patrol_left:
			_going_right = true
	velocity.y = 0.0
	move_and_slide()
	_refresh_cone(facing)

## Return the watcher's current facing direction (used externally for detection queries).
func get_facing() -> Vector2:
	return Vector2.RIGHT if _going_right else Vector2.LEFT

## Check whether the watcher can currently detect the player.
## @param player_pos  World-space position of the player.
## @param player_hiding  True if the player is inside a hiding spot (blocks all sensors).
## @return True if the player is now detected.
func check_player(player_pos: Vector2, player_hiding: bool) -> bool:
	if player_hiding:
		if detects_player:
			detects_player = false
		return false
	var facing: Vector2 = get_facing()
	var detected: bool = _sensor.can_detect(position, facing, player_pos, cover_rects)
	if detected and not detects_player:
		player_detected.emit()
	detects_player = detected
	return detected
