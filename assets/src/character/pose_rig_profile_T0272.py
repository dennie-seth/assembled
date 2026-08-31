#!/usr/bin/env python3
"""Side-profile base-pose keyframe pose-rig (T-0272).

**Why this exists.** T-0259 ran an honest single-frame feasibility probe
(seed 99001, ~100 GPU-s, gitignored scratch): it kept the standing-idle
skeleton (`gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM`) unchanged and only
asked the text prompt for a side-profile camera angle. Result, in the
attempt log's own words: the model "ignored the profile framing entirely and
rendered a front-facing figure ... ControlNet's structural conditioning
dominates the text prompt's camera-angle request, so a prompt-only attempt to
reframe the SAME skeleton into profile cannot work by construction, not just
by bad luck on this seed." `_POSE_KEYPOINTS_NORM` encodes front-facing
anatomical topology -- shoulders side-by-side, both hips/knees/ankles
visible, arms symmetric about the spine -- and no amount of reframing that
skeleton's own pixels changes what topology it *is*.

This module is the missing profile-topology rig T-0259's report calls for: a
new keypoint layout, authored from scratch, not a mirrored, sheared, or
otherwise distorted copy of `_POSE_KEYPOINTS_NORM` (that would be exactly the
synthetic stand-in @DennieSeth's standing rule forbids). Facing right
(`FACING`), it encodes four structural differences from the front rig, each
one directly checkable (see `tests/test_pose_rig_profile_T0272.py`):

  - **legs collapsed onto a single fore-aft line**, not spread side-by-side:
    the front rig's bilateral left/right leg split is a mediolateral gap that
    is simply not visible from the side. Both hips/knees sit close to one
    shared vertical line; the near (front) leg's ankle sits forward of that
    line and the far (back) leg's ankle sits behind it, the ordinary stagger
    of a weight-bearing standing profile stance, not a left/right spread.
  - **shoulders in line with the view axis**: shoulder WIDTH is a depth
    dimension in profile, not an x-gap, so the near and far shoulder are
    nearly coincident, unlike the front rig where they are the single widest
    bilateral spread in the whole skeleton.
  - **one arm forward, one arm back, the far arm partially occluded**: the
    near arm reaches clearly forward of its own shoulder; the far arm stays
    close to the torso silhouette (a much smaller offset, standing in for
    the real occlusion a profile view of a two-armed figure produces) --
    deliberately NOT a mirrored +/-x pair, which is what the front rig's
    arms-at-sides pose would look like if merely relabelled.
  - **head turned sideways**: the nose sits well off the neck's own x
    position, turned toward the facing direction; the far eye and far ear
    collapse toward their near counterparts instead of sitting at the front
    rig's fixed bilateral spread (both eyes/ears visible at once is a
    front-on artifact, not a profile one).

This card delivers ONE still keyframe, not a cycle -- there is no
frame_index/frame_count parameterisation the way `pose_rig_walk_T0259.py`
has for the walk gait; `pose_rig_walk_T0259.py` (T-0259's own note: "this
module is that missing base-pose-level walk authoring ... [and] will consume
[a profile rig] for the side-facing walk") is expected to import this
module's `PROFILE_POSE_KEYPOINTS_NORM` as its own base pose once a
side-facing gait is authored, exactly as it already imports
`_POSE_KEYPOINTS_NORM` from the front rig today.

`render_pose_frame` reuses `gen_arm_a_idle_T0228.draw_pose_skeleton_cell`
directly, unchanged -- the existing primitive the card names, not a
re-authored renderer.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parent
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

from gen_arm_a_idle_T0228 import draw_pose_skeleton_cell  # noqa: E402

Point = tuple[float, float]

#: The one canonical facing this rig authors -- recorded so downstream
#: animation (a side-facing walk, T-0259) mirrors this rig deliberately
#: rather than guessing which way "profile" meant.
FACING = "right"

# Standard 18-keypoint COCO/OpenPose body layout, normalised to a unit
# square (0,0)=top-left -- same numbering gen_arm_a_idle_T0228's front rig
# uses, so every downstream consumer (draw_pose_skeleton_cell, the limb
# colour table, keypoints_to_coco_list) works unchanged. Authored from
# scratch for a right-facing side profile -- see this module's own
# docstring for what each structural choice encodes and why.
PROFILE_POSE_KEYPOINTS_NORM: dict[int, Point] = {
    0: (0.575, 0.100),  # nose -- turned toward the facing direction
    1: (0.500, 0.210),  # neck
    2: (0.505, 0.225),  # near (front) shoulder
    3: (0.545, 0.350),  # near elbow -- forward-reaching arm
    4: (0.610, 0.480),  # near wrist -- forward-reaching arm
    5: (0.495, 0.230),  # far (back) shoulder -- nearly coincident with the near shoulder
    6: (0.480, 0.400),  # far elbow -- back arm, tucked against the torso (occluded)
    7: (0.470, 0.520),  # far wrist -- back arm, tucked against the torso (occluded)
    8: (0.510, 0.570),  # near hip -- front leg
    9: (0.520, 0.750),  # near knee -- front leg
    10: (0.545, 0.930),  # near ankle -- front leg, forward of the hip line
    11: (0.495, 0.572),  # far hip -- back leg, nearly coincident with the near hip
    12: (0.485, 0.750),  # far knee -- back leg
    13: (0.460, 0.930),  # far ankle -- back leg, behind the hip line
    14: (0.565, 0.078),  # near eye -- visible
    15: (0.545, 0.078),  # far eye -- collapsed toward the near eye (occluded by the head)
    16: (0.500, 0.100),  # near ear -- visible
    17: (0.495, 0.100),  # far ear -- collapsed toward the near ear (occluded)
}


def profile_keypoints() -> dict[int, Point]:
    """Return a fresh copy of the static profile base-pose keypoints.

    Unlike `pose_rig_walk_T0259.walk_keypoints_for_frame`, this card delivers
    ONE still keyframe -- there is no frame_index/frame_count parameter
    because there is no animation. A function (not a bare module dict) is
    exposed anyway so a caller can't corrupt the committed rig by mutating
    what it was handed, and so this module's shape matches every other
    pose-rig module's own accessor convention.
    """
    return dict(PROFILE_POSE_KEYPOINTS_NORM)


def render_pose_frame(points: dict[int, Point], size: int):
    """Reuses gen_arm_a_idle_T0228.draw_pose_skeleton_cell directly -- same
    limb topology/colours, same joint-radius/line-width scaling, same pure
    black background -- parametrised on the profile keypoints instead of the
    front-facing static base pose."""
    return draw_pose_skeleton_cell(size, points_norm=points)


def keypoints_to_coco_list(points: dict[int, Point]) -> list[dict]:
    """Serialise the keyframe's keypoints in ascending joint order -- what
    gets written to the committed keypoints JSON alongside the rendered
    skeleton, so the rig is checkable, not merely asserted."""
    return [{"joint": i, "x": points[i][0], "y": points[i][1]} for i in sorted(points)]
