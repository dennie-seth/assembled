extends SceneTree
## T-0122: Bleed-alpha ramp — headless test suite.
##
## Bleed proximity (`07-items-economy.md` §5) is never shown as a number: alpha
## ramps down as an item's `bleed_at` (`04-data-model.md` §3) approaches,
## ending as a bare contour/outline-only render immediately before the item
## bleeds away. Applies uniformly to held (60-90 min) and world/escrow-anchored
## (48-72 h) instances -- same mechanic, different duration. Shares its
## parameter/shader plumbing with the chroma shader (T-0121) rather than
## introducing an independent shader stack.
##
## Verifies:
##   1. chroma_palette_swap.gdshader still loads without error and exposes a
##      bleed_proximity uniform (shared shader family, one parameter added).
##   2. ChromaSprite.bleed_proximity is clamped to [0.0, 1.0].
##   3. ChromaSprite.bleed_proximity forwards to the shader parameter.
##   4. interior_alpha_for_proximity() is monotonically non-increasing over a
##      representative range -- alpha never ramps back up as expiry nears.
##   5. interior_alpha_for_proximity(0.0) == 1.0 (fully visible, far from
##      bleed) and interior_alpha_for_proximity(1.0) == 0.0 (interior faded
##      out entirely at imminent bleed).
##   6. CPU-simulated contour detection: at proximity=1.0 on a synthetic
##      silhouette, only edge/outline pixels remain visibly non-transparent;
##      the interior pixel is fully transparent.
##   7. CPU-simulated contour detection: at proximity=0.0 every silhouette
##      pixel (interior and edge) is fully visible -- no premature fade.
##   8. Background (non-silhouette) pixels stay transparent at every proximity.
##   9. BleedClockDriver.compute_proximity() applies identically to a held
##      duration (60-90 min) and a world/escrow duration (48-72 h) -- same
##      function, different duration, per the "same visual mechanic" rule.
##  10. BleedClockDriver.compute_proximity() is monotonically non-decreasing
##      as "now" advances toward bleed_at, for both timer scopes.
##  11. BleedClockDriver emits bleed_proximity_changed with a value in [0, 1]
##      only -- never a raw countdown in seconds (no numeric UI leak).
##
## Run headless:
##   cd client && timeout 600 godot --headless --script tests/test_T0122_bleed_alpha_ramp.gd
## Exit 0 on PASS, 1 on any failure.

const SHADER_PATH: String = "res://shaders/chroma_palette_swap.gdshader"
const SPRITE_SCRIPT_PATH: String = "res://chroma_sprite.gd"
const DRIVER_SCRIPT_PATH: String = "res://scripts/bleed_clock_driver.gd"

## Tolerance for floating-point comparisons.
const EPS: float = 1e-5

## Number of evenly-spaced samples for monotonicity sweeps.
const RAMP_SAMPLES: int = 20

## Alpha above this is "opaque" for edge-detection purposes -- mirrors the
## BLEED_EDGE_ALPHA_THRESHOLD constant in chroma_palette_swap.gdshader.
const EDGE_ALPHA_THRESHOLD: float = 0.5

## Held-bleed duration fixture: 75 minutes (within the 60-90 min range).
const HELD_DURATION_SECS: float = 75.0 * 60.0

## World/escrow-bleed duration fixture: 60 hours (within the 48-72 h range).
const WORLD_DURATION_SECS: float = 60.0 * 60.0 * 60.0


## CPU-simulation of the bleed-alpha ramp + contour-edge detection performed
## by chroma_palette_swap.gdshader's fragment() (T-0122). `grid` is a square
## array-of-arrays of alpha values (0.0 = transparent, 1.0 = opaque) standing
## in for a sprite's indexed-PNG alpha channel. Out-of-bounds neighbours are
## treated as transparent (silhouette never touches the sprite edge in the
## fixtures below). Returns a same-shape grid of final display alpha.
static func _simulate_bleed_alpha(grid: Array, proximity: float) -> Array:
	var h: int = grid.size()
	var w: int = grid[0].size()
	var out: Array = []
	var interior_factor: float = 1.0 - clampf(proximity, 0.0, 1.0)
	for y: int in range(h):
		var row: Array = []
		for x: int in range(w):
			var a: float = grid[y][x]
			var is_edge: bool = false
			if a > EDGE_ALPHA_THRESHOLD:
				var up: float = grid[y - 1][x] if y > 0 else 0.0
				var down: float = grid[y + 1][x] if y < h - 1 else 0.0
				var left: float = grid[y][x - 1] if x > 0 else 0.0
				var right: float = grid[y][x + 1] if x < w - 1 else 0.0
				is_edge = (up <= EDGE_ALPHA_THRESHOLD or down <= EDGE_ALPHA_THRESHOLD
						or left <= EDGE_ALPHA_THRESHOLD or right <= EDGE_ALPHA_THRESHOLD)
			var final_a: float = a if is_edge else a * interior_factor
			row.append(final_a)
		out.append(row)
	return out


func _init() -> void:
	var failures: Array[String] = []

	# ── 1. Shader still loads and exposes bleed_proximity ─────────────────────
	var shader = load(SHADER_PATH)
	if shader == null:
		failures.append(
			"shader load: could not load '%s' — file missing or parse error" % SHADER_PATH
		)
		_report(failures)
		return
	var code: String = shader.code
	if not code.contains("bleed_proximity"):
		failures.append(
			"shader: expected a 'bleed_proximity' uniform in '%s'" % SHADER_PATH
		)

	# ── ChromaSprite script load ───────────────────────────────────────────────
	var chroma_script = load(SPRITE_SCRIPT_PATH)
	if chroma_script == null:
		failures.append("script load: could not load '%s'" % SPRITE_SCRIPT_PATH)
		_report(failures)
		return

	# ── 2. bleed_proximity clamped to [0, 1] ──────────────────────────────────
	var cs_clamp = chroma_script.new()
	cs_clamp.bleed_proximity = -0.5
	if cs_clamp.bleed_proximity < 0.0:
		failures.append(
			"clamp: bleed_proximity=-0.5 should clamp to 0.0, got %f" % cs_clamp.bleed_proximity
		)
	cs_clamp.bleed_proximity = 2.0
	if cs_clamp.bleed_proximity > 1.0:
		failures.append(
			"clamp: bleed_proximity=2.0 should clamp to 1.0, got %f" % cs_clamp.bleed_proximity
		)

	# ── 3. bleed_proximity forwards to the shader parameter ───────────────────
	var cs_forward = chroma_script.new()
	cs_forward.bleed_proximity = 0.4
	var mat = cs_forward.material
	if not (mat is ShaderMaterial):
		failures.append("material: material is not a ShaderMaterial after setting bleed_proximity")
	else:
		var param: float = mat.get_shader_parameter("bleed_proximity")
		if not is_equal_approx(param, 0.4):
			failures.append(
				"bleed_proximity=0.4: shader parameter should be 0.4, got %f" % param
			)

	# ── 4. interior_alpha_for_proximity() is monotonically non-increasing ────
	var cs_static = chroma_script.new()
	var prev_alpha: float = cs_static.interior_alpha_for_proximity(0.0)
	for i: int in range(1, RAMP_SAMPLES + 1):
		var t: float = float(i) / float(RAMP_SAMPLES)
		var alpha: float = cs_static.interior_alpha_for_proximity(t)
		if alpha > prev_alpha + 1e-6:
			failures.append(
				"ramp monotonicity: alpha increased from %f to %f at t=%f" % [prev_alpha, alpha, t]
			)
		prev_alpha = alpha

	# ── 5. Boundary values ─────────────────────────────────────────────────────
	var alpha_zero: float = cs_static.interior_alpha_for_proximity(0.0)
	if not is_equal_approx(alpha_zero, 1.0):
		failures.append(
			"ramp boundary: interior_alpha_for_proximity(0.0) should be 1.0, got %f" % alpha_zero
		)
	var alpha_one: float = cs_static.interior_alpha_for_proximity(1.0)
	if not is_zero_approx(alpha_one):
		failures.append(
			"ramp boundary: interior_alpha_for_proximity(1.0) should be 0.0, got %f" % alpha_one
		)

	# ── Fixture silhouette: 3x3 filled square inside a 5x5 transparent field ──
	# Interior pixel (2,2) is fully surrounded by opaque neighbours; the 8
	# perimeter pixels of the square each touch a transparent neighbour outside
	# it, so they are contour/edge pixels.
	var silhouette: Array = [
		[0.0, 0.0, 0.0, 0.0, 0.0],
		[0.0, 1.0, 1.0, 1.0, 0.0],
		[0.0, 1.0, 1.0, 1.0, 0.0],
		[0.0, 1.0, 1.0, 1.0, 0.0],
		[0.0, 0.0, 0.0, 0.0, 0.0],
	]

	# ── 6. Contour-only end state (proximity = 1.0) ───────────────────────────
	var end_state: Array = _simulate_bleed_alpha(silhouette, 1.0)
	if end_state[2][2] > EPS:
		failures.append(
			"contour-only: interior pixel (2,2) should be fully transparent at proximity=1.0, got %f"
			% end_state[2][2]
		)
	var edge_coords: Array = [
		[1, 1], [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3],
	]
	for coord: Array in edge_coords:
		var y: int = coord[0]
		var x: int = coord[1]
		if end_state[y][x] < EDGE_ALPHA_THRESHOLD:
			failures.append(
				"contour-only: edge pixel (%d,%d) should remain visibly non-transparent at proximity=1.0, got %f"
				% [y, x, end_state[y][x]]
			)

	# ── 7. No premature fade at proximity = 0.0 ───────────────────────────────
	var start_state: Array = _simulate_bleed_alpha(silhouette, 0.0)
	if not is_equal_approx(start_state[2][2], 1.0):
		failures.append(
			"no premature fade: interior pixel should be fully visible at proximity=0.0, got %f"
			% start_state[2][2]
		)
	for coord: Array in edge_coords:
		var y: int = coord[0]
		var x: int = coord[1]
		if not is_equal_approx(start_state[y][x], 1.0):
			failures.append(
				"no premature fade: edge pixel (%d,%d) should be fully visible at proximity=0.0, got %f"
				% [y, x, start_state[y][x]]
			)

	# ── 8. Background stays transparent at every proximity ───────────────────
	for proximity: float in [0.0, 0.3, 0.7, 1.0]:
		var state: Array = _simulate_bleed_alpha(silhouette, proximity)
		if not is_zero_approx(state[0][0]):
			failures.append(
				"background: (0,0) should stay transparent at proximity=%f, got %f"
				% [proximity, state[0][0]]
			)

	# ── BleedClockDriver script load ──────────────────────────────────────────
	var driver_script = load(DRIVER_SCRIPT_PATH)
	if driver_script == null:
		failures.append("script load: could not load '%s'" % DRIVER_SCRIPT_PATH)
		_report(failures)
		return

	# ── 9. Same function, different duration — held vs world/escrow ──────────
	var bleed_at: float = 1_000_000.0
	for fixture: Dictionary in [
		{"label": "held", "duration": HELD_DURATION_SECS},
		{"label": "world", "duration": WORLD_DURATION_SECS},
	]:
		var duration: float = fixture["duration"]
		var p_birth: float = driver_script.compute_proximity(
			bleed_at - duration, bleed_at, duration
		)
		if not is_zero_approx(p_birth):
			failures.append(
				"%s: proximity at timer start should be 0.0, got %f" % [fixture["label"], p_birth]
			)
		var p_mid: float = driver_script.compute_proximity(
			bleed_at - duration * 0.5, bleed_at, duration
		)
		if absf(p_mid - 0.5) > EPS:
			failures.append(
				"%s: proximity at midpoint should be ~0.5, got %f" % [fixture["label"], p_mid]
			)
		var p_expiry: float = driver_script.compute_proximity(bleed_at, bleed_at, duration)
		if not is_equal_approx(p_expiry, 1.0):
			failures.append(
				"%s: proximity at bleed_at should be 1.0, got %f" % [fixture["label"], p_expiry]
			)

		# ── 10. Monotonic non-decreasing as "now" advances (per scope) ────────
		var prev_p: float = 0.0
		for i: int in range(RAMP_SAMPLES + 1):
			var t_frac: float = float(i) / float(RAMP_SAMPLES)
			var now_t: float = (bleed_at - duration) + t_frac * duration
			var p_t: float = driver_script.compute_proximity(now_t, bleed_at, duration)
			if p_t < prev_p - EPS:
				failures.append(
					"%s monotonicity: proximity decreased from %f to %f at t_frac=%f"
					% [fixture["label"], prev_p, p_t, t_frac]
				)
			prev_p = p_t

	# ── 11. Signal emits proximity in [0,1] only — no raw countdown leak ─────
	var driver = driver_script.new()
	driver.bleed_at = bleed_at
	driver.bleed_duration_secs = HELD_DURATION_SECS
	var emitted: Array[float] = []
	driver.bleed_proximity_changed.connect(
		func(p: float) -> void:
			emitted.append(p)
	)
	driver._process_tick(bleed_at - HELD_DURATION_SECS * 0.25)
	if emitted.size() != 1:
		failures.append(
			"signal: expected 1 emission from _process_tick(), got %d" % emitted.size()
		)
	else:
		var p_check: float = emitted[0]
		if p_check < 0.0 or p_check > 1.0:
			failures.append(
				"no_timer: emitted value %f is outside [0,1] — looks like a raw countdown, not proximity"
				% p_check
			)

	# ── Report ─────────────────────────────────────────────────────────────────
	_report(failures)


func _report(failures: Array[String]) -> void:
	if failures.is_empty():
		print("T-0122 PASS: bleed-alpha ramp verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0122 FAIL: %s" % f)
		quit(1)
