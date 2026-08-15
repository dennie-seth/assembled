## EntityDef — one entry in the entity roster (16-level-design.md §3).
##
## Describes a single entity that may occupy a Hazard room's sensor-category slot.
## entity_id is the stable internal identifier; sensor_category is the
## HazardRoom.SensorCategory value the entity satisfies.
##
## EntityDef instances are created by EntityRoster.register() and returned by
## EntityRoster.entities_for(). Consumers read them; they do not construct them directly.
class_name EntityDef
extends RefCounted

## Stable internal identifier (e.g. "watcher", "sound", "still_air").
## Used by callers to identify which entity was resolved without hardcoding display text.
var entity_id: String = ""

## Which sensor category this entity satisfies.
## Must be a HazardRoom.SensorCategory value.
var sensor_category: int = 0

## Human-readable display name (e.g. "The Watcher").
var display_name: String = ""
