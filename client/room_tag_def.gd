class_name RoomTagDef
## Room tag definition — anchor-kind classification and composable role flags.
##
## Mirrors assembled::RoomTagDef from shared/note_templates.hpp.
## The single source of truth for C++ is the header; this GDScript class
## exposes the same schema to the Godot layer without a GDExtension binding,
## since room-type authoring metadata is editor-side, not performance-critical.
##
## Design: docs/design/16-level-design.md §1.
## Author: Claude

## Anchor kind — system-facing classification of a declared anchor tag.
## Climax and Tear are found generically by the runtime across any archetype;
## Named anchors are author-facing and receive player notes.
## Values match assembled::AnchorKind in shared/note_templates.hpp.
enum AnchorKind {
	NAMED     = 0, ## Ordinary named room anchor; receives player notes.
	CLIMAX    = 1, ## Dedicated climax anchor; at most 1 per archetype (16 §2).
	TEAR      = 2, ## Dedicated tear anchor; exactly 1 per archetype (16 §2).
	MUSIC_CUE = 3, ## Dedicated music-cue anchor; at most 1 per archetype.
}

## Room role flags — author-facing, composable bitmask (16-level-design.md §1).
## A room may carry multiple roles simultaneously (e.g. GATE|HAZARD).
## Gate and Hazard attach to a room's own named tag; Tear and Climax use
## dedicated AnchorKind values instead of role flags.
## Values match assembled::RoomRole constants in shared/note_templates.hpp.
enum RoomRole {
	NONE    = 0, ## No special role (pure Transit).
	GATE    = 1, ## Required progression gating (item-lock or puzzle).
	HAZARD  = 2, ## Entity-capable slot; carries a sensor-category requirement.
	TRANSIT = 4, ## Connective tissue or padding; no special content.
}

## Tag slug (e.g. "ground_relay", "power_substation", "climax").
var tag_name: String
## System-facing anchor classification (AnchorKind enum value).
var anchor_kind: int
## Bitmask of RoomRole flags (author-facing, composable).
var roles: int


## Construct a room tag definition.
## @param p_tag     Tag slug, e.g. "power_substation".
## @param p_kind    AnchorKind enum value.
## @param p_roles   Bitmask of RoomRole flags; use 0 (NONE) for system anchors.
func _init(p_tag: String, p_kind: int, p_roles: int) -> void:
	tag_name = p_tag
	anchor_kind = p_kind
	roles = p_roles


## Returns true if this room carries the given role flag.
## Only meaningful for NAMED anchors; CLIMAX/TEAR/MUSIC_CUE anchors always
## have roles == NONE and has_role() always returns false for any non-zero flag.
## @param role  A RoomRole enum value (GATE, HAZARD, or TRANSIT).
func has_role(role: int) -> bool:
	return (roles & role) != 0
