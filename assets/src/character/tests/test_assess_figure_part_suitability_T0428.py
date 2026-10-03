"""T-0428: the anatomical-suitability check, kept and re-pointed, not
dropped -- `char_gen.part_suitability.beyond_distal_joint_fraction` /
`is_combined_with_next_segment` now judge each `arm` part against the
WRIST as the distal joint (the arm's own new span, shoulder->wrist),
instead of T-0423's `upper_arm`-vs-elbow. An arm that runs past its own
wrist into whatever comes next must still be caught and labelled
"combined", never quietly counted as a win.

All tests here are fully offline: synthetic masks built in-process against
the REAL rig keypoints for `side_right_forward` (so the geometry is real,
not hand-waved), no ComfyUI, no GPU, no dependency on this card's own live
evidence existing yet.

RED state: `assess_figure_part_suitability_T0428` does not exist yet ->
`ModuleNotFoundError` below.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))
sys.path.insert(0, str(_CHARACTER_DIR / "src"))

import assess_figure_part_suitability_T0428 as assess  # noqa: E402
import gen_master_sheet_cutout_compare_T0337 as compare_t0337  # noqa: E402
import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

PANEL = "side_right_forward"
PART = "right_arm"
PANEL_SIZE = compare_t0337.PANEL_SIZE


def _shoulder_wrist_px():
    points = rig.keypoints_for(PANEL)
    spec = gen._FIGURE_PART_SPECS_BY_KEY[PART]
    shoulder_px = compare_t0337._px(points[spec.joint_a], PANEL_SIZE)
    wrist_px = compare_t0337._px(points[spec.joint_b], PANEL_SIZE)
    return shoulder_px, wrist_px


def _write_panel(tmp_path, part_records: dict):
    comparison = {"panels": {PANEL: {"parts": part_records}}}
    (tmp_path / "part_comparison.json").write_text(json.dumps(comparison))


def _write_mask(tmp_path, panel: str, part: str, mask: np.ndarray):
    path = tmp_path / f"panel_{panel}_part_{part}_mask.png"
    Image.fromarray((mask * 255).astype(np.uint8), mode="L").save(path)
    return path


class TestArmSuitabilityJudgedAgainstWrist:
    def test_arm_extending_well_past_the_wrist_is_combined(self, tmp_path, monkeypatch):
        monkeypatch.setattr(assess, "EVIDENCE_DIR", tmp_path)
        shoulder_px, wrist_px = _shoulder_wrist_px()
        assert shoulder_px[1] == wrist_px[1]  # side_right_forward's arm is horizontal

        mask = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=bool)
        y = shoulder_px[1]
        x0 = shoulder_px[0] - 10
        x1 = min(PANEL_SIZE, 1000)  # well past wrist_px[0]
        mask[y - 10 : y + 10, x0:x1] = True
        _write_mask(tmp_path, PANEL, PART, mask)
        _write_panel(tmp_path, {PART: {"present": True, "isolated": True}})

        per_part, totals = assess.compute_report()
        row = next(r for r in per_part if r["part"] == PART)
        assert row["usable"] is False
        assert "wrist" in row["reason"]
        assert row["suitability"] == "combined"
        assert totals["requested"] == 1
        assert totals["mechanically_isolated"] == 1
        assert totals["anatomically_usable"] == 0

    def test_arm_contained_within_shoulder_to_wrist_is_adequate(self, tmp_path, monkeypatch):
        monkeypatch.setattr(assess, "EVIDENCE_DIR", tmp_path)
        shoulder_px, wrist_px = _shoulder_wrist_px()

        mask = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=bool)
        y = shoulder_px[1]
        x0 = shoulder_px[0] - 10
        x1 = wrist_px[0] + 2  # a sliver past the wrist, within tolerance
        mask[y - 10 : y + 10, x0:x1] = True
        _write_mask(tmp_path, PANEL, PART, mask)
        _write_panel(tmp_path, {PART: {"present": True, "isolated": True}})

        per_part, totals = assess.compute_report()
        row = next(r for r in per_part if r["part"] == PART)
        assert row["usable"] is True
        assert row["suitability"] == "adequate"
        assert "wrist" in row["reason"]
        assert totals["anatomically_usable"] == 1

    def test_mechanically_rejected_arm_is_labelled_mechanically_rejected_not_combined(
        self, tmp_path, monkeypatch
    ):
        # A part that fails mechanical isolation stays labelled that, even
        # if it also happens to run past the wrist -- never double-counted
        # or relabelled as the (less severe-sounding) "combined".
        monkeypatch.setattr(assess, "EVIDENCE_DIR", tmp_path)
        shoulder_px, _wrist_px = _shoulder_wrist_px()

        mask = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=bool)
        y = shoulder_px[1]
        mask[y - 10 : y + 10, shoulder_px[0] - 10 : 1000] = True
        _write_mask(tmp_path, PANEL, PART, mask)
        _write_panel(tmp_path, {PART: {"present": True, "isolated": False}})

        per_part, _totals = assess.compute_report()
        row = next(r for r in per_part if r["part"] == PART)
        assert row["usable"] is False
        assert row["suitability"] == "mechanically rejected"


class TestNonArmPartsAreVisuallyJudged:
    def test_head_with_no_recorded_finding_is_adequate(self, tmp_path, monkeypatch):
        monkeypatch.setattr(assess, "EVIDENCE_DIR", tmp_path)
        mask = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=bool)
        mask[100:150, 100:150] = True
        _write_mask(tmp_path, PANEL, "head", mask)
        _write_panel(tmp_path, {"head": {"present": True, "isolated": True}})

        per_part, totals = assess.compute_report()
        row = next(r for r in per_part if r["part"] == "head")
        assert row["usable"] is True
        assert row["suitability"] == "adequate"
        assert totals["anatomically_usable"] == 1

    def test_absent_part_is_reported_not_present_with_no_fraction_computed(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(assess, "EVIDENCE_DIR", tmp_path)
        _write_panel(tmp_path, {PART: {"present": False, "isolated": False}})

        per_part, totals = assess.compute_report()
        row = next(r for r in per_part if r["part"] == PART)
        assert row["present"] is False
        assert row["isolated"] is None
        assert row["suitability"] == "n/a"
        assert totals["requested"] == 1
        assert totals["mechanically_isolated"] == 0
        assert totals["anatomically_usable"] == 0
