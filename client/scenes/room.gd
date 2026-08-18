class_name RoomScene
extends Node2D
## T-0172/T-0187: Base room scene with side-on floor plane.
##
## Rooms are authored on a 24×14 tile grid (384×224 px) at 16 px per tile
## (05-art-direction.md §5, 13-asset-pipeline.md §3.3).
##
## The project viewport is fixed at 384×216, so only the top 216 px of the
## authored 224 px height is ever gameplay-visible. The remaining 8 px is
## non-gameplay bleed (floor thickness / ceiling shadow). Level design gets
## an integer grid; the band costs nothing.
##
## Integer scaling and letterboxing are driven by Godot 4's built-in stretch
## settings (project.godot [display]) and the ViewportManager autoload.
## Nothing in this scene needs to react to window resize events — the engine
## handles re-computation automatically.
##
## T-0187 (11 §4 v5): Each room has exactly one side-on floor plane.
## FloorLayer (TileMapLayer child) is authored row-by-row at 16 px tiles;
## absent tiles in FLOOR_ROW are Drop gaps (02-hazard-vocabulary.md §2).
## floor_plane is populated at _ready() and exposed to the player controller.

## Row index of the walkable floor plane in the 24×14 authored grid (0-indexed).
## Row 12 is the bottom gameplay row (row 13 is non-gameplay bleed).
const FLOOR_ROW: int = 12

## Populated at _ready() by scanning the FloorLayer TileMapLayer.
## Exposes solid/drop classification to whatever queries it (player fall check).
var floor_plane: FloorPlaneRuntime


func _ready() -> void:
	var floor_layer: TileMapLayer = $FloorLayer as TileMapLayer
	floor_plane = FloorPlaneRuntime.new()
	floor_plane.scan(floor_layer, FLOOR_ROW)
