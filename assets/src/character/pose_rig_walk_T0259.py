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

  - each leg's knee/ankle swing forward/back in x, following
    `cos(2*pi*t)`, 180 degrees out of phase between legs -- the "opposed
    leg swing" the motion spec asks for: one leg's forward reach is the
    other's back reach. `cos` puts each leg's own stride EXTREME (contact)
    exactly at t=0 and t=0.5, not at a zero-crossing -- see the 2026-08-31
    IMPROVEMENT PASS note below for why that choice matters.
  - each leg lifts its own knee/ankle off the ground line (`max(0,
    -sin(2*pi*t))`) throughout its own swing half of the cycle, peaking at
    its own mid-swing "passing" point (t=0.75 for the right leg, t=0.25 for
    the left) where its own offset has returned to 0 (ankle back under the
    hip) -- and is exactly 0 throughout its own stance half, so a leg only
    clears the ground while it is not the one bearing weight.
  - while lifted, each leg's knee/ankle is additionally pulled laterally
    toward, and slightly past, the OTHER leg's resting x
    (`CROSS_EXTENT_NORM`, scaled by that leg's own lift) -- the "passing"
    pose is a real cross (the swinging leg's foot visibly passes the
    planted leg), not two legs independently hovering back to bilateral
    symmetry. Zero at every contact pose (lift is 0 there), so it never
    distorts the wide stride the contact pose needs.
  - arms swing opposite-phase to the SAME-side leg (right arm forward when
    the left leg is forward -- the real-gait convention), at an amplitude
    comparable to shoulder width so the opposition reads at game scale.
  - the hip line (and everything above it) bobs down at each foot's own
    contact pose (t=0, t=0.5, where the stride is at rest) and rises as
    weight passes over the single stance leg, peaking at each leg's own
    passing point -- two rises per full cycle, one per stance leg.

Every term above is a periodic function of `t` with period 1, so frame
`frame_count` (one full cycle later) is mathematically identical to frame 0
-- the loop seam (frame N-1 -> frame 0) is not a special case patched in
afterwards, it falls out of the same parameterisation as every other
adjacent pair.

**2026-08-31 IMPROVEMENT PASS (art direction).** The previously-committed
sheet hitched at the loop seam (measured 5.31x the interior mean, raw
changed-pixel count) because frame 0 sampled a near-neutral passing pose,
not a contact pose: the old model offset each leg with a plain
`sin(2*pi*t)` (whose CONTACT extremes sit at t=0.25/0.75, not at a frame
boundary under 8-way slicing) and sampled at the CENTRE of each 8-way phase
slice specifically to dodge a real degeneracy at t=0/0.5 (both legs'
`sin`-based offsets are simultaneously 0 there, an indistinguishable
double-neutral frame) -- which put frame 0 near-neutral instead of at a
stride extreme, off by a quarter cycle from the nearest contact pose.

Swapping the offset curve to `cos` (this revision) moves the informative
extremes to exactly t=0 and t=0.5 and moves the *neutral* crossing to
t=0.25/0.75 -- and that neutral crossing is no longer degenerate, because
`lift` (an independent `sin`-based term, not derived from the same zero as
the offset) is at its own PEAK there, not zero: the two legs are
distinguished by elevation (one flat/stance, one lifted/swinging) even
though their horizontal offsets briefly coincide. That is not a special
case worked around -- it is the correct biomechanical "legs pass" moment,
and it is why the plain, even grid `t = k/N` (no center-of-slice shift) can
be sampled directly: frame 0 lands exactly on a contact pose, every one of
the 8 samples (loop seam included) is exactly `1/N` apart, and the old
degeneracy simply does not exist under this parameterisation.

`STRIDE_EXTENT_NORM`, `KNEE_LIFT_NORM` and `ARM_SWING_EXTENT_NORM` are also
raised well past the previous sheet's barely-visible values (0.145/0.085/
0.09) -- see the module constants below for the chosen values and why.
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

# Chosen to be at least 1.8x the previous sheet's values (0.145/0.085/0.09),
# which produced barely-visible limb motion per the art-direction review --
# "meaningfully larger", not a marginal tweak. Checked against body scale in
# this module's test suite (arm swing vs shoulder width; stride/cross vs hip
# separation) so these aren't just bigger numbers, they read at game scale.
#
# T-0271/DL-26 RESTORATION: attempt 5 (real ComfyUI generation, seed 27182)
# ran these exact values and measured frame deltas of 0.328-0.473 -- past
# DL-21's 0.30 cap, which attempts 6-8 then chased down to 0.22/0.13/0.15/
# 0.02 purely to fit under it. That cap was pre-registered against the
# player IDLE sheet, not this walk gait -- T-0271 fixed the mismatch: a
# locomotion sheet is now graded against MOTION_FRAME_DELTA_CAP (0.50,
# `asset_gate.character.frame_delta_cap_for_motion_class`), which attempt
# 5's own real measured range already clears with room to spare (0.473 <
# 0.50). The amplitude-vs-cap tradeoff that motivated the cut no longer
# exists, so the full attempt-5 values are restored -- motion readability
# graded before the delta number, per this card's own instruction not to
# repeat that trade.
STRIDE_EXTENT_NORM = 0.30  # forward/back ankle swing from the standing hip line
KNEE_LIFT_NORM = 0.18  # how far the passing leg's knee/ankle rise off the ground line
ARM_SWING_EXTENT_NORM = 0.20  # opposite-phase arm swing (>=0.9x shoulder width, 0.166)
CROSS_EXTENT_NORM = 0.14  # lateral pull toward the other leg's resting x while lifted --
# large enough for the lifted ankle to reach the other leg's own resting x
# outright, a real cross, not attempts 6-8's narrowing-only compromise.
HIP_BOB_NORM = 0.02  # vertical body bob, two rises per full gait cycle


def _leg_offset(t: float) -> float:
    """t in [0,1) -> forward(+1)/back(-1) position, period 1.

    `cos(2*pi*t)` puts this leg's own stride EXTREMES (contact, both feet
    planted) at t=0 and t=0.5 -- not at a zero-crossing -- so a plain, even
    8-way grid `t=k/8` lands frame 0 exactly on a contact pose. See the
    module's IMPROVEMENT PASS docstring for why this differs from the
    original `sin`-based curve."""
    return math.cos(2 * math.pi * t)


def _leg_lift(t: float) -> float:
    """Zero throughout this leg's stance half (t in [0, 0.5], where its own
    offset is doing the useful work) and positive throughout its swing half
    (t in [0.5, 1]), peaking at t=0.75 -- the mid-swing 'passing' point,
    where `_leg_offset` has returned to 0 (ankle back under the hip) but the
    leg is fully lifted. Independent of `_leg_offset`'s own zero, so the
    t=0.25/0.75 crossing is informative (one leg flat, the other lifted),
    never a degenerate double-zero."""
    return max(0.0, -math.sin(2 * math.pi * t))


def _hip_bob(t: float) -> float:
    """Negative = up in this normalised space (y grows downward); 0 (no
    bob) at each foot's own contact pose (t=0, t=0.5, stride at rest),
    rising (more negative) as the body vaults over the single stance leg,
    peaking at each leg's own passing point (t=0.25, t=0.75)."""
    return -(1.0 - abs(math.cos(2 * math.pi * t))) * HIP_BOB_NORM


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

    Sampled on the plain, even grid `t = k / frame_count` -- frame 0 is
    `t=0`, a genuine contact pose under `_leg_offset`'s `cos` curve, and
    every one of the `frame_count` samples (loop seam included) is exactly
    `1 / frame_count` of a cycle apart. See this module's IMPROVEMENT PASS
    docstring for why the previous centre-of-slice `+0.5` shift is no
    longer needed (the degeneracy it dodged doesn't exist under this
    parameterisation).
    """
    t = (frame_index % frame_count) / frame_count
    points = dict(base_points)

    right_off = _leg_offset(t)
    left_off = _leg_offset(t + 0.5)
    right_lift = _leg_lift(t)
    left_lift = _leg_lift(t + 0.5)
    bob = _hip_bob(t)

    # cross_sign pulls each leg's knee/ankle, while lifted, toward and past
    # the OTHER leg's resting x -- +1 for the right leg (whose resting x is
    # smaller, per _POSE_KEYPOINTS_NORM), -1 for the left. Zero contribution
    # whenever lift is 0 (every contact pose), so the wide-stride contact
    # pose is never distorted by it.
    for hip, knee, ankle, off, lift, cross_sign in (
        (_R_HIP, _R_KNEE, _R_ANKLE, right_off, right_lift, 1.0),
        (_L_HIP, _L_KNEE, _L_ANKLE, left_off, left_lift, -1.0),
    ):
        hx, hy = points[hip]
        points[hip] = (hx, hy + bob)
        kx, ky = points[knee]
        points[knee] = (
            kx + off * STRIDE_EXTENT_NORM * 0.5 + cross_sign * lift * CROSS_EXTENT_NORM * 0.5,
            ky + bob - lift * KNEE_LIFT_NORM * 0.5,
        )
        ax, ay = points[ankle]
        points[ankle] = (
            ax + off * STRIDE_EXTENT_NORM + cross_sign * lift * CROSS_EXTENT_NORM,
            ay + bob - lift * KNEE_LIFT_NORM,
        )

    # Arms swing opposite-phase to the SAME-side leg (real-gait convention):
    # right arm forward when the left leg is forward.
    for shoulder, elbow, wrist, off in (
        (_R_SHOULDER, _R_ELBOW, _R_WRIST, left_off),
        (_L_SHOULDER, _L_ELBOW, _L_WRIST, right_off),
    ):
        sx, sy = points[shoulder]
        points[shoulder] = (sx, sy + bob)
        ex, ey = points[elbow]
        points[elbow] = (ex + off * ARM_SWING_EXTENT_NORM * 0.5, ey + bob)
        wx, wy = points[wrist]
        points[wrist] = (wx + off * ARM_SWING_EXTENT_NORM, wy + bob)

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
