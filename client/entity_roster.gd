## EntityRoster — registry of entities indexed by sensor category (16-level-design.md §3).
##
## The roster is the single place that maps sensor categories to entity definitions.
## Adding a new entity for an existing category requires only a new register() call here
## — no existing HazardRoom authoring data needs to change. HazardResolver picks among
## all candidates using the universe seed, so the slot absorbs new content for free.
##
## Today's v1 roster has exactly one entity per category; make_default() returns it.
## Tests may inject a custom roster via HazardResolver.resolve_with_roster() to
## simulate future roster growth without touching any HazardRoom data.
class_name EntityRoster
extends RefCounted

## All registered entity definitions for this roster instance.
var _entries: Array[EntityDef] = []

## Add an entity to this roster.
## @param entity_id    Stable internal identifier (e.g. "watcher").
## @param sensor_category  A HazardRoom.SensorCategory value this entity satisfies.
## @param display_name Human-readable name (e.g. "The Watcher").
func register(entity_id: String, sensor_category: int, display_name: String) -> void:
	var def := EntityDef.new()
	def.entity_id = entity_id
	def.sensor_category = sensor_category
	def.display_name = display_name
	_entries.append(def)

## Returns all entities whose sensor_category matches @a category.
## With the v1 roster this returns exactly one entry per category.
## Once the roster grows, multiple entries may be returned and HazardResolver
## will select among them using the universe seed.
func entities_for(category: int) -> Array[EntityDef]:
	var result: Array[EntityDef] = []
	for entry: EntityDef in _entries:
		if entry.sensor_category == category:
			result.append(entry)
	return result

## Factory: returns the default v1 roster — one entity per sensor category.
## This is the authoritative roster for production use. Tests may construct a
## custom EntityRoster and pass it to HazardResolver.resolve_with_roster() instead.
static func make_default() -> EntityRoster:
	var r := EntityRoster.new()
	r.register("watcher",   HazardRoom.SensorCategory.SIGHT_CONE,      "The Watcher")
	r.register("sound",     HazardRoom.SensorCategory.SOUND_RADIUS,     "The Sound")
	r.register("still_air", HazardRoom.SensorCategory.PROXIMITY_PATROL, "The Still Air")
	return r
