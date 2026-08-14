class_name StillAirEntity
extends RefCounted
## The Still Air — vertical-slice hazard entity.
## Fixed route, no line-of-sight check; reads as inevitable rather than alert.
## The player is not spotted — they are simply there when it arrives.
## Carries exactly one ProximityPatrolSensor; all detection is delegated to it —
## no entity-specific detection code exists here.
## HAZARD_LABEL reuses existing vocabulary (02-notes-system.md §2).
## See docs/design/11-moment-to-moment.md §1.

const HAZARD_LABEL: StringName = &"the still air"

## The single sensor attached to this entity. No other detection logic present.
var sensor: ProximityPatrolSensor

func _init() -> void:
	sensor = ProximityPatrolSensor.new()

## Returns true if the player is within this entity's patrol detection radius.
## Entirely delegated to [sensor] — no detection logic in this method.
## @param entity_pos World position of this entity.
## @param player_pos World position of the player.
func is_detecting(entity_pos: Vector2, player_pos: Vector2) -> bool:
	sensor.entity_position = entity_pos
	return sensor.check(player_pos)
