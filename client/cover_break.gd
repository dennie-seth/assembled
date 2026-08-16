class_name CoverBreak extends Node
## CoverBreak: a scene object that blocks only the sight-cone sensor.
##
## Sound-radius and proximity/patrol sensors still detect through cover —
## it offers partial, always-available evasion only.
## (11-moment-to-moment.md §2)

## Explicit preload so Sensor.SIGHT resolves in headless --script mode where
## the global class_name registry may not be populated yet.
const _Sensor := preload("res://sensor.gd")

## Returns true only for SIGHT.  SOUND and PROXIMITY pass through cover.
func blocks_sensor(sensor_type: int) -> bool:
	return sensor_type == _Sensor.SIGHT
