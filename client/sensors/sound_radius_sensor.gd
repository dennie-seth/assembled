class_name SoundRadiusSensor
extends Node
## Composable sound-radius sensor for hazard entities (T-0174).
##
## Omnidirectional — not blocked by any geometry.  The effective detection
## radius switches between walk_radius_tiles and run_radius_tiles based on
## the player's binary noise flag (walk vs run), supplied via
## update_movement_state() each frame before calling check().
##
## Edge-case guarantee: when the player transitions from running to walking/
## stopped in a single frame the sensor retains run_radius for that check
## call, preventing a dropped trigger (the sensor reads both the current and
## previous movement state via _prev_was_running).

## Emitted on the transition: not-detected → detected.
signal target_detected(target_pos: Vector2)
## Emitted on the transition: detected → not-detected.
signal target_cleared()

## Detection radius when the player is walking or stationary (tiles).
## Default: 1.5, matching the first-pass Sound value (doc 14 §10).
@export var walk_radius_tiles: float = 1.5
## Detection radius when the player is running (tiles).
## Default: 5.0, matching the first-pass Sound value (doc 14 §10).
@export var run_radius_tiles: float = 5.0
## Pixels per tile — must match the project tilemap.
@export var tile_size: float = 16.0

## Sensor (entity) world position in pixels.  Updated by the owning entity each frame.
var entity_position: Vector2 = Vector2.ZERO

var _is_running: bool = false
var _prev_was_running: bool = false
var _was_detected: bool = false


## Call with the player's current movement state before calling check().
## @param is_running  true for run, false for walk or stationary.
func update_movement_state(is_running: bool) -> void:
	_prev_was_running = _is_running
	_is_running = is_running


## Returns true iff the player at target_pos is within the effective radius.
## If the player transitioned from running to not-running this frame the run
## radius is still applied for this call (no single-frame trigger drop).
func check(target_pos: Vector2) -> bool:
	# Use run_radius if currently running OR if running the previous frame.
	var radius_tiles: float = run_radius_tiles if (_is_running or _prev_was_running) else walk_radius_tiles
	var dist_px: float = entity_position.distance_to(target_pos)
	var detected: bool = dist_px <= radius_tiles * tile_size

	if detected and not _was_detected:
		_was_detected = true
		target_detected.emit(target_pos)
	elif not detected and _was_detected:
		_was_detected = false
		target_cleared.emit()

	return detected
