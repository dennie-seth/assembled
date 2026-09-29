"""Pure, offline mask-postprocessing helpers for genuinely independent
per-part SAM3 cutouts (T-0417): connected-component isolation ("keep the
component the positive point falls inside") and pairwise mask overlap, the
two mechanical checks the round-3 reviewer named explicitly -- "a total-area
threshold alone never established the clean isolation" the combined-mask
experiment claimed. Neither function talks to ComfyUI/GPU; both operate on
plain boolean numpy arrays so they run in CI with no live host.

RED state: `char_gen.part_isolation` does not exist yet -> ImportError.
"""

from __future__ import annotations

import numpy as np
import pytest

from char_gen.part_isolation import (
    is_part_mask_degenerate,
    keep_components_containing_points,
    mask_overlap_fraction,
)


def _mask(shape=(64, 64)) -> np.ndarray:
    return np.zeros(shape, dtype=bool)


class TestKeepComponentsContainingPoints:
    """The stated policy for a part request that returns several
    disconnected components (e.g. a boot plus a stray fragment): keep only
    the component(s) the part's own positive point(s) fall inside, and
    report how much foreground was discarded as a stray fraction -- not a
    silent merge, not a total-area-only judgement."""

    def test_single_blob_containing_the_point_is_kept_unchanged(self):
        m = _mask()
        m[10:20, 10:20] = True
        cleaned, diag = keep_components_containing_points(m, [(15, 15)])
        assert np.array_equal(cleaned, m)
        assert diag["component_count"] == 1
        assert diag["stray_px"] == 0
        assert diag["stray_fraction"] == 0.0
        assert diag["foreground_px_before"] == 100
        assert diag["foreground_px_after"] == 100

    def test_stray_fragment_disconnected_from_the_point_is_dropped(self):
        m = _mask()
        m[10:20, 10:20] = True  # main blob, 100px -- contains the point
        m[50:53, 50:53] = True  # stray fragment, 9px -- disconnected
        cleaned, diag = keep_components_containing_points(m, [(15, 15)])
        assert cleaned[15, 15]
        assert not cleaned[51, 51]
        assert diag["component_count"] == 2
        assert diag["foreground_px_before"] == 109
        assert diag["foreground_px_after"] == 100
        assert diag["stray_px"] == 9
        assert diag["stray_fraction"] == pytest.approx(9 / 109)

    def test_multiple_positive_points_keep_every_component_they_fall_in(self):
        m = _mask()
        m[0:5, 0:5] = True  # contains point A
        m[30:35, 30:35] = True  # contains point B
        m[60:63, 60:63] = True  # stray, contains neither point
        cleaned, diag = keep_components_containing_points(m, [(2, 2), (32, 32)])
        assert cleaned[2, 2] and cleaned[32, 32]
        assert not cleaned[61, 61]
        assert diag["component_count"] == 3
        assert diag["foreground_px_after"] == 25 + 25

    def test_all_false_mask_has_no_components_and_is_returned_unchanged(self):
        m = _mask()
        cleaned, diag = keep_components_containing_points(m, [(5, 5)])
        assert not cleaned.any()
        assert diag["component_count"] == 0
        assert diag["foreground_px_before"] == 0
        assert diag["foreground_px_after"] == 0
        assert diag["stray_fraction"] == 0.0

    def test_point_landing_on_background_keeps_no_component_for_it(self):
        # The point itself isn't foreground -- e.g. a slightly-off anchor --
        # so it contributes nothing to "kept"; other components still drop.
        m = _mask()
        m[10:20, 10:20] = True
        cleaned, diag = keep_components_containing_points(m, [(0, 0)])
        assert not cleaned.any()
        assert diag["foreground_px_after"] == 0
        assert diag["stray_px"] == 100


class TestMaskOverlapFraction:
    """Overlap is intersection over the SMALLER of the two masks' own areas
    -- a small part (a boot) sitting mostly inside a larger neighbour (a
    lower leg) is exactly the failure mode "isolation judged on more than
    total area" exists to catch, and dividing by the smaller area (rather
    than union/Jaccard) makes that failure read as a large fraction instead
    of being diluted by the bigger mask's own size."""

    def test_disjoint_masks_have_zero_overlap(self):
        a, b = _mask(), _mask()
        a[0:10, 0:10] = True
        b[20:30, 20:30] = True
        assert mask_overlap_fraction(a, b) == 0.0

    def test_fully_nested_small_mask_has_overlap_one(self):
        a, b = _mask(), _mask()
        a[0:20, 0:20] = True  # 400px
        b[5:10, 5:10] = True  # 25px, entirely inside a
        assert mask_overlap_fraction(a, b) == pytest.approx(1.0)
        assert mask_overlap_fraction(b, a) == pytest.approx(1.0)

    def test_partial_overlap_divides_by_the_smaller_area(self):
        a, b = _mask(), _mask()
        a[0:10, 0:10] = True  # 100px
        b[5:15, 5:15] = True  # 100px, overlap region [5:10,5:10] = 25px
        assert mask_overlap_fraction(a, b) == pytest.approx(25 / 100)

    def test_either_mask_empty_is_zero_overlap(self):
        a, b = _mask(), _mask()
        a[0:10, 0:10] = True
        assert mask_overlap_fraction(a, b) == 0.0
        assert mask_overlap_fraction(b, a) == 0.0


class TestIsPartMaskDegenerate:
    """Per-part thresholds are deliberately much lower than the whole-figure
    thresholds `gen_master_sheet_cutout_compare_T0337.is_degenerate_mask_fraction`
    uses -- a single leg segment is a fraction of a whole two-legged mask, not
    comparable to it. Justified against T-0337's own committed round-2 number
    for the combined six-point legs mask (173,562 / 1,048,576 = 0.166 for
    *both* legs together): a single part should be well under that, so the
    high threshold (0.35) sits more than double it, and the low threshold
    (0.002, ~2,097px on a 1024x1024 panel) is small enough to admit a
    legitimately narrow part crop (a boot) while still catching a
    near-empty/failed detection."""

    TOTAL_PX = 1024 * 1024

    def test_a_near_empty_part_mask_is_degenerate(self):
        assert is_part_mask_degenerate(200, self.TOTAL_PX) is True

    def test_a_plausible_single_part_fraction_is_not_degenerate(self):
        for foreground_px in (3000, 20000, 60000, 150000):
            assert is_part_mask_degenerate(foreground_px, self.TOTAL_PX) is False

    def test_a_mask_as_large_as_the_whole_combined_legs_result_is_degenerate(self):
        # 300,000px alone (one "part") is already well past a single part's
        # plausible share of the 173,562px whole-combined-legs precedent.
        assert is_part_mask_degenerate(400000, self.TOTAL_PX) is True

    def test_zero_total_px_raises(self):
        with pytest.raises(ValueError):
            is_part_mask_degenerate(100, 0)
