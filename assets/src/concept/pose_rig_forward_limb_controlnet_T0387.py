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

Two concrete measurements from that evidence pin what to change here, both
already present in T-0382's own committed skeleton JSON
(`player_profile_forward_limb_skeleton_T0380.json`):

  - The near (right) knee sits only ~0.11 of the frame width forward of the
    hip and ~0.01 of the frame height higher -- `thigh_angle_degrees_from_horizontal`
    already clears the inherited <20-degree ceiling on paper, but the
    on-canvas excursion is tiny next to a floor-length coat and a
    dominant, full-length far (standing) leg. Attempt 1 at this card's own
    denoise (0.87) rendered "legs flat"; attempt 3 at 0.80 rendered "both
    feet together at rest, no lifted hem" -- neither denoise let that small
    a joint displacement survive sampling as a visible break in the coat.
  - The two eye joints sit only ~0.02 of the frame width apart on x --
    almost coincident. Attempt 1 (denoise 0.87) rendered a back/three-quarter
    view with no visible lens at all; attempt 3 (denoise 0.80) rendered a
    strap-like band across the face instead of a legible round lens. A
    near-coincident eye pair gives the ControlNet conditioning no strong
    asymmetric signal to anchor a strict profile head with one clearly
    forward, one clearly hidden eye.

This module keeps every joint from `pose_rig_forward_limb_controlnet_T0380`
(which already collapses the far arm -- T-0382's own fix, still needed and
left untouched) verbatim except these two overrides:

  - the near knee/ankle pushed further forward and the knee lifted higher,
    while keeping the thigh angle under the inherited 20-degree ceiling
  - the near eye pulled toward the nose (the forward-most facial point) and
    the far eye pulled back toward the far ear (reading as hidden behind
    the head in a true profile), roughly quadrupling the pair's on-canvas
    x separation
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

# Near knee/ankle: bigger forward reach and a real upward lift (was
# (0.62, 0.56) / (0.7, 0.62) in T-0380/T-0382's rig -- hip (0.51, 0.57) to
# knee here gives dx=0.16, dy=-0.043, thigh angle ~15.0 degrees, comfortably
# under the 20-degree ceiling with margin, versus the prior ~5.2 degrees on
# a much smaller excursion).
_R_KNEE_OVERRIDE: Point = (0.67, 0.527)
_R_ANKLE_OVERRIDE: Point = (0.71, 0.68)

# Eyes: near eye pulled to the nose's x, far eye pulled to the far ear's x
# (was (0.565, 0.078) / (0.545, 0.078) -- ~0.02 apart).
_R_EYE_OVERRIDE: Point = (0.573, 0.084)
_L_EYE_OVERRIDE: Point = (0.498, 0.086)


def _apply_overrides(points: dict[int, Point]) -> dict[int, Point]:
    points = dict(points)
    points[_R_KNEE] = _R_KNEE_OVERRIDE
    points[_R_ANKLE] = _R_ANKLE_OVERRIDE
    points[_R_EYE] = _R_EYE_OVERRIDE
    points[_L_EYE] = _L_EYE_OVERRIDE
    return points


# Reused verbatim from T-0380/T-0382's far-arm-collapsed rig except the near
# knee/ankle and both eyes -- see module docstring.
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
