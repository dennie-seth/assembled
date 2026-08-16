## PlayerController — CharacterBody2D wrapper for the blockout room player.
## Uses PlayerState for the four animation states and binary walk/run noise flag.
## §11 §4: walk/run noise is a binary flag off movement state, not a meter.
## T-0184 §16-a one-room blockout.
class_name PlayerController
extends CharacterBody2D

const WALK_SPEED: float = 64.0  ## px/s — approx 4 tiles/s
const RUN_SPEED: float = 128.0  ## px/s — approx 8 tiles/s, doubles noise

## Item sentinel; mirrors ItemAnchorLogic / ItemDoorLogic.
const ITEM_NONE: int = -1

## Item the player is currently holding (ITEM_NONE if empty).
var held_item: int = ITEM_NONE

## Emitted on the frame the player presses the interact key (E or Space).
signal interact_pressed

var _state: RefCounted  ## PlayerState instance

func _ready() -> void:
	var ps_script: GDScript = load("res://scripts/player_state.gd") as GDScript
	_state = ps_script.new()
	_build_visuals()

## Build placeholder visuals: blue-grey box with a facing indicator dot.
func _build_visuals() -> void:
	var body_rect := ColorRect.new()
	body_rect.name = "BodyRect"
	body_rect.color = Color(0.3, 0.45, 0.75)
	body_rect.size = Vector2(12.0, 14.0)
	body_rect.position = Vector2(-6.0, -7.0)
	add_child(body_rect)

	var facing_dot := ColorRect.new()
	facing_dot.name = "FacingDot"
	facing_dot.color = Color(0.9, 0.9, 1.0)
	facing_dot.size = Vector2(4.0, 4.0)
	facing_dot.position = Vector2(4.0, -2.0)
	add_child(facing_dot)

	var col_shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = Vector2(12.0, 14.0)
	col_shape.shape = box
	add_child(col_shape)

func _physics_process(_delta: float) -> void:
	if _state.state == _state.AnimState.HIDE:
		velocity = Vector2.ZERO
		move_and_slide()
		return

	var move := Vector2.ZERO
	if Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D):
		move.x += 1.0
	if Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A):
		move.x -= 1.0
	if Input.is_key_pressed(KEY_DOWN) or Input.is_key_pressed(KEY_S):
		move.y += 1.0
	if Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W):
		move.y -= 1.0

	var is_moving: bool = move.length_squared() > 0.0
	var is_running: bool = Input.is_key_pressed(KEY_SHIFT)
	_state.set_movement(is_moving, is_running)

	var speed: float = RUN_SPEED if is_running else WALK_SPEED
	velocity = move.normalized() * speed if is_moving else Vector2.ZERO
	move_and_slide()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and (event as InputEventKey).pressed:
		var key: int = (event as InputEventKey).keycode
		if key == KEY_E or key == KEY_SPACE:
			interact_pressed.emit()

## Return current animation state index (matches PlayerState.AnimState enum).
func get_anim_state() -> int:
	return _state.state

## Return true if the player is generating movement noise (running).
func is_making_noise() -> bool:
	return _state.get_noise_flag()

## Transition player into hiding state; movement inputs are ignored while hidden.
func enter_hiding() -> void:
	_state.enter_hiding()
	velocity = Vector2.ZERO

## Exit hiding state; player returns to IDLE.
func exit_hiding() -> void:
	_state.exit_hiding()

## Returns the human-readable name of the current animation state.
func get_state_name() -> String:
	match _state.state:
		_state.AnimState.IDLE:
			return "IDLE"
		_state.AnimState.WALK:
			return "WALK"
		_state.AnimState.RUN:
			return "RUN"
		_state.AnimState.HIDE:
			return "HIDE"
	return "?"
