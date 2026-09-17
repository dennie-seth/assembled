"""Green-content measurement for T-0317's costume side-profile reference.

T-0272 round 5 (`assets/src/character/ARM_PROFILE_ATTEMPT_LOG_T0272.md`)
measured whether a panel's costume reads as the institutional green coat by
counting pixels on the band `g > r+8 and g > b+8 and g < 160` -- green
enough to read as coat colour, but excluding near-white highlights (which
would otherwise false-positive on desaturated light greys). That measurement
was ad-hoc and never committed as reusable code; this card (T-0317) needs
the identical predicate to compare its own generated reference against
round 5's own recorded benchmark (6,000-6,900 green pixels on the sheet's
confirmed front-facing green-coat panels, 1.0-1.7% noise floor on panels
that are not a costume match), so it is committed here as a pure, tested
function rather than re-derived by eye a second time.

RED before GREEN: `char_gen.green_content` does not exist yet.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

WORKTREE = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(WORKTREE / "assets" / "src" / "concept"))

from green_content import count_green_pixels, green_pixel_mask  # noqa: E402


def _solid(color: tuple[int, int, int], size: tuple[int, int] = (10, 10)) -> Image.Image:
    return Image.new("RGB", size, color)


def test_vivid_green_counts_as_green():
    # institutional green coat swatch, e.g. ramp09 (0x5a, 0x60, 0x42) style tone
    img = _solid((70, 110, 60))
    assert count_green_pixels(img) == 100


def test_pure_red_does_not_count_as_green():
    img = _solid((200, 40, 40))
    assert count_green_pixels(img) == 0


def test_pure_grey_does_not_count_as_green():
    img = _solid((120, 120, 120))
    assert count_green_pixels(img) == 0


def test_near_white_green_tint_excluded_by_upper_bound():
    # g must be < 160 -- a near-white pixel with a faint green cast must not
    # count, or anti-aliasing noise on a grey panel would inflate the count
    # (T-0272 round 5's own finding: 1.0-1.7% noise floor on non-match panels).
    img = _solid((235, 245, 230))
    assert count_green_pixels(img) == 0


def test_mixed_image_counts_only_green_pixels():
    img = Image.new("RGB", (2, 1))
    img.putpixel((0, 0), (70, 110, 60))  # green
    img.putpixel((1, 0), (200, 40, 40))  # red
    assert count_green_pixels(img) == 1


def test_crop_box_restricts_measurement_region():
    img = Image.new("RGB", (4, 1))
    img.putpixel((0, 0), (70, 110, 60))  # green, outside crop
    img.putpixel((1, 0), (70, 110, 60))  # green, inside crop
    img.putpixel((2, 0), (70, 110, 60))  # green, inside crop
    img.putpixel((3, 0), (70, 110, 60))  # green, outside crop
    assert count_green_pixels(img, crop=(1, 0, 3, 1)) == 2


def test_green_pixel_mask_shape_matches_image():
    img = _solid((70, 110, 60), size=(5, 3))
    mask = green_pixel_mask(img)
    assert mask.shape == (3, 5)
    assert bool(mask.all())
