"""T-0436 fix round 5 (+ fix round 7's L/R suffix rename): the far shoulder's
attachment to the torso.

@DennieSeth's fix-round-4 verification found a new defect in the reference-pose
render: the far shoulder reads as detached from the body -- a wedge of visible
background in the "armhole" between the sleeve and the torso, right where the arm
should plug in. (Fix round 5 itself measured this on `shoulder_L`, the far side at
that time; fix round 6 swapped the near/far layering to Option B, which made
`shoulder_R` the far side; fix round 7 then swapped the L/R suffix on all eight
limb parts so the name tracks draw depth directly -- near/front = `_R`, far/behind
= `_L` again -- see `shoulder_name` below.) The initial read (scale the part up
5-10%) does not work, for a mechanical reason: a part is pinned at its own PIVOT,
which for either shoulder part is its PROXIMAL (shoulder) joint
(`side_view_rig.json`'s `rig.<part>.pivot`). Scaling moves only the DISTAL end
further out -- the proximal end, and therefore the gap at the body, is untouched at
every scale factor.

What actually causes the wedge is fix round 2's arm-chain `lateral_offset_frac`
(`canonical_rig.lateral_offset_axis.demonstration_values`, magnitude 0.35 through
fix round 4): it pushes the whole far-arm chain sideways to clear the torso
silhouette, and at that magnitude it over-pushes, carrying the sleeve's proximal
end away from the torso instead of just clear of it. This module gives the two
measurements that quantify that, reused by `tests/test_shoulder_attachment_T0436.py`
and by `gen_reference_pose_evidence_T0436.py` when it regenerates the evidence
renders:

* `armhole_wedge_px` -- background pixels enclosed between the far shoulder part
  and `torso`, within `radius` of that shoulder's own joint.
* `sleeve_torso_overlap_px` -- pixels where the far shoulder's own mask and
  `torso`'s own mask are BOTH opaque -- a genuine overlap, not an abutment.

The fix itself is two independent changes, neither touching the committed part art
(the far shoulder's PNG, renamed `shoulder_L.png` this round but byte-identical to
the file it was renamed from, per this card's own no-re-cut rule):

1. The arm-chain lateral offset's magnitude drops from 0.35 to 0.10
   (`canonical_rig.lateral_offset_axis.demonstration_values`) -- see
   `fix_round_5_note` in `side_view_rig.json` for the swept bracket. Fix round 6
   moved WHICH side carried it (that round's `shoulder_R`/`forearm_R`); fix round 7
   renamed that same physical far side back to `shoulder_L`/`forearm_L`, without
   changing the magnitude either time.
2. `bone_length_fix.scaled.shoulder_R` is ANISOTROPIC (`rig_compositor.scaled_parts`'s
   `{height, width}` form) -- the height scale that corrects the bone length is
   unchanged, but the width scale returns to 1.0, restoring the sleeve's own cut
   width (113px, not the 69px the old isotropic 0.6087 scale shrank it to) without
   moving the bone. This correction stays keyed to `shoulder_R` specifically (fix
   round 7's near/front name for the part with the longer cut) -- it corrects THAT
   PNG's own longer cut, not whichever side is far, regardless of which side the
   lateral offset lives on.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

from char_gen.draw_order_audit_T0436 import OPAQUE_THRESHOLD, canvas_geometry, part_alpha_masks
from char_gen.rig_compositor import Placement


def _shoulder_joint_canvas_xy(
    placements: list[Placement], offset: tuple[float, float], shoulder_name: str
) -> tuple[float, float]:
    joint = next(p for p in placements if p.name == shoulder_name)
    return (joint.target_xy[0] + offset[0], joint.target_xy[1] + offset[1])


def armhole_wedge_px(
    placements: list[Placement], radius: float = 130.0, shoulder_name: str = "shoulder_L",
) -> int:
    """Background pixels enclosed between `shoulder_name` and `torso`, within
    `radius` canvas px of `shoulder_name`'s own joint. "Enclosed" is a per-row
    (scanline) test: for each row within the circle, find `torso`'s own opaque
    x-range and `shoulder_name`'s own opaque x-range on that row; if the two ranges
    don't overlap, the background pixels strictly BETWEEN them (whichever range
    sits to which side) are the wedge -- the gap a viewer reads as "the sleeve
    doesn't plug into the body here." A row where the two ranges already overlap
    (or either part isn't present at all) contributes nothing. `shoulder_name`
    defaults to `shoulder_L`, the far side under the committed fix-round-7 naming
    (near/front = `_R`, far/behind = `_L`) -- pass `shoulder_R` explicitly for the
    fix-round-5 geometry (that round's far side, before fix round 6's z-order swap
    and fix round 7's name swap)."""
    offset, canvas_size = canvas_geometry(placements)
    masks = part_alpha_masks(placements, canvas_size, offset)
    torso_mask = masks["torso"] >= OPAQUE_THRESHOLD
    shoulder_mask = masks[shoulder_name] >= OPAQUE_THRESHOLD
    joint_x, joint_y = _shoulder_joint_canvas_xy(placements, offset, shoulder_name)

    height, width = torso_mask.shape
    y_lo = max(0, int(math.floor(joint_y - radius)))
    y_hi = min(height, int(math.ceil(joint_y + radius)) + 1)

    wedge_px = 0
    for y in range(y_lo, y_hi):
        dy2 = (y - joint_y) ** 2
        if dy2 > radius * radius:
            continue
        torso_xs = np.nonzero(torso_mask[y])[0]
        shoulder_xs = np.nonzero(shoulder_mask[y])[0]
        if torso_xs.size == 0 or shoulder_xs.size == 0:
            continue
        torso_min, torso_max = int(torso_xs.min()), int(torso_xs.max())
        sh_min, sh_max = int(shoulder_xs.min()), int(shoulder_xs.max())
        if sh_max < torso_min:
            lo, hi = sh_max + 1, torso_min
        elif torso_max < sh_min:
            lo, hi = torso_max + 1, sh_min
        else:
            continue  # the two ranges already overlap on this row -- no gap
        dx_max = math.sqrt(max(0.0, radius * radius - dy2))
        x_lo = max(lo, int(math.ceil(joint_x - dx_max)))
        x_hi = min(hi, int(math.floor(joint_x + dx_max)) + 1)
        for x in range(x_lo, x_hi):
            if not torso_mask[y, x] and not shoulder_mask[y, x]:
                wedge_px += 1
    return wedge_px


def sleeve_torso_overlap_px(
    placements: list[Placement], shoulder_name: str = "shoulder_L",
) -> int:
    """How many canvas pixels have BOTH `shoulder_name`'s own mask and `torso`'s
    own mask opaque -- a genuine overlap (the sleeve's proximal end sits inside the
    torso's own silhouette), not merely two shapes that happen to touch.
    `shoulder_name` defaults to `shoulder_L`, the far side under the committed
    fix-round-7 naming."""
    offset, canvas_size = canvas_geometry(placements)
    masks = part_alpha_masks(placements, canvas_size, offset)
    torso_mask = masks["torso"] >= OPAQUE_THRESHOLD
    shoulder_mask = masks[shoulder_name] >= OPAQUE_THRESHOLD
    return int(np.count_nonzero(torso_mask & shoulder_mask))


def visible_pixel_count(placements: list[Placement], part_name: str) -> int:
    """How many composited pixels are `part_name`'s own, non-transparent
    contribution to the final render -- a pixel counts only if removing the part
    changes the composite there AND the with-part result is itself opaque there
    (an occluded part's own opaque pixels, hidden behind something painted after
    it, do not count). Same definition
    `tests/test_reference_pose_render_T0436.py`'s own `visible_pixel_count` uses;
    duplicated here (rather than imported from a test module) so this production
    module -- and `gen_reference_pose_evidence_T0436.py`, which needs the exact
    same measure to regenerate evidence -- do not reach into `tests/`."""
    without_part = [p for p in placements if p.name != part_name]

    xs = [p.target_xy[0] - p.pivot_px[0] for p in placements]
    ys = [p.target_xy[1] - p.pivot_px[1] for p in placements]
    x0, y0 = min(xs) - 4.0, min(ys) - 4.0
    x1 = max(x + p.image.width for x, p in zip(xs, placements)) + 4.0
    y1 = max(y + p.image.height for y, p in zip(ys, placements)) + 4.0
    size = (int(x1 - x0), int(y1 - y0))

    def composite(pls: list[Placement]) -> Image.Image:
        canvas = Image.new("RGBA", size, (0, 0, 0, 0))
        for p in sorted(pls, key=lambda pp: -pp.z):
            dest = (
                round(p.target_xy[0] - p.pivot_px[0] - x0),
                round(p.target_xy[1] - p.pivot_px[1] - y0),
            )
            canvas.alpha_composite(p.image, dest=dest)
        return canvas

    arr_with = np.asarray(composite(placements))
    arr_without = np.asarray(composite(without_part))
    differs = np.any(arr_with != arr_without, axis=-1)
    is_opaque = arr_with[:, :, 3] > 0
    return int(np.count_nonzero(differs & is_opaque))
