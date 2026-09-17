#!/usr/bin/env python3
"""Forward-limb ControlNet/OpenPose skeleton for T-0380.

T-0355's stop-and-report (`ARM_FORWARD_LIMB_REFERENCE_ATTEMPT_LOG_T0355.md`,
`docs/assets/evidence/T-0355/README.md`) falsified the prompt-only route: even
the one attempt (4) that got coat/identity right rendered the upper body
twisted to three-quarter (both eye lenses and the far fist visible) once the
pose clause had to compete with the identity clause for the same attention
budget. @DennieSeth's follow-up direction is explicit: pose must come from a
skeleton, not the prompt.

This module authors that skeleton from a **committed** pose-rig joint set --
`pose_rig_master_sheet_T0351.SIDE_RIGHT_FORWARD_KEYPOINTS_NORM` -- rather than
hand-typing new numbers. That rig is already a genuine profile topology (both
shoulders/both hips collapsed onto one line) with the near/right arm and leg
extended forward and the near thigh (`_R_HIP` -> `_R_KNEE`) already close to
horizontal -- exactly "front leg raised ~90 degrees at the hip, not a lunge"
-- and it already faces right (nose x > neck x, forward reach on the
positive-x/right side), the same direction as the T-0317 base image this card
composites onto the img2img canvas. Reusing it verbatim, rather than
re-authoring a new topology, is this card's whole point: the skeleton is
"authored from committed pose-rig joints," not invented fresh.

`render_skeleton` reuses `pose_rig_master_sheet_T0351.render_pose_skeleton`
directly (itself a thin wrapper over `gen_arm_a_idle_T0228.
draw_pose_skeleton_cell`) -- the same OpenPose-format renderer this pipeline
has used for every ControlNet-conditioned card so far.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1] / "character"
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import pose_rig_master_sheet_T0351 as _T0351  # noqa: E402

Point = tuple[float, float]

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

POSE_KEY = "side_right_forward"

# Reused verbatim from the committed T-0351 rig -- see module docstring for
# why this card authors no new keypoint numbers of its own.
FORWARD_LIMB_KEYPOINTS_NORM: dict[int, Point] = _T0351.keypoints_for(POSE_KEY)


def keypoints() -> dict[int, Point]:
    """A fresh copy of this card's keypoints -- a function, not a bare dict
    lookup, so a caller can't corrupt the committed rig by mutating what it
    was handed (same convention as `pose_rig_master_sheet_T0351.keypoints_for`)."""
    return dict(FORWARD_LIMB_KEYPOINTS_NORM)


def thigh_angle_degrees_from_horizontal(points: dict[int, Point] | None = None) -> float:
    """Angle of the near (right) hip->knee segment from horizontal, in
    degrees. The acceptance check is "front leg raised ~90 degrees at the
    hip" measured as the *thigh* sitting near horizontal (hip flexed to
    roughly a right angle relative to the standing torso) -- this is what
    that measurement computes."""
    pts = points if points is not None else FORWARD_LIMB_KEYPOINTS_NORM
    hip_x, hip_y = pts[_R_HIP]
    knee_x, knee_y = pts[_R_KNEE]
    dx = knee_x - hip_x
    dy = knee_y - hip_y
    return math.degrees(math.atan2(abs(dy), abs(dx)))


def render_skeleton(size: int):
    """Reuses `pose_rig_master_sheet_T0351.render_pose_skeleton` directly --
    same limb topology/colours, same joint-radius/line-width scaling, same
    pure black background."""
    return _T0351.render_pose_skeleton(POSE_KEY, size)


def keypoints_to_coco_list(points: dict[int, Point] | None = None) -> list[dict]:
    pts = points if points is not None else FORWARD_LIMB_KEYPOINTS_NORM
    return _T0351.keypoints_to_coco_list(pts)
