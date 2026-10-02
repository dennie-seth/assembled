"""Offline reproduction of Chat's review finding on PR #426 (T-0423 FIX
ROUND): `front_tpose/right_upper_arm` is mechanically `isolated: true` but
46.9% of its own retained pixels lie on the wrist side of the elbow --
mechanical isolation (`part_isolation.py`) has no notion of a part's own
anatomical extent, so it cannot catch a part that swallowed its neighbour.

This module tests `char_gen.part_suitability`, a new, purely additive
offline check computed from the already-committed mask PNGs and rig
keypoints -- no SAM3, no ComfyUI, no GPU, and no mask/threshold/isolation
verdict in `docs/assets/evidence/T-0417/part_comparison.json` is touched by
this module or these tests.

RED state: `char_gen.part_suitability` does not yet exist ->
`ModuleNotFoundError` below.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_cutout_compare_T0337 as compare_t0337  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

from char_gen.part_suitability import (  # noqa: E402
    COMBINED_PART_BEYOND_JOINT_FRACTION_TOLERANCE,
    beyond_distal_joint_fraction,
    is_combined_with_next_segment,
)

EVIDENCE_DIR = Path(__file__).resolve().parents[4] / "docs" / "assets" / "evidence" / "T-0417"

# COCO-18 indices, same numbering as pose_rig_master_sheet_T0351.py.
_R_SHOULDER, _R_ELBOW = 2, 3


def _mask_from_png(path: Path) -> np.ndarray:
    return np.array(Image.open(path)) > 0


class TestBeyondDistalJointFractionSynthetic:
    """Unit coverage on tiny synthetic masks -- deterministic, no committed
    evidence files involved, so these pin the geometry itself rather than
    any one SAM3 run's output."""

    def test_all_pixels_within_segment_is_zero_fraction(self):
        mask = np.zeros((10, 10), dtype=bool)
        mask[4:6, 1:5] = True  # entirely left of x=5
        frac = beyond_distal_joint_fraction(mask, proximal_joint_px=(0, 5), distal_joint_px=(5, 5))
        assert frac == pytest.approx(0.0)

    def test_half_the_mask_past_the_distal_joint_is_half_fraction(self):
        mask = np.zeros((10, 10), dtype=bool)
        mask[4:6, 0:10] = True  # x in [0, 10), distal joint at x=4.5 -> half past it
        frac = beyond_distal_joint_fraction(
            mask, proximal_joint_px=(0, 5), distal_joint_px=(4.5, 5)
        )
        assert frac == pytest.approx(0.5, abs=0.02)

    def test_direction_generalizes_to_a_non_horizontal_segment(self):
        mask = np.zeros((20, 20), dtype=bool)
        mask[0:10, 10] = True  # a vertical column, y in [0, 10)
        # proximal at y=10 (bottom), distal at y=5 (midpoint) -> upper half (y<5) is "beyond"
        frac = beyond_distal_joint_fraction(
            mask, proximal_joint_px=(10, 10), distal_joint_px=(10, 5)
        )
        assert frac == pytest.approx(0.5, abs=0.02)

    def test_raises_on_empty_mask(self):
        mask = np.zeros((10, 10), dtype=bool)
        with pytest.raises(ValueError, match="no foreground pixels"):
            beyond_distal_joint_fraction(mask, proximal_joint_px=(0, 0), distal_joint_px=(5, 5))

    def test_raises_when_joints_coincide(self):
        mask = np.ones((10, 10), dtype=bool)
        with pytest.raises(ValueError, match="coincide"):
            beyond_distal_joint_fraction(mask, proximal_joint_px=(3, 3), distal_joint_px=(3, 3))


class TestIsCombinedWithNextSegment:
    def test_below_tolerance_is_not_combined(self):
        assert is_combined_with_next_segment(0.013) is False

    def test_above_tolerance_is_combined(self):
        assert is_combined_with_next_segment(0.469) is True

    def test_tolerance_is_strictly_exceeded_not_met(self):
        assert is_combined_with_next_segment(COMBINED_PART_BEYOND_JOINT_FRACTION_TOLERANCE) is False


@pytest.mark.skipif(not EVIDENCE_DIR.exists(), reason="T-0417/T-0423 evidence dir not present")
class TestFrontTposeRightUpperArmReproducesTheReviewFinding:
    """Pins the review's own number against the actual committed mask +
    rig keypoints: 13,623 of 29,077 pixels (46.9%) lie past x=235 (the
    elbow), reproducing "13,623 of its 29,077 retained pixels (46.9%) lie
    on the wrist side of the elbow" from the card's Finding 1 exactly,
    computed, not retyped."""

    def _load(self):
        mask = _mask_from_png(
            EVIDENCE_DIR / "panel_front_tpose_part_right_upper_arm_mask.png"
        )
        keypoints = rig.FRONT_TPOSE_KEYPOINTS_NORM
        shoulder_px = compare_t0337._px(keypoints[_R_SHOULDER], compare_t0337.PANEL_SIZE)
        elbow_px = compare_t0337._px(keypoints[_R_ELBOW], compare_t0337.PANEL_SIZE)
        return mask, shoulder_px, elbow_px

    def test_elbow_x_is_235_in_panel_pixel_space(self):
        _, _shoulder_px, elbow_px = self._load()
        assert elbow_px[0] == 235

    def test_pixel_counts_match_the_committed_mask(self):
        mask, _, _ = self._load()
        assert int(mask.sum()) == 29077

    def test_beyond_elbow_fraction_matches_the_review_finding(self):
        mask, shoulder_px, elbow_px = self._load()
        frac = beyond_distal_joint_fraction(mask, shoulder_px, elbow_px)
        assert frac == pytest.approx(0.4685146335591705, abs=1e-9)
        # the review's own rounded figure, reproduced independently:
        assert round(frac * 100, 1) == 46.9

    def test_classified_combined_not_compositor_ready(self):
        mask, shoulder_px, elbow_px = self._load()
        frac = beyond_distal_joint_fraction(mask, shoulder_px, elbow_px)
        assert is_combined_with_next_segment(frac) is True


@pytest.mark.skipif(not EVIDENCE_DIR.exists(), reason="T-0417/T-0423 evidence dir not present")
class TestCleanUpperArmsAreNotFlaggedCombined:
    """The discriminating-threshold claim only holds if at least one
    present, mechanically-clean upper-arm part sits well under tolerance --
    `back_tpose/right_upper_arm` (1.3% beyond its own elbow) is that case,
    confirming 0.20 doesn't just happen to separate a single pair."""

    def test_back_tpose_right_upper_arm_is_not_combined(self):
        mask = _mask_from_png(
            EVIDENCE_DIR / "panel_back_tpose_part_right_upper_arm_mask.png"
        )
        keypoints = rig.BACK_TPOSE_KEYPOINTS_NORM
        shoulder_px = compare_t0337._px(keypoints[_R_SHOULDER], compare_t0337.PANEL_SIZE)
        elbow_px = compare_t0337._px(keypoints[_R_ELBOW], compare_t0337.PANEL_SIZE)
        frac = beyond_distal_joint_fraction(mask, shoulder_px, elbow_px)
        assert frac < 0.05
        assert is_combined_with_next_segment(frac) is False


@pytest.mark.skipif(not EVIDENCE_DIR.exists(), reason="T-0417/T-0423 evidence dir not present")
class TestCommittedRecordsUnchangedByThisRound:
    """This round adds interpretation, never revises measurement -- pins
    the exact pixel counts/verdicts this round's own Finding 1 depends on
    so an accidental edit to the committed evidence during this fix round
    fails loudly here rather than silently drifting from `6e8d27ac`."""

    def test_part_comparison_json_front_tpose_right_upper_arm_unchanged(self):
        data = json.loads((EVIDENCE_DIR / "part_comparison.json").read_text())
        rec = data["panels"]["front_tpose"]["parts"]["right_upper_arm"]
        assert rec["foreground_px_after_isolation"] == 29077
        assert rec["isolated"] is True
        assert rec["overlap_exceeds_tolerance"] is False

    def test_part_comparison_json_front_tpose_head_unchanged(self):
        data = json.loads((EVIDENCE_DIR / "part_comparison.json").read_text())
        rec = data["panels"]["front_tpose"]["parts"]["head"]
        assert rec["foreground_px_after_isolation"] == 5527
        assert rec["isolated"] is True

    def test_part_comparison_json_side_right_forward_torso_matches_t0427s_retuned_run(self):
        # [T-0427] This one entry is a DELIBERATE exception to this class's
        # own "never revises measurement" rule: T-0427's whole premise is
        # retuning the torso's own SAM3 request and re-running it live
        # against every figure panel, including side_right_forward. ROUND 2
        # added lateral shoulder/hip positive points on top of round 1's
        # centerline run (round 1's own 108815 came from the shoulder-seam
        # negatives alone); the live re-run with lateral points moved this
        # panel's count to 107293, staying mechanically isolated throughout.
        # See docs/assets/evidence/T-0427/README.md for the full retuned
        # picture; `front_tpose_right_upper_arm`/`front_tpose_head` above
        # are untouched by T-0427 and still pin their original T-0423
        # numbers unmodified.
        data = json.loads((EVIDENCE_DIR / "part_comparison.json").read_text())
        rec = data["panels"]["side_right_forward"]["parts"]["torso"]
        assert rec["foreground_px_after_isolation"] == 107293
        assert rec["isolated"] is True

    def test_head_overlap_rejected_on_both_forward_panels(self):
        """Finding 2: both forward-side heads are present but
        overlap-rejected -- 3 of 5 panels isolate a head cleanly
        (front_tpose, back_tpose, side_neutral), not 4 of 5."""
        data = json.loads((EVIDENCE_DIR / "part_comparison.json").read_text())
        panels = data["panels"]
        clean_heads = [
            panel
            for panel in (
                "front_tpose",
                "back_tpose",
                "side_right_forward",
                "side_left_forward",
                "side_neutral",
            )
            if panels[panel]["parts"]["head"]["isolated"]
        ]
        assert sorted(clean_heads) == ["back_tpose", "front_tpose", "side_neutral"]
        assert panels["side_right_forward"]["parts"]["head"]["present"] is True
        assert panels["side_right_forward"]["parts"]["head"]["isolated"] is False
        assert panels["side_left_forward"]["parts"]["head"]["present"] is True
        assert panels["side_left_forward"]["parts"]["head"]["isolated"] is False


@pytest.mark.skipif(not EVIDENCE_DIR.exists(), reason="T-0417/T-0423 evidence dir not present")
class TestFigurePartSuitabilityReport:
    """`assess_figure_part_suitability_T0423.compute_report()` is the
    script that produced the README's per-part suitability table -- pins
    its two headline totals (mechanical vs. anatomically-usable, kept
    distinct per this round's own acceptance) and the specific overclaim
    corrections so a future edit to the evidence or the script can't drift
    the README silently out of sync with what the code actually computes."""

    def _report(self):
        import assess_figure_part_suitability_T0423 as report

        return report.compute_report()

    def test_totals_distinguish_mechanical_from_anatomically_usable(self):
        # [T-0427] This script's own `compute_report()` reads the SHARED,
        # live `part_comparison.json` -- it was never a frozen snapshot.
        # T-0427 deliberately re-ran the torso request against all five
        # figure panels (front_tpose/back_tpose newly present,
        # side_left_forward no longer overlap-rejected), which lifts
        # `mechanically_isolated` from T-0423's original 8 to 11.
        #
        # `anatomically_usable` moves from 5 to 7, but NOT because this
        # script correctly identified 2 genuine new wins -- it has a BLIND
        # SPOT: `front_tpose/torso` and `back_tpose/torso` have no
        # `_VISUAL_FINDINGS` entry here (T-0423 never anticipated a torso
        # being present on either T-pose panel), so this function's own
        # "no finding -> usable" default silently counts both as usable.
        # T-0427's own fresh visual inspection found both to be a narrow
        # center-seam strip, not a complete torso (NOT usable). This
        # script also still marks `side_left_forward/torso` as not usable
        # off its OLD stale finding ("coat mask extends into the swallowed
        # left_upper_arm") even though that overlap is now fixed -- a
        # false negative that happens to cancel the two false positives
        # numerically, landing on 7 by coincidence, not correctness. See
        # `assess_figure_part_suitability_T0427.py` and
        # `docs/assets/evidence/T-0427/README.md` for the actually-correct
        # 7 (same count, different, correct membership). This test pins
        # what THIS unmodified T-0423 script literally computes today,
        # blind spot included.
        _, totals = self._report()
        assert totals == {
            "requested": 24,
            "mechanically_isolated": 11,
            "anatomically_usable": 7,
        }

    def test_front_tpose_right_upper_arm_is_combined_not_usable(self):
        per_part, _ = self._report()
        row = next(
            r
            for r in per_part
            if r["panel"] == "front_tpose" and r["part"] == "right_upper_arm"
        )
        assert row["isolated"] is True
        assert row["suitability"] == "combined"
        assert row["usable"] is False

    def test_front_tpose_head_is_incomplete_not_usable(self):
        per_part, _ = self._report()
        row = next(r for r in per_part if r["panel"] == "front_tpose" and r["part"] == "head")
        assert row["isolated"] is True
        assert row["suitability"] == "incomplete"
        assert row["usable"] is False

    def test_side_right_forward_torso_is_partial_not_usable(self):
        per_part, _ = self._report()
        row = next(
            r for r in per_part if r["panel"] == "side_right_forward" and r["part"] == "torso"
        )
        assert row["isolated"] is True
        assert row["suitability"] == "partial"
        assert row["usable"] is False

    def test_the_seven_parts_this_unmodified_script_now_names_usable(self):
        # [T-0427] Renamed from "the five..." -- see
        # test_totals_distinguish_mechanical_from_anatomically_usable's own
        # comment just above for why this grew to 7, and why 2 of the 7 are
        # this script's own known blind spot (`front_tpose/torso`,
        # `back_tpose/torso`) rather than genuine wins. T-0423's original 5
        # are still named here, unmodified and still correct.
        per_part, _ = self._report()
        usable = {
            (r["panel"], r["part"]) for r in per_part if r["present"] and r.get("usable")
        }
        assert usable == {
            ("back_tpose", "head"),
            ("back_tpose", "right_lower_arm"),
            ("back_tpose", "left_lower_arm"),
            ("side_left_forward", "left_lower_arm"),
            ("side_neutral", "head"),
            ("front_tpose", "torso"),  # blind spot, not a real win -- see above
            ("back_tpose", "torso"),  # blind spot, not a real win -- see above
        }


@pytest.mark.skipif(not EVIDENCE_DIR.exists(), reason="T-0417/T-0423 evidence dir not present")
class TestT0427OwnScriptDoesNotRepeatTheAdequateMislabel:
    """[T-0427 ROUND 2] T-0423's own frozen script (tested above) has a
    known blind spot that silently mislabels `front_tpose/torso` and
    `back_tpose/torso` as usable -- tolerated above as a reproduction of
    what that UNMODIFIED script computes, never as correct. This card's own
    `assess_figure_part_suitability_T0427.py` is the script that actually
    produced the committed README, and it must not repeat round 1's own
    mistake: the reviewer's second FAIL on this card found `_TORSO_VISUAL_
    FINDINGS` called `side_left_forward/torso` "adequate"/"a complete-
    looking triangular coat/cloak silhouette" when the committed mask
    (20,111px, 4.8% of the whole figure) excluded the entire cloak. These
    tests pin the corrected report: no torso row is ever "adequate" on any
    of the five figure panels, and the headline totals reflect zero new
    usable torsos, not a count inflated by a mislabel."""

    def _report(self):
        import assess_figure_part_suitability_T0427 as report

        return report.compute_report()

    def test_no_torso_row_is_labelled_adequate_on_any_panel(self):
        # The exact failure mode the reviewer caught: a "partial" or
        # "mechanically rejected" torso wrongly reported as "adequate".
        # This guards against a repeat on ANY of the five figure panels,
        # not just the one the reviewer happened to measure.
        per_part, _ = self._report()
        torso_rows = [r for r in per_part if r["part"] == "torso"]
        assert len(torso_rows) == 5
        for row in torso_rows:
            assert row["suitability"] != "adequate", row

    def test_side_left_forward_torso_is_partial_not_adequate(self):
        # Direct regression pin for the reviewer's own specific finding.
        per_part, _ = self._report()
        row = next(
            r for r in per_part if r["panel"] == "side_left_forward" and r["part"] == "torso"
        )
        assert row["isolated"] is True
        assert row["suitability"] == "partial"
        assert row["usable"] is False

    def test_totals_show_zero_new_usable_torsos_this_round(self):
        # T-0427's own (correct) script must land on T-0423's original 5
        # usable parts, not an inflated count -- unlike the frozen T-0423
        # script's own blind-spot-inflated 7 (pinned separately above as a
        # reproduction of that script's known behaviour, not a target).
        _, totals = self._report()
        assert totals == {
            "requested": 24,
            "mechanically_isolated": 11,
            "anatomically_usable": 5,
        }

    def test_the_five_usable_parts_are_exactly_t0423s_original_five(self):
        per_part, _ = self._report()
        usable = {(r["panel"], r["part"]) for r in per_part if r["present"] and r.get("usable")}
        assert usable == {
            ("back_tpose", "head"),
            ("back_tpose", "right_lower_arm"),
            ("back_tpose", "left_lower_arm"),
            ("side_left_forward", "left_lower_arm"),
            ("side_neutral", "head"),
        }
