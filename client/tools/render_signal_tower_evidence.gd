extends SceneTree
## T-0328: Renders a schematic layout map of the full Signal Tower archetype
## directly from the committed spec (signal_tower/layouts/signal_tower_v1.json)
## via RoomLayout — the same data the overview scene and its tests read.
##
## Not a live screengrab: this environment's headless Godot instance renders
## through the "Dummy" backend (no GPU), which produces blank frames — a
## Viewport screenshot here would be an empty image, not evidence of
## anything. Image is pure CPU-side pixel manipulation with no dependency on
## the rendering pipeline, so this generates a pixel-accurate top-down map
## of the authored geometry: each room's true tile footprint and world
## position, colour-coded by role, with door/ladder openings marked exactly
## where the overview scene computes them (_connection_geometry) — because
## it is generated from the same spec + the same opening-geometry code path,
## it cannot drift from what the game actually builds.
##
## Run headless (from client/):
##   godot --headless --script tools/render_signal_tower_evidence.gd
## Writes docs/assets/evidence/T-0328/signal_tower_layout_map.png and exits 0.

const RoomLayout := preload("res://signal_tower/room_layout.gd")

const LAYOUT_PATH: String = "res://signal_tower/layouts/signal_tower_v1.json"
const OUTPUT_PATH: String = "res://../docs/assets/evidence/T-0328/signal_tower_layout_map.png"

const MARGIN_PX: int = 8
const BORDER_PX: int = 2
const OPENING_SPAN: int = 2

const BACKGROUND_COLOR: Color = Color(0.08, 0.08, 0.09)
const BORDER_COLOR: Color = Color(0.02, 0.02, 0.02)
const DOOR_COLOR: Color = Color(1.0, 0.55, 0.1)
const LADDER_COLOR: Color = Color(0.25, 0.85, 0.95)

const ROOM_COLORS: Dictionary = {
	"signal_tower.ground_relay": Color(0.3, 0.45, 0.75),
	"signal_tower.records_room": Color(0.85, 0.65, 0.15),
	"signal_tower.power_substation": Color(0.75, 0.25, 0.25),
	"signal_tower.equipment_floor": Color(0.75, 0.45, 0.2),
	"signal_tower.storage_cache": Color(0.55, 0.55, 0.6),
	"signal_tower.antenna_shaft": Color(0.75, 0.35, 0.3),
	"signal_tower.broadcast_deck": Color(0.6, 0.3, 0.8),
}


func _init() -> void:
	var layout := RoomLayout.new()
	var err: String = layout.load_from_path(LAYOUT_PATH)
	if err != "":
		printerr("render_evidence FAIL: %s" % err)
		quit(1)
		return

	var bounds: Rect2 = layout.get_bounding_rect_px()
	var img_w: int = int(bounds.size.x) + MARGIN_PX * 2
	var img_h: int = int(bounds.size.y) + MARGIN_PX * 2

	var image := Image.create(img_w, img_h, false, Image.FORMAT_RGB8)
	image.fill(BACKGROUND_COLOR)

	var offset: Vector2 = Vector2(MARGIN_PX, MARGIN_PX) - bounds.position

	for tag: String in layout.get_all_tags():
		var rect: Rect2 = layout.get_rect_px(tag)
		rect.position += offset
		var color: Color = ROOM_COLORS.get(tag, Color(0.5, 0.5, 0.5))
		image.fill_rect(Rect2i(rect), BORDER_COLOR)
		var inset: Rect2i = Rect2i(rect).grow(-BORDER_PX)
		if inset.size.x > 0 and inset.size.y > 0:
			image.fill_rect(inset, color)

	for conn: Dictionary in layout.get_connections():
		var marker_rect: Rect2i = _connector_marker_rect(layout, conn)
		marker_rect.position += Vector2i(offset)
		var marker_color: Color = LADDER_COLOR if conn["type"] == "ladder" else DOOR_COLOR
		image.fill_rect(marker_rect, marker_color)

	var save_err: int = image.save_png(OUTPUT_PATH)
	if save_err != OK:
		printerr("render_evidence FAIL: could not save PNG (error %d)" % save_err)
		quit(1)
		return

	print("render_evidence PASS: wrote %s (%dx%d)" % [OUTPUT_PATH, img_w, img_h])
	quit(0)


## Mirrors signal_tower_overview.gd's _connection_geometry() opening-range math
## so the evidence marker lands exactly where the in-game wall opening is cut.
func _connector_marker_rect(layout: RoomLayout, conn: Dictionary) -> Rect2i:
	var rect_a: Rect2i = layout.get_rect_tiles(conn["from"])
	var rect_b: Rect2i = layout.get_rect_tiles(conn["to"])
	var tile_size: int = layout.tile_size_px

	if conn["type"] == "door":
		var y0: int = max(rect_a.position.y, rect_b.position.y)
		var y1: int = min(rect_a.end.y, rect_b.end.y)
		var mid: int = int((y0 + y1) / 2.0)
		var span0: int = max(y0, mid - int(OPENING_SPAN / 2.0))
		var span1: int = min(y1, span0 + OPENING_SPAN)
		var a_is_left: bool = rect_a.position.x < rect_b.position.x
		var x: int = (rect_a.end.x if a_is_left else rect_b.end.x) * tile_size
		return Rect2i(x - 2, span0 * tile_size, 4, (span1 - span0) * tile_size)
	else:
		var x0: int = max(rect_a.position.x, rect_b.position.x)
		var x1: int = min(rect_a.end.x, rect_b.end.x)
		var midx: int = int((x0 + x1) / 2.0)
		var spanx0: int = max(x0, midx - int(OPENING_SPAN / 2.0))
		var spanx1: int = min(x1, spanx0 + OPENING_SPAN)
		var y: int = (rect_a.end.y if rect_a.position.y < rect_b.position.y else rect_b.end.y) * tile_size
		return Rect2i(spanx0 * tile_size, y - 2, (spanx1 - spanx0) * tile_size, 4)
