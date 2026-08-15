class_name ArchetypeTagSet
## Collection of RoomTagDef entries for one archetype, with INV-12-class validation.
##
## Holds the full declared anchor tag set — every named room, plus any
## system-facing anchors (Tear, Climax, MusicCue) — and exposes queries
## and validation methods that mirror the INV-12 build checks described in
## docs/design/16-level-design.md §4.
##
## Author: Claude

## Integer archetype ID (matches assembled::ArchetypeId in shared/note_templates.hpp).
var archetype_id: int
## All declared room tag definitions for this archetype (Array of RoomTagDef).
var rooms: Array


## Construct an archetype tag set.
## @param p_id     Archetype ID.
## @param p_rooms  Array of RoomTagDef instances (all declared anchors).
func _init(p_id: int, p_rooms: Array) -> void:
	archetype_id = p_id
	rooms = p_rooms


## Returns all NAMED-anchor rooms carrying the given role flag.
## Only NAMED anchors are eligible for Gate/Hazard/Transit roles;
## system-facing anchors (CLIMAX, TEAR, MUSIC_CUE) are excluded.
## @param role  A RoomTagDef.RoomRole enum value.
## @return      Array of matching RoomTagDef instances; empty if none.
func rooms_with_role(role: int) -> Array:
	var result: Array = []
	for room: Object in rooms:
		if room.anchor_kind == RoomTagDef.AnchorKind.NAMED and room.has_role(role):
			result.append(room)
	return result


## Returns the first room with the given anchor kind, or null if absent.
## Use this to locate system-facing anchors (CLIMAX, TEAR, MUSIC_CUE).
## @param kind  A RoomTagDef.AnchorKind enum value.
func find_anchor(kind: int) -> Object:
	for room: Object in rooms:
		if room.anchor_kind == kind:
			return room
	return null


## Core validation — checks invariants that must hold for every archetype:
##   - Tear count must be exactly 1 (16 §2: "exactly one per archetype").
##   - Climax count must be at most 1 (16 §2: "at most one per archetype").
##   - MusicCue count must be at most 1.
## Returns an Array[String] of error messages; empty means PASS.
## Note: zero Climax rooms is valid for archetypes that do not declare one.
## Use validate_required_anchors() to enforce presence of declared anchors.
func validate() -> Array:
	var errors: Array[String] = []
	var tear_count: int = 0
	var climax_count: int = 0
	var music_cue_count: int = 0

	for room: Object in rooms:
		match room.anchor_kind:
			RoomTagDef.AnchorKind.TEAR:
				tear_count += 1
			RoomTagDef.AnchorKind.CLIMAX:
				climax_count += 1
			RoomTagDef.AnchorKind.MUSIC_CUE:
				music_cue_count += 1

	if tear_count != 1:
		errors.append(
			"Tear count is %d — must be exactly 1 per archetype (16-level-design.md §2)"
			% tear_count
		)
	if climax_count > 1:
		errors.append(
			"Climax count is %d — must be at most 1 per archetype (16 §2)" % climax_count
		)
	if music_cue_count > 1:
		errors.append(
			"MusicCue count is %d — must be at most 1 per archetype" % music_cue_count
		)

	return errors


## Schema validation — checks that every required anchor kind is present.
## This is the INV-12-class check for system-facing anchors: if an archetype
## declares Climax or MusicCue, every variant of that archetype must include it.
## @param kinds  Array of RoomTagDef.AnchorKind values that must be present.
## @return       Array[String] of error messages; empty means PASS.
func validate_required_anchors(kinds: Array) -> Array:
	var errors: Array[String] = []
	for kind: int in kinds:
		if find_anchor(kind) == null:
			errors.append(
				"Required anchor kind %d is missing from archetype %d (INV-12 check)"
				% [kind, archetype_id]
			)
	return errors


## Returns true if the archetype has at least one Gate room.
## Gate has no hard minimum (16 §2), so false is valid — but see audit_gate_count()
## for making the 0-Gate state visible rather than silent.
func has_gate() -> bool:
	for room: Object in rooms:
		if room.anchor_kind == RoomTagDef.AnchorKind.NAMED and room.has_role(RoomTagDef.RoomRole.GATE):
			return true
	return false


## Returns a human-readable audit string describing Gate room count.
## When count is 0, the string makes the state legible so authors can
## distinguish a deliberate 0-Gate archetype from one that simply forgot
## to tag a room (16 §2 edge case: "no hard minimum, but should be auditable").
func audit_gate_count() -> String:
	var count: int = 0
	for room: Object in rooms:
		if room.anchor_kind == RoomTagDef.AnchorKind.NAMED and room.has_role(RoomTagDef.RoomRole.GATE):
			count += 1
	if count == 0:
		return (
			"0 Gate rooms in archetype %d — verify intentional "
			"(contributes nothing to unique-keyed unlock economy; 16-level-design.md §2)"
			% archetype_id
		)
	return "%d Gate room(s) in archetype %d" % [count, archetype_id]
