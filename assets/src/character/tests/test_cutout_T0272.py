"""RED: content-aware foreground extraction, generalized from the old
keypoint-bbox-clipping `cutout_foreground_mask` (T-0272 round 4).

`docs/design/13-asset-pipeline.md` §3.5's per-frame background cutout
originally treated "outside this frame's own keypoint bbox (+margin)" as
background, unconditionally. That broke the moment a rendered figure
genuinely deviated from the ControlNet skeleton's own keypoint positions --
T-0272 round 3's Test D (a second IP-Adapter reference pulling the pose
toward a real side profile) produced legible silhouettes that the old hard
bbox clip zeroed (attempt 13) or shrank below the foreground floor (attempts
14-15). `char_gen.cutout.extract_foreground_mask` replaces the hard clip with
connected-component selection over a content-based (border-flood) foreground
detector: `keypoints_norm` is a HINT used only to disambiguate between
candidate blobs, never a frame that can clip real pixels. Covers, per the
card's own TDD list: a figure centered on its hint (today's happy path,
unchanged), a figure shifted well off the hint (must survive), a genuinely
blank/erased frame (must still read as empty), a non-human/wide silhouette
(no upright-human assumption), and stray specks outside the figure (cleanup
preserved).
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from char_gen.cutout import (
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_OKLAB_TOLERANCE,
    cutout_foreground_mask,
    extract_foreground_mask,
)

SIZE = 64
BACKGROUND_RGB = (0, 0, 0)
FIGURE_RGB = (0, 200, 90)  # far outside CUTOUT_OKLAB_TOLERANCE of black in Oklab space


def _solid(rgb: tuple[int, int, int]) -> np.ndarray:
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = rgb
    return arr


def _rect_image(rects: list[tuple[int, int, int, int]]) -> Image.Image:
    """A black `SIZE`x`SIZE` field with one or more solid-figure-colour
    rectangles (x0, y0, x1, y1) stamped onto it, each disjoint from the
    frame border so `border_flood_background_mask` cannot reach them."""
    arr = _solid(BACKGROUND_RGB)
    for x0, y0, x1, y1 in rects:
        arr[y0:y1, x0:x1] = FIGURE_RGB
    return Image.fromarray(arr, mode="RGB")


def _hint_from_px_box(x0: int, y0: int, x1: int, y1: int) -> dict[int, tuple[float, float]]:
    """A minimal two-point keypoints_norm dict whose bbox (in the [0,1]
    normalised space `extract_foreground_mask` expects) is exactly the given
    pixel box -- margin is applied on top by the function under test, same
    as the original keypoint-derived bbox."""
    return {
        0: (x0 / SIZE, y0 / SIZE),
        1: ((x1 - 1) / SIZE, (y1 - 1) / SIZE),
    }


def test_figure_centered_on_hint_is_fully_recovered() -> None:
    """Happy path, unchanged: a figure sitting inside its own keypoints hint
    is recovered in full -- the regression anchor for T-0252's already-
    promoted front idle sheet, whose figure sits centered on its own rig."""
    rect = (20, 20, 44, 44)
    img = _rect_image([rect])
    hint = _hint_from_px_box(*rect)

    mask = extract_foreground_mask(img, CUTOUT_OKLAB_TOLERANCE, hint, BACKGROUND_MASK_MARGIN_FRAC)

    expected = np.zeros((SIZE, SIZE), dtype=bool)
    expected[rect[1] : rect[3], rect[0] : rect[2]] = True
    assert np.array_equal(mask, expected)


def test_figure_shifted_well_off_hint_still_extracted() -> None:
    """The T-0272 round-3 Test D case: the rendered figure sits far outside
    the skeleton's own keypoint bbox (a stacked profile reference pulled the
    pose off-rig). The old hard bbox clip zeroed this entirely (attempt 13)
    or cut it down under the foreground floor (attempts 14-15); the new
    content-aware selection must recover the whole figure regardless of
    where it landed."""
    figure_rect = (40, 4, 60, 24)  # top-right corner
    hint_rect = (4, 40, 24, 60)  # bottom-left corner -- disjoint from the figure
    img = _rect_image([figure_rect])
    hint = _hint_from_px_box(*hint_rect)

    mask = extract_foreground_mask(img, CUTOUT_OKLAB_TOLERANCE, hint, BACKGROUND_MASK_MARGIN_FRAC)

    expected = np.zeros((SIZE, SIZE), dtype=bool)
    expected[figure_rect[1] : figure_rect[3], figure_rect[0] : figure_rect[2]] = True
    assert np.array_equal(mask, expected), (
        "a figure entirely outside its own keypoints hint must still be recovered in full, "
        "not clipped to zero"
    )
    assert mask.sum() == (figure_rect[2] - figure_rect[0]) * (figure_rect[3] - figure_rect[1])


def test_blank_frame_has_no_foreground() -> None:
    """A genuinely erased/all-background frame must still read as empty --
    the "figure is too small / was erased" failure mode stays detectable
    even though "the figure moved" no longer is."""
    img = _rect_image([])
    hint = _hint_from_px_box(20, 20, 44, 44)

    mask = extract_foreground_mask(img, CUTOUT_OKLAB_TOLERANCE, hint, BACKGROUND_MASK_MARGIN_FRAC)

    assert mask.sum() == 0


def test_wide_asymmetric_silhouette_needs_no_keypoints_hint() -> None:
    """Stands in for a non-human entity (the owl-Watcher, robot-Sound,
    spider-Still-Air): a silhouette with no upright-human aspect ratio and no
    keypoints hint at all must still be recovered by content alone."""
    rect = (2, 26, 62, 34)  # a wide, short bar -- nothing about it is human-shaped
    img = _rect_image([rect])

    mask = extract_foreground_mask(img, CUTOUT_OKLAB_TOLERANCE, keypoints_norm=None)

    expected = np.zeros((SIZE, SIZE), dtype=bool)
    expected[rect[1] : rect[3], rect[0] : rect[2]] = True
    assert np.array_equal(mask, expected)


def test_stray_speck_outside_figure_is_excluded() -> None:
    """A disconnected speck elsewhere in the frame (noise, not character)
    must not survive alongside the real figure -- the existing largest-blob
    cleanup behaviour, preserved rather than loosened."""
    figure_rect = (20, 20, 44, 44)
    speck_rect = (58, 2, 62, 6)
    img = _rect_image([figure_rect, speck_rect])
    hint = _hint_from_px_box(*figure_rect)

    mask = extract_foreground_mask(img, CUTOUT_OKLAB_TOLERANCE, hint, BACKGROUND_MASK_MARGIN_FRAC)

    expected = np.zeros((SIZE, SIZE), dtype=bool)
    expected[figure_rect[1] : figure_rect[3], figure_rect[0] : figure_rect[2]] = True
    assert np.array_equal(mask, expected)
    assert mask.sum() < (SIZE * SIZE), "sanity: mask must not be the whole frame"


def test_legacy_name_is_a_drop_in_alias() -> None:
    """`cutout_foreground_mask` is the pre-round-4 name every existing
    generator (gen_chained_idle_T0250, gen_hybrid_source_idle_T0252,
    gen_hybrid_walk_T0259, gen_hybrid_profile_T0272) imports positionally as
    (img, points_norm, tolerance, bbox_margin_frac) -- it must keep working,
    unchanged in call shape, as a thin alias over the new function."""
    rect = (10, 10, 30, 30)
    img = _rect_image([rect])
    hint = _hint_from_px_box(*rect)

    legacy = cutout_foreground_mask(img, hint, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC)
    current = extract_foreground_mask(
        img, CUTOUT_OKLAB_TOLERANCE, hint, BACKGROUND_MASK_MARGIN_FRAC
    )
    assert np.array_equal(legacy, current)
