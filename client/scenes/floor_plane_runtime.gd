class_name FloorPlaneRuntime
extends RefCounted
## T-0187: Side-on floor plane runtime (11 §4 v5).
##
## Scans a TileMapLayer at the authored floor row and classifies each column
## (0..AUTHORED_COLS-1) as either solid floor or a Drop gap (absent tile).
##
## A column is solid when a tile is present at (col, floor_row) in the layer.
## A column is a Drop gap when no tile exists there — this is the "Drop" hazard
## (02-hazard-vocabulary.md §2). The gap is authored directly in the tile layer
## (place/remove tiles), not via a scripted trigger volume.
##
## Usage:
##   var fp := FloorPlaneRuntime.new()
##   fp.scan($FloorLayer, RoomScene.FLOOR_ROW)
##   if fp.is_drop_at_column(player_col):
##       handle_fall()

## Number of tile columns in the authored room grid (24 × 14 at 16 px/tile).
const AUTHORED_COLS: int = 24

var _solid_columns: Array[int] = []
var _drop_columns: Array[int] = []


## Scan [param layer] at [param floor_row] and populate solid/drop column lists.
## Safe to call even when the layer has no tiles at all (all-Drop case).
## Replaces any previous scan result.
func scan(layer: TileMapLayer, floor_row: int) -> void:
	_solid_columns.clear()
	_drop_columns.clear()
	for col: int in range(AUTHORED_COLS):
		var coord := Vector2i(col, floor_row)
		if layer.get_cell_source_id(coord) != -1:
			_solid_columns.append(col)
		else:
			_drop_columns.append(col)


## Returns a copy of the solid column index list (columns 0..23 with a floor tile).
func get_solid_columns() -> Array[int]:
	return _solid_columns.duplicate()


## Returns a copy of the Drop column index list (columns 0..23 with no floor tile).
func get_drop_columns() -> Array[int]:
	return _drop_columns.duplicate()


## Returns true if column [param col] has a solid floor tile.
func is_solid_at_column(col: int) -> bool:
	return _solid_columns.has(col)


## Returns true if column [param col] is a Drop gap (no floor tile).
func is_drop_at_column(col: int) -> bool:
	return _drop_columns.has(col)


## Returns true if any Drop gap exists in this floor.
func has_drop() -> bool:
	return not _drop_columns.is_empty()
