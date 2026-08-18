class_name HidingSpotV2 extends Node
## HidingSpotV2: floor-anchored hiding spot for the side-on floor plane.
##
## Rebuilds HidingSpot (T-0175) for the §11 §4 v5 side-on geometry.
##
## Rules (11-moment-to-moment.md §2):
##   - Floor-anchored: placed at a fixed plane_x on the room's single floor
##     plane; never floating or multi-level-positioned.
##   - Single-occupant: try_enter() rejects a second entity while one is
##     already inside.
##   - Entry is exposed: try_enter() has NO side-effect that cancels an active
##     sensor detection.  No i-frame is granted on the transition.
##   - Once inside cleanly: all three sensor types (SIGHT, SOUND, PROXIMITY)
##     are blocked.  No timer, no ongoing check.
##
## Callers must include this node in the obstacle list passed to
## Sensor.is_detection_blocked() only when the queried entity IS the current
## occupant — occupancy tracking is the caller's responsibility.

## Floor anchor: X position on the room's single floor plane in pixels.
## Set this once when the object is placed; it does not move.
var plane_x: float = 0.0

var _occupant: Node = null


## Attempt to enter this hiding spot.
##
## Returns true if the spot was empty and the entity was accepted.
## Returns false if another entity is already inside — single-occupant is
## enforced here; callers must handle rejection.
##
## No i-frame is granted: any sensor that already has the entity at this
## instant still catches it.  try_enter() emits no cancel-detection signal.
##
## @param entity  The entity attempting to enter.
func try_enter(entity: Node) -> bool:
	if _occupant != null:
		return false
	_occupant = entity
	return true


## Release the spot.
##
## Only the current occupant can exit; other callers are silently ignored so
## that stale references from displaced logic cannot corrupt occupancy state.
##
## @param entity  The entity attempting to exit.
func exit_spot(entity: Node) -> void:
	if _occupant == entity:
		_occupant = null


## Returns true if an entity currently occupies this spot.
func is_occupied() -> bool:
	return _occupant != null


## Returns the current occupant, or null if the spot is empty.
func get_occupant() -> Node:
	return _occupant


## Blocks all three sensor types (SIGHT, SOUND, and PROXIMITY).
##
## The [sensor_type] parameter is accepted for interface conformance with
## Sensor.is_detection_blocked(); all types are suppressed unconditionally
## once the player is inside.  Callers must only pass this node as an
## obstacle when the queried entity IS the current occupant.
##
## @param _sensor_type  One of Sensor.SIGHT, Sensor.SOUND, Sensor.PROXIMITY.
func blocks_sensor(_sensor_type: int) -> bool:
	return true
