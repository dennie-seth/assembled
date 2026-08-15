extends Node
## T-0172: Integer-scale viewport manager.
##
## Encodes the 384×216 internal resolution and the fairness rule from
## 13-asset-pipeline.md §3.3 and 05-art-direction.md §5:
##
##   "Fixed viewport, integer scale, letterbox the remainder."
##
## Rooms are authored on a 24×14 tile grid (384×224 px). The viewport shows
## the top 216 px; the remaining 8 px (one half-tile) is non-gameplay bleed.
## The display is never widened past 384 px on ultrawide monitors — excess is
## letterboxed so every player has the same horizontal sightline.
##
## Godot 4's built-in stretch settings (canvas_items / integer / keep) in
## project.godot handle re-computation automatically on every window resize.
## This autoload exposes the underlying math for tests and for any game code
## that needs to query the current presentation geometry at runtime.

## Internal (native) viewport dimensions — never changes at runtime.
const NATIVE_WIDTH: int = 384
const NATIVE_HEIGHT: int = 216

## Authored room height (14 tile rows × 16 px). The viewport shows only the
## top NATIVE_HEIGHT px; the remaining 8 px is non-gameplay bleed.
const AUTHORED_ROWS: int = 14
const AUTHORED_HEIGHT: int = AUTHORED_ROWS * 16  ## 224 px

## Returns the largest integer N >= 1 such that N*NATIVE_WIDTH <= display.x
## and N*NATIVE_HEIGHT <= display.y. Never fractional.
static func compute_integer_scale(display_size: Vector2i) -> int:
	var sx: int = display_size.x / NATIVE_WIDTH
	var sy: int = display_size.y / NATIVE_HEIGHT
	return maxi(1, mini(sx, sy))


## Returns the top-left position of the content rect (the letterbox offset)
## for a given display size.
static func compute_letterbox_offset(display_size: Vector2i) -> Vector2i:
	var scale: int = compute_integer_scale(display_size)
	var content_w: int = NATIVE_WIDTH * scale
	var content_h: int = NATIVE_HEIGHT * scale
	return Vector2i((display_size.x - content_w) / 2, (display_size.y - content_h) / 2)


## Returns the Rect2i that the gameplay content occupies within the display.
## Its width is always NATIVE_WIDTH * scale — never larger than the display
## and never wider than NATIVE_WIDTH * scale regardless of display aspect.
static func compute_content_rect(display_size: Vector2i) -> Rect2i:
	var scale: int = compute_integer_scale(display_size)
	var offset: Vector2i = compute_letterbox_offset(display_size)
	return Rect2i(offset, Vector2i(NATIVE_WIDTH * scale, NATIVE_HEIGHT * scale))
