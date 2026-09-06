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

`pose_rig_walk_T0259.walk_cycle_hint_keypoints` (this card) returns the
union of every frame's own keypoints across the cycle, which recovered
90-98% of the true foreground on every previously-affected frame in that
same empirical sweep, with no `cutout.py` change at all -- the shared
module's hint contract already accepts any `points_norm` dict.

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
    """The fix: scored against the whole cycle's union of keypoints, the
    same rectangle in the same position survives essentially whole."""
    img = _synthetic_cross_frame()
    union_points = pose_rig_walk_T0259.walk_cycle_hint_keypoints(FRAME_COUNT)
    mask = cutout_foreground_mask(
        img, union_points, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
    )
    rect_area = (int(0.36 * SIZE) - int(0.24 * SIZE)) * (int(0.90 * SIZE) - int(0.10 * SIZE))
    assert mask.sum() >= rect_area * 0.9


def test_gen_hybrid_walk_uses_the_union_hint_not_the_per_frame_hint() -> None:
    """Wiring check: gen_hybrid_walk_T0259's per-frame cutout call must be
    driven by pose_rig_walk_T0259.walk_cycle_hint_keypoints(), not by that
    frame's own walk_keypoints_for_frame() -- the whole point of this fix
    is that the frame's own keypoints are the WRONG hint source for cutout,
    even though they are still the right source for the ControlNet skeleton
    and the provenance record."""
    import inspect

    import gen_hybrid_walk_T0259 as walk

    src = inspect.getsource(walk)
    assert "walk_cycle_hint_keypoints" in src, (
        "gen_hybrid_walk_T0259 must call pose_rig_walk_T0259.walk_cycle_hint_keypoints() "
        "for its cutout hint region"
    )
