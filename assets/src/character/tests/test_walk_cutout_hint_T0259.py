"""RED: gen_hybrid_walk_T0259's per-frame cutout hint is too narrow for a
gait cycle's own passing/cross frames.

`char_gen.cutout.extract_foreground_mask` keeps a candidate foreground
component only when a MAJORITY of that component's own area falls inside a
keypoints-derived hint bbox+margin. That is a sound prior for a static
pose, but `pose_rig_walk_T0259.walk_keypoints_for_frame`'s own
`CROSS_EXTENT_NORM` term pulls both legs toward the body's centre on the
passing frames (indices 2, 3, 6 of 8), which narrows THAT frame's own
keypoint bbox even though the rendered figure's actual silhouette (head,
shoulders, torso, the non-crossing leg's stance width) still occupies the
gait's normal full width. Measured against every real §24-e attempt
generated for this card (attempts 5-9, denoise 0.24-0.45, independent
seeds): the single largest real foreground component's overlap with frame
2's own hint sat at 8-46%, well under the 50% majority bar, so a
correctly-generated figure was being discarded as background on exactly
these three frames regardless of denoise or seed -- not a generation
defect, a hint-region defect.

`pose_rig_walk_T0259.walk_cutout_hint_keypoints(frame_index, frame_count)`
(this card) unions a frame's own keypoints with frame 0's -- the gait's own
genuine two-leg-wide contact/stance pose -- which recovered 90%+ of the
true foreground on every previously-affected frame in that same empirical
sweep, with no `cutout.py` change at all: the shared module's hint contract
already accepts any `points_norm` dict. A full 8-frame union was tried
first and rejected: it also widened frames that never needed it, and
measurably let real background clutter survive cutout on every frame
(background_fraction dropped to 57.5-62.9% sheet-wide, below the sheet's
own 65% cleanliness floor). Anchoring on frame 0 specifically -- rather
than the full cycle -- recovers the same foreground on cross frames while
leaving frame 0 (and every other already-wide-enough frame) unchanged.

This test proves the mechanism directly against `char_gen.cutout`'s real
functions, using a synthetic frame shaped like the real defect: a
foreground rectangle positioned at frame 2's own true silhouette extent
(x in [0.24, 0.36], well within the gait's normal stance width) but
OUTSIDE frame 2's own narrow keypoint bbox+margin ([0.387, 0.613] before
margin) -- exactly where the real generated frames put their torso/shoulder
content. It must survive when scored against the union hint and (to prove
the test is actually exercising the defect, not tautological) get dropped
when scored against frame 2's own per-frame hint.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import pose_rig_walk_T0259  # noqa: E402

from char_gen.cutout import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_OKLAB_TOLERANCE,
    cutout_foreground_mask,
)

SIZE = 384
FRAME_COUNT = pose_rig_walk_T0259.FRAME_COUNT
CROSS_FRAME = 2  # a passing frame -- see pose_rig_walk_T0259.walk_keypoints_for_frame


def _synthetic_cross_frame() -> Image.Image:
    """A white background with a black foreground rectangle placed at
    frame 2's real silhouette extent (x in [0.24, 0.36] of the frame,
    y spanning most of the body) -- inside the gait's normal stance width,
    outside frame 2's own narrow cross-frame keypoint bbox -- PLUS a tiny
    disconnected speck fully inside frame 2's own hint (a stand-in for the
    small, fully-contained fringing-noise flecks every real generated
    frame has -- see the module docstring's 291-component measurement).

    That speck matters for reproducing the actual defect: `extract_foreground_mask`
    only falls back to "keep every component with any overlap at all" when
    NO component in the whole frame clears the 50% majority bar. A real
    frame always has at least one such tiny, fully-enclosed speck, which
    trivially clears majority (100% of a small area) and starves that
    fallback -- so the big, real, merely-partially-overlapping silhouette
    component is dropped outright instead of partially credited. A test
    with only the big rectangle and no speck would exercise the *wrong*
    branch and pass for the wrong reason."""
    arr = np.full((SIZE, SIZE, 3), 255, dtype=np.uint8)
    x0, x1 = int(0.24 * SIZE), int(0.36 * SIZE)
    y0, y1 = int(0.10 * SIZE), int(0.90 * SIZE)
    arr[y0:y1, x0:x1] = (20, 20, 20)
    sx0, sx1 = int(0.49 * SIZE), int(0.51 * SIZE)
    sy0, sy1 = int(0.49 * SIZE), int(0.51 * SIZE)
    arr[sy0:sy1, sx0:sx1] = (10, 10, 10)
    return Image.fromarray(arr, mode="RGB")


def test_per_frame_hint_drops_the_real_silhouette_on_a_cross_frame() -> None:
    """Establishes the defect: scored against frame 2's OWN keypoints, the
    rectangle (frame 2's real silhouette location) fails the majority-
    overlap bar and is dropped almost entirely."""
    img = _synthetic_cross_frame()
    own_points = pose_rig_walk_T0259.walk_keypoints_for_frame(CROSS_FRAME, FRAME_COUNT)
    mask = cutout_foreground_mask(
        img, own_points, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
    )
    rect_area = (int(0.36 * SIZE) - int(0.24 * SIZE)) * (int(0.90 * SIZE) - int(0.10 * SIZE))
    assert mask.sum() < rect_area * 0.5, (
        "test does not reproduce the defect -- frame 2's own hint should drop most of "
        "this rectangle"
    )


def test_union_hint_recovers_the_real_silhouette_on_a_cross_frame() -> None:
    """The fix: scored against frame 2's own keypoints widened by frame 0's
    contact-pose stance, the same rectangle in the same position survives
    essentially whole."""
    img = _synthetic_cross_frame()
    hint_points = pose_rig_walk_T0259.walk_cutout_hint_keypoints(CROSS_FRAME, FRAME_COUNT)
    mask = cutout_foreground_mask(
        img, hint_points, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
    )
    rect_area = (int(0.36 * SIZE) - int(0.24 * SIZE)) * (int(0.90 * SIZE) - int(0.10 * SIZE))
    assert mask.sum() >= rect_area * 0.9


def test_gen_hybrid_walk_uses_the_widened_hint_not_the_bare_per_frame_hint() -> None:
    """Wiring check: gen_hybrid_walk_T0259's per-frame cutout call must be
    driven by pose_rig_walk_T0259.walk_cutout_hint_keypoints(), not by that
    frame's own bare walk_keypoints_for_frame() -- the whole point of this
    fix is that a cross frame's own keypoints are too narrow a hint for
    cutout, even though they are still the right source for the ControlNet
    skeleton and the provenance record."""
    import inspect

    import gen_hybrid_walk_T0259 as walk

    src = inspect.getsource(walk)
    assert "walk_cutout_hint_keypoints" in src, (
        "gen_hybrid_walk_T0259 must call pose_rig_walk_T0259.walk_cutout_hint_keypoints() "
        "for its cutout hint region"
    )


# ── background_region_delta (2026-09-08 session 6, ROUND PLAN item 2) ──────
#
# The card's own frame-delta gate (asset_gate.art.check_frame_consistency)
# measures the WHOLE cell -- it cannot say whether a large delta between two
# adjacent frames comes from real limb motion (inside the keypoints hint
# region) or from background/cutout-hold instability (outside it). Session
# 5's own real attempts show both failure modes on the same sheet (attempt 6
# cells 4/5 leak background at ~0.45-0.61 background_fraction; attempt 7
# cells 0/4 erase real limb content at ~0.83-0.84) -- a single whole-cell
# delta number cannot distinguish them. `background_region_delta` splits a
# cell-pair's raw changed-pixel count by whether each changed pixel falls
# inside or outside that frame's own keypoints-hint bbox+margin (the same
# bbox `char_gen.cutout._keypoints_hint_mask` scores foreground components
# against), so "how much of this delta is background noise vs. actual gait
# motion" becomes a directly reported number instead of a visual guess.

CELL = 48


def _cell(fill: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (CELL, CELL), fill)


def _paint(
    img: Image.Image, box: tuple[int, int, int, int], fill: tuple[int, int, int]
) -> Image.Image:
    out = img.copy()
    x0, y0, x1, y1 = box
    arr = np.array(out)
    arr[y0:y1, x0:x1] = fill
    return Image.fromarray(arr, mode="RGB")


# A hint bbox roughly centred on the cell, independent of any real pose --
# background_region_delta only needs points_norm's own min/max extent, not a
# gait-shaped skeleton.
_CENTRE_HINT = {0: (0.35, 0.35), 1: (0.65, 0.65)}


def test_change_inside_the_hint_region_does_not_count_as_background_delta() -> None:
    """A change confined to the hint bbox (simulated real limb motion) must
    report zero background-region delta, even though the whole-cell delta is
    large."""
    from gen_hybrid_walk_T0259 import background_region_delta

    a = _cell((10, 10, 10))
    # (0.35*48, 0.35*48) .. (0.65*48, 0.65*48) with 0 margin is inside the
    # hint's own bbox -- paint well within it.
    b = _paint(a, (18, 18, 30, 30), (200, 200, 200))
    result = background_region_delta(a, b, _CENTRE_HINT, bbox_margin_frac=0.0)
    assert result["background_region_changed_px"] == 0
    assert result["background_region_delta_ratio"] == 0.0
    assert result["hint_region_changed_px"] > 0


def test_change_outside_the_hint_region_is_reported_as_background_delta() -> None:
    """A change confined to a corner well outside the hint bbox (simulated
    background/cutout-hold leak) must report zero hint-region delta and a
    non-zero background-region delta."""
    from gen_hybrid_walk_T0259 import background_region_delta

    a = _cell((10, 10, 10))
    b = _paint(a, (0, 0, 6, 6), (200, 200, 200))
    result = background_region_delta(a, b, _CENTRE_HINT, bbox_margin_frac=0.0)
    assert result["hint_region_changed_px"] == 0
    assert result["background_region_changed_px"] == 36
    assert result["background_region_delta_ratio"] > 0.0
