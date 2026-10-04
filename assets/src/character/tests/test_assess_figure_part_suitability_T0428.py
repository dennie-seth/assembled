"""T-0428: the anatomical-suitability check, kept and re-pointed, not
dropped -- `char_gen.part_suitability.beyond_distal_joint_fraction` /
`is_combined_with_next_segment` now judge each `arm` part against the
WRIST as the distal joint (the arm's own new span, shoulder->wrist),
instead of T-0423's `upper_arm`-vs-elbow. An arm that runs past its own
wrist into whatever comes next must still be caught and labelled
"combined", never quietly counted as a win.

Most tests here are fully offline: synthetic masks built in-process against
the REAL rig keypoints for `side_right_forward` (so the geometry is real,
not hand-waved), no ComfyUI, no GPU, no dependency on this card's own live
evidence existing yet. `TestLiveEvidenceReproducesThisCardsOwnResult` is the
one exception -- same "read the already-committed evidence PNGs/JSON
directly, no mocking" pattern `tests/test_part_suitability_T0423.py` already
uses for T-0417's directory: still no ComfyUI/GPU, just a file read of this
card's own committed `docs/assets/evidence/T-0428/part_comparison.json`.

RED state: `assess_figure_part_suitability_T0428` does not exist yet ->
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
        # Isolate the WRIST-boundary geometry under test from this card's own
        # real _VISUAL_FINDINGS entry for (side_right_forward, right_arm) --
        # see TestArmPartsAreAlsoVisuallyJudged below for that override.
        monkeypatch.setattr(assess, "_VISUAL_FINDINGS", {})
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
        monkeypatch.setattr(assess, "_VISUAL_FINDINGS", {})
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
        monkeypatch.setattr(assess, "_VISUAL_FINDINGS", {})
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


class TestArmPartsAreAlsoVisuallyJudged:
    """[T-0428 live run] `beyond_distal_joint_fraction` only answers "how much
    of this mask lies past the distal joint" -- it has no notion of whether
    the mask is shaped like a limb at all, so a costume detail that happens
    to sit entirely within the shoulder-wrist bounding box (a clasp, a hood
    streamer) passes it at 0.0% and would otherwise be quietly counted as a
    usable arm. The same `_VISUAL_FINDINGS` override already used for
    head/torso must also apply to `arm` parts so the committed, mechanical
    report cannot disagree with this card's own documented visual finding
    (see docs/assets/evidence/T-0428/README.md §3)."""

    def test_geometrically_clean_arm_with_a_visual_finding_is_not_usable(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(
            assess,
            "_VISUAL_FINDINGS",
            {(PANEL, PART): "visually not an arm -- a costume clasp, not a limb"},
        )
        monkeypatch.setattr(assess, "EVIDENCE_DIR", tmp_path)
        shoulder_px, wrist_px = _shoulder_wrist_px()

        mask = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=bool)
        y = shoulder_px[1]
        x0 = shoulder_px[0] - 10
        x1 = wrist_px[0] + 2  # geometrically "within tolerance" -- the bug this guards
        mask[y - 10 : y + 10, x0:x1] = True
        _write_mask(tmp_path, PANEL, PART, mask)
        _write_panel(tmp_path, {PART: {"present": True, "isolated": True}})

        per_part, totals = assess.compute_report()
        row = next(r for r in per_part if r["part"] == PART)
        assert row["usable"] is False
        assert row["reason"] == "visually not an arm -- a costume clasp, not a limb"
        assert totals["anatomically_usable"] == 0


class TestNonArmPartsAreVisuallyJudged:
    def test_head_with_no_recorded_finding_is_adequate(self, tmp_path, monkeypatch):
        # [T-0428 live run] side_right_forward/head and side_left_forward/head
        # both got real `_VISUAL_FINDINGS` entries from this card's own live
        # evidence (see module docstring) -- this test is about the generic
        # "no recorded finding -> adequate" path, so it clears the dict back
        # to empty rather than relying on PANEL/"head" staying finding-free.
        monkeypatch.setattr(assess, "_VISUAL_FINDINGS", {})
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


class TestLiveEvidenceReproducesThisCardsOwnResult:
    """[T-0428 live run] Reads this card's own already-committed
    `docs/assets/evidence/T-0428/part_comparison.json` and the real
    `_VISUAL_FINDINGS` entries above directly -- no monkeypatching, same
    "pin the committed evidence's own numbers" pattern
    `tests/test_part_suitability_T0423.py` already uses for T-0417's
    directory. Pins the phantom-overlap hypothesis test (head x arm
    overlap cleared on both panels by the ear-midpoint anchor) and the
    honest, not-glossed result: both heads are mechanically isolated or
    rejected, but neither is anatomically a usable head by name."""

    def _comparison(self):
        return json.loads((assess.EVIDENCE_DIR / "part_comparison.json").read_text())

    def test_head_x_arm_overlap_is_cleared_on_both_panels(self):
        data = self._comparison()
        for panel, arm_part in (
            ("side_right_forward", "right_arm"),
            ("side_left_forward", "left_arm"),
        ):
            overlaps = data["panels"][panel]["overlaps"]
            pair = next(
                o
                for o in overlaps
                if {o["part_a"], o["part_b"]} == {"head", arm_part}
            )
            assert pair["overlap_fraction"] == pytest.approx(0.0)
            assert pair["exceeds_tolerance"] is False

    def test_neither_forward_head_is_anatomically_usable_by_name(self):
        per_part, totals = assess.compute_report()
        for panel in ("side_right_forward", "side_left_forward"):
            row = next(r for r in per_part if r["panel"] == panel and r["part"] == "head")
            assert row["usable"] is False
        assert totals["requested"] == 6
        assert totals["mechanically_isolated"] == 5

    def test_neither_forward_arm_is_anatomically_usable_by_name(self):
        # [T-0428 live run] Both arm masks pass the geometric "0.0% beyond
        # its own wrist" check, but visual inspection (README.md §3) found
        # neither is actually the figure's own arm: side_right_forward's is
        # the costume's chest clasp/buckle, side_left_forward's is a
        # vertical hood/cloak streamer. The mechanical report must say so
        # too, not just the prose -- a geometrically-clean mask that isn't
        # shaped like the part it claims to be is still not usable.
        per_part, totals = assess.compute_report()
        for panel, arm_part in (
            ("side_right_forward", "right_arm"),
            ("side_left_forward", "left_arm"),
        ):
            row = next(r for r in per_part if r["panel"] == panel and r["part"] == arm_part)
            assert row["usable"] is False
        # Only side_left_forward/torso ends up anatomically usable by name --
        # the same corrected total README.md §2/§3 report.
        assert totals["anatomically_usable"] == 1
