shader_type canvas_item;
/// Chroma palette-swap shader — T-0121.
///
/// Performs LUT-based palette substitution for indexed sprites so that foreign
/// objects render in their own palette while home objects remain unmodified.
/// A collapse-proximity ramp drives overall chroma intensity: at proximity 0.0
/// the effect is absent (universe newly created); at 1.0 it is at maximum
/// (imminent collapse).  The screen is the clock — this shader IS the
/// meta-timer, not a cosmetic pass.
///
/// Asset contract (P-4): the sprite texture encodes the palette index in its
/// RED channel (0.0 = index 0, 1.0 = index 255).  Index semantics must be
/// uniform across every asset that passes through this shader; non-uniform
/// semantics produce silent colour corruption.  T-0102 (the asset-validation
/// gate) owns that invariant — this shader assumes it already holds.
///
/// Usage:
///   var mat := ShaderMaterial.new()
///   mat.shader = preload("res://shaders/chroma_palette_swap.gdshader")
///   mat.set_shader_parameter("home_lut", home_lut_texture)
///   mat.set_shader_parameter("foreign_lut", foreign_lut_texture)
///   mat.set_shader_parameter("origin_palette", item.origin_palette)
///   mat.set_shader_parameter("collapse_proximity", clock_proximity)
///   sprite.material = mat

/// Home-universe palette LUT.  1×256 (or 256×1) RGBA texture, filter_nearest.
/// Column N / 255.0 maps palette index N to its home-universe colour.
uniform sampler2D home_lut : filter_nearest, hint_default_black;

/// Foreign-universe palette LUT.  Same layout as home_lut.
/// Used instead of home_lut when origin_palette > 0.
uniform sampler2D foreign_lut : filter_nearest, hint_default_white;

/// Palette identifier for the rendered entity.
/// 0 = home universe — object renders unmodified through home_lut.
/// Any other value = foreign origin — object renders through foreign_lut
/// mixed against home_lut by the chroma-intensity ramp.
uniform int origin_palette = 0;

/// Collapse-clock proximity: 0.0 = universe newly created, 1.0 = imminent
/// collapse.  Drives the chroma-intensity ramp — never rendered as a number
/// or numeric UI element anywhere in the pipeline.
uniform float collapse_proximity : hint_range(0.0, 1.0) = 0.0;

/// Ramp exponent for the chroma-intensity curve.
/// pow() on [0, 1] is monotonically non-decreasing; exponent > 1 gives a
/// slow-build-then-surge profile so the early game reads as merely "slightly
/// wrong" while the final minutes go chromatically violent.
/// Must match RAMP_EXPONENT in chroma_sprite.gd (intensity_for_proximity).
const float RAMP_EXPONENT = 2.0;

void fragment() {
	// Palette index encoded in the RED channel of the indexed sprite (0–1
	// normalised, where 0.0 = index 0 and 1.0 = index 255).
	float idx = texture(TEXTURE, UV).r;

	// Preserve the source alpha exactly — the sprite silhouette (which pixels
	// are transparent) must not change when the palette is swapped.
	float src_alpha = texture(TEXTURE, UV).a;

	// Home colour at this palette index.
	vec4 home_col = texture(home_lut, vec2(idx, 0.5));

	vec4 out_col;
	if (origin_palette == 0) {
		// Home object — render unmodified through the home LUT.
		out_col = home_col;
	} else {
		// Foreign object — resolve colour through the foreign LUT.
		vec4 foreign_col = texture(foreign_lut, vec2(idx, 0.5));

		// Chroma-intensity ramp: monotonically increasing with collapse_proximity.
		// At chroma=0 the foreign object is indistinguishable from a home object;
		// at chroma=1 it is fully in its foreign palette (maximum chromatism).
		float chroma = pow(collapse_proximity, RAMP_EXPONENT);

		out_col = mix(home_col, foreign_col, chroma);
	}

	// Compose with preserved source alpha so silhouette is unchanged.
	COLOR = vec4(out_col.rgb, out_col.a * src_alpha);
}
