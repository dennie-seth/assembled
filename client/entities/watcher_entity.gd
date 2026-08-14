class_name WatcherEntity
extends RefCounted
## The Watcher — vertical-slice hazard entity.
## Stationary or slow-patrol; telegraphed and avoidable by routing.
## Carries exactly one SightConeSensor; all detection is delegated to it —
## no entity-specific detection code exists here.
## HAZARD_LABEL reuses existing vocabulary (02-notes-system.md §2).
## See docs/design/11-moment-to-moment.md §1.

const HAZARD_LABEL: StringName = &"the watcher"

## The single sensor attached to this entity. No other detection logic present.
var sensor: SightConeSensor

func _init() -> void:
	sensor = SightConeSensor.new()

## Returns true if this entity's sight cone detects the player.
## Entirely delegated to [sensor] — no detection logic in this method.
## @param entity_pos World position of this entity.
## @param entity_facing Normalized direction this entity is facing.
## @param player_pos World position of the player.
## @param player_in_cover True when the player is behind cover.
func is_detecting(entity_pos: Vector2, entity_facing: Vector2, player_pos: Vector2, player_in_cover: bool) -> bool:
	return sensor.detect(entity_pos, entity_facing, player_pos, player_in_cover)
