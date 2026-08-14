class_name SightConeSensor
extends RefCounted
## Sight-cone detection sensor. Triggers when the player is within
## [cone_angle] degrees of the entity's facing direction and within [range].
## Blocked by player in cover (cover-break mechanic, 11-moment-to-moment.md §2).
## See docs/design/11-moment-to-moment.md §1.

## Half-angle of the sight cone in degrees. Full cone = 2 * cone_angle.
var cone_angle: float = 45.0
## Maximum detection range in world units.
var range: float = 300.0

## @return Unique type identifier for this sensor, used for introspection.
func sensor_type() -> StringName:
	return &"sight_cone"

## Returns true if the entity's sight cone catches the player this tick.
## @param entity_pos World position of this entity.
## @param entity_facing Normalized direction the entity is facing.
## @param player_pos World position of the player.
## @param player_in_cover True when player is behind cover (blocks sight).
func detect(entity_pos: Vector2, entity_facing: Vector2, player_pos: Vector2, player_in_cover: bool) -> bool:
	if player_in_cover:
		return false
	var to_player: Vector2 = player_pos - entity_pos
	var dist: float = to_player.length()
	if dist > range:
		return false
	if dist < 0.001:
		return true  # player at entity position — always caught
	var angle_deg: float = rad_to_deg(entity_facing.angle_to(to_player.normalized()))
	return absf(angle_deg) <= cone_angle
