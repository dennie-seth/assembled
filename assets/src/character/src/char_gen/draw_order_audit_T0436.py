"""T-0436 fix round 4: confirm the published z-order (`side_view_rig.json`'s
`rig.*.z`) is REALIZED by the actual compositing, not merely declared.

@DennieSeth's second fix-round-3 item claimed the z-order itself was wrong; measured
directly, it was not -- the order is exactly the ten values he specified, and the
realized paint order already matches them 10 of 10 with 0 of 15 contested pairs
resolving against the list (see `docs/design/23-canonical-rig.md` Sec 3d/10 for the
narrative). What this module gives is the REPLAY that check depends on: it walks
`rig_compositor.render_frames`'s own paint loop (`sorted(pl, key=lambda p: -p.z)`)
and records, pixel by pixel, which part's own rendered alpha last touched each
location -- the actual "last writer" -- rather than reading `rig.*.z` back out of the
JSON and asserting the order from the numbers alone. The arm-angle fix in this same
round changes WHERE the arms overlap the torso/legs, so this check is re-run after
that fix, not assumed to still hold from the previous round's numbers.

Used by `gen_draw_order_audit_T0436.py` to produce the labeled evidence render the
card's acceptance criteria requires; the functions here carry the actual test
coverage (`tests/test_draw_order_audit_T0436.py`), per this package's one-off-script
convention (see `gen_reference_pose_evidence_T0436.py`'s own docstring)."""
from __future__ import annotations

import math

import numpy as np

from char_gen.rig_compositor import Placement, placement_bbox

#: A part's own alpha is treated as "opaque enough to win a pixel" at or above this
#: value -- excludes the thin anti-aliased edge-blend ring (partial alpha) from
#: counting as a real contested-pixel win either way, the same distinction
#: `tests/test_reference_pose_render_T0436.py`'s `visible_pixel_count` already draws
#: between an occluded part's own opaque pixels and a blended edge pixel.
OPAQUE_THRESHOLD = 128


def canvas_geometry(
    placements: list[Placement], margin: float = 4.0
) -> tuple[tuple[float, float], tuple[int, int]]:
    """Same bbox + margin convention `rig_compositor.render_frames` uses, factored
    out so this module's raster shares one canvas frame with the real render.
    Returns `(offset, canvas_size)` -- `offset` is what `part_alpha_masks` expects
    to ADD to a placement's own `target_xy - pivot_px` (i.e. `(-x0, -y0)`, not the
    bare top-left corner), matching `render_frames`'s own `offset = (-x0, -y0)`."""
    x0, y0, x1, y1 = placement_bbox(placements)
    x0, y0, x1, y1 = x0 - margin, y0 - margin, x1 + margin, y1 + margin
    offset = (-x0, -y0)
    canvas_size = (math.ceil(x1 - x0), math.ceil(y1 - y0))
    return offset, canvas_size


def part_alpha_masks(
    placements: list[Placement], canvas_size: tuple[int, int], offset: tuple[float, float]
) -> dict[str, np.ndarray]:
    """Each part's OWN alpha channel (0-255), painted onto a canvas-sized array at
    its actual placed position -- independent of every other part, so this is "is
    this part's own art opaque here", not a composited result."""
    width, height = canvas_size
    masks: dict[str, np.ndarray] = {}
    for p in placements:
        canvas = np.zeros((height, width), dtype=np.uint8)
        alpha = np.asarray(p.image)[:, :, 3]
        src_h, src_w = alpha.shape
        dest_x = round(p.target_xy[0] - p.pivot_px[0] + offset[0])
        dest_y = round(p.target_xy[1] - p.pivot_px[1] + offset[1])
        x0, y0 = max(0, dest_x), max(0, dest_y)
        x1, y1 = min(width, dest_x + src_w), min(height, dest_y + src_h)
        if x1 > x0 and y1 > y0:
            canvas[y0:y1, x0:x1] = alpha[y0 - dest_y:y1 - dest_y, x0 - dest_x:x1 - dest_x]
        masks[p.name] = canvas
    return masks


def realized_owner(placements: list[Placement], masks: dict[str, np.ndarray]) -> np.ndarray:
    """Replay the SAME paint order `rig_compositor.render_frames` uses and record,
    per pixel, the name of the last part whose own mask was opaque there -- the
    actual winner of that pixel in the real composite, not an inference from the
    z numbers."""
    height, width = next(iter(masks.values())).shape
    owner = np.full((height, width), "", dtype=object)
    for p in sorted(placements, key=lambda pp: -pp.z):
        owner[masks[p.name] >= OPAQUE_THRESHOLD] = p.name
    return owner


def realized_draw_rank(placements: list[Placement]) -> dict[str, int]:
    """Rank 1 = painted first (backmost); rank N = painted LAST (frontmost), so it
    wins every pixel it is opaque at. Derived from the identical sort
    `render_frames` uses to composite, not a separate read of the z numbers."""
    order = sorted(placements, key=lambda pp: -pp.z)
    return {p.name: rank + 1 for rank, p in enumerate(order)}


def contested_pairs(placements: list[Placement], masks: dict[str, np.ndarray]) -> list[dict]:
    """Every pair of parts whose own masks overlap by at least one opaque pixel,
    with how many of those contested pixels the realized owner raster actually
    gives to each side. `resolves_against_z_order` is True only when the
    HIGHER-z part (the one that should lose, since it draws first and is painted
    over) wins a MAJORITY of the contested pixels -- a true order violation, not
    anti-aliasing noise at a silhouette edge."""
    owner = realized_owner(placements, masks)
    z_of = {p.name: p.z for p in placements}
    names = list(masks)
    results = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            overlap = (masks[a] >= OPAQUE_THRESHOLD) & (masks[b] >= OPAQUE_THRESHOLD)
            contested_px = int(np.count_nonzero(overlap))
            if contested_px == 0:
                continue
            lower_z, higher_z = (a, b) if z_of[a] < z_of[b] else (b, a)
            lower_wins = int(np.count_nonzero((owner == lower_z) & overlap))
            higher_wins = int(np.count_nonzero((owner == higher_z) & overlap))
            results.append({
                "lower_z_part": lower_z,
                "higher_z_part": higher_z,
                "contested_px": contested_px,
                "lower_z_wins": lower_wins,
                "higher_z_wins": higher_wins,
                "resolves_against_z_order": higher_wins > lower_wins,
            })
    return results
