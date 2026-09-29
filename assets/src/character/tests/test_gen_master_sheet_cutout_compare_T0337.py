"""[FIX ROUND 2] Panel/part-aware SAM3 point-prompt derivation and the
degenerate-mask sanity check, both pure/offline (no ComfyUI, no GPU, no
network) -- the reviewer's round-2 finding was that
`gen_master_sheet_cutout_compare_T0337.py` queried every panel, including
the legs-only panel, with a single fixed NECK point
(`_neck_pixel`/`_NECK_JOINT`), which is a real anatomical anchor for the
five whole-figure panels but a collapsed, invalid placeholder for the
"legs" panel (`pose_rig_master_sheet_T0351.LEGS_KEYPOINTS_NORM`'s
`_LEGS_UPPER_BODY_COLLAPSE_POINT`). These tests pin the two pieces of pure
decision logic this round adds: `panel_prompt_points` (derives a bounded,
panel-appropriate set of positive/negative point prompts from that panel's
own pose rig keypoints, never from the legs panel's collapsed placeholder)
and `is_degenerate_mask_fraction` (rejects a near-empty or near-full mask
by thresholds justified against this round's own recorded pixel counts).

RED state: neither function exists on `gen_master_sheet_cutout_compare_T0337`
yet -> AttributeError/ImportError.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_cutout_compare_T0337 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

PANEL_SIZE = gen.PANEL_SIZE


class TestPanelPromptPointsLegs:
    """The "legs" panel is the case the round-2 review named explicitly:
    its upper-body joints (nose/neck/shoulders/elbows/wrists/eyes/ears) all
    collapse to one placeholder point near the top edge -- not real
    anatomy -- so the derivation must source its points from hip/knee/ankle
    only, never from that collapsed joint."""

    def _records(self):
        points = rig.keypoints_for("legs")
        return gen.panel_prompt_points("legs", points, PANEL_SIZE)

    def test_returns_six_positive_points_thigh_lower_leg_boot_both_sides(self):
        records = self._records()
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 6
        derivations = " ".join(r["derivation"].lower() for r in positives)
        for side in ("right", "left"):
            assert side in derivations
        for part in ("thigh", "lower_leg", "boot"):
            assert part in derivations

    def test_no_positive_point_sits_on_the_collapsed_upper_body_placeholder(self):
        points = rig.keypoints_for("legs")
        collapse_x, collapse_y = points[1]  # NECK == the collapse point on this panel
        collapse_px = (int(collapse_x * PANEL_SIZE), int(collapse_y * PANEL_SIZE))
        records = self._records()
        positives = [r for r in records if r["polarity"] == "positive"]
        for r in positives:
            assert (r["x"], r["y"]) != collapse_px

    def test_negative_points_include_the_four_corners_and_the_collapse_point(self):
        records = self._records()
        negatives = [r for r in records if r["polarity"] == "negative"]
        coords = {(r["x"], r["y"]) for r in negatives}
        assert (4, 4) in coords
        assert (PANEL_SIZE - 4, 4) in coords
        assert (4, PANEL_SIZE - 4) in coords
        assert (PANEL_SIZE - 4, PANEL_SIZE - 4) in coords
        points = rig.keypoints_for("legs")
        collapse_x, collapse_y = points[1]
        assert (int(collapse_x * PANEL_SIZE), int(collapse_y * PANEL_SIZE)) in coords

    def test_all_points_are_in_bounds_and_carry_a_derivation_string(self):
        for r in self._records():
            assert 0 <= r["x"] <= PANEL_SIZE
            assert 0 <= r["y"] <= PANEL_SIZE
            assert r["polarity"] in ("positive", "negative")
            assert isinstance(r["derivation"], str) and r["derivation"]


class TestPanelPromptPointsWholeFigure:
    """The five whole-figure panels (front/back T-pose, both side-forward
    panels, side-neutral) do have a real neck -- but the round-2 finding
    covers them too: T-0351's own poses spread both arms/legs well clear of
    the torso (T-pose especially), and the withdrawn single-neck-point
    experiment's own committed numbers (16,777 / 7,467 px of 1,048,576 for
    front/back_tpose) show a single torso point does not reliably grow to
    the whole figure. These panels get positive points at the torso anchor
    plus both wrist and both ankle extremities."""

    def test_front_tpose_positive_points_cover_neck_wrists_and_ankles(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.panel_prompt_points("front_tpose", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 5
        derivations = " ".join(r["derivation"].lower() for r in positives)
        assert "neck" in derivations
        assert "wrist" in derivations
        assert "ankle" in derivations
        assert "right" in derivations and "left" in derivations

    def test_positive_point_pixel_coords_match_the_source_keypoints(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.panel_prompt_points("front_tpose", points, PANEL_SIZE)
        positives = {(r["x"], r["y"]) for r in records if r["polarity"] == "positive"}
        neck_x, neck_y = points[1]
        assert (int(neck_x * PANEL_SIZE), int(neck_y * PANEL_SIZE)) in positives
        r_wrist_x, r_wrist_y = points[4]
        assert (int(r_wrist_x * PANEL_SIZE), int(r_wrist_y * PANEL_SIZE)) in positives

    def test_negative_points_are_the_four_corners_only(self):
        points = rig.keypoints_for("side_neutral")
        records = gen.panel_prompt_points("side_neutral", points, PANEL_SIZE)
        negatives = [r for r in records if r["polarity"] == "negative"]
        assert len(negatives) == 4
        coords = {(r["x"], r["y"]) for r in negatives}
        assert coords == {
            (4, 4),
            (PANEL_SIZE - 4, 4),
            (4, PANEL_SIZE - 4),
            (PANEL_SIZE - 4, PANEL_SIZE - 4),
        }

    def test_bounded_not_a_sweep_every_panel_has_one_fixed_configuration(self):
        # Exactly one call, one deterministic record set per panel -- not a
        # sweep over multiple threshold/point configurations.
        for key in gen.PANEL_KEYS:
            points = rig.keypoints_for(key)
            first = gen.panel_prompt_points(key, points, PANEL_SIZE)
            second = gen.panel_prompt_points(key, points, PANEL_SIZE)
            assert first == second


class TestIsDegenerateMaskFraction:
    """Thresholds justified against this round's own committed numbers
    (docs/assets/evidence/T-0337/comparison.json, the withdrawn
    single-neck-point experiment): the three unusable masks measured
    16,777 / 7,467 / 547 px of a 1,048,576 px (1024x1024) panel -- fractions
    0.016 / 0.007 / 0.0005 -- while Oklab's own flood on the same six panels
    spans roughly 0.124-0.396. The low threshold sits strictly between the
    worst failure (0.016) and the smallest plausible Oklab result (0.124);
    the high threshold sits strictly above the largest plausible Oklab
    result (0.396)."""

    TOTAL_PX = 1024 * 1024

    def test_the_three_withdrawn_single_point_failures_are_degenerate(self):
        for foreground_px in (16777, 7467, 547):
            assert gen.is_degenerate_mask_fraction(foreground_px, self.TOTAL_PX) is True

    def test_the_plausible_oklab_range_is_not_degenerate(self):
        for foreground_px in (130298, 235408, 299515, 392045, 410555, 415174):
            assert gen.is_degenerate_mask_fraction(foreground_px, self.TOTAL_PX) is False

    def test_a_near_full_panel_mask_is_degenerate(self):
        assert gen.is_degenerate_mask_fraction(950000, self.TOTAL_PX) is True

    def test_zero_total_px_raises(self):
        import pytest

        with pytest.raises(ValueError):
            gen.is_degenerate_mask_fraction(100, 0)
