"""RED: derive a same-render-style side-profile reference panel from the
committed T-0209 concept sheet (T-0272 round 4, defect 2 -- "a costume-
bearing side-profile reference").

Direct visual inspection of `player_character_concept_sheet_v1.png` (see
`ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s round-4-continued section) found: every
green-coat panel on that sheet is a pure front view -- there is no profile or
even three-quarter angle of the green costume anywhere on it, so the card's
cheapest option ("crop a profile-ish view ... so it at least carries the
palette") is not literally achievable from either named source (the concept
sheet or T-0252's own front-only idle sheet). The sheet DOES contain a
genuine, unambiguous side-profile panel -- rendered in the same art style as
every other panel, just in the sheet's grey/tan tactical-variant costume tier,
not the green cloth-coat tier. `extract_panel_reference` crops that panel
tightly to its own figure and forces every non-figure pixel (background *and*
the panel's own small text-label artifact) to solid black, matching this
card's "solid flat black background" generation target -- a same-style,
correctly-facing (right, matching `pose_rig_profile_T0272.FACING`) pose
reference, still not a costume match, but a cheap, real, committed derivation
rather than another gitignored scratch file.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from derive_profile_style_reference_T0272 import extract_panel_reference

SIZE = 64
BACKGROUND_RGB = (150, 150, 150)
FIGURE_RGB = (90, 95, 60)  # a mid-tone fill, far enough from background in Oklab space
TOLERANCE = 0.03


def _panel(figure_rect, extra_blob=None) -> Image.Image:
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = BACKGROUND_RGB
    x0, y0, x1, y1 = figure_rect
    arr[y0:y1, x0:x1] = FIGURE_RGB
    if extra_blob is not None:
        bx0, by0, bx1, by1 = extra_blob
        arr[by0:by1, bx0:bx1] = (10, 10, 10)  # a dark "text label" blob, disjoint from the figure
    return Image.fromarray(arr, mode="RGB")


def test_panel_is_cropped_tightly_to_the_figure_with_margin() -> None:
    figure_rect = (20, 10, 40, 50)
    panel = _panel(figure_rect)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=4)

    expected_w = (figure_rect[2] - figure_rect[0]) + 2 * 4
    expected_h = (figure_rect[3] - figure_rect[1]) + 2 * 4
    assert out.size == (expected_w, expected_h)


def test_figure_pixels_keep_their_colour_background_goes_black() -> None:
    figure_rect = (20, 10, 40, 50)
    panel = _panel(figure_rect)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=4)
    arr = np.array(out)

    # centre of the crop is well inside the figure -- must keep its colour
    cy, cx = arr.shape[0] // 2, arr.shape[1] // 2
    assert tuple(arr[cy, cx]) == FIGURE_RGB
    # a corner of the crop (the margin region) is background -- must be black
    assert tuple(arr[0, 0]) == (0, 0, 0)


def test_disconnected_label_artifact_is_suppressed_to_black() -> None:
    """A small disconnected blob (the panel's own text-label artifact) that
    falls inside the figure's bbox+margin must still be forced to black --
    only the largest connected component (the figure itself) is kept."""
    figure_rect = (20, 10, 40, 50)
    label_blob = (18, 8, 24, 9)  # a thin sliver just above the figure, inside the margin
    panel = _panel(figure_rect, extra_blob=label_blob)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=4)
    arr = np.array(out)

    assert not np.any(np.all(arr == (10, 10, 10), axis=-1)), (
        "the disconnected label artifact must be suppressed to black, not survive alongside "
        "the figure"
    )


def test_margin_is_clamped_to_the_source_panel_bounds() -> None:
    """A figure sitting flush against the panel edge must not raise or wrap --
    the margin clamps to the source panel's own extent."""
    figure_rect = (0, 0, 20, 20)
    panel = _panel(figure_rect)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=10)

    assert out.size[0] <= SIZE
    assert out.size[1] <= SIZE
