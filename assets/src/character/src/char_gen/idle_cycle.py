"""Deterministic side-view idle loop for the committed character parts.

Idle is the opposite problem to the walk. The walk moves the whole body and the feet
travel; idle has to read as *alive at rest* without drawing the eye, and **the feet must not
move at all**. That one constraint drives the design:

* the hips are what breathes and shifts weight -- they translate
* the ankles are **fixed** for the whole loop
* so the legs are solved by **two-bone inverse kinematics** from the moving hip to the
  stationary ankle, rather than by posing the thigh and reading off where the foot lands

Posing the legs forward (as the walk does) and hoping the feet stay put does not work: any
hip motion drags them. Solving backwards from a planted ankle makes "both feet planted" true
by construction instead of by inspection.

Two signals, deliberately at different rates so they do not beat against each other:

* **breathing** -- primary, two cycles per loop, a vertical rise and fall through the hips
  and torso with a small torso pitch
* **weight shift** -- secondary, ONE cycle per loop (half the breath's rate), a lateral
  settle with a small counter-roll

The arms do not swing. They carry a **lagged fraction** of the torso's own motion, which
reads as hanging weight rather than a driven arc.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from char_gen.walk_cycle import bone_length, distal_joint  # noqa: F401  (shared geometry)

#: Breathing: two full cycles per loop (the faster of the two signals).
BREATH_CYCLES_PER_LOOP = 2.0
#: Weight shift: one cycle per loop. 2:1 against the breath is harmonically clean.
SHIFT_CYCLES_PER_LOOP = 1.0

# Amplitudes as a fraction of the torso's own height.
#
# CALIBRATED TO THE OUTPUT RESOLUTION, not chosen by eye. A first pass used
# "subtle" fractions (0.016 / 0.012) and measured 0.15px and 0.25px of travel at the
# 40px figure -- both well under one pixel, i.e. motion that is arithmetically present
# and visually absent. At this scale a readable idle signal has to be ~1px, which is
# how pixel-art idles have always worked: the whole figure bobs by a pixel rather than
# a chest inflating by a hair.
#
# These values target ~1.3px of breath and ~0.9px of sway at a 40px figure, keeping the
# breath the primary signal. The driver re-measures and prints both.
BREATH_RISE_FRAC = 0.125       # hip/torso vertical travel  -> ~1.3px at 40px
BREATH_PITCH_DEG = 2.2         # torso pitch over the breath
SHIFT_SWAY_FRAC = 0.044        # hip lateral travel         -> ~0.9px at 40px
SHIFT_ROLL_DEG = 1.6           # torso counter-roll over the shift

#: The arms trail the torso rather than swinging: a fraction of its motion, delayed.
ARM_TRAIL_GAIN = 0.55
ARM_TRAIL_LAG = 0.08           # in loop phase
ELBOW_REST_DEG = 14.0          # a hanging arm is never perfectly straight
ELBOW_TRAIL_GAIN = 0.35
HEAD_TRAIL_GAIN = 0.30
HEAD_TRAIL_LAG = 0.05


@dataclass(frozen=True)
class IdlePose:
    """Resolved idle pose at one phase. Translations are in source pixels."""
    hip_dx: float
    hip_dy: float
    torso_deg: float
    head_deg: float
    shoulder_deg: float
    elbow_deg: float


def _breath(phase: float) -> float:
    return math.sin(2 * math.pi * BREATH_CYCLES_PER_LOOP * phase)


def _shift(phase: float) -> float:
    return math.sin(2 * math.pi * SHIFT_CYCLES_PER_LOOP * phase)


def pose_at(phase: float, torso_height: float, *, far_side: bool = False) -> IdlePose:
    """Resolve the idle pose. `far_side` lags the arm slightly more, so the two arms do
    not move as one rigid pair."""
    phase = phase % 1.0
    b, s = _breath(phase), _shift(phase)

    torso_deg = BREATH_PITCH_DEG * b + SHIFT_ROLL_DEG * s
    lag = ARM_TRAIL_LAG * (1.6 if far_side else 1.0)
    trail_b = _breath(phase - lag)
    trail_s = _shift(phase - lag)
    trailed = BREATH_PITCH_DEG * trail_b + SHIFT_ROLL_DEG * trail_s

    head_src = (BREATH_PITCH_DEG * _breath(phase - HEAD_TRAIL_LAG)
                + SHIFT_ROLL_DEG * _shift(phase - HEAD_TRAIL_LAG))

    return IdlePose(
        hip_dx=SHIFT_SWAY_FRAC * torso_height * s,
        # breathing rises: negative is up the screen
        hip_dy=-BREATH_RISE_FRAC * torso_height * (0.5 + 0.5 * b),
        torso_deg=torso_deg,
        head_deg=HEAD_TRAIL_GAIN * head_src - torso_deg,
        shoulder_deg=ARM_TRAIL_GAIN * trailed - torso_deg,
        elbow_deg=ELBOW_REST_DEG + ELBOW_TRAIL_GAIN * trailed,
    )


@dataclass(frozen=True)
class LegIK:
    """Two-bone solution: angles that put a fixed ankle under a moving hip."""
    thigh_deg: float
    knee_flexion_deg: float

    @property
    def calf_deg(self) -> float:
        """Absolute calf angle -- parent plus own flexion, knee bending backward."""
        return self.thigh_deg - self.knee_flexion_deg


def solve_leg(hip: tuple[float, float], ankle: tuple[float, float],
              thigh_len: float, calf_len: float) -> LegIK:
    """Angles placing `ankle` at the end of the chain hanging from `hip`.

    Uses this rig's own convention: an angle is measured from straight-down, positive
    swinging the tip toward +x. The knee bends forward (thigh forward of the hip-ankle
    line, calf back), which is the human direction.
    """
    dx, dy = ankle[0] - hip[0], ankle[1] - hip[1]
    reach = math.hypot(dx, dy)
    lo, hi = abs(thigh_len - calf_len), thigh_len + calf_len
    # Clamp just inside full extension: a perfectly straight leg is a singularity and
    # also looks locked. Leaving a sliver of bend is both safer and better-looking.
    reach = max(lo + 1e-6, min(hi - 1e-6, reach))

    direction = math.degrees(math.atan2(dx, dy))
    cos_a = (thigh_len ** 2 + reach ** 2 - calf_len ** 2) / (2 * thigh_len * reach)
    cos_b = (thigh_len ** 2 + calf_len ** 2 - reach ** 2) / (2 * thigh_len * calf_len)
    a = math.degrees(math.acos(max(-1.0, min(1.0, cos_a))))
    b = math.degrees(math.acos(max(-1.0, min(1.0, cos_b))))
    return LegIK(thigh_deg=direction + a, knee_flexion_deg=180.0 - b)


def ankle_of(hip: tuple[float, float], ik: LegIK,
             thigh_len: float, calf_len: float) -> tuple[float, float]:
    """Forward-kinematics check: where the solved chain actually puts the ankle."""
    knee = distal_joint(hip, thigh_len, ik.thigh_deg)
    return distal_joint(knee, calf_len, ik.calf_deg)
