## HazardRoom — authoring metadata for a Hazard-role room (16-level-design.md §3).
##
## A Hazard room is authored with a sensor-category slot, not a specific entity.
## The geometry — cover placement, patrol space, hiding spots — is built for one
## category. Which entity occupies the slot is resolved per-universe by HazardResolver
## so the entity roster can grow later without any existing Hazard room needing
## re-authoring. The slot absorbs new content for free.
##
## Usage:
##   var room := HazardRoom.new()
##   room.sensor_category = HazardRoom.SensorCategory.SIGHT_CONE
##   var entity: EntityDef = HazardResolver.resolve(room, universe_seed)
class_name HazardRoom
extends RefCounted

## The three sensor categories a Hazard room can declare (16-level-design.md §3).
## These correspond to sensor archetypes, never to specific entity names.
enum SensorCategory {
	## Entities that detect the player via a directional sight cone (e.g. The Watcher).
	SIGHT_CONE = 0,
	## Entities that react to sound within a detection radius (e.g. The Sound).
	SOUND_RADIUS = 1,
	## Entities that patrol and catch by proximity, with no line-of-sight check (e.g. The Still Air).
	PROXIMITY_PATROL = 2,
}

## The sensor category this room's Hazard slot requires.
## Set by the level author at design time. Never set to a specific entity name;
## that resolution happens at runtime via HazardResolver.
var sensor_category: int = SensorCategory.SIGHT_CONE
