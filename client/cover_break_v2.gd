class_name CoverBreakV2 extends Node
## CoverBreakV2: floor-anchored cover-break for the side-on floor plane.
##
## Rebuilds CoverBreak (T-0175) for the §11 §4 v5 side-on geometry.
##
## Rules (11-moment-to-moment.md §2):
##   - Floor-anchored: placed at a fixed plane_x on the room's single floor
##     plane; never floating or multi-level-positioned.
##   - Blocks the sight-cone sensor only, via horizontal occlusion — the same
##     cover_props mechanism used by foreground props in T-0189.
##   - Sound-radius and proximity/patrol sensors detect through this object
##     unchanged; they have no cover_props.
##
## Usage:
##   var cover := CoverBreakV2.new()
##   cover.plane_x = 2.5 * 16.0           # floor-anchored position
##   cover.cover_width_px = 16.0           # 1-tile-wide object (default)
##   sight_sensor.cover_props.append(cover.get_cover_interval())

## Floor anchor: X position on the room's single floor plane in pixels.
## Set this once when the object is placed; it does not move.
var plane_x: float = 0.0

## Horizontal width of this cover object in pixels.
## Defaults to 16 px (one tile).  Interval is half-width on each side of plane_x.
var cover_width_px: float = 16.0


## Returns the horizontal occlusion interval (min_x, max_x) in pixels.
##
## Pass this Vector2 to SightConeSensorV2.cover_props to register this object
## as a sight-blocking cover prop.  The interval is symmetric about plane_x.
##
## @return  Vector2(plane_x - cover_width_px/2, plane_x + cover_width_px/2)
func get_cover_interval() -> Vector2:
	var half: float = cover_width_px * 0.5
	return Vector2(plane_x - half, plane_x + half)
