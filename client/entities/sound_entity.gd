class_name SoundEntity
extends RefCounted
## The Sound — vertical-slice hazard entity.
## Roams and converges on noise; punishes running blind.
## Carries exactly one SoundRadiusSensor; all detection is delegated to it —
## no entity-specific detection code exists here.
## HAZARD_LABEL reuses existing vocabulary (02-notes-system.md §2).
## See docs/design/11-moment-to-moment.md §1.

const HAZARD_LABEL: StringName = &"the sound"

const _SoundRadiusSensor = preload("res://sensors/sound_radius_sensor.gd")

## The single sensor attached to this entity. No other detection logic present.
var sensor: _SoundRadiusSensor

func _init() -> void:
	sensor = _SoundRadiusSensor.new()

## Returns true if this entity hears the player's movement noise.
## Entirely delegated to [sensor] — no detection logic in this method.
## @param entity_pos World position of this entity.
## @param player_pos World position of the player.
## @param player_running True when the player is running.
func is_detecting(entity_pos: Vector2, player_pos: Vector2, player_running: bool) -> bool:
	sensor.entity_position = entity_pos
	sensor.update_movement_state(player_running)
	return sensor.check(player_pos)
