## signal_tower archetype tag set — canonical declaration of all 10 anchor tags.
##
## Single source of truth for signal_tower room roles and anchor kinds on the
## GDScript/Godot side.  The C++ parallel lives in shared/note_templates.hpp
## (kSignalTowerRoomTags).
##
## Usage:
##   var tag_set := SignalTowerTagSet.make()
##   var errors := tag_set.validate()
##
## Design: docs/design/14-vertical-slice.md §2, docs/design/16-level-design.md §5.
## Author: Claude

const _RoomTagDef := preload("res://room_tag_def.gd")
const _ArchetypeTagSet := preload("res://archetype_tag_set.gd")

## Archetype integer ID (assembled::ArchetypeId::SIGNAL_TOWER = 6).
const ARCHETYPE_ID: int = 6


## Returns the canonical ArchetypeTagSet for signal_tower.
## All 10 declared anchor tags — 7 named rooms + tear + climax + music_cue —
## are included.  (16 §4: "Fixed across every variant; INV-12 build check applies.")
##
## Room layout (14 §2):
##   ground_relay      Transit
##   records_room      Gate (puzzle-locked Climax Room, co-located with climax/music_cue)
##   power_substation  Gate + Hazard (sight-cone slot — The Watcher)
##   equipment_floor   Hazard (sound-radius slot — The Sound)
##   storage_cache     Transit
##   antenna_shaft     Hazard (proximity/patrol slot — The Still Air)
##   broadcast_deck    Transit (chain tear to Hospital lives here as own tag)
##   tear              dedicated TEAR anchor (chain, leads to Hospital)
##   climax            dedicated CLIMAX anchor (co-located at records_room)
##   music_cue         dedicated MUSIC_CUE anchor (co-located at records_room)
static func make() -> Object:
	var rooms: Array = [
		_RoomTagDef.new("ground_relay",     _RoomTagDef.AnchorKind.NAMED,     _RoomTagDef.RoomRole.TRANSIT),
		_RoomTagDef.new("records_room",     _RoomTagDef.AnchorKind.NAMED,     _RoomTagDef.RoomRole.GATE),
		_RoomTagDef.new("power_substation", _RoomTagDef.AnchorKind.NAMED,     _RoomTagDef.RoomRole.GATE | _RoomTagDef.RoomRole.HAZARD),
		_RoomTagDef.new("equipment_floor",  _RoomTagDef.AnchorKind.NAMED,     _RoomTagDef.RoomRole.HAZARD),
		_RoomTagDef.new("storage_cache",    _RoomTagDef.AnchorKind.NAMED,     _RoomTagDef.RoomRole.TRANSIT),
		_RoomTagDef.new("antenna_shaft",    _RoomTagDef.AnchorKind.NAMED,     _RoomTagDef.RoomRole.HAZARD),
		_RoomTagDef.new("broadcast_deck",   _RoomTagDef.AnchorKind.NAMED,     _RoomTagDef.RoomRole.TRANSIT),
		_RoomTagDef.new("tear",             _RoomTagDef.AnchorKind.TEAR,      _RoomTagDef.RoomRole.NONE),
		_RoomTagDef.new("climax",           _RoomTagDef.AnchorKind.CLIMAX,    _RoomTagDef.RoomRole.NONE),
		_RoomTagDef.new("music_cue",        _RoomTagDef.AnchorKind.MUSIC_CUE, _RoomTagDef.RoomRole.NONE),
	]
	return _ArchetypeTagSet.new(ARCHETYPE_ID, rooms)
