class_name RoomScene
extends Node2D
## T-0172: Base room scene.
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
