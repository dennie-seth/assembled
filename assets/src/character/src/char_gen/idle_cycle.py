"""Deterministic side-view idle cycle for the same hand-cut parts and rig as the walk.

Second user of the reference path from `char_gen.walk_cycle`: hand-cut parts ->
post-process key (`char_gen.background_key`) -> a deterministic rig and gait. No GPU, no
sampling -- the same inputs always produce the same frames.

Idle is the opposite of the walk's whole-body motion: nothing swings, nothing lifts. Only
two signals drive it, both expressed as pixel OFFSETS rather than joint angles because
nothing here rotates a bone -- the torso and head translate for breath, the torso sways
fore-aft for weight shift, and the arms trail a damped, delayed copy of that sway. Legs
hold a fixed rest angle at every phase, so the hip/knee/ankle chain never moves and the
feet stay planted by construction (see `char_gen.idle_render.foot_bottom_rows`, which
proves this from the actually composited pixels rather than from this module's intent).

Reused unmodified from `char_gen.walk_cycle`: the `Curve` keyframe type, `sample`'s linear
interpolation, and the sign/parenting conventions it documents. Nothing in walk_cycle.py
itself changes -- its own tests are unaffected by this module existing.

Figure height
-------------
``FIGURE_HEIGHT_NATIVE_PX`` is measured, not estimated, from the ten committed parts plus
`side_view_rig.json`'s own attach points, the same way that file's `bone_length_fix`
measured the calf_L correction:

* head reach above the neck: ``head.png`` height (184px) * its pivot_y (0.92) = 169.28px
* spine (neck -> hip, both read from ``attach_torso_local_px``): 236.44 - 5.14 = 231.3px
* leg chain (hip -> ankle): thigh bone_length (246.72) + calf bone_length (330.24,
  matching the rig's own post-fix measurement of 577.0px total) = 576.96px

169.28 + 231.3 + 576.96 = 977.54px native, descending to the standard 40px figure height
(`docs/design/13-asset-pipeline.md`) at ``DESCEND_SCALE`` = 40 / 977.54 ≈ 0.0409.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from char_gen.walk_cycle import Curve, sample

__all__ = [
    "FRAME_COUNT",
    "BREATH_CYCLES_PER_LOOP",
    "SWAY_CYCLES_PER_LOOP",
    "FIGURE_PX",
    "FIGURE_HEIGHT_NATIVE_PX",
    "DESCEND_SCALE",
    "BREATH_AMPLITUDE_NATIVE_PX",
    "SWAY_AMPLITUDE_NATIVE_PX",
    "ARM_LAG_PHASE",
    "ARM_LAG_DAMPING",
    "LEG_REST_ANGLE_DEG",
    "ARM_REST_ANGLE_DEG",
    "BREATH",
    "SWAY",
    "IdleOffsets",
    "offsets_at",
]

#: Chosen so a slower, subtler loop than the walk's 8-frame gait still samples each signal
#: densely: 12 frames gives 6 samples per breath cycle (2 cycles/loop) and all 12 samples
#: for the slower, 1-cycle/loop weight shift.
FRAME_COUNT = 12

#: Breath completes twice per loop, weight shift once -- an exact 2:1 harmonic lock, not a
#: pair of nearby frequencies, so the two never beat against each other (T-0430 edge case).
BREATH_CYCLES_PER_LOOP = 2
SWAY_CYCLES_PER_LOOP = 1

#: The standard final figure height this animation must still read at.
#: docs/design/13-asset-pipeline.md.
FIGURE_PX = 40

#: Measured -- see module docstring.
FIGURE_HEIGHT_NATIVE_PX = 977.54
DESCEND_SCALE = FIGURE_PX / FIGURE_HEIGHT_NATIVE_PX

#: Native-resolution amplitudes, chosen so each signal clears 1px by a comfortable margin
#: once descended (>2x and >1.4x respectively -- see test_idle_cycle.py's
#: TestAmplitudeSurvivesDescent), with breath set larger than sway so breathing reads as
#: the primary signal and weight shift as the secondary one.
BREATH_AMPLITUDE_NATIVE_PX = 55.0
SWAY_AMPLITUDE_NATIVE_PX = 35.0

#: How far behind the torso's own sway the arms trail, as a fraction of one full loop, and
#: how strongly damped that trail is. Both must be nonzero/sub-1.0 for the arms to read as
#: trailing rather than rigidly swinging with the torso (T-0430 edge case: "the arms read
#: as swinging").
ARM_LAG_PHASE = 0.08
ARM_LAG_DAMPING = 0.55

#: Legs and arms never rotate in idle -- holding a fixed rest angle at every phase is what
#: makes feet provably planted and arms read as hanging rather than swinging through a
#: driven arc. A nonzero elbow bend was considered and dropped: both shoulder parts are
#: rectangular crops with no silhouette of their own (parts/side_view/README.md), so a bent
#: elbow would be driven correctly and still invisible -- exactly the trap T-0430's own
#: "do not" list warns against compensating for with a bigger amplitude.
LEG_REST_ANGLE_DEG = 0.0
ARM_REST_ANGLE_DEG = 0.0


def _sine_curve(cycles: int, amplitude: float, steps: int = 16) -> Curve:
    """A `Curve` sampled from a pure sine over `cycles` full periods per loop.

    `steps` keyframes per loop (not per cycle) keep endpoints exact: phase 0.0 and phase
    1.0 both land on sin(0) = sin(2*pi*cycles) = 0 for any integer `cycles`, so the curve
    is seamless by construction, not by coincidence of hand-picked keyframes.
    """
    return [
        (i / steps, amplitude * math.sin(2 * math.pi * cycles * (i / steps)))
        for i in range(steps + 1)
    ]


#: Vertical offset (px, native resolution) applied to torso + head. Positive raises the
#: chest (screen-up); see `char_gen.idle_render` for the sign applied when compositing.
BREATH: Curve = _sine_curve(BREATH_CYCLES_PER_LOOP, BREATH_AMPLITUDE_NATIVE_PX)

#: Horizontal (fore-aft) offset (px, native resolution) applied to torso + head, and the
#: signal arms trail a damped, delayed copy of. A side view has no lateral (into-the-screen)
#: axis to show, so "lateral or fore-aft" resolves to the one horizontal axis this view has.
SWAY: Curve = _sine_curve(SWAY_CYCLES_PER_LOOP, SWAY_AMPLITUDE_NATIVE_PX)


@dataclass(frozen=True)
class IdleOffsets:
    """Resolved translation offsets for one phase, in native-resolution pixels."""

    breath_dy: float
    sway_dx: float
    arm_lag_dx: float


def offsets_at(phase: float) -> IdleOffsets:
    """Sample breath, sway, and the arms' own damped/delayed copy of sway at `phase`."""
    breath_dy = sample(BREATH, phase)
    sway_dx = sample(SWAY, phase)
    arm_lag_dx = sample(SWAY, phase - ARM_LAG_PHASE) * ARM_LAG_DAMPING
    return IdleOffsets(breath_dy=breath_dy, sway_dx=sway_dx, arm_lag_dx=arm_lag_dx)
