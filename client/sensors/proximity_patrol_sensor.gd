class_name ProximityPatrolSensor
extends Node
## Composable proximity/patrol sensor for hazard entities (T-0174).
##
## Advances the entity along a fixed waypoint route and detects the player
## when they fall within catch_radius_tiles of the entity's current position.
## No line-of-sight check is performed — detection triggers regardless of
## geometry between the entity and the player (11-moment-to-moment.md §1).
##
## Add as a child of any entity node.  Call advance(delta) in _physics_process
## to move the entity along its route, then call check(player_pos) to query
## detection.  The entity reads entity_position to sync its visual position.

## Emitted on the transition: not-detected → detected.
signal target_detected(target_pos: Vector2)
## Emitted on the transition: detected → not-detected.
signal target_cleared()

## Patrol route in world-space pixels.  The entity loops through these
## waypoints in order, wrapping from the last back to the first.
@export var waypoints: Array[Vector2] = []
## Catch radius in tiles — detection fires when the player is this close.
## Default: 1.5, matching the first-pass Still Air value (doc 14 §10).
@export var catch_radius_tiles: float = 1.5
## Patrol movement speed in tiles per second.
@export var patrol_speed_tiles_per_sec: float = 4.0
## Pixels per tile — must match the project tilemap.
@export var tile_size: float = 16.0

## Current entity world position on the patrol route.
## Read by the owning entity to synchronise its visual/collision position.
## Set this to the patrol's starting world position before the first advance().
var entity_position: Vector2 = Vector2.ZERO

var _waypoint_idx: int = 0
var _was_detected: bool = false


## Advances the entity along its patrol route by delta seconds.
## Handles arriving at a waypoint and continuing through remaining distance
## within the same frame, so large delta values skip correctly.
func advance(delta: float) -> void:
	if waypoints.is_empty():
		return

	var remaining_px: float = patrol_speed_tiles_per_sec * tile_size * delta
	while remaining_px > 0.0:
		var wp: Vector2 = waypoints[_waypoint_idx]
		var dist: float = entity_position.distance_to(wp)
		if dist <= remaining_px:
			# Arrive at waypoint; spend dist out of remaining, advance index.
			remaining_px -= dist
			entity_position = wp
			_waypoint_idx = (_waypoint_idx + 1) % waypoints.size()
		else:
			entity_position = entity_position.move_toward(wp, remaining_px)
			remaining_px = 0.0


## Returns true iff the player at target_pos is within catch_radius of the
## entity's current patrol position.  No LOS check is performed.
func check(target_pos: Vector2) -> bool:
	var dist_px: float = entity_position.distance_to(target_pos)
	var detected: bool = dist_px <= catch_radius_tiles * tile_size

	if detected and not _was_detected:
		_was_detected = true
		target_detected.emit(target_pos)
	elif not detected and _was_detected:
		_was_detected = false
		target_cleared.emit()

	return detected
