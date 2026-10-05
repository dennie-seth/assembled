"""Deterministic side-view idle loop for the committed character parts.

Scope, deliberately small
-------------------------
**One signal: a gentle vertical breath in the upper body.** @DennieSeth, 2026-10-05, after a
first version that layered breathing, a weight shift, torso pitch and roll, and trailing arm
motion -- correct on every measurement and too busy to watch. Idle plays constantly, so it
has to sit still enough to ignore.

So this carries a single motion and nothing else:

* the torso, head and arms rise and fall together as one piece
* the **hips and both legs do not move at all** -- they are solved once, at rest, and reused
  for every frame
* no sway, no pitch, no roll, no arm swing, no limb articulation

Because the hips are static the feet are planted trivially rather than by inverse kinematics
each frame. `solve_leg` is still used for that one-off rest pose, and remains the right tool
for any future animation whose hips *do* move while a foot stays put.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from char_gen.walk_cycle import bone_length, distal_joint  # noqa: F401  (shared geometry)

#: One gentle rise-and-fall per loop. Two reads as panting at this frame count.
BREATH_CYCLES_PER_LOOP = 1.0

#: Vertical travel of the upper body, as a fraction of the torso's own height.
#:
#: CALIBRATED TO THE OUTPUT RESOLUTION, not chosen by eye. An earlier pass used a
#: "subtle" 0.016 and measured 0.15px of travel at the 40px figure -- arithmetically
#: present, visually absent. At this scale a readable signal has to clear a pixel, so this
#: targets ~1.1px: enough to see, small enough to ignore.
BREATH_RISE_FRAC = 0.108

#: The arms hang. Constant for the whole loop -- they ride the torso and carry no motion of
#: their own.
SHOULDER_REST_DEG = 0.0
ELBOW_REST_DEG = 14.0          # a hanging arm is never perfectly straight
HEAD_REST_DEG = 0.0

#: How much of the breath the legs absorb. Zero: the hips are static, so the legs are
#: identical in every frame and the feet cannot drift.
LEG_FOLLOW = 0.0

#: The idle STANCE: straight legs, thighs vertical, feet flat.
#:
#: These are set directly rather than solved. An earlier version ran the rest pose through
#: `solve_leg` at 93% extension, which resolved to 43.4 degrees of knee flexion with the
#: thighs ~25 degrees forward -- a crouch carried over from the walk, not a standing pose.
#: A neutral stand has nothing to solve for: the thigh hangs vertical and the knee is
#: straight, so saying so is both simpler and exactly right.
IDLE_THIGH_DEG = 0.0
IDLE_KNEE_FLEXION_DEG = 0.0

#: Fore-aft offset of the FAR leg's hip, as a fraction of torso width. With both legs
#: vertical they would otherwise coincide exactly and the far one would be invisible; in a
#: side view the far leg sits slightly behind (negative is behind, since the figure faces +x).
FAR_LEG_OFFSET_FRAC = -0.055


@dataclass(frozen=True)
class IdlePose:
    """Resolved idle pose at one phase.

    `upper_dy` is the only field that varies across the loop. Negative is up the screen.
    """
    upper_dy: float
    shoulder_deg: float = SHOULDER_REST_DEG
    elbow_deg: float = ELBOW_REST_DEG
    head_deg: float = HEAD_REST_DEG
    torso_deg: float = 0.0
    hip_dx: float = 0.0
    hip_dy: float = 0.0


def breath(phase: float) -> float:
    """0..1 ease over one cycle, resting at both ends so the loop closes seamlessly."""
    return 0.5 - 0.5 * math.cos(2 * math.pi * BREATH_CYCLES_PER_LOOP * (phase % 1.0))


def pose_at(phase: float, torso_height: float) -> IdlePose:
    """Resolve the pose. Only `upper_dy` varies; everything else is the rest pose."""
    return IdlePose(upper_dy=-BREATH_RISE_FRAC * torso_height * breath(phase))


def travel_at_final_height(torso_height: float, descent_scale: float) -> float:
    """Peak-to-peak upper-body travel in FINAL pixels -- the number that decides whether
    the motion reads at all."""
    return BREATH_RISE_FRAC * torso_height * descent_scale


# --------------------------------------------------------------------- legs ----
@dataclass(frozen=True)
class LegIK:
    """Two-bone solution: angles that put an ankle under a hip."""
    thigh_deg: float
    knee_flexion_deg: float

    @property
    def calf_deg(self) -> float:
        """Absolute calf angle -- parent plus own flexion, knee bending backward."""
        return self.thigh_deg - self.knee_flexion_deg


def solve_leg(hip: tuple[float, float], ankle: tuple[float, float],
              thigh_len: float, calf_len: float) -> LegIK:
    """Angles placing `ankle` at the end of the chain hanging from `hip`.

    This rig's convention: an angle is measured from straight-down, positive swinging the
    tip toward +x. The knee bends forward, which is the human direction.
    """
    dx, dy = ankle[0] - hip[0], ankle[1] - hip[1]
    reach = math.hypot(dx, dy)
    lo, hi = abs(thigh_len - calf_len), thigh_len + calf_len
    # Clamp just inside full extension: straight is both a singularity and a locked-looking
    # pose. A sliver of bend is safer and better looking.
    reach = max(lo + 1e-6, min(hi - 1e-6, reach))

    direction = math.degrees(math.atan2(dx, dy))
    cos_a = (thigh_len ** 2 + reach ** 2 - calf_len ** 2) / (2 * thigh_len * reach)
    cos_b = (thigh_len ** 2 + calf_len ** 2 - reach ** 2) / (2 * thigh_len * calf_len)
    a = math.degrees(math.acos(max(-1.0, min(1.0, cos_a))))
    b = math.degrees(math.acos(max(-1.0, min(1.0, cos_b))))
    return LegIK(thigh_deg=direction + a, knee_flexion_deg=180.0 - b)


def idle_stance() -> LegIK:
    """The standing pose the breath rides on: straight leg, thigh vertical."""
    return LegIK(thigh_deg=IDLE_THIGH_DEG, knee_flexion_deg=IDLE_KNEE_FLEXION_DEG)


def ankle_of(hip: tuple[float, float], ik: LegIK,
             thigh_len: float, calf_len: float) -> tuple[float, float]:
    """Forward-kinematics check: where the solved chain actually puts the ankle."""
    knee = distal_joint(hip, thigh_len, ik.thigh_deg)
    return distal_joint(knee, calf_len, ik.calf_deg)
