#!/usr/bin/env python3
"""Deterministic walk-cycle pose-rig keypoint generator (T-0259, continuing
HANDOFF §24-b/§24.4 "the script becomes the pose authority" into a genuine
gait, not a stride-offset variant of the idle cycle.

`pose_rig_T0249.py`'s own 'move' state generalisation evidence
(`pose_rig_move_evidence_T0249.json`) already documented its own limit: it
only offsets Arm A's static standing-idle base pose (`_POSE_KEYPOINTS_NORM`)
with a symmetric stride, so it can drive an idle-with-stride variant, never
a true mid-stride gait -- no knee lift, no opposed arm swing, no
weight-bearing/passing-leg distinction. This module is that missing
base-pose-level walk authoring.

Division of labour is unchanged from §24.4: the script owns keypoints,
frame count, timing and the animation curve; the model owns silhouette,
costume, shading, texture. `walk_keypoints_for_frame` is pure and
deterministic -- the same (frame_index, frame_count) always yields the same
18 keypoints, no randomness. `render_pose_frame` reuses
`gen_arm_a_idle_T0228.draw_pose_skeleton_cell` directly, unchanged -- the
existing primitive the card names, not a re-authored renderer.

The gait model (frame index i of frame_count N, phase t = i / N, all offsets
in the same 0..1-normalised unit-square space `_POSE_KEYPOINTS_NORM` uses):

  - each leg's knee/ankle swing forward/back in x, sinusoidally, 180 degrees
    out of phase between legs -- the "opposed leg swing" the motion spec
    asks for: one leg's forward reach is the other's back reach.
  - each leg lifts its own knee/ankle off the ground line at its own
    mid-swing point (the "pass" pose where the free leg clears) and settles
    back to the ground line at its own contact pose (t=0 for the right leg,
    t=0.5 for the left) -- a leg only clears the ground while it is not the
    one bearing weight.
  - arms swing opposite-phase to the SAME-side leg (right arm forward when
    the left leg is forward -- the real-gait convention), at a smaller
    amplitude than the legs.
  - the hip line (and everything above it) bobs down at each foot's own
    contact pose and rises as weight passes over the single stance leg --
    two dips per full cycle, one per foot contact.

Every term above is a periodic function of `t` with period 1, so frame
`frame_count` (one full cycle later) is mathematically identical to frame 0
-- the loop seam (frame N-1 -> frame 0) is not a special case patched in
afterwards, it falls out of the same parameterisation as every other
adjacent pair.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parent
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

from gen_arm_a_idle_T0228 import _POSE_KEYPOINTS_NORM, draw_pose_skeleton_cell  # noqa: E402

Point = tuple[float, float]

FRAME_COUNT = 8

# Joint indices, Arm A's 18-keypoint COCO numbering (see gen_arm_a_idle_T0228's
# module docstring for the full layout).
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_BODY_BOB_JOINTS: tuple[int, ...] = (0, 1, 2, 5, 14, 15, 16, 17)  # nose/neck/shoulders/eyes/ears

STRIDE_EXTENT_NORM = 0.145  # forward/back ankle swing from the standing hip line
KNEE_LIFT_NORM = 0.085  # how far the passing leg's knee/ankle rise off the ground line
ARM_SWING_EXTENT_NORM = 0.09  # opposite-phase arm swing, smaller than the leg's
HIP_BOB_NORM = 0.02  # vertical body bob, two dips per full gait cycle


def _leg_swing(t: float) -> float:
    """t in [0,1) -> forward(+1)/back(-1) position, period 1.

    A pure `sin(2*pi*t)` is mirror-symmetric about t=0.25 and t=0.75
    (`sin(2*pi*(0.5-t)) == sin(2*pi*t)`) -- the reach-forward half and the
    snap-back half would pass through exactly the same position values, so
    two frames placed symmetrically around a quarter-cycle point sample
    byte-identical leg positions. A real gait is not symmetric this way --
    the swing-through leg snaps back faster than it reaches forward -- so a
    second harmonic is added to break the mirror (the standard walk-cycle
    curve-shaping technique), which is also what keeps `walk_keypoints_for_frame`
    honestly yielding 8 distinct frames rather than 4 mirrored pairs."""
    return math.sin(2 * math.pi * t) + 0.25 * math.sin(4 * math.pi * t)


def _knee_lift(t: float) -> float:
    """Positive through the leg's forward-swing half (peaking near
    t=0.2-0.25 -- the 'pass' point where the free leg clears the ground)
    and zero through its backward stance-drag half (foot planted/dragging,
    no lift). Derived from the same asymmetric `_leg_swing` curve (not a
    plain `sin`) so it inherits that curve's broken t=0.25 mirror symmetry
    instead of reintroducing one."""
    return max(0.0, _leg_swing(t))


def _hip_bob(t: float) -> float:
    """Negative = up in this normalised space (y grows downward); dips
    (less negative) at each foot's own contact pose, rises between."""
    return -abs(math.cos(2 * math.pi * t)) * HIP_BOB_NORM


def walk_keypoints_for_frame(
    frame_index: int,
    frame_count: int = FRAME_COUNT,
    *,
    base_points: dict[int, Point] = _POSE_KEYPOINTS_NORM,
) -> dict[int, Point]:
    """Derive one frame's 18 keypoints for a loopable walk cycle.

    Deterministic: the same (frame_index, frame_count) always yields the
    same points. `frame_index` is read mod `frame_count`, so frame
    `frame_count` (the loop seam) is identical to frame 0 by construction.

    Sampled at the CENTRE of each frame's phase slice (`+0.5`), not its
    leading edge -- a sample exactly at t=0 or t=0.5 lands on the gait's own
    symmetric neutral-crossing, where every joint's offset, lift and hip-bob
    term is simultaneously at its shared degenerate value regardless of
    which leg is swinging vs planted, producing two genuinely identical
    frames (see this module's test suite, `test_frames_vary_across_the_cycle`).
    """
    t = ((frame_index % frame_count) + 0.5) / frame_count
    points = dict(base_points)

    right_phase = _leg_swing(t)
    left_phase = _leg_swing(t + 0.5)
    right_lift = _knee_lift(t)
    left_lift = _knee_lift(t + 0.5)
    bob = _hip_bob(t)

    for hip, knee, ankle, phase, lift in (
        (_R_HIP, _R_KNEE, _R_ANKLE, right_phase, right_lift),
        (_L_HIP, _L_KNEE, _L_ANKLE, left_phase, left_lift),
    ):
        hx, hy = points[hip]
        points[hip] = (hx, hy + bob)
        kx, ky = points[knee]
        points[knee] = (
            kx + phase * STRIDE_EXTENT_NORM * 0.5,
            ky + bob - lift * KNEE_LIFT_NORM * 0.5,
        )
        ax, ay = points[ankle]
        points[ankle] = (ax + phase * STRIDE_EXTENT_NORM, ay + bob - lift * KNEE_LIFT_NORM)

    # Arms swing opposite-phase to the SAME-side leg (real-gait convention):
    # right arm forward when the left leg is forward.
    for shoulder, elbow, wrist, phase in (
        (_R_SHOULDER, _R_ELBOW, _R_WRIST, left_phase),
        (_L_SHOULDER, _L_ELBOW, _L_WRIST, right_phase),
    ):
        sx, sy = points[shoulder]
        points[shoulder] = (sx, sy + bob)
        ex, ey = points[elbow]
        points[elbow] = (ex + phase * ARM_SWING_EXTENT_NORM * 0.5, ey + bob)
        wx, wy = points[wrist]
        points[wrist] = (wx + phase * ARM_SWING_EXTENT_NORM, wy + bob)

    for j in _BODY_BOB_JOINTS:
        x, y = points[j]
        points[j] = (x, y + bob)

    return points


def render_pose_frame(points: dict[int, Point], size: int):
    """Reuses gen_arm_a_idle_T0228.draw_pose_skeleton_cell directly -- same
    limb topology/colours, same joint-radius/line-width scaling, same pure
    black background -- parametrised on this frame's keypoints instead of
    the static base pose."""
    return draw_pose_skeleton_cell(size, points_norm=points)


def keypoints_to_coco_list(points: dict[int, Point]) -> list[dict]:
    """Serialise a frame's keypoints in ascending joint order -- what gets
    written to the per-frame keypoints JSON committed alongside each
    rendered skeleton, so the recipe is checkable, not merely asserted."""
    return [{"joint": i, "x": points[i][0], "y": points[i][1]} for i in sorted(points)]
