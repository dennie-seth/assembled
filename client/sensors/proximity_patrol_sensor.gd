class_name ProximityPatrolSensor
extends RefCounted
## Proximity/patrol detection sensor. Triggers when the player enters
## [patrol_radius]. No line-of-sight check — reads as environmental and
## inevitable: the player is not spotted, they are simply there when the
## entity arrives.
## See docs/design/11-moment-to-moment.md §1.

## Detection radius in world units.
var patrol_radius: float = 80.0

## @return Unique type identifier for this sensor, used for introspection.
func sensor_type() -> StringName:
	return &"proximity_patrol"

## Returns true if the player is within the patrol detection radius.
## @param entity_pos World position of this entity.
## @param player_pos World position of the player.
func detect(entity_pos: Vector2, player_pos: Vector2) -> bool:
	return (player_pos - entity_pos).length() <= patrol_radius
