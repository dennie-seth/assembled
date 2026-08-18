extends SceneTree
## T-0187: Side-on floor plane runtime — failing tests (red phase).
##
## Verifies that the room runtime uses a single floor plane (side-on layout,
## 11 §4 v5) and correctly classifies solid tiles vs. Drop-gap tiles.
##
## Tests:
##   1. FloorPlaneRuntime script exists and can be instantiated
##   2. No-Drop room: all 24 columns solid, drop list empty
##   3. Gapped room: authored gap at cols 10-13 reported exactly
##   4. Viewport/integer-scale/letterbox contract unchanged from T-0172
##   5. Drop at col 0 (grid edge) does not crash, reported as gap
##   6. Drop at col 23 (grid edge) does not crash, reported as gap
##   7. All-Drop room (no floor tiles) loads without error, all 24 cols Drop
##   8. room.tscn has a TileMapLayer child named "FloorLayer" with 16×16 tiles
##      and room.gd declares a 'floor_plane' property
##
## Run headless (from client/):
##   timeout 60 godot --headless --script tests/test_floor_plane.gd
## Exit 0 = PASS, exit 1 = FAIL.

const FLOOR_ROW: int = 12
const AUTHORED_COLS: int = 24

const ViewportManagerScript := preload("res://autoloads/viewport_manager.gd")


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_floor_plane_runtime_exists()
	failures += _test_solid_floor_no_drop()
	failures += _test_floor_with_drop_gap()
	failures += _test_viewport_unchanged()
	failures += _test_drop_at_edge_col_0()
	failures += _test_drop_at_edge_col_23()
	failures += _test_all_drop_room()
	failures += _test_room_has_floor_layer()

	if failures.is_empty():
		print("T-0187 PASS: side-on floor plane runtime verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0187 FAIL: %s" % f)
		quit(1)


## Create a minimal TileMapLayer with tiles placed at the given columns in FLOOR_ROW.
## The TileSet has a single atlas source (id=0) with a 16×16 tile at atlas coord (0,0).
## The caller is responsible for calling layer.free() when done.
func _make_floor_layer(solid_cols: Array[int]) -> TileMapLayer:
	var ts := TileSet.new()
	ts.tile_size = Vector2i(16, 16)

	var src := TileSetAtlasSource.new()
	src.texture_region_size = Vector2i(16, 16)
	src.create_tile(Vector2i(0, 0))
	ts.add_source(src, 0)

	var layer := TileMapLayer.new()
	layer.tile_set = ts

	for col: int in solid_cols:
		layer.set_cell(Vector2i(col, FLOOR_ROW), 0, Vector2i(0, 0))

	return layer


## ── 1. FloorPlaneRuntime script exists ────────────────────────────────────────

func _test_floor_plane_runtime_exists() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scenes/floor_plane_runtime.gd") as GDScript
	if script == null:
		failures.append(
			"floor_plane_runtime: res://scenes/floor_plane_runtime.gd not found (red phase)"
		)
		return failures
	var fpr: RefCounted = script.new()
	if fpr == null:
		failures.append("floor_plane_runtime: script.new() returned null")
	return failures


## ── 2. Fully solid floor — no Drop ───────────────────────────────────────────

func _test_solid_floor_no_drop() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scenes/floor_plane_runtime.gd") as GDScript
	if script == null:
		failures.append("solid_floor: res://scenes/floor_plane_runtime.gd missing")
		return failures

	var all_cols: Array[int] = []
	for c: int in range(AUTHORED_COLS):
		all_cols.append(c)

	var layer: TileMapLayer = _make_floor_layer(all_cols)
	var fpr: RefCounted = script.new()
	fpr.scan(layer, FLOOR_ROW)

	if fpr.has_drop():
		failures.append("solid_floor: has_drop() must be false when all 24 columns have tiles")

	var drops: Array = fpr.get_drop_columns()
	if not drops.is_empty():
		failures.append(
			"solid_floor: get_drop_columns() must be empty; got %s" % str(drops)
		)

	var solids: Array = fpr.get_solid_columns()
	if solids.size() != AUTHORED_COLS:
		failures.append(
			"solid_floor: get_solid_columns() must have %d entries; got %d"
			% [AUTHORED_COLS, solids.size()]
		)

	for c: int in range(AUTHORED_COLS):
		if not fpr.is_solid_at_column(c):
			failures.append(
				"solid_floor: is_solid_at_column(%d) must be true (first failing column)" % c
			)
			break

	layer.free()
	return failures


## ── 3. Floor with Drop gap at cols 10–13 ──────────────────────────────────────

func _test_floor_with_drop_gap() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scenes/floor_plane_runtime.gd") as GDScript
	if script == null:
		failures.append("drop_gap: res://scenes/floor_plane_runtime.gd missing")
		return failures

	var gap_cols: Array[int] = [10, 11, 12, 13]
	var solid_cols: Array[int] = []
	for c: int in range(AUTHORED_COLS):
		if c not in gap_cols:
			solid_cols.append(c)

	var layer: TileMapLayer = _make_floor_layer(solid_cols)
	var fpr: RefCounted = script.new()
	fpr.scan(layer, FLOOR_ROW)

	if not fpr.has_drop():
		failures.append("drop_gap: has_drop() must be true when cols 10-13 have no tiles")

	var drops: Array = fpr.get_drop_columns()
	if drops.size() != gap_cols.size():
		failures.append(
			"drop_gap: get_drop_columns() must have %d entries; got %d (%s)"
			% [gap_cols.size(), drops.size(), str(drops)]
		)
	else:
		for c: int in gap_cols:
			if c not in drops:
				failures.append(
					"drop_gap: column %d must appear in get_drop_columns() but does not" % c
				)
			if not fpr.is_drop_at_column(c):
				failures.append("drop_gap: is_drop_at_column(%d) must be true" % c)

	var solids: Array = fpr.get_solid_columns()
	if solids.size() != solid_cols.size():
		failures.append(
			"drop_gap: get_solid_columns() must have %d entries; got %d"
			% [solid_cols.size(), solids.size()]
		)

	for c: int in gap_cols:
		if fpr.is_solid_at_column(c):
			failures.append(
				"drop_gap: is_solid_at_column(%d) must be false (column is a gap)" % c
			)

	layer.free()
	return failures


## ── 4. Viewport/integer-scale/letterbox contract unchanged from T-0172 ─────────

func _test_viewport_unchanged() -> Array[String]:
	var failures: Array[String] = []
	const VIEWPORT_W: int = 384
	const VIEWPORT_H: int = 216

	var vw: int = int(ProjectSettings.get_setting("display/window/size/viewport_width", 0))
	if vw != VIEWPORT_W:
		failures.append("viewport: viewport_width=%d expected %d" % [vw, VIEWPORT_W])

	var vh: int = int(ProjectSettings.get_setting("display/window/size/viewport_height", 0))
	if vh != VIEWPORT_H:
		failures.append("viewport: viewport_height=%d expected %d" % [vh, VIEWPORT_H])

	var stretch_mode: String = str(
		ProjectSettings.get_setting("display/window/stretch/mode", "")
	)
	if stretch_mode != "canvas_items":
		failures.append(
			"viewport: stretch/mode='%s' expected 'canvas_items'" % stretch_mode
		)

	var scale_mode: String = str(
		ProjectSettings.get_setting("display/window/stretch/scale_mode", "")
	)
	if scale_mode != "integer":
		failures.append(
			"viewport: stretch/scale_mode='%s' expected 'integer'" % scale_mode
		)

	var aspect: String = str(
		ProjectSettings.get_setting("display/window/stretch/aspect", "")
	)
	if aspect != "keep":
		failures.append("viewport: stretch/aspect='%s' expected 'keep'" % aspect)

	if ViewportManagerScript.NATIVE_WIDTH != VIEWPORT_W:
		failures.append(
			"viewport: ViewportManager.NATIVE_WIDTH=%d expected %d"
			% [ViewportManagerScript.NATIVE_WIDTH, VIEWPORT_W]
		)
	if ViewportManagerScript.NATIVE_HEIGHT != VIEWPORT_H:
		failures.append(
			"viewport: ViewportManager.NATIVE_HEIGHT=%d expected %d"
			% [ViewportManagerScript.NATIVE_HEIGHT, VIEWPORT_H]
		)

	return failures


## ── 5. Drop at column 0 (left grid edge) ──────────────────────────────────────

func _test_drop_at_edge_col_0() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scenes/floor_plane_runtime.gd") as GDScript
	if script == null:
		failures.append("edge_col0: res://scenes/floor_plane_runtime.gd missing")
		return failures

	var solid_cols: Array[int] = []
	for c: int in range(1, AUTHORED_COLS):
		solid_cols.append(c)

	var layer: TileMapLayer = _make_floor_layer(solid_cols)
	var fpr: RefCounted = script.new()
	fpr.scan(layer, FLOOR_ROW)  ## must not crash on edge column

	if not fpr.is_drop_at_column(0):
		failures.append("edge_col0: column 0 gap must be reported as Drop")
	if fpr.is_solid_at_column(0):
		failures.append("edge_col0: column 0 must not be solid when tile is absent")
	var drops: Array = fpr.get_drop_columns()
	if 0 not in drops:
		failures.append("edge_col0: column 0 must appear in get_drop_columns()")
	if drops.size() != 1:
		failures.append(
			"edge_col0: get_drop_columns() must have exactly 1 entry; got %d" % drops.size()
		)

	layer.free()
	return failures


## ── 6. Drop at column 23 (right grid edge) ────────────────────────────────────

func _test_drop_at_edge_col_23() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scenes/floor_plane_runtime.gd") as GDScript
	if script == null:
		failures.append("edge_col23: res://scenes/floor_plane_runtime.gd missing")
		return failures

	var solid_cols: Array[int] = []
	for c: int in range(0, AUTHORED_COLS - 1):
		solid_cols.append(c)

	var layer: TileMapLayer = _make_floor_layer(solid_cols)
	var fpr: RefCounted = script.new()
	fpr.scan(layer, FLOOR_ROW)  ## must not crash on edge column

	if not fpr.is_drop_at_column(23):
		failures.append("edge_col23: column 23 gap must be reported as Drop")
	if fpr.is_solid_at_column(23):
		failures.append("edge_col23: column 23 must not be solid when tile is absent")
	var drops: Array = fpr.get_drop_columns()
	if 23 not in drops:
		failures.append("edge_col23: column 23 must appear in get_drop_columns()")
	if drops.size() != 1:
		failures.append(
			"edge_col23: get_drop_columns() must have exactly 1 entry; got %d" % drops.size()
		)

	layer.free()
	return failures


## ── 7. All-Drop room (no floor tiles) ─────────────────────────────────────────

func _test_all_drop_room() -> Array[String]:
	var failures: Array[String] = []
	var script: GDScript = load("res://scenes/floor_plane_runtime.gd") as GDScript
	if script == null:
		failures.append("all_drop: res://scenes/floor_plane_runtime.gd missing")
		return failures

	var layer: TileMapLayer = _make_floor_layer([])  ## no tiles placed
	var fpr: RefCounted = script.new()
	fpr.scan(layer, FLOOR_ROW)  ## must not crash

	if not fpr.has_drop():
		failures.append("all_drop: has_drop() must be true when no floor tiles exist")

	var drops: Array = fpr.get_drop_columns()
	if drops.size() != AUTHORED_COLS:
		failures.append(
			"all_drop: get_drop_columns() must have %d entries; got %d"
			% [AUTHORED_COLS, drops.size()]
		)

	var solids: Array = fpr.get_solid_columns()
	if not solids.is_empty():
		failures.append(
			"all_drop: get_solid_columns() must be empty; got %d entries" % solids.size()
		)

	layer.free()
	return failures


## ── 8. room.tscn structure: FloorLayer + floor_plane property ─────────────────

func _test_room_has_floor_layer() -> Array[String]:
	var failures: Array[String] = []
	var packed: PackedScene = load("res://scenes/room.tscn") as PackedScene
	if packed == null:
		failures.append("room_floor_layer: res://scenes/room.tscn failed to load")
		return failures

	var room: Node = packed.instantiate()
	if room == null:
		failures.append("room_floor_layer: instantiate() returned null")
		return failures

	## Structural check: FloorLayer TileMapLayer must exist.
	var floor_layer: TileMapLayer = room.get_node_or_null("FloorLayer") as TileMapLayer
	if floor_layer == null:
		failures.append(
			"room_floor_layer: no TileMapLayer child named 'FloorLayer' in room.tscn"
		)
		room.free()
		return failures

	var ts: TileSet = floor_layer.tile_set
	if ts == null:
		failures.append("room_floor_layer: FloorLayer.tile_set is null")
	else:
		var cell_size: Vector2i = ts.tile_size
		if cell_size != Vector2i(16, 16):
			failures.append(
				"room_floor_layer: FloorLayer TileSet.tile_size=%s expected Vector2i(16,16)"
				% str(cell_size)
			)

	## Script check: room.gd must declare 'floor_plane' property.
	var room_script: GDScript = room.get_script() as GDScript
	if room_script != null:
		var props: Array[Dictionary] = room_script.get_script_property_list()
		var has_floor_plane: bool = false
		for prop: Dictionary in props:
			if prop.get("name", "") == "floor_plane":
				has_floor_plane = true
				break
		if not has_floor_plane:
			failures.append(
				"room_floor_layer: room.gd must declare a 'floor_plane' property"
			)

	room.free()
	return failures
