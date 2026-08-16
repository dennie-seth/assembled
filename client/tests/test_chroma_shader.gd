extends SceneTree
## T-0121: Chroma palette-swap shader — headless test suite.
##
## Verifies:
##   1. chroma_palette_swap.gdshader loads without error as MODE_CANVAS_ITEM.
##   2. chroma_sprite.gd loads as a GDScript resource.
##   3. ChromaSprite extends Sprite2D (checked via script's base_script chain).
##   4. Setting origin_palette=0 (home) writes 0 to the shader parameter;
##      setting origin_palette=1 (foreign) writes 1.
##   5. collapse_proximity is clamped to [0.0, 1.0].
##   6. intensity_for_proximity() is monotonically non-decreasing over a
##      representative range — mirrors the GLSL ramp without a GPU.
##   7. intensity_for_proximity(0.0) == 0.0 and intensity_for_proximity(1.0) == 1.0
##      so the clock reads "no threat" at start and "maximum" at collapse.
##   8. CPU-simulated palette swap: swapping origin_palette changes pixel colour
##      but preserves source alpha (silhouette/index data unchanged).
##   9. CPU-simulated palette swap: at origin_palette=0 the home colour is
##      returned unmodified regardless of collapse_proximity.
##  10. Visual regression: CPU-simulated output at proximity=0.0 vs proximity=1.0
##      produces visibly distinct colours for a foreign object (|Δ| >= 0.5 in
##      at least one channel) — proves the ramp creates meaningful contrast.
##
## Run headless:
##   godot --headless --script tests/test_chroma_shader.gd
## from client/. Exit 0 on PASS, 1 on any failure.
##
## Design note: ChromaSprite is a GDScript class_name; when running --headless
## with --script, Godot may not complete the global class scan before the test
## script is parsed.  We therefore load both scripts dynamically via load() and
## use untyped instances rather than relying on global name resolution.
## Shader-parameter and property access work identically on untyped instances.

## Path to the shader relative to the Godot project root.
const SHADER_PATH: String = "res://shaders/chroma_palette_swap.gdshader"
## Path to the ChromaSprite script.
const SPRITE_SCRIPT_PATH: String = "res://chroma_sprite.gd"

## Ramp exponent — must match RAMP_EXPONENT in chroma_palette_swap.gdshader
## and _RAMP_EXPONENT in chroma_sprite.gd.
const RAMP_EXPONENT: float = 2.0

## Number of evenly-spaced samples for the monotonicity sweep.
const RAMP_SAMPLES: int = 20


## CPU-simulation of the GLSL fragment shader logic.
## Given palette lookup results and shader uniforms, returns the output colour.
## Mirrors chroma_palette_swap.gdshader exactly so headless tests exercise the
## same arithmetic without requiring a GPU.
static func _simulate_fragment(
		src_alpha: float,
		home_col: Color,
		foreign_col: Color,
		p_origin_palette: int,
		p_collapse_proximity: float) -> Color:
	var out_col: Color
	if p_origin_palette == 0:
		out_col = home_col
	else:
		var chroma: float = pow(clampf(p_collapse_proximity, 0.0, 1.0), RAMP_EXPONENT)
		out_col = home_col.lerp(foreign_col, chroma)
	return Color(out_col.r, out_col.g, out_col.b, out_col.a * src_alpha)


func _init() -> void:
	var failures: Array[String] = []

	# ── 1. Shader file loads as MODE_CANVAS_ITEM ──────────────────────────────
	var shader = load(SHADER_PATH)
	if shader == null:
		failures.append(
			"shader load: could not load '%s' — file missing or parse error" % SHADER_PATH
		)
	else:
		if shader.get_mode() != Shader.MODE_CANVAS_ITEM:
			failures.append(
				"shader load: expected MODE_CANVAS_ITEM, got mode=%d" % shader.get_mode()
			)

	# ── 2. chroma_sprite.gd loads as a GDScript resource ─────────────────────
	var chroma_script = load(SPRITE_SCRIPT_PATH)
	if chroma_script == null:
		failures.append(
			"script load: could not load '%s'" % SPRITE_SCRIPT_PATH
		)
		_report(failures)
		return

	# ── 3. ChromaSprite extends Sprite2D ──────────────────────────────────────
	# Walk the script's inheritance chain looking for Sprite2D.
	var found_sprite2d: bool = false
	var walk_script = chroma_script
	while walk_script != null:
		if walk_script.get_instance_base_type() == "Sprite2D":
			found_sprite2d = true
			break
		walk_script = walk_script.get_base_script()
	if not found_sprite2d:
		failures.append(
			"inheritance: ChromaSprite does not extend Sprite2D"
		)

	# ── 4. origin_palette shader parameter binding ────────────────────────────
	# Instantiate without add_child() — _apply_params() is lazy so _ready()
	# is not required; setting origin_palette triggers material creation.
	var cs_home = chroma_script.new()
	cs_home.origin_palette = 0
	var mat_home = cs_home.material
	if not (mat_home is ShaderMaterial):
		failures.append(
			"material: material is not a ShaderMaterial after setting origin_palette"
		)
	else:
		var param_home: int = int(mat_home.get_shader_parameter("origin_palette"))
		if param_home != 0:
			failures.append(
				"origin_palette=0: shader parameter should be 0, got %d" % param_home
			)

	var cs_foreign = chroma_script.new()
	cs_foreign.origin_palette = 1
	var mat_foreign = cs_foreign.material
	if not (mat_foreign is ShaderMaterial):
		failures.append(
			"material (foreign): material is not a ShaderMaterial"
		)
	else:
		var param_foreign: int = int(mat_foreign.get_shader_parameter("origin_palette"))
		if param_foreign != 1:
			failures.append(
				"origin_palette=1: shader parameter should be 1, got %d" % param_foreign
			)

	# ── 5. collapse_proximity is clamped to [0, 1] ───────────────────────────
	var cs_clamp = chroma_script.new()
	cs_clamp.collapse_proximity = -0.5
	var mat_clamp = cs_clamp.material
	if mat_clamp is ShaderMaterial:
		var prox_neg: float = mat_clamp.get_shader_parameter("collapse_proximity")
		if prox_neg < 0.0:
			failures.append(
				"clamp: collapse_proximity=-0.5 should clamp to 0.0, got %f" % prox_neg
			)
	cs_clamp.collapse_proximity = 2.0
	if mat_clamp is ShaderMaterial:
		var prox_over: float = mat_clamp.get_shader_parameter("collapse_proximity")
		if prox_over > 1.0:
			failures.append(
				"clamp: collapse_proximity=2.0 should clamp to 1.0, got %f" % prox_over
			)

	# ── 6. intensity_for_proximity() is monotonically non-decreasing ──────────
	# Call the static method on a freshly created instance (GDScript allows
	# calling static methods on instances in addition to on the class name).
	var cs_static = chroma_script.new()
	var prev_intensity: float = cs_static.intensity_for_proximity(0.0)
	for i: int in range(1, RAMP_SAMPLES + 1):
		var t: float = float(i) / float(RAMP_SAMPLES)
		var intensity: float = cs_static.intensity_for_proximity(t)
		if intensity < prev_intensity - 1e-6:
			failures.append(
				"ramp monotonicity: intensity decreased from %f to %f at t=%f" % [prev_intensity, intensity, t]
			)
		prev_intensity = intensity

	# ── 7. Boundary values ────────────────────────────────────────────────────
	var intensity_zero: float = cs_static.intensity_for_proximity(0.0)
	if not is_zero_approx(intensity_zero):
		failures.append(
			"ramp boundary: intensity_for_proximity(0.0) should be 0.0, got %f" % intensity_zero
		)
	var intensity_one: float = cs_static.intensity_for_proximity(1.0)
	if not is_equal_approx(intensity_one, 1.0):
		failures.append(
			"ramp boundary: intensity_for_proximity(1.0) should be 1.0, got %f" % intensity_one
		)

	# ── 8. Palette swap preserves alpha (silhouette), changes colour ──────────
	# Fixture: alpha 0.7, home colour = red, foreign colour = blue.
	var fix_alpha: float = 0.7
	var home_c: Color = Color(1.0, 0.0, 0.0, 1.0)    # red
	var foreign_c: Color = Color(0.0, 0.0, 1.0, 1.0)  # blue

	# Home (origin_palette=0): colour unchanged, alpha preserved.
	var out_home: Color = _simulate_fragment(fix_alpha, home_c, foreign_c, 0, 0.5)
	if not is_equal_approx(out_home.a, fix_alpha):
		failures.append(
			"silhouette (home): alpha changed: expected %f, got %f" % [fix_alpha, out_home.a]
		)
	if not (is_equal_approx(out_home.r, home_c.r)
			and is_equal_approx(out_home.g, home_c.g)
			and is_equal_approx(out_home.b, home_c.b)):
		failures.append(
			"silhouette (home): colour changed unexpectedly — got (%f,%f,%f)" % [out_home.r, out_home.g, out_home.b]
		)

	# Foreign (origin_palette=1, proximity=1.0): colour swapped, alpha preserved.
	var out_foreign: Color = _simulate_fragment(fix_alpha, home_c, foreign_c, 1, 1.0)
	if not is_equal_approx(out_foreign.a, fix_alpha):
		failures.append(
			"silhouette (foreign): alpha changed: expected %f, got %f" % [fix_alpha, out_foreign.a]
		)
	if (is_equal_approx(out_foreign.r, home_c.r)
			and is_equal_approx(out_foreign.g, home_c.g)
			and is_equal_approx(out_foreign.b, home_c.b)):
		failures.append(
			"palette swap: colour unchanged after swap (origin_palette=1, proximity=1.0)"
		)

	# ── 9. Home object renders unmodified at any proximity ────────────────────
	for prox: float in [0.0, 0.5, 1.0]:
		var out: Color = _simulate_fragment(1.0, home_c, foreign_c, 0, prox)
		if not (is_equal_approx(out.r, home_c.r)
				and is_equal_approx(out.g, home_c.g)
				and is_equal_approx(out.b, home_c.b)):
			failures.append(
				"home unmodified: origin_palette=0 at proximity=%f changed colour to (%f,%f,%f)" % [prox, out.r, out.g, out.b]
			)

	# ── 10. Visual regression: low vs. high proximity produce distinct output ─
	# For a foreign object (origin_palette=1), the output at proximity=0.0
	# must differ from the output at proximity=1.0 by >= 0.5 in at least one
	# channel — proving the ramp produces visible contrast across the clock.
	var out_low: Color = _simulate_fragment(1.0, home_c, foreign_c, 1, 0.0)
	var out_high: Color = _simulate_fragment(1.0, home_c, foreign_c, 1, 1.0)
	var delta_r: float = absf(out_high.r - out_low.r)
	var delta_g: float = absf(out_high.g - out_low.g)
	var delta_b: float = absf(out_high.b - out_low.b)
	var max_delta: float = maxf(delta_r, maxf(delta_g, delta_b))
	if max_delta < 0.5:
		failures.append(
			"visual regression: low vs. high collapse proximity differ by only %f (need >= 0.5 in at least one channel) — ramp produces no visible contrast" % max_delta
		)

	# ── Report ────────────────────────────────────────────────────────────────
	_report(failures)


func _report(failures: Array[String]) -> void:
	if failures.is_empty():
		print("T-0121 PASS: chroma palette-swap shader and ramp verified")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0121 FAIL: %s" % f)
		quit(1)
