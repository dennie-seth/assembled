## Single room in the Signal Tower chain.
##
## A room carries a set of author-facing roles (Gate, Hazard, Transit) and
## at most one system-facing tag (Climax or Tear) per 16 §1. Roles are
## metadata — a room can hold multiple simultaneously (e.g. Gate + Hazard).
## Whether a HAZARD room has a live entity at runtime is a roll-per-universe
## concern (16 §3); the room declares only its sensor-category slot.

class_name RoomDefinition

var anchor_tag: String
var display_name: String

## Author-facing roles (16 §1). Stored as String keys matching RoomTypes.Role
## enum names so callers can use has_role("HAZARD") without a preload chain.
var _roles: Array = []

## True if this room was authoritatively given an EntitySensor instance.
var has_entity: bool = false

## True if this room's entry is gated by a puzzle (14 §5 Records Room pattern).
var puzzle_locked: bool = false

## Items available in this room (drawn from existing spawn pool — 11 §6).
var items: Array = []

## The entity sensor attached to this room (null if not a Hazard or no entity).
var _sensor: Object = null   ## EntitySensor

func _init(
	p_tag: String,
	p_name: String,
	p_roles: Array,
	p_items: Array = []
) -> void:
	anchor_tag = p_tag
	display_name = p_name
	_roles = p_roles
	items = p_items

## Returns true if this room carries the named role.
## role_name: one of "CLIMAX", "TEAR", "GATE", "HAZARD", "TRANSIT"
func has_role(role_name: String) -> bool:
	return _roles.has(role_name)

## Attach an EntitySensor to this room.
## Marks has_entity = true.
func set_entity(sensor: Object) -> void:
	_sensor = sensor
	has_entity = true

## Returns the sensor type string for the attached entity ("SIGHT_CONE" etc.),
## or "NONE" if no entity is attached.
func get_entity_sensor_type() -> String:
	if _sensor == null:
		return "NONE"
	return _sensor.get_sensor_type()

## Returns the attached EntitySensor, or null.
func get_entity() -> Object:
	return _sensor
