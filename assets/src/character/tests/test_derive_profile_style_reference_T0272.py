"""RED (T-0272 round 4) / RED again (T-0347): derive a same-render-style
side-profile reference panel from the committed T-0209 concept sheet (T-0272
round 4, defect 2 -- "a costume-bearing side-profile reference").

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
tightly to its own figure (using the largest border-connected-flood
foreground component to find that figure's own bbox, discarding the panel's
own small text-label artifact from the bbox computation only) -- a same-
style, correctly-facing (right, matching `pose_rig_profile_T0272.FACING`)
pose reference, still not a costume match, but a cheap, real, committed
derivation rather than another gitignored scratch file.

T-0347 RED: this panel's output (`player_profile_style_reference_T0272.png`)
is wired into `gen_hybrid_profile_T0272.py` as a secondary IP-Adapter
reference (`--secondary-concept`, see `ARM_PROFILE_ATTEMPT_LOG_T0272.md`
attempts 25/53/61-66) -- exactly the kind of image T-0347's probe found
`force_border_background_to_fill`-style recolouring corrupts. The original
implementation forced every non-figure pixel (background *and* the label
artifact) to solid black before crop, the same mask-then-recolour operation
as that helper, just inlined rather than calling it by name. This version
never recolours a pixel: the crop keeps whatever the source panel's own
background and artifact pixels actually are, exactly like
`gen_hybrid_walk_T0259.crop_identity_reference`'s own T-0347 fix.
"""

from __future__ import annotations

import numpy as np
from derive_profile_style_reference_T0272 import extract_panel_reference
from PIL import Image

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


def test_figure_and_background_pixels_keep_their_original_colour() -> None:
    """T-0347: the crop is a plain crop, byte-preserving -- no pixel is
    forced to a fill colour, matching `crop_identity_reference`'s own fix."""
    figure_rect = (20, 10, 40, 50)
    panel = _panel(figure_rect)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=4)
    arr = np.array(out)

    # centre of the crop is well inside the figure -- must keep its colour
    cy, cx = arr.shape[0] // 2, arr.shape[1] // 2
    assert tuple(arr[cy, cx]) == FIGURE_RGB
    # a corner of the crop (the margin region) is background -- must keep the
    # panel's own background colour, not a forced fill
    assert tuple(arr[0, 0]) == BACKGROUND_RGB


def test_disconnected_label_artifact_is_preserved_not_recoloured() -> None:
    """A small disconnected blob (the panel's own text-label artifact) that
    falls inside the figure's bbox+margin is excluded from the bbox
    computation (only the largest connected component -- the figure --
    drives the crop bounds) but its own pixels, if they land inside the
    resulting crop, are never touched -- T-0347: no pixel in an IP-Adapter
    reference is ever forced to a fill colour."""
    figure_rect = (20, 10, 40, 50)
    label_blob = (18, 8, 24, 9)  # a thin sliver just above the figure, inside the margin
    panel = _panel(figure_rect, extra_blob=label_blob)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=4)
    arr = np.array(out)

    assert np.any(np.all(arr == (10, 10, 10), axis=-1)), (
        "the label artifact's own pixels must survive unmodified in the crop -- excluded from "
        "the bbox computation, never recoloured"
    )


def test_extract_panel_reference_never_forces_pixels_to_a_fill_colour() -> None:
    """Guard (T-0347): fails if a future caller reintroduces border-fill-
    style recolouring on this reference path -- e.g. re-adding a mask-then-
    paint step because a stray artifact resurfaces, without re-reading why
    `force_border_background_to_fill` must never touch a reference image.
    None of the synthetic panel's own colours (background, figure, label)
    is pure black, so any (0, 0, 0) pixel in the output can only be a
    forced fill, not source content."""
    figure_rect = (20, 10, 40, 50)
    label_blob = (18, 8, 24, 9)
    panel = _panel(figure_rect, extra_blob=label_blob)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=4)
    arr = np.array(out)

    assert not np.any(np.all(arr == (0, 0, 0), axis=-1)), (
        "extract_panel_reference must never force a pixel to a fill colour -- applying "
        "border-fill-style recolouring to an IP-Adapter reference image destroys generation "
        "coherence (T-0347); this function must only crop, never recolour"
    )


def test_margin_is_clamped_to_the_source_panel_bounds() -> None:
    """A figure sitting near the panel edge, with a margin wide enough to
    overshoot it, must not raise or wrap -- the margin clamps to the source
    panel's own extent instead."""
    figure_rect = (2, 2, 22, 22)
    panel = _panel(figure_rect)

    out = extract_panel_reference(panel, tolerance=TOLERANCE, margin=10)

    assert out.size[0] <= SIZE
    assert out.size[1] <= SIZE
