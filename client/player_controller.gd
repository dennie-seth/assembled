class_name PlayerController
extends CharacterBody2D
## T-0173: Side-on player controller.
##
## Owns movement, four animation states (IDLE / MOVE / CROUCH_HIDE / DIE),
## and the binary walk/run noise flag.  No stamina resource exists: running
## costs nothing except the increased detection radius it exposes.
##
## Callers drive state each frame via apply_input / apply_crouch / apply_die,
## then read anim_state and is_loud.  Physics integration (move_and_slide) is
## separated into _physics_process so that unit tests can call update_state
## without a live PhysicsServer.

## Four animation states defined in 01-vision.md §8.  No combat states.
enum AnimState {
	IDLE,
	MOVE,
	CROUCH_HIDE,
	DIE,
}

## Horizontal speed in pixels/second while walking (quiet movement).
const WALK_SPEED: float = 80.0
## Horizontal speed in pixels/second while running (loud movement).
const RUN_SPEED: float = 160.0

## Current animation state.  Read-only from outside; mutated only by
## update_state().
var anim_state: AnimState = AnimState.IDLE

## True when the player is running AND actually moving (velocity != zero).
## Binary — not a meter, not stamina-gated.  Drives the sound-radius sensor
## (11-moment-to-moment.md §4).
var is_loud: bool = false

## Horizontal input direction: −1.0 (left), 0.0 (none), +1.0 (right).
var _input_dir: float = 0.0
## True when the player explicitly requested run (held sprint key).
var _is_running: bool = false
## True when the player is crouching into a hide state.
var _is_crouching: bool = false
## True once apply_die() has been called.  Latches — death is terminal.
var _is_dead: bool = false


## Set horizontal movement direction and run mode from player input.
##
## @param direction  Clamped to [−1.0, +1.0].  0.0 means no horizontal input.
## @param running    True when the sprint key is held.
func apply_input(direction: float, running: bool) -> void:
	_input_dir = clampf(direction, -1.0, 1.0)
	_is_running = running


## Enter or leave the crouch-hide animation state.
##
## @param crouched  True to enter CROUCH_HIDE; false to leave it.
func apply_crouch(crouched: bool) -> void:
	_is_crouching = crouched


## Latch the player into the DIE state.  Cannot be undone on this instance.
func apply_die() -> void:
	_is_dead = true


## Recompute velocity, anim_state, and is_loud from the current input flags.
##
## Does NOT call move_and_slide(); call this before the physics step or use
## it directly in tests.
##
## @param delta  Frame delta time in seconds (used for future acceleration
##               curves; currently the velocity is set directly).
func update_state(_delta: float) -> void:
	# Compute intended horizontal velocity from input and selected speed.
	var speed: float = RUN_SPEED if _is_running else WALK_SPEED
	velocity = Vector2(_input_dir * speed, 0.0)

	# Noise flag: loud only when the run key is held AND the player is
	# actually moving.  Zero velocity — even with run held — produces no noise.
	is_loud = _is_running and velocity.length_squared() > 0.0

	# Animation state priority: die > crouch_hide > move > idle.
	if _is_dead:
		anim_state = AnimState.DIE
	elif _is_crouching:
		anim_state = AnimState.CROUCH_HIDE
	elif velocity.length_squared() > 0.0:
		anim_state = AnimState.MOVE
	else:
		anim_state = AnimState.IDLE


func _physics_process(delta: float) -> void:
	update_state(delta)
	move_and_slide()
