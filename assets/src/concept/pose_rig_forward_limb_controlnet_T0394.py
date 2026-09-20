#!/usr/bin/env python3
"""T-0394 forward-limb skeleton -- resting near leg, no hip-flex excursion.

@DennieSeth, after T-0387's stop-and-report: "Design change: no raised
leg... The reference this card produces needs a resting, flat single leg in
profile -- nothing more." T-0380/T-0382/T-0387 all inherited a raised-leg
override (near thigh close to horizontal, hip flexed ~90 degrees) from
`pose_rig_master_sheet_T0351.SIDE_RIGHT_FORWARD_KEYPOINTS_NORM`, and that
excursion is exactly what T-0387's own evidence shows colliding with the
single-arm result: the one attempt that enlarged it broke composition
outright, and the smaller inherited excursion never rendered as a visible
raise across 6 attempts spanning T-0382 and T-0387 either. Per this card's
own "Reuse, do not rebuild" and "Do not reintroduce a raised leg or any
hip-flex excursion", the fix here is not a new knee/ankle number -- it is
`pose_rig_master_sheet_T0351`'s own already-committed `SIDE_NEUTRAL_KEYPOINTS_NORM`
near-leg joints: "true profile, arms down, legs together" -- the same
resting-stance family the T-0317 base image itself already shows.

This module keeps every joint from `pose_rig_forward_limb_controlnet_T0380`
(far arm already collapsed -- T-0382's own fix, still needed and left
untouched; near arm still extended forward -- the qualifying pose for the
single-arm result) verbatim except one override: the near knee and ankle,
replaced with `SIDE_NEUTRAL_KEYPOINTS_NORM`'s own values. The near hip stays
unchanged (T-0380's `SIDE_RIGHT_FORWARD` hip and T-0351's `SIDE_NEUTRAL` hip
are already the same point, (0.510, 0.570) -- the two rigs share a pivot,
only the leg below it differs), so this override is a pure downstream
truncation of the raise, not a re-anchoring of the whole leg.
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

import pose_rig_forward_limb_controlnet_T0380 as _t0380  # noqa: E402
import pose_rig_master_sheet_T0351 as _t0351  # noqa: E402
from gen_arm_a_idle_T0228 import draw_pose_skeleton_cell  # noqa: E402

Point = tuple[float, float]

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

POSE_KEY = _t0380.POSE_KEY

# Resting-leg override: T-0351's own committed SIDE_NEUTRAL near knee/ankle,
# reused verbatim -- no hand-typed numbers. Was (0.620, 0.560) / (0.700,
# 0.620) (raised, thigh ~5 degrees from horizontal); becomes (0.512, 0.750)
# / (0.515, 0.930) (resting, thigh ~89 degrees from horizontal -- close to
# vertical, matching the T-0317 base's own standing leg).
_R_KNEE_RESTING: Point = _t0351.SIDE_NEUTRAL_KEYPOINTS_NORM[_R_KNEE]
_R_ANKLE_RESTING: Point = _t0351.SIDE_NEUTRAL_KEYPOINTS_NORM[_R_ANKLE]


def _apply_resting_near_leg(points: dict[int, Point]) -> dict[int, Point]:
    points = dict(points)
    points[_R_KNEE] = _R_KNEE_RESTING
    points[_R_ANKLE] = _R_ANKLE_RESTING
    return points


# Reused verbatim from T-0380/T-0382's far-arm-collapsed rig except the near
# knee/ankle -- see module docstring.
FORWARD_LIMB_KEYPOINTS_NORM: dict[int, Point] = _apply_resting_near_leg(
    _t0380.FORWARD_LIMB_KEYPOINTS_NORM
)


def keypoints() -> dict[int, Point]:
    """A fresh copy of this card's keypoints -- same convention as
    `pose_rig_forward_limb_controlnet_T0380.keypoints`."""
    return dict(FORWARD_LIMB_KEYPOINTS_NORM)


def thigh_angle_degrees_from_horizontal(points: dict[int, Point] | None = None) -> float:
    """Angle of the near (right) hip->knee segment from horizontal, in
    degrees -- same measurement as T-0380/T-0382/T-0387's own. A resting
    leg reads close to 90 (vertical); a raised leg reads close to 0
    (horizontal)."""
    import math

    pts = points if points is not None else FORWARD_LIMB_KEYPOINTS_NORM
    hip_x, hip_y = pts[_R_HIP]
    knee_x, knee_y = pts[_R_KNEE]
    dx = knee_x - hip_x
    dy = knee_y - hip_y
    return math.degrees(math.atan2(abs(dy), abs(dx)))


def render_skeleton(size: int):
    """Draws this module's own (resting-leg) `keypoints()` via the shared
    OpenPose renderer -- must not delegate to T-0380/T-0382/T-0387's or
    T-0351's own convenience wrappers, which would silently discard this
    override (see module docstring)."""
    return draw_pose_skeleton_cell(size, points_norm=keypoints())


def keypoints_to_coco_list(points: dict[int, Point] | None = None) -> list[dict]:
    pts = points if points is not None else FORWARD_LIMB_KEYPOINTS_NORM
    return _t0380.keypoints_to_coco_list(pts)
