"""RED: force a frame's own border-connected background to a genuinely dark
fill colour, T-0319's fix for the walk sheet's mid-grey background.

Root cause (measured, not guessed -- see WALK_BACKGROUND_FIX_T0319.md for the
full evidence): `gen_hybrid_walk_T0259.py`'s `IDENTITY_REFERENCE_CROP_BOX`
crops a panel out of the committed concept sheet
(`assets/src/concept/player_character_concept_sheet_v1.png`, T-0209) whose
OWN panel background is mid-grey (modal RGB ~(144,143,145)) -- not the
prompt's requested "solid flat black background". That crop is fed to
IPAdapterAdvanced at weight 0.6 as the identity reference; IP-Adapter's
image-level conditioning carries the reference's own background tone into
every generated frame regardless of what the text prompt or negative prompt
say (the negative prompt already names "grey background" explicitly, inherited
unchanged from the idle recipe's own `MAIN_NEGATIVE` -- text conditioning
cannot suppress an image-conditioning leak). Measured modal border RGB on the
preserved attempt 5/7 raw frames (142-153, 142-150, 142-151) matches the
reference crop's own modal border colour almost exactly.

`char_gen.cutout.force_border_background_to_fill` is the fix's shared
primitive: reuse the already-tested `border_flood_background_mask` (T-0315)
to find a frame's own border-connected background region, then paint exactly
those pixels a genuinely dark fill colour, leaving every other pixel
byte-identical. Two call sites use it (both covered by their own tests
elsewhere): `crop_identity_reference` (pre-upload, the generation-time fix)
and the attempt 5/7 re-cut path (post-hoc, no new GPU spend).

RED: `char_gen.cutout` has no `force_border_background_to_fill` and no
`DARK_BACKGROUND_FILL`.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from char_gen.cutout import (
    CUTOUT_OKLAB_TOLERANCE,
    DARK_BACKGROUND_FILL,
    border_flood_background_mask,
    force_border_background_to_fill,
)

SIZE = 64
BACKGROUND_RGB = (144, 143, 145)  # T-0319's measured mid-grey, not black
FIGURE_RGB = (0, 200, 90)  # far outside CUTOUT_OKLAB_TOLERANCE of the grey above


def _grey_bg_image(rect: tuple[int, int, int, int]) -> Image.Image:
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = BACKGROUND_RGB
    x0, y0, x1, y1 = rect
    arr[y0:y1, x0:x1] = FIGURE_RGB
    return Image.fromarray(arr, mode="RGB")


def test_background_pixels_forced_to_dark_fill() -> None:
    rect = (20, 20, 44, 44)
    img = _grey_bg_image(rect)

    result = force_border_background_to_fill(img, CUTOUT_OKLAB_TOLERANCE)

    arr = np.array(result)
    assert tuple(arr[0, 0]) == DARK_BACKGROUND_FILL
    assert tuple(arr[0, SIZE - 1]) == DARK_BACKGROUND_FILL
    assert tuple(arr[SIZE - 1, 0]) == DARK_BACKGROUND_FILL


def test_foreground_pixels_are_byte_identical() -> None:
    rect = (20, 20, 44, 44)
    img = _grey_bg_image(rect)

    result = force_border_background_to_fill(img, CUTOUT_OKLAB_TOLERANCE)

    arr = np.array(result)
    figure_region = arr[rect[1] : rect[3], rect[0] : rect[2]]
    assert np.all(figure_region == FIGURE_RGB), (
        "forcing the background to a dark fill must never touch a pixel the border-flood "
        "mask itself did not classify as background"
    )


def test_result_matches_border_flood_mask_exactly() -> None:
    """The set of forced pixels must be exactly `border_flood_background_mask`'s
    own output -- this function adds no new classification logic of its own,
    it only recolours what that shared, already-tested detector finds."""
    rect = (10, 30, 50, 40)
    img = _grey_bg_image(rect)
    mask = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)

    result = force_border_background_to_fill(img, CUTOUT_OKLAB_TOLERANCE)

    arr = np.array(result)
    forced = np.all(arr == np.array(DARK_BACKGROUND_FILL), axis=-1)
    assert np.array_equal(forced, mask)


def test_default_fill_is_dark_background_fill_constant() -> None:
    rect = (20, 20, 44, 44)
    img = _grey_bg_image(rect)

    default_result = force_border_background_to_fill(img, CUTOUT_OKLAB_TOLERANCE)
    explicit_result = force_border_background_to_fill(
        img, CUTOUT_OKLAB_TOLERANCE, fill_rgb=DARK_BACKGROUND_FILL
    )

    assert np.array_equal(np.array(default_result), np.array(explicit_result))


def test_custom_fill_color_is_respected() -> None:
    rect = (20, 20, 44, 44)
    img = _grey_bg_image(rect)
    custom_fill = (7, 7, 7)

    result = force_border_background_to_fill(img, CUTOUT_OKLAB_TOLERANCE, fill_rgb=custom_fill)

    arr = np.array(result)
    assert tuple(arr[0, 0]) == custom_fill


def test_dark_background_fill_matches_promoted_idle_anchor() -> None:
    """T-0319's target: comparable to T-0252's own promoted idle keyframe
    background, (18, 17, 14) -- not an arbitrary "any dark colour"."""
    assert DARK_BACKGROUND_FILL == (18, 17, 14)


def test_already_dark_background_is_left_alone() -> None:
    """A frame whose background is already near-black (the happy path every
    other generator's already-promoted sheet exhibits) must not be visibly
    altered by this fix -- the forced fill and the original are both 'dark',
    well within cutout tolerance of one another."""
    rect = (20, 20, 44, 44)
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = (18, 17, 14)
    x0, y0, x1, y1 = rect
    arr[y0:y1, x0:x1] = FIGURE_RGB
    img = Image.fromarray(arr, mode="RGB")

    result = force_border_background_to_fill(img, CUTOUT_OKLAB_TOLERANCE)

    result_arr = np.array(result)
    background_mask = ~(
        (np.arange(SIZE)[:, None] >= y0)
        & (np.arange(SIZE)[:, None] < y1)
        & (np.arange(SIZE)[None, :] >= x0)
        & (np.arange(SIZE)[None, :] < x1)
    )
    assert np.all(result_arr[background_mask] == list(DARK_BACKGROUND_FILL))


@pytest.mark.parametrize("bad_tolerance", [-0.01])
def test_negative_tolerance_still_runs_without_crashing(bad_tolerance: float) -> None:
    """Not a supported use, but `border_flood_background_mask` itself has no
    tolerance validation -- confirm this thin wrapper doesn't add a new crash
    mode beyond whatever the shared primitive already tolerates."""
    rect = (20, 20, 44, 44)
    img = _grey_bg_image(rect)
    force_border_background_to_fill(img, bad_tolerance)
