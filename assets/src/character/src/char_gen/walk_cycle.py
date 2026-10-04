"""Deterministic side-view walk cycle for hand-cut character parts.

This is the reference implementation for the character animation path: hand-cut parts ->
post-process key (`char_gen.background_key`) -> this rig and gait. No GPU, no sampling;
the same inputs always produce the same frames.

Bone model
----------
`docs/design/21-character-rig-bones.md` EXTENDED set. A part's pivot is a normalized
fraction of its OWN cropped bounding box and sits at the **proximal** joint, so a segment's
reach is `img.height * (1 - pivot_y)`. Bone length is therefore DERIVED from the art: scale
a part and its child joint moves proportionally, with the chain still intact.

Sign convention
---------------
The figure faces **+x**. A positive angle swings a downward-hanging part's tip forward.

* ``calf    = thigh    - knee_flexion``   -- the knee bends the heel backward
* ``forearm = shoulder + elbow_flexion``  -- the elbow brings the hand forward

Gait
----
Flexion is keyframed over the cycle rather than taken from a single sine. That matters: an
earlier revision used one half-rectified sine at 20 degrees peak, which is sub-pixel on a
~9px calf at a 40px figure AND exactly zero for half the cycle -- so each limb read as a
single rigid bone. The knee's real double-peak shape (small loading-response bend, near
straight at mid-stance, large swing-phase bend) is what makes a walk read as a walk.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

#: (phase, degrees) keyframes. Phase runs 0..1 over one full cycle and wraps.
Curve = list[tuple[float, float]]

#: Thigh: forward at heel strike, swinging back through stance, forward again in swing.
HIP: Curve = [(0.00, 24), (0.30, 6), (0.50, -12), (0.62, -18), (0.80, 10), (1.00, 24)]
#: Knee flexion: loading response, near-straight mid-stance, large swing bend, extend.
KNEE: Curve = [(0.00, 6), (0.15, 18), (0.40, 4), (0.55, 26), (0.72, 62), (0.85, 34),
               (1.00, 6)]
#: Upper arm: opposes the same-side hip.
SHOULDER: Curve = [(0.00, -18), (0.30, -4), (0.50, 10), (0.62, 16), (0.80, -8),
                   (1.00, -18)]
#: Elbow flexion: never fully straight, more as the arm swings forward.
ELBOW: Curve = [(0.00, 18), (0.25, 34), (0.50, 16), (0.75, 30), (1.00, 18)]

#: The far-side limbs run half a cycle out of phase with the near side.
OPPOSITE_PHASE = 0.5


def sample(curve: Curve, phase: float) -> float:
    """Linear interpolation over keyframes. `phase` wraps at 1.0."""
    if not curve:
        raise ValueError("curve is empty")
    phase = phase % 1.0
    for (t0, v0), (t1, v1) in zip(curve, curve[1:]):
        if t0 <= phase <= t1:
            if t1 == t0:
                return v0
            return v0 + (v1 - v0) * (phase - t0) / (t1 - t0)
    return curve[-1][1]


@dataclass(frozen=True)
class JointAngles:
    """Resolved angles for one side at one phase, in degrees."""
    hip: float
    knee_flexion: float
    shoulder: float
    elbow_flexion: float

    @property
    def calf(self) -> float:
        """Absolute calf angle -- parent plus its own flexion, knee bending backward."""
        return self.hip - self.knee_flexion

    @property
    def forearm(self) -> float:
        """Absolute forearm angle -- parent plus its own flexion, elbow bending forward."""
        return self.shoulder + self.elbow_flexion


def angles_at(phase: float, *, far_side: bool = False) -> JointAngles:
    if far_side:
        phase += OPPOSITE_PHASE
    return JointAngles(
        hip=sample(HIP, phase),
        knee_flexion=sample(KNEE, phase),
        shoulder=sample(SHOULDER, phase),
        elbow_flexion=sample(ELBOW, phase),
    )


def bone_length(part_height: int, pivot_y: float) -> float:
    """A segment's reach: the part below its proximal pivot."""
    return part_height * (1.0 - pivot_y)


def distal_joint(root: tuple[float, float], length: float,
                 angle_deg: float) -> tuple[float, float]:
    """Where a segment's far end lands -- the pivot its CHILD hangs from."""
    r = math.radians(angle_deg)
    return (root[0] + length * math.sin(r), root[1] + length * math.cos(r))


def root_bob(phase: float, amplitude: float) -> float:
    """Two dips per cycle, one per footfall. Negative is up the screen."""
    return -abs(math.sin(2 * math.pi * phase)) * amplitude


@dataclass(frozen=True)
class LegLengths:
    """Measured bone lengths for one leg, so the two sides can be compared."""
    thigh: float
    calf: float

    @property
    def chain(self) -> float:
        return self.thigh + self.calf


def length_scale_to_match(short: float, reference: float) -> float:
    """Factor that makes a short bone match its opposite number.

    The far calf is routinely shorter in hand-cut side-view art because its upper portion
    is occluded by the near leg -- the CUT is short, the bone is not. Scaling the part
    restores the bone, and because pivots are normalized the chain stays intact.
    """
    if short <= 0:
        raise ValueError("bone length must be positive")
    return reference / short


@dataclass
class PartSpec:
    """One part's placement: which bone it is, and where its pivot sits."""
    bone: str
    pivot: tuple[float, float] = (0.5, 0.0)
    layer: int = 0
    length_scale: float = 1.0
    phase_offset: float = 0.0
    tags: list[str] = field(default_factory=list)
