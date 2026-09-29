"""Box-descend one cut master-sheet PART (not a whole frame/sheet) to game
scale (T-0337), preserving this pipeline's existing per-frame guarantees
without re-deriving them: quantize-then-mask at the ALREADY-descended
resolution (the same order `cutout.apply_cutout_masks` already uses at the
sheet level -- see `cutout.CUTOUT_METHOD_DESCRIPTION`), a BOX filter for
both the RGB crop and its mask (matching `cutout.downscale_mask`'s own
choice, so a part and the sheet it came from downscale identically), and
`sprite_io.save_sprite_sheet`'s indexed-PNG-plus-tRNS contract (P-6) for the
result -- Godot's decoder expands that into real ("true") RGBA on load, the
exact contract `sprite_io`'s own docstring documents.

A part crop is rarely square (a limb is tall and narrow, a head near-round)
-- unlike `cutout.downscale_mask`, which only ever serves whole, square
sheet cells, so this module's own rect-shaped resize is new code, not a
retune of that function.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from char_gen.sprite_io import BACKGROUND_INDEX, to_indexed_image


def mask_bbox(mask: np.ndarray, margin_px: int = 0) -> tuple[int, int, int, int]:
    """Tight `(y0, y1, x0, x1)` bounding box around `mask`'s True pixels,
    optionally expanded by `margin_px` on every side and clamped to the
    frame. Raises `ValueError` on an all-False mask -- there is no part to
    descend, and a silent empty crop would be a worse failure than a loud
    one."""
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        raise ValueError("mask has no foreground pixels -- nothing to descend")
    h, w = mask.shape
    y0 = max(0, int(ys.min()) - margin_px)
    y1 = min(h, int(ys.max()) + 1 + margin_px)
    x0 = max(0, int(xs.min()) - margin_px)
    x1 = min(w, int(xs.max()) + 1 + margin_px)
    return y0, y1, x0, x1


def _srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """Duplicated deliberately from `cutout._srgb_to_oklab`, same rationale
    that module's own copy documents: a generator/descent step importing
    from the shared package is the intended dependency direction, not the
    reverse, and this is a small, stable colour-space conversion, not
    business logic that could drift out of sync."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l_), np.cbrt(m_), np.cbrt(s_)
    lightness = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([lightness, a, b2], axis=-1)


def _quantize_to_palette(
    rgb_arr: np.ndarray,
    palette: list[tuple[int, int, int]],
    exclude_indices: tuple[int, ...] = (),
) -> np.ndarray:
    """Nearest-neighbour quantize in Oklab space, no dithering -- same rule
    `gen_arm_a_idle_T0228.quantize_to_palette` already applies at the sheet
    level, reimplemented here against the locked-palette list shape
    `sprite_io.save_sprite_sheet` itself takes (index == list position)
    rather than that function's `asset_gate.palette.Palette` type, to avoid
    this shared package taking on a dependency the rest of `char_gen`
    doesn't have.

    `exclude_indices` removes palette slots from the nearest-neighbour search
    entirely -- `box_descend_part` uses this to keep `BACKGROUND_INDEX`
    reserved for mask-selected background, [FIX ROUND 1]: without it, dark
    foreground pixels can quantize nearest to slot 0's own colour, and
    `sprite_io.save_sprite_sheet`'s tRNS is per-INDEX (not per-pixel), so
    every pixel landing on that index -- foreground included -- goes fully
    transparent."""
    h, w = rgb_arr.shape[:2]
    pixels_oklab = _srgb_to_oklab(rgb_arr.reshape(-1, 3))
    allowed = [i for i in range(len(palette)) if i not in exclude_indices]
    slot_oklab = _srgb_to_oklab(np.array([palette[i] for i in allowed], dtype=np.float64))
    diff = pixels_oklab[:, None, :] - slot_oklab[None, :, :]
    dist2 = np.einsum("pnc,pnc->pn", diff, diff)
    nearest_local = np.argmin(dist2, axis=1)
    nearest = np.array(allowed, dtype=np.uint8)[nearest_local]
    return nearest.reshape(h, w).astype(np.uint8)


def _resize_mask_box(mask: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Area-downscale a boolean mask to `size` = `(width, height)` via the
    same BOX filter `cutout.downscale_mask` uses for square sheet cells, and
    re-threshold at 50% coverage."""
    mask_img = Image.fromarray((mask * 255).astype(np.uint8))
    small = mask_img.resize(size, Image.Resampling.BOX)
    return np.array(small) >= 128


def box_descend_part(
    img: Image.Image,
    mask: np.ndarray,
    palette: list[tuple[int, int, int]],
    target_size: tuple[int, int],
    margin_px: int = 0,
) -> Image.Image:
    """Crop `img` to `mask`'s own bounding box (+`margin_px`), BOX-downscale
    the RGB crop and its mask independently to `target_size` = `(width,
    height)`, quantize the descended RGB to `palette` -- **excluding
    `BACKGROUND_INDEX` from the candidate slots**, so foreground never lands
    on the background index no matter how close its colour sits to slot 0 in
    Oklab space [FIX ROUND 1] -- then force every pixel the
    descended-and-rethresholded mask calls background to `BACKGROUND_INDEX`.
    Returns a mode-`'P'` image; save it with `sprite_io.save_sprite_sheet`
    for the true-RGBA/tRNS contract (P-6): that contract marks
    `BACKGROUND_INDEX` transparent per-INDEX, not per-pixel, so any
    foreground pixel quantized onto it would silently vanish too."""
    y0, y1, x0, x1 = mask_bbox(mask, margin_px)
    rgb_crop = np.array(img.convert("RGB"))[y0:y1, x0:x1]
    mask_crop = mask[y0:y1, x0:x1]

    descended_rgb = np.array(Image.fromarray(rgb_crop).resize(target_size, Image.Resampling.BOX))
    descended_mask = _resize_mask_box(mask_crop, target_size)

    indices = _quantize_to_palette(descended_rgb, palette, exclude_indices=(BACKGROUND_INDEX,))
    indices[~descended_mask] = BACKGROUND_INDEX
    return to_indexed_image(indices, palette)
