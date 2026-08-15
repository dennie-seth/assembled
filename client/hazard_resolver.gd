## HazardResolver — resolves a Hazard room's sensor-category slot to a concrete entity
## for a specific universe (16-level-design.md §3).
##
## The occupying entity is chosen from the EntityRoster using the universe seed so that
## a Hazard room never names an entity directly. With today's single-entity roster the
## result is deterministic. When the roster grows, different universe seeds yield different
## entities — this is intentional (02-notes-system.md §4): note warnings become unreliable
## by design, not by bug.
##
## Usage:
##   var entity := HazardResolver.resolve(room, universe_seed)
##
## For testing roster growth without touching HazardRoom data:
##   var entity := HazardResolver.resolve_with_roster(room, seed, custom_roster)
class_name HazardResolver
extends RefCounted

const _HazardRoom := preload("res://hazard_room.gd")
const _EntityDef := preload("res://entity_def.gd")
const _EntityRoster := preload("res://entity_roster.gd")

## Resolve the entity occupying @a room's sensor-category slot for the given universe.
## Builds and consults the authoritative v1 EntityRoster (one entity per category).
## Returns null only if the roster has no entry for the room's category — should not
## occur with a complete roster.
## @param room           The authored HazardRoom — only its sensor_category is read.
## @param universe_seed  Per-universe integer; different values yield different entities
##                       once the roster has more than one entry per category.
static func resolve(room: _HazardRoom, universe_seed: int) -> _EntityDef:
	return resolve_with_roster(room, universe_seed, _build_default_roster())

## Resolve using a caller-supplied @a roster.
## Use this to inject a custom or expanded roster in tests without modifying any
## HazardRoom authoring data — the room's sensor_category is unchanged.
## @param room           The authored HazardRoom — only its sensor_category is read.
## @param universe_seed  Per-universe integer used to select among multiple candidates.
## @param roster         The EntityRoster to consult.
static func resolve_with_roster(room: _HazardRoom, universe_seed: int, roster: _EntityRoster) -> _EntityDef:
	var candidates: Array[_EntityDef] = roster.entities_for(room.sensor_category)
	if candidates.is_empty():
		return null
	var idx: int = universe_seed % candidates.size()
	return candidates[idx]

## Build the authoritative v1 entity roster — one entity per sensor category.
## This is the single definition of the default entity list; add new entries here
## when the roster grows. Existing HazardRoom authoring data never needs updating.
static func _build_default_roster() -> _EntityRoster:
	var r := _EntityRoster.new()
	r.register("watcher",   _HazardRoom.SensorCategory.SIGHT_CONE,      "The Watcher")
	r.register("sound",     _HazardRoom.SensorCategory.SOUND_RADIUS,     "The Sound")
	r.register("still_air", _HazardRoom.SensorCategory.PROXIMITY_PATROL, "The Still Air")
	return r
