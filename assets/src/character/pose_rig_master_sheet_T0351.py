#!/usr/bin/env python3
"""Five-pose ControlNet/OpenPose skeleton rig for the Tier-1 master sheet
(T-0351, successor to #365/T-0336).

Seven prompt-only attempts (`ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md`,
`docs/assets/evidence/T-0351/README.md`) never achieved pose compliance --
not even once, across two fundamentally different generation strategies.
@DennieSeth's 2026-09-10 amendment permits ControlNet/OpenPose for pose
conditioning only ("pose follows the reference/skeleton, not the prompt"),
scoped narrowly: it must not restyle, re-identify, or otherwise alter the
figure, and style/identity LoRA and IP-Adapter weights stay exactly as
#365 set them.

This module is the authored skeleton, one 18-keypoint COCO/OpenPose layout
per `gen_master_sheet_T0336.POSE_SPECS` entry, built the same way
`pose_rig_profile_T0272.py` was: a genuinely different topology per pose,
never a mirrored/sheared/distorted copy of the front-facing idle rig
(`gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM`) standing in for a pose it
cannot represent -- that is exactly the synthetic-stand-in shortcut
@DennieSeth's standing rule forbids, and it is also mechanically what
T-0259's own probe proved does not work (a profile-camera prompt over an
unchanged front-facing skeleton renders the front topology regardless of
what the text asks for; ControlNet's structural conditioning dominates the
prompt).

Per-pose construction:

  - **front_tpose / back_tpose** -- both arms raised from the idle rig's
    arms-at-sides pose to horizontal (wrist y within a few percent of
    shoulder y), reaching well past the idle rig's own elbow/wrist x
    offsets so the arms sit clear of the torso; legs spread further than
    idle stance. Front and back are bilaterally symmetric by construction,
    so `back_tpose` is `mirror_keypoints_lr(front_tpose)` -- for a
    perfectly symmetric T-pose this lands on the same pixel positions as
    the front rig (mirroring a mirror-symmetric shape is a no-op on
    position, only swapping which colour-coded limb is labelled which
    anatomical side), which is the expected, correct result: what
    distinguishes "front view" from "back view" here is the *prompt text*,
    not the skeleton -- there is no camera-facing signal a flat 2D joint
    layout can encode that text can't fight over cleanly (unlike the
    front-vs-profile case, front and back T-pose are not different
    topologies).
  - **side_right_forward** -- a genuine profile topology (shoulders/hips
    collapsed onto the view axis, same principle as `pose_rig_profile_T0272`),
    with the near/right arm and leg extended clearly forward (~90 degrees
    from the hanging-down baseline: horizontal arm, thigh raised toward
    horizontal) and the far/left arm and leg held back close to the body.
  - **side_left_forward** -- `mirror_keypoints_lr(side_right_forward)`: the
    anatomically correct opposite-side pose, not an independently
    hand-typed set of numbers that could silently drift from its sibling.
  - **side_neutral** -- also a genuine profile topology, but arms hang
    straight down (wrist below elbow below shoulder, no forward reach) and
    both legs sit together on the fore-aft line (no forward/back stagger)
    -- the standing keyframe anchor, distinct from panels 3/4's walking
    stance.

`render_pose_skeleton` reuses `gen_arm_a_idle_T0228.draw_pose_skeleton_cell`
directly, unchanged -- the existing OpenPose-format renderer this pipeline
has used for every prior ControlNet-conditioned card (T-0228, T-0249,
T-0259, T-0272, T-0250, T-0252), not a re-authored one.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parent
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

from gen_arm_a_idle_T0228 import draw_pose_skeleton_cell  # noqa: E402

Point = tuple[float, float]

# Standard 18-keypoint COCO/OpenPose body layout -- same numbering every
# other pose-rig module in this pipeline uses.
_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

# (right_index, left_index) pairs -- everything else (nose, neck) is
# unpaired and keeps its own index under a mirror.
_LR_PAIRS: tuple[tuple[int, int], ...] = (
    (_R_SHOULDER, _L_SHOULDER),
    (_R_ELBOW, _L_ELBOW),
    (_R_WRIST, _L_WRIST),
    (_R_HIP, _L_HIP),
    (_R_KNEE, _L_KNEE),
    (_R_ANKLE, _L_ANKLE),
    (_R_EYE, _L_EYE),
    (_R_EAR, _L_EAR),
)


def mirror_keypoints_lr(points: dict[int, Point]) -> dict[int, Point]:
    """Flip a keypoint set left-right: x -> 1-x, and swap each joint's
    anatomical left/right label so the result is a genuinely correct
    opposite-side (or opposite-facing) rig, not merely a horizontally
    flipped image with the wrong limb still labelled "right". Nose/neck
    have no left/right counterpart, so only their x flips."""
    swap_map: dict[int, int] = {}
    for right_idx, left_idx in _LR_PAIRS:
        swap_map[right_idx] = left_idx
        swap_map[left_idx] = right_idx
    mirrored: dict[int, Point] = {}
    for i, (x, y) in points.items():
        target = swap_map.get(i, i)
        mirrored[target] = (1.0 - x, y)
    return mirrored


# ── Panel 1/2: front/back T-pose -- arms horizontal, legs spread. ──────────
FRONT_TPOSE_KEYPOINTS_NORM: dict[int, Point] = {
    _NOSE: (0.500, 0.095),
    _NECK: (0.500, 0.210),
    _R_SHOULDER: (0.417, 0.225),
    _R_ELBOW: (0.230, 0.225),
    _R_WRIST: (0.070, 0.225),
    _L_SHOULDER: (0.583, 0.225),
    _L_ELBOW: (0.770, 0.225),
    _L_WRIST: (0.930, 0.225),
    _R_HIP: (0.446, 0.570),
    _R_KNEE: (0.400, 0.750),
    _R_ANKLE: (0.320, 0.930),
    _L_HIP: (0.554, 0.570),
    _L_KNEE: (0.600, 0.750),
    _L_ANKLE: (0.680, 0.930),
    _R_EYE: (0.476, 0.075),
    _L_EYE: (0.524, 0.075),
    _R_EAR: (0.452, 0.090),
    _L_EAR: (0.548, 0.090),
}
BACK_TPOSE_KEYPOINTS_NORM: dict[int, Point] = mirror_keypoints_lr(FRONT_TPOSE_KEYPOINTS_NORM)

# ── Panel 4: side, right-forward -- true profile, right arm+leg forward. ──
SIDE_RIGHT_FORWARD_KEYPOINTS_NORM: dict[int, Point] = {
    _NOSE: (0.575, 0.100),
    _NECK: (0.500, 0.210),
    _R_SHOULDER: (0.505, 0.225),
    _R_ELBOW: (0.620, 0.225),
    _R_WRIST: (0.750, 0.225),
    _L_SHOULDER: (0.495, 0.230),
    _L_ELBOW: (0.470, 0.380),
    _L_WRIST: (0.460, 0.500),
    _R_HIP: (0.510, 0.570),
    _R_KNEE: (0.620, 0.560),
    _R_ANKLE: (0.700, 0.620),
    _L_HIP: (0.495, 0.572),
    _L_KNEE: (0.460, 0.740),
    _L_ANKLE: (0.430, 0.900),
    _R_EYE: (0.565, 0.078),
    _L_EYE: (0.545, 0.078),
    _R_EAR: (0.500, 0.100),
    _L_EAR: (0.495, 0.100),
}
# ── Panel 3: side, left-forward -- anatomically correct mirror of panel 4. ─
SIDE_LEFT_FORWARD_KEYPOINTS_NORM: dict[int, Point] = mirror_keypoints_lr(
    SIDE_RIGHT_FORWARD_KEYPOINTS_NORM
)

# ── Panel 5: side, neutral -- true profile, arms down, legs together. ─────
SIDE_NEUTRAL_KEYPOINTS_NORM: dict[int, Point] = {
    _NOSE: (0.560, 0.100),
    _NECK: (0.500, 0.210),
    _R_SHOULDER: (0.505, 0.225),
    _R_ELBOW: (0.520, 0.400),
    _R_WRIST: (0.530, 0.560),
    _L_SHOULDER: (0.495, 0.230),
    _L_ELBOW: (0.485, 0.400),
    _L_WRIST: (0.478, 0.560),
    _R_HIP: (0.510, 0.570),
    _R_KNEE: (0.512, 0.750),
    _R_ANKLE: (0.515, 0.930),
    _L_HIP: (0.495, 0.572),
    _L_KNEE: (0.492, 0.750),
    _L_ANKLE: (0.490, 0.930),
    _R_EYE: (0.565, 0.078),
    _L_EYE: (0.545, 0.078),
    _R_EAR: (0.500, 0.100),
    _L_EAR: (0.495, 0.100),
}

# Keyed identically to gen_master_sheet_T0336.POSE_SPECS -- the CLI/attempt
# driver looks up this module by pose.key, never by import-order position.
POSE_KEYPOINTS_BY_KEY: dict[str, dict[int, Point]] = {
    "front_tpose": FRONT_TPOSE_KEYPOINTS_NORM,
    "back_tpose": BACK_TPOSE_KEYPOINTS_NORM,
    "side_left_forward": SIDE_LEFT_FORWARD_KEYPOINTS_NORM,
    "side_right_forward": SIDE_RIGHT_FORWARD_KEYPOINTS_NORM,
    "side_neutral": SIDE_NEUTRAL_KEYPOINTS_NORM,
}


def keypoints_for(pose_key: str) -> dict[int, Point]:
    """Return a fresh copy of one pose's keypoints -- a function, not a bare
    dict lookup, so a caller can't corrupt the committed rig by mutating
    what it was handed (same convention as `pose_rig_profile_T0272.
    profile_keypoints`)."""
    return dict(POSE_KEYPOINTS_BY_KEY[pose_key])


def render_pose_skeleton(pose_key: str, size: int):
    """Reuses gen_arm_a_idle_T0228.draw_pose_skeleton_cell directly -- same
    limb topology/colours, same joint-radius/line-width scaling, same pure
    black background -- parametrised on this pose's keypoints."""
    return draw_pose_skeleton_cell(size, points_norm=keypoints_for(pose_key))


def keypoints_to_coco_list(points: dict[int, Point]) -> list[dict]:
    """Serialise a pose's keypoints in ascending joint order -- what gets
    written to the per-pose keypoints JSON committed alongside each
    rendered skeleton, so the rig is checkable, not merely asserted."""
    return [{"joint": i, "x": points[i][0], "y": points[i][1]} for i in sorted(points)]
