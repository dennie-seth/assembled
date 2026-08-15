class_name SightConeSensor
extends Node
## Composable sight-cone sensor for hazard entities (T-0174).
##
## Add as a child of any entity node.  Each frame, set entity_position and
## entity_facing_angle, then call check(player_pos) to query detection.
##
## Occlusion (e.g. tilemap walls) is injected via occluder_fn rather than
## hard-wired to a physics space, so the sensor is testable headless and
## usable by any entity without scene coupling.
##
## The Hiding card's cover-break logic reads last_check_was_occluded to
## distinguish "target hidden behind geometry" from "target simply out of cone".

## Emitted on the transition: not-detected → detected.
signal target_detected(target_pos: Vector2)
## Emitted on the transition: detected → not-detected.
signal target_cleared()

## Half-angle of the FOV cone in degrees.  Total FOV = 2 × cone_half_angle_deg.
## Default: 45° → 90° total, matching the first-pass Watcher value (doc 14 §10).
@export var cone_half_angle_deg: float = 45.0
## Detection range in tiles.
## Default: 6, matching the first-pass Watcher value (doc 14 §10).
@export var range_tiles: float = 6.0
## Pixels per tile — must match the project tilemap.
@export var tile_size: float = 16.0

## Entity world position in pixels.  Updated by the owning entity each frame.
var entity_position: Vector2 = Vector2.ZERO
## Entity facing direction as an angle in radians (0 = +X, PI/2 = +Y).
var entity_facing_angle: float = 0.0

## Occlusion callable: (from: Vector2, to: Vector2) -> bool.
## Return true if the direct line from → to is blocked by geometry.
## Leave as an invalid Callable (default) for no occlusion check.
## The owning entity injects the physics-space or tilemap raycast here.
var occluder_fn: Callable

## True iff the most recent check() call was blocked specifically by
## geometry (occluder_fn returned true), as opposed to being out of angle
## or range.  The Hiding card's cover-break hook reads this property.
var last_check_was_occluded: bool = false

var _was_detected: bool = false


## Returns true iff target_pos is inside the cone, within range, and unoccluded.
## Emits target_detected / target_cleared on state transitions.
func check(target_pos: Vector2) -> bool:
	last_check_was_occluded = false

	var to_target: Vector2 = target_pos - entity_position
	var dist_px: float = to_target.length()

	# Range check.
	if dist_px > range_tiles * tile_size:
		_set_detected(false)
		return false

	# Cone angle check.
	var angle_to: float = to_target.angle()
	var diff: float = absf(angle_difference(entity_facing_angle, angle_to))
	if diff > deg_to_rad(cone_half_angle_deg):
		_set_detected(false)
		return false

	# Occlusion check — only reached when target is in cone and range.
	if occluder_fn.is_valid() and occluder_fn.call(entity_position, target_pos):
		last_check_was_occluded = true
		_set_detected(false)
		return false

	_set_detected(true)
	return true


func _set_detected(detected: bool) -> void:
	if detected and not _was_detected:
		_was_detected = true
		target_detected.emit(entity_position)
	elif not detected and _was_detected:
		_was_detected = false
		target_cleared.emit()
