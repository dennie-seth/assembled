"""Anatomical-suitability check for a part mask, independent of mechanical
isolation (T-0423 FIX ROUND).

`part_isolation.py` answers "is this mask a single connected component that
doesn't bleed into a sibling part's mask" -- a geometric/connectivity
question about the mask alone. It has no notion of the part's own
anatomical extent: a mask can be one clean connected component, overlap
nothing, and still not be the part it claims to be, because it extends past
the joint that is supposed to bound it. That is exactly what Chat's review
of PR #426 found by hand for `front_tpose/right_upper_arm` -- mechanically
`isolated: true` (one component, 3.0% stray, zero overlap), but 46.9% of its
own retained pixels lie on the wrist side of the elbow, i.e. it is the upper
arm AND the forearm, handed to a Tier-2 compositor that will act on it as if
it were one.

This module reproduces that finding as a computation over the already-
committed mask PNG and rig keypoints, no SAM3/GPU/ComfyUI involved, and
generalizes it so every present upper-arm part gets the same check, not just
the one the review happened to name.

**Scope: `upper_arm` only, never `lower_arm`.** T-0338's own part-to-joint
chain is "upper arm, **lower arm+hand**" -- the lower-arm part's own stated
anatomical scope already includes the hand, so pixels beyond its distal
joint (the wrist) are the hand the part is supposed to contain, not a
sibling part's territory. Applying this check to a `lower_arm` part would
flag a well-formed forearm+hand cutout as "combined" for containing its own
hand. `upper_arm`'s distal joint (the elbow) has no such built-in allowance
-- T-0338 names "lower arm+hand" as its own separate consumable part, so
anything of `upper_arm`'s past the elbow is unambiguously someone else's
territory.

**Scope: not `head`/`torso`.** Neither has a `joint_b` in the one- or
two-joint sense this check needs (see `PartSpec.joint_b_pair` in
`gen_master_sheet_part_cutouts_T0417.py` for why the torso's anchor is a
three-point derivation, not a two-joint span) -- there is no second joint to
measure "beyond" against, so the metric does not apply and must not be
forced onto a misleading number for either.
"""

from __future__ import annotations

import numpy as np

#: A combined-part failure (real content from the next anatomical segment)
#: measures far above ordinary joint-point/mask-smoothing blur. Observed
#: on this card's own five present upper-arm part masks: the three not
#: already excluded by overclaim/overlap/stray rejection sit at 0.0%-1.3%
#: beyond their own elbow (back_tpose/right_upper_arm 1.3%, side_neutral/
#: right_upper_arm 0.0%); the two genuinely contaminated ones sit at 21.8%
#: (side_right_forward/right_upper_arm, already excluded by stray+overlap
#: for other reasons) and 46.9% (front_tpose/right_upper_arm, the one this
#: round corrects). 0.20 sits well above the clean range and well below
#: both contaminated readings, so it discriminates the two populations
#: this run actually produced rather than being picked to hit one number.
COMBINED_PART_BEYOND_JOINT_FRACTION_TOLERANCE = 0.20


def beyond_distal_joint_fraction(
    mask: np.ndarray,
    proximal_joint_px: tuple[float, float],
    distal_joint_px: tuple[float, float],
) -> float:
    """Fraction of `mask`'s own foreground pixels that lie farther from
    `proximal_joint_px` than `distal_joint_px` itself does, measured along
    the proximal->distal direction -- i.e. past the joint that is supposed
    to bound this part, toward where the next anatomical segment begins.

    Projects every foreground pixel onto the proximal->distal axis (handles
    an arm at any angle, not just the horizontal T-pose case the review
    first found this on) and compares that projection to the distal
    joint's own projection, which by construction equals the proximal-to-
    distal segment's own length.

    Raises `ValueError` if `mask` has no foreground pixels at all (a part
    reported `present: false` has no fraction to compute -- see this
    module's docstring on keeping "not present" and "present but unusable"
    distinct) or if the two joints coincide (no direction to project onto).
    """
    foreground_px = int(mask.sum())
    if foreground_px == 0:
        raise ValueError("mask has no foreground pixels -- part is not present")

    ax, ay = proximal_joint_px
    bx, by = distal_joint_px
    dx, dy = bx - ax, by - ay
    length = float(np.hypot(dx, dy))
    if length == 0.0:
        raise ValueError("proximal and distal joints coincide -- no direction to measure")
    ux, uy = dx / length, dy / length

    ys, xs = np.nonzero(mask)
    projections = ux * (xs.astype(np.float64) - ax) + uy * (ys.astype(np.float64) - ay)
    beyond_px = int((projections > length).sum())
    return beyond_px / foreground_px


def is_combined_with_next_segment(beyond_joint_fraction: float) -> bool:
    """True when `beyond_joint_fraction` (from `beyond_distal_joint_fraction`,
    an `upper_arm` part only -- see this module's docstring) exceeds
    `COMBINED_PART_BEYOND_JOINT_FRACTION_TOLERANCE`, i.e. this part's mask
    includes enough of the next anatomical segment that handing it to a
    consumer under its own part name would be wrong."""
    return beyond_joint_fraction > COMBINED_PART_BEYOND_JOINT_FRACTION_TOLERANCE
