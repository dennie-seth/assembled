class_name ChromaSprite
extends Sprite2D
## Sprite2D subclass that applies the chroma palette-swap shader (T-0121) and
## the bleed-alpha ramp that shares its shader family (T-0122).
##
## Exposes origin_palette, collapse_proximity, and bleed_proximity as typed,
## exported properties. The ShaderMaterial is created lazily on first property
## write so that setting any of them works correctly even before the node
## enters the scene tree (allowing headless tests to inspect the material
## without add_child()).
##
## The static intensity_for_proximity() and interior_alpha_for_proximity()
## functions mirror the GLSL ramps in chroma_palette_swap.gdshader so GDScript
## code (and headless tests) can reason about the curves without a GPU.

const _SHADER_PATH: String = "res://shaders/chroma_palette_swap.gdshader"

## Ramp exponent — must match RAMP_EXPONENT in chroma_palette_swap.gdshader.
const _RAMP_EXPONENT: float = 2.0

## Palette identifier for this sprite.
## 0 = home universe (renders unmodified through the home LUT).
## Any other value = foreign object (renders through the foreign LUT, mixed by
## the chroma-intensity ramp against the home LUT).
@export var origin_palette: int = 0:
	set(v):
		origin_palette = v
		_apply_params()

## Collapse-clock proximity driving the chroma-intensity ramp.
## 0.0 = universe newly created (foreign objects barely distinguishable).
## 1.0 = imminent collapse (foreign objects maximally chromatically violent).
## Values outside [0, 1] are clamped before forwarding to the shader.
@export_range(0.0, 1.0) var collapse_proximity: float = 0.0:
	set(v):
		collapse_proximity = clampf(v, 0.0, 1.0)
		_apply_params()

## Bleed-clock proximity driving the bleed-alpha ramp (T-0122).
## 0.0 = bleed_at far away (item fully visible).
## 1.0 = imminent bleed (interior faded out, contour/outline only).
## Values outside [0, 1] are clamped before forwarding to the shader.
@export_range(0.0, 1.0) var bleed_proximity: float = 0.0:
	set(v):
		bleed_proximity = clampf(v, 0.0, 1.0)
		_apply_params()


func _ready() -> void:
	_apply_params()


## Ensure a ShaderMaterial backed by the chroma shader exists, then forward the
## current property values to its uniforms.  Creates the material lazily so
## that setting either property before _ready() (e.g. in headless tests that
## never call add_child) still works correctly.
func _apply_params() -> void:
	if not material is ShaderMaterial:
		var mat: ShaderMaterial = ShaderMaterial.new()
		mat.shader = load(_SHADER_PATH) as Shader
		material = mat
	var mat: ShaderMaterial = material as ShaderMaterial
	mat.set_shader_parameter("origin_palette", origin_palette)
	mat.set_shader_parameter("collapse_proximity", collapse_proximity)
	mat.set_shader_parameter("bleed_proximity", bleed_proximity)


## Compute the chroma-intensity value the shader will apply for a given
## collapse_proximity.  Mirrors the GLSL pow(collapse_proximity, RAMP_EXPONENT)
## ramp in chroma_palette_swap.gdshader so that GDScript callers and headless
## tests can verify monotonicity without a GPU.
##
## @param p Collapse-clock proximity in [0.0, 1.0].
## @return  Chroma intensity in [0.0, 1.0], monotonically non-decreasing.
static func intensity_for_proximity(p: float) -> float:
	return pow(clampf(p, 0.0, 1.0), _RAMP_EXPONENT)


## Compute the interior-alpha ramp factor the shader will apply for a given
## bleed_proximity.  Mirrors the GLSL interior_factor in
## chroma_palette_swap.gdshader: 1.0 at proximity 0.0 (interior fully visible)
## ramping linearly down to 0.0 at proximity 1.0 (interior fully transparent —
## only contour/edge texels remain, per the fragment shader's edge detection).
##
## @param p Bleed-clock proximity in [0.0, 1.0].
## @return  Interior alpha factor in [0.0, 1.0], monotonically non-increasing.
static func interior_alpha_for_proximity(p: float) -> float:
	return 1.0 - clampf(p, 0.0, 1.0)
