class_name ProximityPatrolSensorV2
extends Node
## Composable proximity/patrol sensor for the side-on floor plane (T-0189 / §11 §4 v5).
##
## Replaces ProximityPatrolSensor (T-0174) for the rebuilt side-on model.  The
## patrol route is expressed as an ordered list of X positions on the floor plane
## (floats, not 2D Vectors).  The entity advances along the route and back in a
## loop, moving horizontally only.
##
## Detection triggers when the player's horizontal distance from the entity falls
## within catch_radius_tiles.  No line-of-sight, no geometry blocking, no cover —
## detection is purely radial and unaffected by foreground props or Drop gaps
## (11-moment-to-moment.md §1, unchanged from T-0174).
##
## Add as a child of any entity node.  Call advance(delta) in _physics_process
## to move the entity, then call check(player_plane_x) to query detection.
## Read entity_plane_x to sync the entity's visual position.

## Emitted on the transition: not-detected → detected.
## @param target_plane_x  The player's X position on the floor plane.
signal target_detected(target_plane_x: float)

## Emitted on the transition: detected → not-detected.
signal target_cleared()

## Patrol route: ordered X positions in world-space pixels.
## The entity loops through them in order, wrapping from the last back to the first.
@export var waypoints: Array[float] = []

## Detection radius in tiles.
@export var catch_radius_tiles: float = 1.5

## Patrol speed in tiles per second.
@export var patrol_speed_tiles_per_sec: float = 4.0

## Pixels per tile — must match the project tilemap.
@export var tile_size: float = 16.0

## Current entity X position on the patrol route in pixels.
## Read by the owning entity to synchronise its visual/collision position.
## Set to the patrol's starting X before the first advance() call.
var entity_plane_x: float = 0.0

var _waypoint_idx: int = 0
var _was_detected: bool = false


## Advance the entity along its patrol route by delta seconds.
## Handles overshooting a waypoint within the same frame so large delta values
## skip correctly, matching the T-0174 Vector2 patrol contract.
##
## @param delta  Frame delta time in seconds.
func advance(delta: float) -> void:
	if waypoints.is_empty():
		return

	var remaining_px: float = patrol_speed_tiles_per_sec * tile_size * delta
	while remaining_px > 0.0:
		var wp: float = waypoints[_waypoint_idx]
		var dist: float = absf(entity_plane_x - wp)
		if dist <= remaining_px:
			# Arrive at waypoint; spend dist, advance to next.
			remaining_px -= dist
			entity_plane_x = wp
			_waypoint_idx = (_waypoint_idx + 1) % waypoints.size()
		else:
			# Move toward waypoint without overshooting.
			var dir: float = signf(wp - entity_plane_x)
			entity_plane_x += dir * remaining_px
			remaining_px = 0.0


## Returns true iff the player at player_plane_x is within catch_radius_tiles.
## No line-of-sight or geometry check is performed.
##
## @param player_plane_x  Player's X position on the floor plane in pixels.
func check(player_plane_x: float) -> bool:
	var dist_px: float = absf(player_plane_x - entity_plane_x)
	var detected: bool = dist_px <= catch_radius_tiles * tile_size

	if detected and not _was_detected:
		_was_detected = true
		target_detected.emit(player_plane_x)
	elif not detected and _was_detected:
		_was_detected = false
		target_cleared.emit()

	return detected
