class_name PlayerController
extends CharacterBody2D
## T-0188: Player controller — side-on, single floor plane, no jump.
##
## Rebuilds T-0173's free-2D model to the confirmed §11 §4 v5 spec:
##   - Movement is horizontal only; vertical Y is pinned to floor_y every frame.
##   - No jump input or jump state exists anywhere in this controller.
##   - Vertical room-to-room movement happens only via explicit ladder/stairs
##     connectors (§11 §5); stepping into a connector area emits room_transition.
##   - Walking or running onto a Drop-gap tile triggers instant fall death —
##     no fall-damage tier, no recovery, no partial fall.
##
## Drop-gap check evaluates BOTH the player's current position rect (catches
## the rapid-reversal edge case: player already on gap with reversed input)
## AND the candidate next-frame rect (catches entering a gap this frame).
##
## Preserves the full T-0173 public interface:
##   AnimState enum {IDLE, MOVE, CROUCH_HIDE, DIE}
##   WALK_SPEED, RUN_SPEED constants
##   anim_state, is_loud properties
##   apply_input(), apply_crouch(), apply_die(), update_state()

## Four animation states (§8).  No combat states, no jump/airborne state.
## Contract defined in T-0173, carried forward unchanged.
enum AnimState {
	IDLE,
	MOVE,
	CROUCH_HIDE,
	DIE,
}

## Horizontal walk speed px/s — quiet movement.
const WALK_SPEED: float = 80.0
## Horizontal run speed px/s — loud movement.
const RUN_SPEED: float = 160.0

## Player body half-extents (12×14 px, centred at position).
## Used for gap overlap testing.
const _HALF_W: float = 6.0
const _HALF_H: float = 7.0

## Current animation state.  Read-only from outside; written by update_state().
var anim_state: AnimState = AnimState.IDLE

## True when the player is running AND actually moving.  Binary — no meter,
## no stamina gate.  Drives the sound-radius sensor (§11 §4).
var is_loud: bool = false

## Floor Y coordinate in world space.  Set by the room runtime (T-0187).
## _physics_process pins position.y to this value before and after each
## move_and_slide call, preventing any vertical drift.
var floor_y: float = 0.0

## Drop-gap tile rects in world space.  Any overlap between the player body
## (current or next-frame position) and any entry triggers instant fall death.
## Populated by the room runtime (T-0187).
var drop_gaps: Array[Rect2] = []

## Room connectors (ladders / stairs).  Each entry is a Dictionary:
##   "area"           : Rect2   — world-space trigger zone
##   "target_room_id" : String  — destination room identifier
## When the player's centre enters an area, room_transition is emitted.
## The room runtime listens and drives the actual scene/floor-plane change.
var room_connectors: Array[Dictionary] = []

## Emitted when the player steps into a ladder/stairs connector area.
## @param target_room_id  Destination room identifier, passed verbatim from
##                        the connector dictionary.
signal room_transition(target_room_id: String)

## Emitted on the frame the player presses the interact key (E or Space).
signal interact_pressed

# ── Internal flags ─────────────────────────────────────────────────────────────
var _input_dir: float = 0.0
var _is_running: bool = false
var _is_crouching: bool = false
var _is_dead: bool = false


# ── Public API (T-0173 contract + T-0188 additions) ───────────────────────────

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


## Latch the player into the DIE state.  Terminal — cannot be undone on this
## instance.
func apply_die() -> void:
	_is_dead = true


## Recompute velocity, anim_state, and is_loud from the current input flags.
##
## Drop-gap check (§11 §4 v5):
##   1. Build the player's body rect at the CURRENT position.
##   2. Build the body rect at the CANDIDATE next-frame position
##      (position + velocity * delta).
##   3. If either rect overlaps any entry in drop_gaps, call apply_die()
##      immediately and return — no intermediate state, no frame delay.
##
## Checking the current position first is the rapid-reversal guard: if the
## player is already standing on a gap tile (having entered it in a prior frame
## with a direction that has since reversed), they die this frame regardless of
## which way the new velocity points.
##
## Does NOT call move_and_slide(); call this from _physics_process or directly
## from tests (safe without a live PhysicsServer).
##
## @param delta  Frame delta time in seconds.
func update_state(delta: float) -> void:
	# Dead state is terminal — freeze and return.
	if _is_dead:
		anim_state = AnimState.DIE
		velocity = Vector2.ZERO
		is_loud = false
		return

	# Horizontal-only velocity — Y is always zero (no jump, floor-plane locked).
	var speed: float = RUN_SPEED if _is_running else WALK_SPEED
	velocity = Vector2(_input_dir * speed, 0.0)

	# ── Drop-gap check ─────────────────────────────────────────────────────────
	var half: Vector2 = Vector2(_HALF_W, _HALF_H)
	var cur_rect: Rect2 = Rect2(position - half, half * 2.0)
	var next_rect: Rect2 = Rect2(position + velocity * delta - half, half * 2.0)

	for gap: Rect2 in drop_gaps:
		if cur_rect.intersects(gap) or next_rect.intersects(gap):
			apply_die()
			anim_state = AnimState.DIE
			velocity = Vector2.ZERO
			is_loud = false
			return

	# Noise flag: running AND actually moving.  Zero velocity → no noise.
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

	# ── Room connector check ───────────────────────────────────────────────────
	# Emit room_transition if the player's centre is inside any connector area.
	# The room runtime (T-0187) listens on this signal and performs the actual
	# room swap + floor_y update.  This controller never modifies position.y
	# directly for vertical transitions — that is the room runtime's job.
	for connector: Dictionary in room_connectors:
		var area: Rect2 = connector["area"] as Rect2
		if area.has_point(position):
			room_transition.emit(connector["target_room_id"])
			break  # one transition per frame


func _physics_process(delta: float) -> void:
	# Pin Y to the floor plane before physics integration, preventing any
	# vertical drift the PhysicsServer might introduce.
	position.y = floor_y
	update_state(delta)
	move_and_slide()
	# Re-pin after move_and_slide in case integration nudged Y.
	position.y = floor_y


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and (event as InputEventKey).pressed:
		var key: int = (event as InputEventKey).keycode
		if key == KEY_E or key == KEY_SPACE:
			interact_pressed.emit()
