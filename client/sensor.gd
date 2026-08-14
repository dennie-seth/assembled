class_name Sensor
## Sensor type constants and detection-blocking helper.
##
## Entities compose their detection behaviour from a small reusable sensor
## kit (11-moment-to-moment.md §1).  Three sensor types are supported:
##
##   SIGHT      — sight cone.  Blocked by geometry, cover (CoverBreak), and
##                hiding spots (HidingSpot).
##   SOUND      — sound radius.  Omnidirectional; blocked by hiding spots only.
##   PROXIMITY  — proximity / patrol.  No LOS check; blocked by hiding spots
##                only.
##
## Obstacle nodes (CoverBreak, HidingSpot) implement:
##   blocks_sensor(sensor_type: int) -> bool
##
## Callers pass only the obstacles relevant to the specific entity being
## checked — e.g. include a HidingSpot only when the checked entity IS the
## current occupant.

## Sight-cone sensor — blocked by geometry, cover, and hiding spots.
const SIGHT: int = 0
## Sound-radius sensor — blocked by hiding spots only; omnidirectional.
const SOUND: int = 1
## Proximity / patrol sensor — blocked by hiding spots only; no LOS check.
const PROXIMITY: int = 2

## Returns true if any obstacle in [obstacles] blocks [sensor_type].
static func is_detection_blocked(sensor_type: int, obstacles: Array) -> bool:
	for obs: Variant in obstacles:
		if obs.blocks_sensor(sensor_type):
			return true
	return false
