// Chroma palette-swap shader (T-0121).
//
// Implements the collapse-clock / foreignness signal from 01-vision.md §8:
//   "the home universe is muted; anything that bled in renders in its own
//   palette, and the further it travelled the more chromatically violent it is."
//
// Mechanism (13-asset-pipeline.md §3.0):
//   Assets are indexed PNGs. Each pixel's red channel carries a palette index
//   (0–15). Home-palette objects render through palette_home. Foreign-palette
//   objects render through the substituted LUT (palette_lut), with intensity
//   keyed to collapse-clock proximity so the screen is the clock — the number
//   is never shown.
//
// Uniforms:
//   origin_palette    int    0 = home palette (no swap), 1+ = foreign palette ID
//   collapse_proximity float  0.0 (far from collapse) – 1.0 (imminent collapse)
//   lut               sampler2D  1D LUT texture (1×16 RGBA strip, foreign palette)
//   palette_home      sampler2D  1D LUT texture (1×16 RGBA strip, home palette)
//   TEXTURE           sampler2D  the indexed-PNG sprite (R channel = palette index)
//
// Index-semantics invariant (P-4, 13 §3.0):
//   Index N means the same palette slot in every asset feeding this shader.
//   Mismatched assets produce visibly wrong colours — this is intentional: the
//   shader never silently tolerated corrupted output. The asset-validation gate
//   (T-0102) enforces the invariant before assets reach this shader.
//
// Chroma intensity ramp:
//   At collapse_proximity = 0.0 the foreign LUT is applied at full saturation.
//   The ramp is monotonic — higher proximity never produces lower chroma output.
//   This is a design constraint, not a preference: the screen must always read
//   "closer = more chromatically violent" (01 §8).

shader_type canvas_item;

/// 0 = home palette (passthrough, no LUT swap).
/// 1+ = foreign palette ID (apply lut with intensity ramp).
uniform int origin_palette = 0;

/// Collapse-clock proximity: 0.0 = far from collapse, 1.0 = imminent.
/// Drives the chroma intensity ramp. Never rendered as a number (01 §8).
uniform float collapse_proximity : hint_range(0.0, 1.0) = 0.0;

/// Foreign palette LUT — 1D strip (1×16 RGBA). Pixel X = palette slot index.
uniform sampler2D lut : filter_nearest, repeat_disable;

/// Home palette LUT — 1D strip (1×16 RGBA). Pixel X = palette slot index.
uniform sampler2D palette_home : filter_nearest, repeat_disable;

void fragment() {
	// Sample the indexed sprite: R channel carries the palette slot index.
	vec4 indexed = texture(TEXTURE, UV);
	float slot = indexed.r;  // normalised 0.0–1.0 representing index / 15

	// Select palette based on origin_palette.
	vec4 home_colour = texture(palette_home, vec2(slot, 0.5));

	if (origin_palette == 0) {
		// Home-palette object — no chroma substitution.
		COLOR = home_colour;
	} else {
		// Foreign-palette object — apply LUT with collapse-proximity ramp.
		vec4 foreign_colour = texture(lut, vec2(slot, 0.5));

		// Intensity ramp: lerp from home to foreign colour based on
		// collapse_proximity. At proximity = 0 we stay near home; at
		// proximity = 1 we are fully in foreign colour space.
		// The ramp is deliberately monotonic: mix() with a non-decreasing
		// t (collapse_proximity) guarantees chroma only increases with proximity.
		//
		// Base chroma is already present at proximity = 0 (foreign LUT applied
		// at low weight) so the object is always recognisably "other" even when
		// collapse is distant. Intensity accelerates toward the maximum.
		float t = 0.15 + collapse_proximity * 0.85;  // ramp: 0.15 – 1.0
		COLOR = mix(home_colour, foreign_colour, t);
	}

	// Preserve original alpha (sprite silhouette unchanged — only colour swaps).
	COLOR.a = indexed.a;
}
