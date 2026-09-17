class_name StillAirControllerSideon
extends Node
## Proximity/patrol entity controller for the side-on Signal Tower (§20-a3 / T-0194).
##
## Antenna Shaft hazard: The Still Air patrols a fixed route and detects any
## player (regardless of movement state) within a 1.5-tile catch radius (24 px).
## No line-of-sight check — detection is purely radial.
##
## First-pass parameters from 14 §10; tuning in playtest per 11 M-2.

const SENSOR_CATEGORY: String = "PROXIMITY_PATROL"

## Catch radius in pixels (1.5 tiles × 16 px).
const CATCH_RADIUS_PX: float = 24.0

## Patrol lap duration in seconds (midpoint of the 20–30 s range from 14 §10).
const LAP_SEC: float = 25.0

## Patrol X bounds — set by the room after instantiation.
var patrol_left_x: float = 0.0
var patrol_right_x: float = 0.0

## Returns true if the player is within the catch radius.
##
## @param dist_px     Horizontal pixel distance from the entity to the player.
## @param _is_running Movement state — irrelevant for proximity detection.
## @param _inventory  Player inventory — unused by this sensor.
func check_player(dist_px: float, _is_running: bool, _inventory: Array) -> bool:
	return dist_px <= CATCH_RADIUS_PX
