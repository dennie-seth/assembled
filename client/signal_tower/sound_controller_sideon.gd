class_name SoundControllerSideon
extends Node
## Sound entity controller for the side-on Signal Tower (§20-a3 / T-0194).
##
## Equipment Floor hazard: The Sound detects players based on noise level.
## Running players are detected within a 5-tile radius (80 px); walking
## players within a 1.5-tile radius (24 px).
##
## Distance is the caller-supplied horizontal pixel distance from the entity.
## Omnidirectional: no facing or geometry blocking applies.
##
## First-pass parameters from 14 §10; tuning in playtest per 11 M-2.

const SENSOR_CATEGORY: String = "SOUND_RADIUS"

## Detection radius for a running player in pixels (5 tiles × 16 px).
const RUN_RADIUS_PX: float = 80.0

## Detection radius for a walking (or stationary) player in pixels (1.5 tiles × 16 px).
const WALK_RADIUS_PX: float = 24.0

## Patrol X bounds — set by the room after instantiation.
var patrol_left_x: float = 0.0
var patrol_right_x: float = 0.0

## Returns true if the player is detected.
##
## @param dist_px     Horizontal pixel distance from the entity to the player.
## @param is_running  true = player is running; false = walking or stationary.
## @param _inventory  Player inventory — unused by this sensor (reserved for
##                    future stealth items), present for interface consistency.
func check_player(dist_px: float, is_running: bool, _inventory: Array) -> bool:
	var radius: float = RUN_RADIUS_PX if is_running else WALK_RADIUS_PX
	return dist_px <= radius
