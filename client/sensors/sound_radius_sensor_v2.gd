class_name SoundRadiusSensorV2
extends Node
## Composable sound-radius sensor for the side-on floor plane (T-0189 / §11 §4 v5).
##
## Replaces SoundRadiusSensor (T-0174) for the rebuilt side-on model.  Distance
## is measured as horizontal absolute difference (|player_plane_x − entity_plane_x|)
## — the floor plane's single axis.
##
## Omnidirectional: sound propagates regardless of the entity's facing direction.
## Never blocked by room geometry, Drop gaps, or foreground cover props.
##
## Effective radius switches between walk_radius_tiles and run_radius_tiles based
## on the player's binary noise flag.  Single-frame run→stop guarantee preserved
## from T-0174: if the player transitioned from running to not-running this frame,
## run_radius still applies for this check (no dropped trigger on state change).

## Emitted on the transition: not-detected → detected.
## @param target_plane_x  The player's X position on the floor plane.
signal target_detected(target_plane_x: float)

## Emitted on the transition: detected → not-detected.
signal target_cleared()

## Detection radius when the player is walking or stationary (tiles).
@export var walk_radius_tiles: float = 1.5

## Detection radius when the player is running (tiles).
@export var run_radius_tiles: float = 5.0

## Pixels per tile — must match the project tilemap.
@export var tile_size: float = 16.0

## Entity's X position on the side-on floor plane in pixels.
## Updated by the owning entity each frame before calling check().
var entity_plane_x: float = 0.0

var _is_running: bool = false
var _prev_was_running: bool = false
var _was_detected: bool = false


## Update the player's noise state before calling check().
## @param is_running  true = player is running; false = walking or stationary.
func update_movement_state(is_running: bool) -> void:
	_prev_was_running = _is_running
	_is_running = is_running


## Returns true iff the player at player_plane_x is within the effective radius.
## If the player transitioned from running to not-running this frame the run
## radius is still applied (no single-frame trigger drop).
##
## @param player_plane_x  Player's X position on the floor plane in pixels.
func check(player_plane_x: float) -> bool:
	var radius_tiles: float = run_radius_tiles if (_is_running or _prev_was_running) else walk_radius_tiles
	var dist_px: float = absf(player_plane_x - entity_plane_x)
	var detected: bool = dist_px <= radius_tiles * tile_size

	if detected and not _was_detected:
		_was_detected = true
		target_detected.emit(player_plane_x)
	elif not detected and _was_detected:
		_was_detected = false
		target_cleared.emit()

	return detected
