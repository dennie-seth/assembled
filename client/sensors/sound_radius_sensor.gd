class_name SoundRadiusSensor
extends RefCounted
## Sound-radius detection sensor. Omnidirectional — not blocked by cover or
## geometry. Triggers at [run_radius] when the player is running, or at
## [walk_radius] when walking (default 0 = walking is effectively silent).
## Punishes running blind; rewards cautious movement.
## See docs/design/11-moment-to-moment.md §1, §4.

## Detection radius when the player is running.
var run_radius: float = 400.0
## Detection radius when the player is walking. Default 0 = silent walk.
var walk_radius: float = 0.0

## @return Unique type identifier for this sensor, used for introspection.
func sensor_type() -> StringName:
	return &"sound_radius"

## Returns true if the entity hears the player this tick.
## @param entity_pos World position of this entity.
## @param player_pos World position of the player.
## @param player_running True when the player is running; false when walking.
func detect(entity_pos: Vector2, player_pos: Vector2, player_running: bool) -> bool:
	var dist: float = (player_pos - entity_pos).length()
	var radius: float = run_radius if player_running else walk_radius
	return dist <= radius
