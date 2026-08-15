extends SceneTree
## T-0172: Room scene + tilemap runtime.
##
## Verifies:
##   1. Project viewport is fixed at 384×216 with integer scaling and letterboxing
##      (display/window/stretch/mode = "canvas_items", scale_mode = "integer",
##       aspect = "keep" — 13-asset-pipeline.md §3.3 / 05-art-direction.md §5)
##   2. Room scene loads and exposes a TileMapLayer named "TileLayer" with 16×16 tiles
##   3. Authored grid is 24×14 tiles = 384×224 px; viewport clips at 216 leaving 8 px bleed
##   4. ViewportManager.compute_integer_scale() returns exact integer factors for
##      common display sizes (x2 through x10)
##   5. Content rect never widens past 384 px on non-16:9 or ultrawide displays
##   6. After any window resize the scale is always a whole integer (no fractional pixels)
##
## Run headless:
##   godot --headless --script tests/test_room_scene.gd
## from client/. Exit 0 on PASS, 1 on any failure.

## Tile constants as specified in 05-art-direction.md §5 and 13-asset-pipeline.md §3.3.
const TILE_PX: int = 16
const AUTHORED_COLS: int = 24
const AUTHORED_ROWS: int = 14
const AUTHORED_W: int = AUTHORED_COLS * TILE_PX  ## 384 px
const AUTHORED_H: int = AUTHORED_ROWS * TILE_PX  ## 224 px
const VIEWPORT_W: int = 384
const VIEWPORT_H: int = 216
const BLEED_PX: int = AUTHORED_H - VIEWPORT_H    ## 8 px

const ViewportManagerScript := preload("res://autoloads/viewport_manager.gd")


func _init() -> void:
	var failures: Array[String] = []

	failures += _test_viewport_project_settings()
	failures += _test_room_scene_structure()
	failures += _test_authored_dimensions()
	failures += _test_integer_scale_values()
	failures += _test_content_never_widens()
	failures += _test_resize_no_fractional_pixels()

	if failures.is_empty():
		print("T-0172 PASS: room scene + tilemap runtime verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0172 FAIL: %s" % f)
		quit(1)


## ── 1. Viewport project settings ──────────────────────────────────────────────
## 05-art-direction.md §5: internal resolution 384×216, integer-scaled, letterboxed.

func _test_viewport_project_settings() -> Array[String]:
	var failures: Array[String] = []

	var vw: int = int(ProjectSettings.get_setting("display/window/size/viewport_width", 0))
	if vw != VIEWPORT_W:
		failures.append(
			"viewport_settings: viewport_width=%d, expected %d" % [vw, VIEWPORT_W]
		)

	var vh: int = int(ProjectSettings.get_setting("display/window/size/viewport_height", 0))
	if vh != VIEWPORT_H:
		failures.append(
			"viewport_settings: viewport_height=%d, expected %d" % [vh, VIEWPORT_H]
		)

	var stretch_mode: String = str(
		ProjectSettings.get_setting("display/window/stretch/mode", "")
	)
	if stretch_mode != "canvas_items":
		failures.append(
			"viewport_settings: stretch/mode='%s', expected 'canvas_items'" % stretch_mode
		)

	var scale_mode: String = str(
		ProjectSettings.get_setting("display/window/stretch/scale_mode", "")
	)
	if scale_mode != "integer":
		failures.append(
			"viewport_settings: stretch/scale_mode='%s', expected 'integer'" % scale_mode
		)

	var aspect: String = str(
		ProjectSettings.get_setting("display/window/stretch/aspect", "")
	)
	if aspect != "keep":
		failures.append(
			"viewport_settings: stretch/aspect='%s', expected 'keep'" % aspect
		)

	return failures


## ── 2. Room scene structure ────────────────────────────────────────────────────
## room.tscn must have a TileMapLayer child named "TileLayer" with 16×16 tile_size.

func _test_room_scene_structure() -> Array[String]:
	var failures: Array[String] = []

	var packed := load("res://scenes/room.tscn") as PackedScene
	if packed == null:
		failures.append("room_structure: res://scenes/room.tscn does not exist or failed to load")
		return failures

	var room: Node = packed.instantiate()
	if room == null:
		failures.append("room_structure: PackedScene.instantiate() returned null")
		return failures

	var tile_layer: TileMapLayer = room.get_node_or_null("TileLayer") as TileMapLayer
	if tile_layer == null:
		failures.append(
			"room_structure: no TileMapLayer child named 'TileLayer' found in room.tscn"
		)
		room.free()
		return failures

	var ts: TileSet = tile_layer.tile_set
	if ts == null:
		failures.append("room_structure: TileLayer.tile_set is null — needs an assigned TileSet")
	else:
		var cell_size: Vector2i = ts.tile_size
		if cell_size != Vector2i(TILE_PX, TILE_PX):
			failures.append(
				"room_structure: TileSet.tile_size=%s, expected Vector2i(%d,%d)"
				% [str(cell_size), TILE_PX, TILE_PX]
			)

	room.free()
	return failures


## ── 3. Authored dimensions ─────────────────────────────────────────────────────
## Authored grid is 24×14 (384×224 px). Viewport shows top 216 px; 8 px is bleed.
## These relationships are constants on the ViewportManager script.

func _test_authored_dimensions() -> Array[String]:
	var failures: Array[String] = []

	if AUTHORED_W != VIEWPORT_W:
		failures.append(
			"authored_dims: AUTHORED_W=%d, expected equal to VIEWPORT_W=%d (same horizontal span)"
			% [AUTHORED_W, VIEWPORT_W]
		)

	if BLEED_PX != 8:
		failures.append(
			"authored_dims: BLEED_PX=%d, expected 8 (AUTHORED_H 224 - VIEWPORT_H 216)"
			% BLEED_PX
		)

	# ViewportManager must expose the same canonical constants.
	if ViewportManagerScript.NATIVE_WIDTH != VIEWPORT_W:
		failures.append(
			"authored_dims: ViewportManager.NATIVE_WIDTH=%d, expected %d"
			% [ViewportManagerScript.NATIVE_WIDTH, VIEWPORT_W]
		)

	if ViewportManagerScript.NATIVE_HEIGHT != VIEWPORT_H:
		failures.append(
			"authored_dims: ViewportManager.NATIVE_HEIGHT=%d, expected %d"
			% [ViewportManagerScript.NATIVE_HEIGHT, VIEWPORT_H]
		)

	if ViewportManagerScript.AUTHORED_ROWS != AUTHORED_ROWS:
		failures.append(
			"authored_dims: ViewportManager.AUTHORED_ROWS=%d, expected %d"
			% [ViewportManagerScript.AUTHORED_ROWS, AUTHORED_ROWS]
		)

	return failures


## ── 4. Integer scale values ────────────────────────────────────────────────────
## compute_integer_scale must return exact integer factors for common sizes.

func _test_integer_scale_values() -> Array[String]:
	var failures: Array[String] = []

	## Exact multiples of 384×216.
	var cases: Array = [
		[Vector2i(768, 432),   2],   # ×2
		[Vector2i(1152, 648),  3],   # ×3
		[Vector2i(1536, 864),  4],   # ×4
		[Vector2i(1920, 1080), 5],   # ×5 — 1080p
		[Vector2i(2304, 1296), 6],   # ×6
		[Vector2i(2688, 1512), 7],   # ×7
		[Vector2i(3072, 1728), 8],   # ×8
		[Vector2i(3456, 1944), 9],   # ×9
		[Vector2i(3840, 2160), 10],  # ×10 — 4 K
		## Non-multiples: scale is floored, never fractional.
		[Vector2i(1280, 720),  3],   # 1280/384=3.33 → 3; 720/216=3.33 → 3
		[Vector2i(1440, 900),  3],   # 1440/384=3.75 → 3; 900/216=4.16 → min=3
		[Vector2i(2560, 1440), 6],   # 2560/384=6.66 → 6; 1440/216=6.66 → 6
		## Tiny/sub-native: always at least 1.
		[Vector2i(320, 200),   1],
		[Vector2i(100, 100),   1],
	]

	for c: Array in cases:
		var display: Vector2i = c[0]
		var expected: int = c[1]
		var got: int = ViewportManagerScript.compute_integer_scale(display)
		if got != expected:
			failures.append(
				"integer_scale: display=%s → got %d, expected %d" % [str(display), got, expected]
			)

	return failures


## ── 5. Content rect never widens past 384 px ──────────────────────────────────
## Fairness rule (13-asset-pipeline.md §3.3): ultrawide display must NOT show
## more room than a 16:9 display. The content rect width is always 384*scale.

func _test_content_never_widens() -> Array[String]:
	var failures: Array[String] = []

	var wide_displays: Array[Vector2i] = [
		Vector2i(2560, 1080),  # 21:9
		Vector2i(3440, 1440),  # 21:9 QHD
		Vector2i(5120, 1440),  # 32:9
		Vector2i(7680, 2160),  # 32:9 4 K
	]

	for display: Vector2i in wide_displays:
		var scale: int = ViewportManagerScript.compute_integer_scale(display)
		var rect: Rect2i = ViewportManagerScript.compute_content_rect(display)

		if rect.size.x != VIEWPORT_W * scale:
			failures.append(
				"no_widen: display=%s scale=%d rect.size.x=%d, expected %d"
				% [str(display), scale, rect.size.x, VIEWPORT_W * scale]
			)

		## The letterbox bar on each side must be non-negative.
		var bar_x: int = (display.x - rect.size.x) / 2
		if bar_x < 0:
			failures.append(
				"no_widen: display=%s content wider than display (bar_x=%d)"
				% [str(display), bar_x]
			)

		## Symmetry: left bar + content + right bar == display width.
		var left_bar: int = rect.position.x
		var right_bar: int = display.x - (rect.position.x + rect.size.x)
		if left_bar != right_bar:
			failures.append(
				"no_widen: display=%s letterbox bars unequal (left=%d right=%d)"
				% [str(display), left_bar, right_bar]
			)

	return failures


## ── 6. No fractional pixels after resize ──────────────────────────────────────
## For any display size the content rect dimensions must be exact multiples of
## NATIVE_WIDTH / NATIVE_HEIGHT — i.e. no sub-pixel rendering.

func _test_resize_no_fractional_pixels() -> Array[String]:
	var failures: Array[String] = []

	## A broad sweep of display sizes to catch edge cases.
	var sizes: Array[Vector2i] = [
		Vector2i(800, 600),
		Vector2i(1024, 768),
		Vector2i(1280, 800),
		Vector2i(1366, 768),
		Vector2i(1600, 900),
		Vector2i(1920, 1080),
		Vector2i(2560, 1440),
		Vector2i(3840, 2160),
		Vector2i(5120, 2880),
		Vector2i(1280, 1024),   # 5:4 — square-ish monitor
		Vector2i(1920, 1200),   # 16:10
	]

	for display: Vector2i in sizes:
		var scale: int = ViewportManagerScript.compute_integer_scale(display)
		var rect: Rect2i = ViewportManagerScript.compute_content_rect(display)

		## Width must be an exact integer multiple of VIEWPORT_W.
		if rect.size.x % VIEWPORT_W != 0:
			failures.append(
				"no_fractional: display=%s rect.size.x=%d is not a multiple of %d"
				% [str(display), rect.size.x, VIEWPORT_W]
			)

		## Height must be an exact integer multiple of VIEWPORT_H.
		if rect.size.y % VIEWPORT_H != 0:
			failures.append(
				"no_fractional: display=%s rect.size.y=%d is not a multiple of %d"
				% [str(display), rect.size.y, VIEWPORT_H]
			)

		## Confirm the rect matches compute_integer_scale.
		if rect.size.x != VIEWPORT_W * scale:
			failures.append(
				"no_fractional: display=%s rect.size.x=%d != VIEWPORT_W*scale (%d)"
				% [str(display), rect.size.x, VIEWPORT_W * scale]
			)

		if rect.size.y != VIEWPORT_H * scale:
			failures.append(
				"no_fractional: display=%s rect.size.y=%d != VIEWPORT_H*scale (%d)"
				% [str(display), rect.size.y, VIEWPORT_H * scale]
			)

	return failures
