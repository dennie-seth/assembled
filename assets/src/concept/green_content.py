"""Green-content measurement (T-0317, `docs/design/13-asset-pipeline.md` §6.9).

Pure functions over a PIL image, returning plain Python/numpy values rather
than raising or printing (`.claude/rules/python.md`'s "pure functions
returning a shared result type" -- there is no pass/fail verdict here, only
a measurement, so a bare count is the right return type rather than a
`CheckResult`).

Implements the exact predicate T-0272 round 5 used by eye to distinguish the
front concept sheet's confirmed green-coat panels (6,000-6,900 matching
pixels) from its grey/tan tactical-variant panels (1.0-1.7% of panel area,
anti-aliasing noise): a pixel counts as "coat green" if its green channel
exceeds both red and blue by a margin (rules out grey/white/red) and stays
below a ceiling (rules out near-white highlights with a faint green cast).
"""

from __future__ import annotations

import numpy as np
from PIL import Image

GREEN_MARGIN = 8
GREEN_CEILING = 160


def green_pixel_mask(image: Image.Image) -> np.ndarray:
    """Boolean (H, W) mask of pixels that read as institutional-green coat
    colour: green channel at least `GREEN_MARGIN` above both red and blue,
    and below `GREEN_CEILING` (excludes near-white/desaturated highlights)."""
    arr = np.array(image.convert("RGB"), dtype=np.int16)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    return (g > r + GREEN_MARGIN) & (g > b + GREEN_MARGIN) & (g < GREEN_CEILING)


def count_green_pixels(image: Image.Image, crop: tuple[int, int, int, int] | None = None) -> int:
    """Count of green-coat-matching pixels, optionally restricted to `crop`
    (left, upper, right, lower) so a generated frame can be measured over a
    region comparable in scale to the front sheet's own panel crops."""
    region = image.crop(crop) if crop is not None else image
    return int(green_pixel_mask(region).sum())
