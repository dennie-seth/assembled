## BlockoutRoom — one-room blockout coordinator for T-0184 §16-a.
##
## Authored grid: 24 columns × 13 rows at 16 px/tile = 384×208 px gameplay area.
## The viewport is 384×216; the remaining 8 px at the bottom is the non-gameplay
## bleed band referenced in §13 §3.3 / §05 §5.
##
## Room contains exactly one Watcher, one cover-break position, one hiding spot,
## one item-locked door (debug item 42), and one item anchor — grey-box placeholder
## art only; no chroma, no audio, no notes (§16-a scope).
##
## Controls (keyboard only — blockout prototype):
##   WASD / Arrows  move
##   Shift           hold to run (binary noise flag ON)
##   E / Space       interact (pick up item, enter/exit hiding, open door)
##
## Author: Claude
extends Node2D

## Tile grid constants — single source of truth for authored layout.
const TILE_SIZE: int = 16
const GRID_COLS: int = 24
const GRID_ROWS: int = 13    ## rows within the 384×208 playable viewport slice
const BLEED_PX: int = 8      ## non-gameplay strip at bottom (216 - 208 = 8)

## Item sentinels — match ItemAnchorLogic / ItemDoorLogic.
const ITEM_NONE: int = -1
## Debug grant item ID (matches T-0171 deterministic grant, compiled out in release).
const DEBUG_ITEM_ID: int = 42

## Node references built in _ready.
var _player: PlayerController
var _watcher: WatcherController
var _hiding_logic: RefCounted
var _door_logic: RefCounted
var _anchor_logic: RefCounted

## UI labels.
var _status_label: Label
var _item_label: Label
var _alert_label: Label

## Room state.
var _player_is_hiding: bool = false
var _door_open: bool = false
var _door_body: StaticBody2D   ## kept to disable collision on open
var _anchor_visual: ColorRect  ## toggled when item is picked up / placed
var _alert_timer: float = 0.0

## Convert tile column/row to world-space pixel position (top-left of tile).
func _px(col: int, row: int) -> Vector2:
	return Vector2(col * TILE_SIZE, row * TILE_SIZE)

## Centre of a tile.
func _pxc(col: int, row: int) -> Vector2:
	return _px(col, row) + Vector2(TILE_SIZE * 0.5, TILE_SIZE * 0.5)

func _ready() -> void:
	_build_room()
	_connect_signals()

# ── Room construction ──────────────────────────────────────────────────────────

func _build_room() -> void:
	_build_camera()
	_build_walls()
	_build_cover()
	_build_hiding_spot()
	_build_item_anchor()
	_build_item_door()
	_build_watcher()
	_build_player()
	_build_hud()

## Camera centred on the room.
func _build_camera() -> void:
	var cam := Camera2D.new()
	cam.name = "Camera2D"
	cam.position = Vector2(192.0, 104.0)
	add_child(cam)

## Perimeter walls (StaticBody2D with grey ColorRect + collision).
func _build_walls() -> void:
	# Top wall — row 0.
	_make_wall(Rect2(_px(0, 0), Vector2(GRID_COLS * TILE_SIZE, TILE_SIZE)))
	# Bottom wall — row 12.
	_make_wall(Rect2(_px(0, 12), Vector2(GRID_COLS * TILE_SIZE, TILE_SIZE)))
	# Left wall — col 0, full height.
	_make_wall(Rect2(_px(0, 0), Vector2(TILE_SIZE, GRID_ROWS * TILE_SIZE)))
	# Right wall — col 23, full height.
	_make_wall(Rect2(_px(23, 0), Vector2(TILE_SIZE, GRID_ROWS * TILE_SIZE)))

## Single cover-break column: col 10, rows 2–9 (8 tiles tall).
## Blocks sight only — does NOT block sound or proximity (§11 §2).
## Label annotates which guarantee applies.
func _build_cover() -> void:
	var cover_rect := Rect2(_px(10, 2), Vector2(TILE_SIZE, 8 * TILE_SIZE))
	_make_wall(cover_rect, Color(0.45, 0.45, 0.45), "Cover")

## Dedicated hiding spot: cols 11–12, rows 2–9 (2 tiles wide, 8 tiles tall).
## Blocks sight, sound, and proximity once cleanly inside — full guarantee (§11 §2).
## No invincibility frame: detection at moment of entry registers as a catch (T-0175).
func _build_hiding_spot() -> void:
	_hiding_logic = load("res://scripts/hiding_spot_logic.gd").new()

	var hs_area := Area2D.new()
	hs_area.name = "HidingSpot"

	# Collision.
	var hs_shape := CollisionShape2D.new()
	var hs_box := RectangleShape2D.new()
	hs_box.size = Vector2(2 * TILE_SIZE, 8 * TILE_SIZE)
	hs_shape.shape = hs_box
	hs_area.add_child(hs_shape)

	# Visual: dark blueish rectangle with label.
	var hs_rect := ColorRect.new()
	hs_rect.name = "Visual"
	hs_rect.color = Color(0.08, 0.1, 0.22, 0.85)
	hs_rect.size = Vector2(2 * TILE_SIZE, 8 * TILE_SIZE)
	hs_area.add_child(hs_rect)

	var lbl := _make_tile_label("HIDE", Color(0.5, 0.6, 1.0))
	lbl.position = Vector2(2.0, 4.0)
	hs_area.add_child(lbl)

	hs_area.position = _px(11, 2)
	add_child(hs_area)

## Item anchor: col 4, row 6 (one tile, left half of room).
## Seeded with DEBUG_ITEM_ID so the player can pick it up without a live economy.
func _build_item_anchor() -> void:
	_anchor_logic = load("res://scripts/item_anchor_logic.gd").new()
	_anchor_logic.anchored_item_id = DEBUG_ITEM_ID

	var anc_area := Area2D.new()
	anc_area.name = "ItemAnchor"

	var anc_shape := CollisionShape2D.new()
	var anc_box := RectangleShape2D.new()
	anc_box.size = Vector2(TILE_SIZE, TILE_SIZE)
	anc_shape.shape = anc_box
	anc_area.add_child(anc_shape)

	_anchor_visual = ColorRect.new()
	_anchor_visual.name = "Visual"
	_anchor_visual.color = Color(0.9, 0.75, 0.1)
	_anchor_visual.size = Vector2(TILE_SIZE, TILE_SIZE)
	anc_area.add_child(_anchor_visual)

	var lbl := _make_tile_label("#42", Color(0.2, 0.1, 0.0))
	lbl.position = Vector2(1.0, 4.0)
	anc_area.add_child(lbl)

	anc_area.position = _px(4, 6)
	add_child(anc_area)

## Item-locked door: col 21, rows 2–9 (1 tile wide, 8 tiles tall).
## Opened only by DEBUG_ITEM_ID — wrong/absent item is rejected (T-0179).
## Door stays in a StaticBody2D so its collision can be disabled on open.
func _build_item_door() -> void:
	_door_logic = load("res://scripts/item_door_logic.gd").new()
	_door_logic.required_item_id = DEBUG_ITEM_ID

	_door_body = StaticBody2D.new()
	_door_body.name = "ItemDoor"

	var door_shape := CollisionShape2D.new()
	door_shape.name = "DoorShape"
	var door_box := RectangleShape2D.new()
	door_box.size = Vector2(TILE_SIZE, 8 * TILE_SIZE)
	door_shape.shape = door_box
	_door_body.add_child(door_shape)

	var door_rect := ColorRect.new()
	door_rect.name = "Visual"
	door_rect.color = Color(0.7, 0.3, 0.05)
	door_rect.size = Vector2(TILE_SIZE, 8 * TILE_SIZE)
	_door_body.add_child(door_rect)

	var lbl := _make_tile_label("DOOR\n#42", Color(1.0, 0.9, 0.7))
	lbl.position = Vector2(1.0, 32.0)
	_door_body.add_child(lbl)

	_door_body.position = _px(21, 2)
	add_child(_door_body)

## Watcher: patrols cols 14–18 (5-tile span = 80 px) on row 6 centre.
## Slow patrol speed, wide sight cone, cover_rects wired to the cover column.
func _build_watcher() -> void:
	_watcher = load("res://scripts/watcher_controller.gd").new()
	_watcher.name = "Watcher"
	_watcher.patrol_left = _pxc(14, 6).x
	_watcher.patrol_right = _pxc(18, 6).x
	# Cover column at col 10: occupies x=[160,176), y=[32,160).
	_watcher.cover_rects = [Rect2(_px(10, 2), Vector2(TILE_SIZE, 8 * TILE_SIZE))]
	_watcher.position = _pxc(14, 6)
	add_child(_watcher)

## Player: spawns at col 2, row 6 (left side, middle height).
func _build_player() -> void:
	_player = load("res://scripts/player_controller.gd").new()
	_player.name = "Player"
	_player.position = _pxc(2, 6)
	add_child(_player)

## HUD: CanvasLayer with three labels for state, item, and alert text.
func _build_hud() -> void:
	var hud := CanvasLayer.new()
	hud.name = "HUD"

	_status_label = Label.new()
	_status_label.name = "StatusLabel"
	_status_label.position = Vector2(4.0, 4.0)
	_status_label.add_theme_font_size_override("font_size", 8)
	_status_label.text = "State: IDLE"
	hud.add_child(_status_label)

	_item_label = Label.new()
	_item_label.name = "ItemLabel"
	_item_label.position = Vector2(4.0, 16.0)
	_item_label.add_theme_font_size_override("font_size", 8)
	_item_label.text = "Item: none  [E]=interact"
	hud.add_child(_item_label)

	_alert_label = Label.new()
	_alert_label.name = "AlertLabel"
	_alert_label.position = Vector2(96.0, 4.0)
	_alert_label.add_theme_font_size_override("font_size", 9)
	_alert_label.modulate = Color(1.0, 0.25, 0.25)
	_alert_label.text = ""
	hud.add_child(_alert_label)

	add_child(hud)

# ── Signal wiring ──────────────────────────────────────────────────────────────

func _connect_signals() -> void:
	_player.interact_pressed.connect(_on_player_interact)
	_watcher.player_detected.connect(_on_player_detected)

# ── Per-frame update ───────────────────────────────────────────────────────────

func _process(delta: float) -> void:
	# Detection check (called every process frame for responsiveness).
	var detected: bool = _watcher.check_player(_player.position, _player_is_hiding)

	# Update HUD.
	var noise_str: String = " [NOISE]" if _player.is_making_noise() else ""
	var detect_str: String = " !! SPOTTED !!" if detected else ""
	_status_label.text = "State: %s%s%s" % [_player.get_state_name(), noise_str, detect_str]

	var item_str: String = "Item: #%d" % _player.held_item if _player.held_item != ITEM_NONE else "Item: none"
	var door_str: String = "  Door: OPEN" if _door_open else ""
	_item_label.text = "%s%s  [E]=interact" % [item_str, door_str]

	# Update anchor visual (disappears when item is picked up).
	_anchor_visual.visible = _anchor_logic.has_item()

	# Alert timer.
	if _alert_timer > 0.0:
		_alert_timer -= delta
		if _alert_timer <= 0.0:
			_alert_label.text = ""

# ── Interaction handler ────────────────────────────────────────────────────────

func _on_player_interact() -> void:
	# --- Exit hiding spot ---
	if _player_is_hiding:
		_player_is_hiding = false
		_hiding_logic.exit()
		_player.exit_hiding()
		return

	# --- Enter hiding spot (cols 11–12, rows 2–9) ---
	var hiding_origin: Vector2 = _px(11, 2)
	var hiding_size: Vector2 = Vector2(2 * TILE_SIZE, 8 * TILE_SIZE)
	if _is_near_rect(hiding_origin, hiding_size, _player.position, 1.5 * TILE_SIZE):
		var detected_now: bool = _watcher.check_player(_player.position, false)
		var result: int = _hiding_logic.try_enter(detected_now)
		if result == _hiding_logic.EntryResult.SAFE:
			_player_is_hiding = true
			_player.enter_hiding()
			_show_alert("-- hidden --", Color(0.5, 0.8, 1.0))
		else:
			# Caught on entry: detection registered instant before entry, no i-frame.
			_show_alert("CAUGHT!", Color(1.0, 0.2, 0.2))
		return

	# --- Pick up / place item at anchor (col 4, row 6) ---
	var anchor_origin: Vector2 = _px(4, 6)
	if _is_near_rect(anchor_origin, Vector2(TILE_SIZE, TILE_SIZE), _player.position, 1.5 * TILE_SIZE):
		if _anchor_logic.has_item() and _player.held_item == ITEM_NONE:
			_player.held_item = _anchor_logic.pick_up()
			_show_alert("Picked up #%d" % _player.held_item, Color(0.9, 0.9, 0.2))
		elif _player.held_item != ITEM_NONE and not _anchor_logic.has_item():
			_anchor_logic.place_item(_player.held_item)
			_player.held_item = ITEM_NONE
			_show_alert("Item placed", Color(0.6, 0.6, 0.6))
		return

	# --- Open item-locked door (col 21, rows 2–9) ---
	if not _door_open:
		var door_origin: Vector2 = _px(21, 2)
		if _is_near_rect(door_origin, Vector2(TILE_SIZE, 8 * TILE_SIZE), _player.position, 2.0 * TILE_SIZE):
			if _door_logic.try_open(_player.held_item):
				_door_open = true
				_open_door_visually()
				_show_alert("Door opened!", Color(0.3, 1.0, 0.4))
			else:
				var msg: String = "Wrong item!" if _player.held_item != ITEM_NONE else "Need item #42!"
				_show_alert(msg, Color(1.0, 0.4, 0.1))

## True if player_pos is within reach_px of any edge of the given rect.
func _is_near_rect(origin: Vector2, size: Vector2, player_pos: Vector2, reach_px: float) -> bool:
	var rect := Rect2(origin.x - reach_px, origin.y - reach_px,
		size.x + reach_px * 2.0, size.y + reach_px * 2.0)
	return rect.has_point(player_pos)

## Disable door collision and fade its visual.
func _open_door_visually() -> void:
	for child: Node in _door_body.get_children():
		if child is CollisionShape2D:
			(child as CollisionShape2D).disabled = true
		elif child is ColorRect:
			(child as ColorRect).color = Color(0.7, 0.3, 0.05, 0.25)

## Show timed alert text on the HUD.
func _show_alert(msg: String, color: Color) -> void:
	_alert_label.text = msg
	_alert_label.modulate = color
	_alert_timer = 2.0

func _on_player_detected() -> void:
	_show_alert("!! SPOTTED !!", Color(1.0, 0.15, 0.15))

# ── Helper builders ────────────────────────────────────────────────────────────

## Create a StaticBody2D wall with a grey ColorRect visual at the given rect.
func _make_wall(rect: Rect2, color: Color = Color(0.28, 0.28, 0.28), tag: String = "") -> void:
	var body := StaticBody2D.new()
	if not tag.is_empty():
		body.name = tag

	var col_shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = rect.size
	# CollisionShape position is relative to the StaticBody2D parent.
	col_shape.position = rect.size * 0.5
	col_shape.shape = box
	body.add_child(col_shape)

	var visual := ColorRect.new()
	visual.size = rect.size
	visual.color = color
	body.add_child(visual)

	body.position = rect.position
	add_child(body)

## Create an 8px font label suitable for tile-sized UI text.
func _make_tile_label(text: String, color: Color = Color.WHITE) -> Label:
	var lbl := Label.new()
	lbl.text = text
	lbl.add_theme_font_size_override("font_size", 7)
	lbl.modulate = color
	lbl.autowrap_mode = TextServer.AUTOWRAP_OFF
	return lbl
