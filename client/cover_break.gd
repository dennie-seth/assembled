class_name CoverBreak extends Node
## CoverBreak: a scene object that blocks only the sight-cone sensor.
##
## Sound-radius and proximity/patrol sensors still detect through cover —
## it offers partial, always-available evasion only.
## (11-moment-to-moment.md §2)

## Returns true only for SIGHT.  SOUND and PROXIMITY pass through cover.
func blocks_sensor(sensor_type: int) -> bool:
	return sensor_type == Sensor.SIGHT
