## EntityRoster — registry of entities indexed by sensor category (16-level-design.md §3).
##
## The roster is the single place that maps sensor categories to entity definitions.
## Adding a new entity for an existing category requires only a new register() call here
## — no existing HazardRoom authoring data needs to change. HazardResolver picks among
## all candidates using the universe seed, so the slot absorbs new content for free.
##
## This class is a pure data container: build a roster with register(), then query it
## with entities_for(). The default v1 roster is constructed by HazardResolver.resolve().
class_name EntityRoster
extends RefCounted

const _EntityDef := preload("res://entity_def.gd")

## All registered entity definitions for this roster instance.
var _entries: Array[_EntityDef] = []

## Add an entity to this roster.
## @param entity_id    Stable internal identifier (e.g. "watcher").
## @param sensor_category  A HazardRoom.SensorCategory value this entity satisfies.
## @param display_name Human-readable name (e.g. "The Watcher").
func register(entity_id: String, sensor_category: int, display_name: String) -> void:
	var def := _EntityDef.new()
	def.entity_id = entity_id
	def.sensor_category = sensor_category
	def.display_name = display_name
	_entries.append(def)

## Returns all entities whose sensor_category matches @a category.
## With the v1 roster this returns exactly one entry per category.
## Once the roster grows, multiple entries may be returned and HazardResolver
## will select among them using the universe seed.
func entities_for(category: int) -> Array[_EntityDef]:
	var result: Array[_EntityDef] = []
	for entry: _EntityDef in _entries:
		if entry.sensor_category == category:
			result.append(entry)
	return result
