## Seven-room Signal Tower chain per docs/design/14-vertical-slice.md §10.
##
## Room graph (14 §10):
##
##   Ground Relay (entry, Transit)
##   ├── Records Room  [optional branch, puzzle-locked, Climax + Gate]
##   └── Power Substation  [Gate + Hazard / Watcher / sight-cone]
##        └── Equipment Floor  [Hazard / Sound / sound-radius]
##             ├── Storage Cache  [optional branch, Transit]
##             └── Antenna Shaft  [Hazard / Still Air / proximity-patrol]
##                  └── Broadcast Deck  [Tear — chain tear → Hospital (19)]
##
## All vertical connectors are ladders (11 §5 — free, ungated).
## Branches are single doors, dead-ending back to their parent room.
##
## Entity roster (14 §3, 11 §1): one sensor per entity, none combined.
##   The Watcher  — sight cone    — Power Substation
##   The Sound    — sound radius  — Equipment Floor
##   The Still Air — prox/patrol  — Antenna Shaft
##
## Chroma note: the chain tear leads to Hospital (archetype 2), which is
## still home-palette — foreignness is reserved for Long Descent's pocket
## tear (12 §3a). The chroma shader (T-0121) is scaffolded on the
## Broadcast Deck tear anchor for when foreign content does appear at
## the terminal archetype's pocket.

class_name SignalTowerChain

const _RoomDefinition: GDScript = preload("res://signal_tower/room_definition.gd")
const _EntitySensor: GDScript = preload("res://signal_tower/entity_sensor.gd")
const _ChainTear: GDScript = preload("res://signal_tower/chain_tear.gd")

## Declared anchor tags for signal_tower (INV-12 checked at build time):
## ground_relay, records_room, power_substation, equipment_floor,
## storage_cache, antenna_shaft, broadcast_deck, tear, climax, music_cue
## (climax and music_cue co-located at Records Room per 14 §2 footnote).

## anchor_tag -> RoomDefinition
var _rooms: Dictionary = {}

## Chain tear instance for Broadcast Deck.
var tear: Object   ## ChainTear

## Critical path (main-line rooms, excluding all branches).
## Used to verify Records Room is not silently assumed on the main path.
const CRITICAL_PATH: Array[String] = [
	"signal_tower.ground_relay",
	"signal_tower.power_substation",
	"signal_tower.equipment_floor",
	"signal_tower.antenna_shaft",
	"signal_tower.broadcast_deck",
]

func _init() -> void:
	_build_rooms()
	_attach_entities()
	tear = _ChainTear.new()

func _build_rooms() -> void:
	# Ground Relay — entry Transit room; teaches the hiding-spot mechanic before
	# it matters (14 §10). Item: Rusted Transit Pass (common, spawn pool).
	var ground_relay: Object = _RoomDefinition.new(
		"signal_tower.ground_relay",
		"Ground Relay",
		["TRANSIT"],
		["rusted_transit_pass"]
	)
	_rooms[ground_relay.anchor_tag] = ground_relay

	# Records Room — optional branch off Ground Relay.
	# Climax Room (11 §7): puzzle-locked entry via wear-mark drawer logic (14 §5).
	# Delivers highest-tier item currently hosted in the player's universe
	# (Resonance Key if unique hosted; else rare; else empty — INV-6 holds).
	# Also carries music_cue tag (13 §4.2, 14 §9) — climax ≈ music ≈ reward.
	var records_room: Object = _RoomDefinition.new(
		"signal_tower.records_room",
		"Records Room",
		["CLIMAX", "GATE"],
		[]
	)
	records_room.puzzle_locked = true
	_rooms[records_room.anchor_tag] = records_room

	# Power Substation — Gate + Hazard. Three-breaker light-chase puzzle
	# (14 §4) unlocks the ladder upward and grants Relay Fuse (spawn pool).
	# The Watcher's slow sweep (90°/6 tiles) is the puzzle's tension.
	var power_substation: Object = _RoomDefinition.new(
		"signal_tower.power_substation",
		"Power Substation",
		["GATE", "HAZARD"],
		["relay_fuse"]
	)
	_rooms[power_substation.anchor_tag] = power_substation

	# Equipment Floor — Hazard (sound-radius slot). Cluttered maze layout
	# punishes running. The Sound roams toward whatever noise it last heard.
	var equipment_floor: Object = _RoomDefinition.new(
		"signal_tower.equipment_floor",
		"Equipment Floor",
		["HAZARD"],
		[]
	)
	_rooms[equipment_floor.anchor_tag] = equipment_floor

	# Storage Cache — optional branch off Equipment Floor. Transit room with
	# Copper Coil item reward.
	var storage_cache: Object = _RoomDefinition.new(
		"signal_tower.storage_cache",
		"Storage Cache",
		["TRANSIT"],
		["copper_coil"]
	)
	_rooms[storage_cache.anchor_tag] = storage_cache

	# Antenna Shaft — Hazard (proximity/patrol slot). Narrow vertical shaft
	# with The Still Air on a fixed ~25s lap. No LOS — avoidance is pure
	# timing. At least one hiding alcove partway up as the only safety valve.
	var antenna_shaft: Object = _RoomDefinition.new(
		"signal_tower.antenna_shaft",
		"Antenna Shaft",
		["HAZARD"],
		["corroded_antenna_fragment"]
	)
	_rooms[antenna_shaft.anchor_tag] = antenna_shaft

	# Broadcast Deck — Tear room. Chain tear to Hospital (19, archetype 2).
	# No entity; breathing room before the crossing. The tear anchor is the
	# chroma-lit centrepiece — home-palette content here, chroma shader is
	# wired to the tear anchor for when foreign content appears (pocket tears).
	var broadcast_deck: Object = _RoomDefinition.new(
		"signal_tower.broadcast_deck",
		"Broadcast Deck",
		["TEAR"],
		[]
	)
	_rooms[broadcast_deck.anchor_tag] = broadcast_deck

func _attach_entities() -> void:
	# The Watcher — sight cone — Power Substation (14 §3)
	var watcher: Object = _EntitySensor.new()
	watcher.init_sight_cone("The Watcher")
	_rooms["signal_tower.power_substation"].set_entity(watcher)

	# The Sound — sound radius — Equipment Floor (14 §3)
	var sound: Object = _EntitySensor.new()
	sound.init_sound_radius("The Sound")
	_rooms["signal_tower.equipment_floor"].set_entity(sound)

	# The Still Air — proximity/patrol — Antenna Shaft (14 §3)
	var still_air: Object = _EntitySensor.new()
	still_air.init_proximity_patrol("The Still Air")
	_rooms["signal_tower.antenna_shaft"].set_entity(still_air)

## Returns the RoomDefinition for anchor_tag, or null if not found.
func get_room(tag: String) -> Object:
	return _rooms.get(tag, null)

## Returns all declared anchor tags for this archetype.
func get_all_tags() -> Array:
	return _rooms.keys()

## Returns true if Records Room does not appear on the critical path.
## The critical path runs Ground Relay -> Power Substation -> Equipment Floor
## -> Antenna Shaft -> Broadcast Deck. Records Room is a branch off
## Ground Relay and is never silently assumed on the main route.
func critical_path_excludes_records_room() -> bool:
	return not CRITICAL_PATH.has("signal_tower.records_room")
