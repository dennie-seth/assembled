## Room type taxonomy per docs/design/16-level-design.md §1.
##
## Climax and Tear are system-facing (own declared anchor tags) — the spawner
## and crossing logic find them generically across any archetype via lookup.
## Gate, Hazard, and Transit are author-facing roles on ordinary named room tags.

class_name RoomTypes

enum Role {
	CLIMAX,          ## Guaranteed rare/unique delivery point (≤1 per archetype)
	TEAR,            ## Crossable to next archetype or foreign pocket (exactly 1/archetype)
	GATE,            ## Required progression barrier — item-lock or puzzle (11 §5–§6)
	HAZARD,          ## Entity-capable slot (11 §1 sensor kit)
	TRANSIT,         ## Connective tissue / no special content
}

enum SensorCategory {
	SIGHT_CONE,       ## Blocked by geometry/cover — The Watcher
	SOUND_RADIUS,     ## Omnidirectional, walk/run threshold — The Sound
	PROXIMITY_PATROL, ## Fixed route, no LOS check — The Still Air
}

enum MovementState {
	WALK,
	RUN,
}
