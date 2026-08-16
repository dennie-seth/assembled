## HidingSpotLogic — full sensor block once inside cleanly; no i-frame on entry.
## §11 §2: hiding spot blocks sight, sound, and proximity once cleanly inside.
## T-0175: no invincibility frame on entry transition.
extends RefCounted

enum EntryResult { SAFE, CAUGHT }

## True while the player is occupying this hiding spot.
var is_occupied: bool = false

## A hiding spot always blocks all sensors once the player is inside.
func blocks_all_sensors() -> bool:
	return true

## Attempt to enter the hiding spot.
## detected: whether any watcher sensor had the player at the moment of entry.
## Returns CAUGHT (no occupancy set) if detected; SAFE and sets is_occupied otherwise.
func try_enter(detected: bool) -> EntryResult:
	if detected:
		return EntryResult.CAUGHT
	is_occupied = true
	return EntryResult.SAFE

## Exit the hiding spot, clearing occupancy.
func exit() -> void:
	is_occupied = false
