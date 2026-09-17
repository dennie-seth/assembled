## BlockoutRoomSideon — one-room blockout coordinator for T-0192.
##
## Rebuilds the §16-a one-room blockout on the T-0187–T-0190 side-on runtime.
## Everything is constructed in code; no Godot editor layout is required.
## Grey boxes only — no chroma, no audio, no notes (§16-a scope).
##
## Room layout (24 × 13 tiles at 16 px/tile, 384 × 208 px playable area):
##
##   Col  0       Left wall
##   Col  1–2     Entry corridor — player spawns here
##   Col  4       Item anchor (debug item #42, yellow box)
##   Col  7       Hiding spot (dark blue-grey box, blocks all sensors)
##   Col  9       Cover break  (mid-grey, blocks sight only)
##   Col 12–18    Watcher patrol zone (red box with cone overlay)
##   Col 21       Item-locked door (orange, requires item #42)
##   Col 22–23    Right wall
##
## Design intent:
##   - Player spawns at col 2, watcher patrol starts at col 12 — 160 px apart,
##     outside the 6-tile (96 px) sight range — so the player can spot the
##     Watcher before the Watcher spots them.
##   - Cover at col 9 breaks the watcher's sight line; the hiding spot at col 7
##     is safely behind the cover interval [144, 160].
##   - The door at col 21 is in the watcher patrol zone — the player must either
##     evade detection or use the hiding spot to cross safely.
##   - All sensor thresholds are balanced so failure results from a player error
##     (walking into the cone, running near sound range), not an ambush.
##
## Controls: WASD / Arrows = move, Shift = run, E / Space = interact.
##
## Author: Claude
extends Node2D

## ── Layout constants ─────────────────────────────────────────────────────────
const TILE_SIZE: int  = 16
const GRID_COLS: int  = 24
const GRID_ROWS: int  = 13
const BLEED_PX: int   = 8

## Player spawn tile column.
const PLAYER_SPAWN_COL: int     = 2
## Item anchor tile column (holds debug item #42).
const ITEM_ANCHOR_COL: int      = 4
## Hiding spot tile column (centre of the floor-anchored spot).
const HIDING_SPOT_COL: int      = 7
## Cover break tile column (centre of the cover object).
const COVER_COL: int            = 9
## Watcher patrol boundaries (tile columns).
const WATCHER_LEFT_COL: int     = 12
const WATCHER_RIGHT_COL: int    = 18
## Item-locked door tile column.
const DOOR_COL: int             = 21

## Debug item ID (matches ItemAnchorLogic / ItemDoorLogic sentinel, T-0171).
const DEBUG_ITEM_ID: int = 42
const ITEM_NONE: int     = -1

## ── Preloads ─────────────────────────────────────────────────────────────────
const _PlayerScript: GDScript  = preload("res://scripts/player_controller.gd")
const _WatcherScript: GDScript = preload("res://scripts/watcher_controller_sideon.gd")

## ── Node references ───────────────────────────────────────────────────────────
var _player: CharacterBody2D
var _watcher  ## WatcherControllerSideon instance

var _hiding_spot: Node   ## HidingSpotV2 instance
var _cover: Node         ## CoverBreakV2 instance
var _anchor_logic: RefCounted
var _door_logic: RefCounted

var _anchor_visual: ColorRect
var _door_body: StaticBody2D

## ── Room state ────────────────────────────────────────────────────────────────
var _player_is_hiding: bool = false
var _door_open: bool        = false
var _alert_timer: float     = 0.0

## ── HUD labels ────────────────────────────────────────────────────────────────
var _status_label: Label
var _item_label: Label
var _alert_label: Label


## Convert tile column to world-space pixel X at the centre of that tile.
func _pxc_x(col: int) -> float:
	return float(col * TILE_SIZE) + float(TILE_SIZE) * 0.5


## Convert tile column/row to world-space pixel position (top-left of tile).
func _px(col: int, row: int) -> Vector2:
	return Vector2(col * TILE_SIZE, row * TILE_SIZE)


func _ready() -> void:
	_build_room()
	_connect_signals()


# ── Room construction ──────────────────────────────────────────────────────────

func _build_room() -> void:
	_build_camera()
	_build_walls()
	_build_floor()
	_build_cover()
	_build_hiding_spot()
	_build_item_anchor()
	_build_item_door()
	_build_watcher()
	_build_player()
	_build_hud()


func _build_camera() -> void:
	var cam := Camera2D.new()
	cam.name = "Camera2D"
	cam.position = Vector2(192.0, 104.0)
	add_child(cam)


## Perimeter walls (top, bottom, left, right strips).
func _build_walls() -> void:
	_make_wall(Rect2(_px(0, 0), Vector2(GRID_COLS * TILE_SIZE, TILE_SIZE)))   ## top
	_make_wall(Rect2(_px(0, 12), Vector2(GRID_COLS * TILE_SIZE, TILE_SIZE)))  ## bottom
	_make_wall(Rect2(_px(0, 0), Vector2(TILE_SIZE, GRID_ROWS * TILE_SIZE)))   ## left
	_make_wall(Rect2(_px(22, 0), Vector2(2 * TILE_SIZE, GRID_ROWS * TILE_SIZE))) ## right (cols 22–23)


## Solid floor strip at row 11 (one row above bottom wall) — players walk here.
func _build_floor() -> void:
	_make_wall(
		Rect2(_px(1, 11), Vector2(21 * TILE_SIZE, TILE_SIZE)),
		Color(0.22, 0.22, 0.22)
	)


## Cover break: col 9, rows 2–10 (visual pillar) — blocks watcher sight only.
## CoverBreakV2 registers its horizontal interval with the watcher's sight sensor.
func _build_cover() -> void:
	_cover = load("res://cover_break_v2.gd").new()
	_cover.plane_x       = _pxc_x(COVER_COL)   ## 152 px
	_cover.cover_width_px = float(TILE_SIZE)     ## 16 px → interval [144, 160]
	add_child(_cover)

	## Visual pillar (grey, mid-tone to distinguish from walls).
	var pillar_rect := ColorRect.new()
	pillar_rect.color = Color(0.42, 0.42, 0.42)
	pillar_rect.size  = Vector2(TILE_SIZE, 9 * TILE_SIZE)
	pillar_rect.position = _px(COVER_COL, 2)
	add_child(pillar_rect)

	var lbl := _make_tile_label("COV", Color(0.8, 0.8, 0.8))
	lbl.position = _px(COVER_COL, 2) + Vector2(1.0, 2.0)
	add_child(lbl)


## Hiding spot: floor-anchored at col 7.  Occupant is protected from all sensors.
func _build_hiding_spot() -> void:
	_hiding_spot = load("res://hiding_spot_v2.gd").new()
	_hiding_spot.plane_x = _pxc_x(HIDING_SPOT_COL)   ## 120 px
	add_child(_hiding_spot)

	## Visual: dark recess behind cover position.
	var hs_area := Area2D.new()
	hs_area.name = "HidingSpotArea"

	var hs_shape := CollisionShape2D.new()
	var hs_box   := RectangleShape2D.new()
	hs_box.size  = Vector2(TILE_SIZE, 9 * TILE_SIZE)
	hs_shape.shape = hs_box
	hs_shape.position = Vector2(TILE_SIZE * 0.5, 4.5 * TILE_SIZE)
	hs_area.add_child(hs_shape)

	var hs_rect := ColorRect.new()
	hs_rect.color = Color(0.08, 0.1, 0.22, 0.85)
	hs_rect.size  = Vector2(TILE_SIZE, 9 * TILE_SIZE)
	hs_area.add_child(hs_rect)

	var lbl := _make_tile_label("HIDE", Color(0.5, 0.6, 1.0))
	lbl.position = Vector2(0.0, 3.0)
	hs_area.add_child(lbl)

	hs_area.position = _px(HIDING_SPOT_COL, 2)
	add_child(hs_area)


## Item anchor: col 4, row 10 (just above floor). Seeded with debug item #42.
func _build_item_anchor() -> void:
	_anchor_logic = load("res://scripts/item_anchor_logic.gd").new()
	_anchor_logic.anchored_item_id = DEBUG_ITEM_ID

	var anc_area := Area2D.new()
	anc_area.name = "ItemAnchor"

	var anc_shape := CollisionShape2D.new()
	var anc_box   := RectangleShape2D.new()
	anc_box.size  = Vector2(TILE_SIZE, TILE_SIZE)
	anc_shape.shape = anc_box
	anc_shape.position = Vector2(TILE_SIZE * 0.5, TILE_SIZE * 0.5)
	anc_area.add_child(anc_shape)

	_anchor_visual = ColorRect.new()
	_anchor_visual.name  = "Visual"
	_anchor_visual.color = Color(0.9, 0.75, 0.1)
	_anchor_visual.size  = Vector2(TILE_SIZE, TILE_SIZE)
	anc_area.add_child(_anchor_visual)

	var lbl := _make_tile_label("#42", Color(0.15, 0.08, 0.0))
	lbl.position = Vector2(1.0, 4.0)
	anc_area.add_child(lbl)

	anc_area.position = _px(ITEM_ANCHOR_COL, 10)
	add_child(anc_area)


## Item-locked door: col 21, rows 2–10. Requires debug item #42 to open.
func _build_item_door() -> void:
	_door_logic = load("res://scripts/item_door_logic.gd").new()
	_door_logic.required_item_id = DEBUG_ITEM_ID

	_door_body = StaticBody2D.new()
	_door_body.name = "ItemDoor"

	var door_shape := CollisionShape2D.new()
	door_shape.name = "DoorShape"
	var door_box    := RectangleShape2D.new()
	door_box.size   = Vector2(TILE_SIZE, 9 * TILE_SIZE)
	door_shape.shape = door_box
	door_shape.position = Vector2(TILE_SIZE * 0.5, 4.5 * TILE_SIZE)
	_door_body.add_child(door_shape)

	var door_rect := ColorRect.new()
	door_rect.name  = "Visual"
	door_rect.color = Color(0.7, 0.3, 0.05)
	door_rect.size  = Vector2(TILE_SIZE, 9 * TILE_SIZE)
	_door_body.add_child(door_rect)

	var lbl := _make_tile_label("DOOR\n#42", Color(1.0, 0.9, 0.7))
	lbl.position = Vector2(1.0, 28.0)
	_door_body.add_child(lbl)

	_door_body.position = _px(DOOR_COL, 2)
	add_child(_door_body)


## Watcher: patrol from col 12 to col 18 on the floor row (row 10 centre).
## Cover interval from CoverBreakV2 is registered with the watcher's sight sensor
## at construction time via the cover_props array.
func _build_watcher() -> void:
	_watcher = _WatcherScript.new()
	_watcher.name = "Watcher"
	_watcher.patrol_left_x  = _pxc_x(WATCHER_LEFT_COL)
	_watcher.patrol_right_x = _pxc_x(WATCHER_RIGHT_COL)
	_watcher.cover_props.append(_cover.get_cover_interval())
	_watcher.position = Vector2(_pxc_x(WATCHER_LEFT_COL), _px(0, 10).y + TILE_SIZE * 0.5)
	add_child(_watcher)


## Player: spawns at col 2, floor row 10.
func _build_player() -> void:
	_player = _PlayerScript.new()
	_player.name = "Player"
	_player.position = Vector2(_pxc_x(PLAYER_SPAWN_COL), _px(0, 10).y + TILE_SIZE * 0.5)
	add_child(_player)


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
	## Build obstacle list: hiding spot included only when player is occupant.
	var obstacles: Array = []
	if _player_is_hiding:
		obstacles.append(_hiding_spot)

	var player_plane_x: float = _player.position.x
	var is_running: bool      = _player.is_making_noise()

	var detected: bool = _watcher.check_player(
		player_plane_x, is_running, obstacles
	)

	## HUD status.
	var noise_str: String   = " [NOISE]" if is_running else ""
	var detect_str: String  = " !! SPOTTED !!" if detected else ""
	var state_str: String   = _player.get_state_name() if _player.has_method("get_state_name") else "?"
	_status_label.text = "State: %s%s%s" % [state_str, noise_str, detect_str]

	var item_str: String = "Item: #%d" % _player.held_item if _player.held_item != ITEM_NONE else "Item: none"
	var door_str: String = "  Door: OPEN" if _door_open else ""
	_item_label.text = "%s%s  [E]=interact" % [item_str, door_str]

	_anchor_visual.visible = _anchor_logic.has_item()

	if _alert_timer > 0.0:
		_alert_timer -= delta
		if _alert_timer <= 0.0:
			_alert_label.text = ""


# ── Interaction handler ────────────────────────────────────────────────────────

func _on_player_interact() -> void:
	## Exit hiding spot.
	if _player_is_hiding:
		_player_is_hiding = false
		_hiding_spot.exit_spot(_player)
		_player.exit_hiding()
		return

	var player_x: float = _player.position.x

	## Enter hiding spot (within 1.5 tiles of the spot's plane_x).
	var hiding_reach: float = 1.5 * TILE_SIZE
	if absf(player_x - _hiding_spot.plane_x) <= hiding_reach:
		## Check detection state at entry moment — no i-frame.
		var obstacles_entry: Array = []
		var detected_at_entry: bool = _watcher.check_player(
			player_x, _player.is_making_noise(), obstacles_entry
		)
		if detected_at_entry:
			## No i-frame — caught the instant of entry attempt.
			_show_alert("CAUGHT!", Color(1.0, 0.2, 0.2))
		elif _hiding_spot.try_enter(_player):
			_player_is_hiding = true
			_player.enter_hiding()
			_show_alert("-- hidden --", Color(0.5, 0.8, 1.0))
		## If try_enter returned false (spot occupied), silently ignore.
		return

	## Pick up / place item at anchor.
	var anchor_reach: float = 1.5 * TILE_SIZE
	var anchor_x: float = _pxc_x(ITEM_ANCHOR_COL)
	if absf(player_x - anchor_x) <= anchor_reach:
		if _anchor_logic.has_item() and _player.held_item == ITEM_NONE:
			_player.held_item = _anchor_logic.pick_up()
			_show_alert("Picked up #%d" % _player.held_item, Color(0.9, 0.9, 0.2))
		elif _player.held_item != ITEM_NONE and not _anchor_logic.has_item():
			_anchor_logic.place_item(_player.held_item)
			_player.held_item = ITEM_NONE
			_show_alert("Item placed", Color(0.6, 0.6, 0.6))
		return

	## Open item-locked door.
	if not _door_open:
		var door_x: float = _pxc_x(DOOR_COL)
		if absf(player_x - door_x) <= 2.0 * TILE_SIZE:
			if _door_logic.try_open(_player.held_item):
				_door_open = true
				_open_door_visually()
				_show_alert("Door opened!", Color(0.3, 1.0, 0.4))
			else:
				var msg: String = "Wrong item!" if _player.held_item != ITEM_NONE else "Need item #42!"
				_show_alert(msg, Color(1.0, 0.4, 0.1))


func _open_door_visually() -> void:
	for child: Node in _door_body.get_children():
		if child is CollisionShape2D:
			(child as CollisionShape2D).disabled = true
		elif child is ColorRect:
			(child as ColorRect).color = Color(0.7, 0.3, 0.05, 0.25)


func _show_alert(msg: String, color: Color) -> void:
	_alert_label.text = msg
	_alert_label.modulate = color
	_alert_timer = 2.0


func _on_player_detected() -> void:
	_show_alert("!! SPOTTED !!", Color(1.0, 0.15, 0.15))


# ── Helper builders ────────────────────────────────────────────────────────────

## StaticBody2D wall with a ColorRect visual at [param rect].
func _make_wall(rect: Rect2, color: Color = Color(0.28, 0.28, 0.28)) -> void:
	var body := StaticBody2D.new()

	var col_shape := CollisionShape2D.new()
	var box       := RectangleShape2D.new()
	box.size = rect.size
	col_shape.position = rect.size * 0.5
	col_shape.shape    = box
	body.add_child(col_shape)

	var visual := ColorRect.new()
	visual.size  = rect.size
	visual.color = color
	body.add_child(visual)

	body.position = rect.position
	add_child(body)


## 7 px font label for tile-sized annotations.
func _make_tile_label(text: String, color: Color = Color.WHITE) -> Label:
	var lbl := Label.new()
	lbl.text = text
	lbl.add_theme_font_size_override("font_size", 7)
	lbl.modulate = color
	lbl.autowrap_mode = TextServer.AUTOWRAP_OFF
	return lbl
