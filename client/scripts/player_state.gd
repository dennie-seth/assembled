## PlayerState — four animation states and binary walk/run noise flag.
## §11 §4: walk/run noise is a binary flag off movement state, not a meter.
extends RefCounted

enum AnimState { IDLE, WALK, RUN, HIDE }

var state: AnimState = AnimState.IDLE
var is_running: bool = false

## Set movement inputs. Ignored while in HIDE state.
func set_movement(is_moving: bool, is_run_key: bool) -> void:
	if state == AnimState.HIDE:
		return
	if not is_moving:
		state = AnimState.IDLE
		is_running = false
	elif is_run_key:
		state = AnimState.RUN
		is_running = true
	else:
		state = AnimState.WALK
		is_running = false

## Binary noise flag: true only when running.
func get_noise_flag() -> bool:
	return is_running

## Transition into the hiding state, clearing movement noise.
func enter_hiding() -> void:
	state = AnimState.HIDE
	is_running = false

## Exit hiding, resetting to IDLE.
func exit_hiding() -> void:
	state = AnimState.IDLE
	is_running = false
