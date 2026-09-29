"""Mask-quality checks for genuinely independent per-part SAM3 cutouts
(T-0417) -- the two mechanisms the round-3 review named as missing from
T-0337's combined-mask experiment: "a total-area threshold alone never
established the clean isolation the README claimed," and "the current
combined-mask experiment cannot establish either success or failure at
separating those parts." Isolation here is judged on more than total area:

  - `keep_components_containing_points` implements the stated policy for a
    part request that returns several disconnected components (a boot plus
    a stray fragment) -- keep the component(s) the part's own positive
    point(s) fall inside, drop the rest, and report how much was dropped
    (`stray_fraction`) rather than silently accepting whatever total area
    came back.
  - `mask_overlap_fraction` measures how much two sibling parts' own masks
    (e.g. a thigh and the lower leg sharing a knee) overlap, so that overlap
    can be judged against a stated tolerance instead of ignored.

Connected-component labelling is implemented here as a small, self-contained
4-connectivity flood fill, not `scipy.ndimage.label` -- `char-gen`'s own
`pyproject.toml` deliberately does not pin scipy (see the existing
best-effort `from scipy import ndimage` call sites in `synth_entities.py`
and `gen_arm_a_idle_T0228.py`, which no-op when it's absent); this module's
correctness is load-bearing for the isolation verdict itself, so it does not
depend on an optional package being installed.
"""

from __future__ import annotations

import numpy as np

#: Per-part degenerate-fraction thresholds for a 1024x1024 panel -- distinct
#: from `gen_master_sheet_cutout_compare_T0337.DEGENERATE_MASK_FRACTION_*`,
#: which are tuned for a WHOLE-figure/whole-legs mask. A single part is a
#: fraction of that: T-0337's own committed FIX ROUND 2 number for the
#: combined six-point "legs" mask (both legs together) is 173,562px of
#: 1,048,576 -- fraction 0.166. PART_DEGENERATE_FRACTION_LOW (0.002, ~2,097px)
#: is small enough to admit a legitimately narrow single part (a boot) while
#: still catching a near-empty/failed detection; PART_DEGENERATE_FRACTION_HIGH
#: (0.35) sits more than double the whole-combined-legs precedent, so a
#: single part claiming that much of the panel has almost certainly bled
#: into a sibling part or the background, not genuinely isolated one limb.
PART_DEGENERATE_FRACTION_LOW = 0.002
PART_DEGENERATE_FRACTION_HIGH = 0.35

#: A sibling-part mask overlapping more than this fraction of the SMALLER
#: mask's own area is treated as "not actually separated" rather than two
#: independently isolated parts. Some overlap near a shared joint (thigh vs.
#: lower leg at the knee) is expected from point-derived anchors and mask
#: smoothing; 0.25 is chosen to tolerate that boundary blur while still
#: catching the failure mode the round-3 overlay actually showed -- both
#: legs' full masks reported as if they were separate parts, which would
#: measure as near-total overlap, far above this threshold.
PART_OVERLAP_FRACTION_TOLERANCE = 0.25

#: 4-connectivity neighbour offsets for the flood fill below.
_NEIGHBOR_OFFSETS: tuple[tuple[int, int], ...] = ((-1, 0), (1, 0), (0, -1), (0, 1))


def _label_connected_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """4-connectivity connected-component labelling over a boolean mask.
    Returns `(labels, component_count)` where `labels` is an int array the
    same shape as `mask`, 0 for background and 1..component_count for each
    component. Pure numpy/Python -- see this module's own docstring for why
    this isn't `scipy.ndimage.label`."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    current = 0
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or labels[y, x] != 0:
                continue
            current += 1
            stack = [(y, x)]
            labels[y, x] = current
            while stack:
                cy, cx = stack.pop()
                for dy, dx in _NEIGHBOR_OFFSETS:
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and labels[ny, nx] == 0:
                        labels[ny, nx] = current
                        stack.append((ny, nx))
    return labels, current


def keep_components_containing_points(
    mask: np.ndarray, points_px: list[tuple[int, int]]
) -> tuple[np.ndarray, dict]:
    """Keep only the connected component(s) that at least one of
    `points_px` (each an `(x, y)` pixel coordinate) falls inside; drop every
    other component as a stray fragment. A point landing on a background
    pixel (not foreground at all) keeps nothing for that point -- it does
    not fall back to "nearest component."

    Returns `(cleaned_mask, diagnostics)` where `diagnostics` carries
    `component_count`, `foreground_px_before`, `foreground_px_after`,
    `stray_px` and `stray_fraction` (0.0 when there was no foreground to
    begin with, never a divide-by-zero)."""
    labels, component_count = _label_connected_components(mask)
    foreground_px_before = int(mask.sum())

    kept_ids: set[int] = set()
    h, w = mask.shape
    for x, y in points_px:
        if 0 <= y < h and 0 <= x < w:
            label_id = int(labels[y, x])
            if label_id != 0:
                kept_ids.add(label_id)

    cleaned = np.isin(labels, list(kept_ids)) if kept_ids else np.zeros_like(mask, dtype=bool)
    foreground_px_after = int(cleaned.sum())
    stray_px = foreground_px_before - foreground_px_after
    stray_fraction = (stray_px / foreground_px_before) if foreground_px_before > 0 else 0.0

    return cleaned, {
        "component_count": component_count,
        "kept_component_ids": sorted(kept_ids),
        "foreground_px_before": foreground_px_before,
        "foreground_px_after": foreground_px_after,
        "stray_px": stray_px,
        "stray_fraction": stray_fraction,
    }


def mask_overlap_fraction(mask_a: np.ndarray, mask_b: np.ndarray) -> float:
    """Fraction of the SMALLER mask's own area that overlaps the other --
    see this module's docstring for why dividing by the smaller area (not
    union/Jaccard) is the right measure for "did a part bleed into its
    neighbour." Returns 0.0 when either mask is empty."""
    area_a = int(mask_a.sum())
    area_b = int(mask_b.sum())
    if area_a == 0 or area_b == 0:
        return 0.0
    intersection = int(np.logical_and(mask_a, mask_b).sum())
    return intersection / min(area_a, area_b)


def is_part_mask_degenerate(foreground_px: int, total_px: int) -> bool:
    """True when `foreground_px / total_px` falls outside the plausible
    range for a real single-part mask on a 1024x1024 panel -- pure
    arithmetic, no ComfyUI/host dependency, so it runs offline. See this
    module's own `PART_DEGENERATE_FRACTION_LOW`/`_HIGH` docstring for the
    justification."""
    if total_px <= 0:
        raise ValueError("total_px must be positive")
    fraction = foreground_px / total_px
    return fraction < PART_DEGENERATE_FRACTION_LOW or fraction > PART_DEGENERATE_FRACTION_HIGH
