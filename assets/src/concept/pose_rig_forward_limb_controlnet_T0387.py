#!/usr/bin/env python3
"""T-0387 forward-limb skeleton -- larger near-leg raise, separated eyes.

T-0382 re-ran T-0380 attempt 2's recipe (seed 380002, denoise 0.87,
ControlNet strength/end 1.5/1.0) against the corrected (far-arm-collapsed)
`pose_rig_forward_limb_controlnet_T0380` skeleton and spent its own 3-attempt
cap without a compliant image (`docs/assets/evidence/T-0382/README.md`).
Denoise 0.87 (attempt 1) was where the arm defect stayed fixed and the pose
extension actually happened, but the goggle lens was not visible and the
legs read flat; denoise 0.80 (attempt 3) bought back the lens/background at
the cost of the arm and leg extension disappearing entirely. This card holds
0.87 and fixes the remaining two defects at the skeleton and prompt, not by
trading denoise again.

One concrete measurement from that evidence pins what to change here,
already present in T-0382's own committed skeleton JSON
(`player_profile_forward_limb_skeleton_T0380.json`): the two eye joints sit
only ~0.02 of the frame width apart on x -- almost coincident. Attempt 1
(denoise 0.87) rendered a back/three-quarter view with no visible lens at
all; attempt 3 (denoise 0.80) rendered a strap-like band across the face
instead of a legible round lens. A near-coincident eye pair gives the
ControlNet conditioning no strong asymmetric signal to anchor a strict
profile head with one clearly forward, one clearly hidden eye.

This module's own attempt 1/2 (this card's first two of its three
pre-registered attempts) also tried a much larger near-knee/ankle excursion
to fix the raised-leg defect, run together with the eye change above. Both
attempts broke the single-arm result T-0382 attempt 1 already had at this
exact seed/denoise/prompt baseline: attempt 1 (heavier prompt rewrite, both
skeleton overrides) collapsed composition outright (figure zoomed past the
frame); attempt 2 (reverted to near-original prompt, same two skeleton
overrides) restored composition but brought back a second, unrequested
hand at the hip -- the exact defect the far-arm collapse was meant to
prevent -- with the leg still not reading as a clean raise either. Since
the eye change is small and localized to the head while the knee/ankle
change is a large excursion into the torso/hip region (physically where
the phantom hand appeared), the knee/ankle override is the more likely
cause of that regression. This card's third and final attempt isolates the
one change least implicated in that regression: only the eye separation,
with the near knee/ankle reverted verbatim to T-0380/T-0382's own rig,
restoring the exact skeleton context attempt 1's single-arm result was
measured under.

This module keeps every joint from `pose_rig_forward_limb_controlnet_T0380`
(which already collapses the far arm -- T-0382's own fix, still needed and
left untouched) verbatim except one override: the near eye pulled toward
the nose (the forward-most facial point) and the far eye pulled back toward
the far ear (reading as hidden behind the head in a true profile), roughly
quadrupling the pair's on-canvas x separation. The near-leg raise's small
on-canvas amplitude remains an open, unresolved defect this card's
evidence reports rather than works around by spending a fourth attempt.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CONCEPT_DIR = Path(__file__).resolve().parent
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

_CHARACTER_DIR = Path(__file__).resolve().parents[1] / "character"
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import pose_rig_forward_limb_controlnet_T0380 as _t0382  # noqa: E402
from gen_arm_a_idle_T0228 import draw_pose_skeleton_cell  # noqa: E402

Point = tuple[float, float]

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

POSE_KEY = _t0382.POSE_KEY

# Eyes: near eye pulled to the nose's x, far eye pulled to the far ear's x
# (was (0.565, 0.078) / (0.545, 0.078) -- ~0.02 apart). The near knee/ankle
# are deliberately NOT overridden here -- see module docstring: attempt 1/2
# tried a bigger knee/ankle excursion and both regressed the single-arm
# result, so this card's third and final attempt isolates the eye change
# alone, reverting the leg joints verbatim to T-0380/T-0382's own rig.
_R_EYE_OVERRIDE: Point = (0.573, 0.084)
_L_EYE_OVERRIDE: Point = (0.498, 0.086)


def _apply_overrides(points: dict[int, Point]) -> dict[int, Point]:
    points = dict(points)
    points[_R_EYE] = _R_EYE_OVERRIDE
    points[_L_EYE] = _L_EYE_OVERRIDE
    return points


# Reused verbatim from T-0380/T-0382's far-arm-collapsed rig except both
# eyes -- see module docstring.
FORWARD_LIMB_KEYPOINTS_NORM: dict[int, Point] = _apply_overrides(
    _t0382.FORWARD_LIMB_KEYPOINTS_NORM
)


def keypoints() -> dict[int, Point]:
    """A fresh copy of this card's keypoints -- same convention as
    `pose_rig_forward_limb_controlnet_T0380.keypoints`."""
    return dict(FORWARD_LIMB_KEYPOINTS_NORM)


def thigh_angle_degrees_from_horizontal(points: dict[int, Point] | None = None) -> float:
    """Angle of the near (right) hip->knee segment from horizontal, in
    degrees -- same measurement as T-0380/T-0382's own."""
    import math

    pts = points if points is not None else FORWARD_LIMB_KEYPOINTS_NORM
    hip_x, hip_y = pts[_R_HIP]
    knee_x, knee_y = pts[_R_KNEE]
    dx = knee_x - hip_x
    dy = knee_y - hip_y
    return math.degrees(math.atan2(abs(dy), abs(dx)))


def render_skeleton(size: int):
    """Draws this module's own (leg-amplified, eye-separated) `keypoints()`
    via the shared OpenPose renderer -- must not delegate to T-0380/T-0382's
    or T-0351's own convenience wrappers, which would silently discard these
    overrides (see module docstring)."""
    return draw_pose_skeleton_cell(size, points_norm=keypoints())


def keypoints_to_coco_list(points: dict[int, Point] | None = None) -> list[dict]:
    pts = points if points is not None else FORWARD_LIMB_KEYPOINTS_NORM
    return _t0382.keypoints_to_coco_list(pts)
