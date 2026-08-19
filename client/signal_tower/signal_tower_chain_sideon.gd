class_name SignalTowerChainSideon
extends Node
## Seven-room Signal Tower chain rebuilt on the side-on runtime (§20-a3 / T-0194).
##
## Room graph (14 §10) on the side-on movement model (T-0187–T-0190):
##
##   Ground Relay  (entry, Transit)
##   ├── Records Room       [optional branch, Climax + Gate, puzzle-locked]
##   └── Power Substation   [Gate + Hazard / SIGHT_CONE / WatcherControllerSideon]
##        └── Equipment Floor  [Hazard / SOUND_RADIUS / SoundControllerSideon]
##             ├── Storage Cache  [optional branch, Transit]
##             └── Antenna Shaft  [Hazard / PROXIMITY_PATROL / StillAirControllerSideon]
##                  └── Broadcast Deck  [Tear — chain tear → Hospital (19)]
##
## Entity sensor categories (V2 side-on assignment):
##   Power Substation  — SIGHT_CONE        (WatcherControllerSideon)
##   Equipment Floor   — SOUND_RADIUS      (SoundControllerSideon)
##   Antenna Shaft     — PROXIMITY_PATROL  (StillAirControllerSideon)
##
## The chain tear at Broadcast Deck requires a Resonance Key for first crossing
## and stays open for the rest of the run (chain_tear.gd / 12 §3a).

const _ChainTear: GDScript = preload("res://signal_tower/chain_tear.gd")
const _WatcherScript: GDScript = preload("res://signal_tower/watcher_controller_sideon.gd")
const _SoundScript: GDScript = preload("res://signal_tower/sound_controller_sideon.gd")
const _StillAirScript: GDScript = preload("res://signal_tower/still_air_controller_sideon.gd")

## All seven room anchor tags in declaration order.
const ALL_TAGS: Array[String] = [
	"signal_tower.ground_relay",
	"signal_tower.records_room",
	"signal_tower.power_substation",
	"signal_tower.equipment_floor",
	"signal_tower.storage_cache",
	"signal_tower.antenna_shaft",
	"signal_tower.broadcast_deck",
]

## Critical path — 5 rooms, entry to tear, excluding all optional branches.
const CRITICAL_PATH: Array[String] = [
	"signal_tower.ground_relay",
	"signal_tower.power_substation",
	"signal_tower.equipment_floor",
	"signal_tower.antenna_shaft",
	"signal_tower.broadcast_deck",
]

## Sensor category per hazard room (V2 side-on assignment).
## Non-hazard rooms are absent from this map; callers receive "NONE".
const ENTITY_SENSOR_CATEGORIES: Dictionary = {
	"signal_tower.power_substation": "SIGHT_CONE",
	"signal_tower.equipment_floor": "SOUND_RADIUS",
	"signal_tower.antenna_shaft": "PROXIMITY_PATROL",
}

## Next critical-path room per tag ("" = end of chain).
const MAIN_NEXT: Dictionary = {
	"signal_tower.ground_relay":    "signal_tower.power_substation",
	"signal_tower.power_substation": "signal_tower.equipment_floor",
	"signal_tower.equipment_floor": "signal_tower.antenna_shaft",
	"signal_tower.antenna_shaft":   "signal_tower.broadcast_deck",
	"signal_tower.broadcast_deck":  "",
}

## Optional branches per room (rooms that dead-end back to their parent).
const BRANCHES: Dictionary = {
	"signal_tower.ground_relay":    ["signal_tower.records_room"],
	"signal_tower.equipment_floor": ["signal_tower.storage_cache"],
}

## Chain tear instance — placed at Broadcast Deck.
## Requires a Resonance Key for first crossing; remains open thereafter.
var tear: Object  ## ChainTear

func _init() -> void:
	tear = _ChainTear.new()

## Returns all declared anchor tags for this archetype (7 total).
func get_all_tags() -> Array:
	return ALL_TAGS.duplicate()

## Returns the ordered critical-path tag sequence (5 rooms).
func get_critical_path() -> Array[String]:
	return CRITICAL_PATH.duplicate()

## Returns true if Records Room is absent from the critical path.
func critical_path_excludes_records_room() -> bool:
	return not CRITICAL_PATH.has("signal_tower.records_room")

## Returns true if Storage Cache is absent from the critical path.
func critical_path_excludes_storage_cache() -> bool:
	return not CRITICAL_PATH.has("signal_tower.storage_cache")

## Returns optional branch tags off the given room, or an empty array.
func get_branches_from(tag: String) -> Array[String]:
	if not BRANCHES.has(tag):
		return []
	var raw: Array = BRANCHES[tag]
	var result: Array[String] = []
	result.assign(raw)
	return result

## Returns the V2 sensor category string for a hazard room ("SIGHT_CONE",
## "SOUND_RADIUS", "PROXIMITY_PATROL"), or "NONE" for non-hazard rooms.
func get_entity_sensor_category(tag: String) -> String:
	return ENTITY_SENSOR_CATEGORIES.get(tag, "NONE")

## Returns the next room tag along the critical path, or "" at the end.
func get_main_next(tag: String) -> String:
	return MAIN_NEXT.get(tag, "")

## Factory: returns the correct side-on entity controller Node for a hazard
## room, or null if the room has no entity.
## The caller owns the returned node and must free() it when done.
func create_entity_controller(tag: String) -> Node:
	match tag:
		"signal_tower.power_substation":
			return _WatcherScript.new() as Node
		"signal_tower.equipment_floor":
			return _SoundScript.new() as Node
		"signal_tower.antenna_shaft":
			return _StillAirScript.new() as Node
	return null
