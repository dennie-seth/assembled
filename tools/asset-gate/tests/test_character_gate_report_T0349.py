"""Machine-readable per-frame gate report (T-0349).

Every T-0259 reviewer re-derived frame deltas from a sheet by hand, and they
did not always agree -- one measurement on the wrong grid gave 1.29x where
the true value on the correct 4x2 grid is 5.3077x. `build_character_gate_report`
is the fix: the gate itself emits the grid, motion class, thresholds and
per-frame numbers it already computed, so a reviewer reads them instead of
re-deriving them (and re-disagreeing).

This module tests the report builder in isolation with tiny synthetic
sheets; `assets/src/character/tests/test_gate_report_T0349.py` is the
acceptance test proving the builder reproduces the exact known values
against the real, committed T-0266 walk sheet.

This card changes no threshold or gate semantics -- `checks` in the report
must be exactly what `check_character_arm_c_provenance` /
`check_character_frame_delta_cap` (the real enforcement predicates) already
decide, never a re-derivation.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from asset_gate.art import check_frame_consistency, slice_sheet_frames
from asset_gate.character import (
    build_character_gate_report,
    check_character_arm_c_provenance,
    check_character_frame_delta_cap,
)
from conftest import TEST_PALETTE_HEX, make_indexed_image

# 2x2 grid of 2x2 cells, 4 frames -- deliberately unequal pixel-delta counts
# across all 4 adjacent pairs (3 interior + the loop seam) so max/min is
# meaningfully distinct from 1.0.
_FRAME_0 = np.array([[1, 1], [0, 0]], dtype=np.uint8)
_FRAME_1 = np.array([[1, 1], [1, 0]], dtype=np.uint8)
_FRAME_2 = np.array([[2, 2], [2, 2]], dtype=np.uint8)
_FRAME_3 = np.array([[2, 2], [2, 0]], dtype=np.uint8)


def _sheet_from_cells(cells: list[np.ndarray], cols: int, rows: int) -> Image.Image:
    cell_h, cell_w = cells[0].shape
    arr = np.zeros((cell_h * rows, cell_w * cols), dtype=np.uint8)
    for i, cell in enumerate(cells):
        r, c = divmod(i, cols)
        arr[r * cell_h : (r + 1) * cell_h, c * cell_w : (c + 1) * cell_w] = cell
    return make_indexed_image(arr, TEST_PALETTE_HEX)


@pytest.fixture
def sheet() -> Image.Image:
    return _sheet_from_cells([_FRAME_0, _FRAME_1, _FRAME_2, _FRAME_3], cols=2, rows=2)


@pytest.fixture
def provenance() -> dict:
    return {
        "motion_class": "locomotion",
        "frame_delta_range": [0.01, 0.4],
        "arm_c_benchmark": [0.072, 0.112],
        "beats_arm_c_benchmark": False,
    }


def test_report_records_the_grid_explicitly(sheet, provenance):
    report = build_character_gate_report(sheet, provenance, cols=2, rows=2, cell_px=2)
    assert report["grid"] == {
        "cols": 2,
        "rows": 2,
        "cell_px": 2,
        "frame_cells": [[0, 0], [0, 1], [1, 0], [1, 1]],
    }


def test_report_records_motion_class_and_threshold(sheet, provenance):
    report = build_character_gate_report(sheet, provenance, cols=2, rows=2, cell_px=2)
    assert report["motion_class"] == "locomotion"
    assert report["thresholds"]["frame_delta_cap"] == 0.50
    assert report["thresholds"]["arm_c_benchmark"] == [0.072, 0.112]


def test_report_falls_closed_to_idle_cap_when_motion_class_missing(sheet):
    report = build_character_gate_report(sheet, {}, cols=2, rows=2, cell_px=2)
    assert report["motion_class"] is None
    assert report["thresholds"]["frame_delta_cap"] == 0.30


def test_report_pixel_delta_counts_are_per_pair_and_include_loop_seam(sheet, provenance):
    report = build_character_gate_report(sheet, provenance, cols=2, rows=2, cell_px=2)
    pairs = report["frame_pairs"]
    assert len(pairs) == 4
    # explicit loop seam: last frame -> frame 0
    assert pairs[-1]["pair"] == [[1, 1], [0, 0]]
    # frame0->frame1: only cell (1,0) differs (0 -> 1)
    assert pairs[0]["pixel_delta_count"] == 1
    # frame1->frame2: every cell's index changes (1->2, including the
    # already-foreground ones) -- the point of this metric vs. silhouette-only
    assert pairs[1]["pixel_delta_count"] == 4


def test_report_pixel_delta_summary_max_min_ratio(sheet, provenance):
    report = build_character_gate_report(sheet, provenance, cols=2, rows=2, cell_px=2)
    summary = report["pixel_delta_summary"]
    counts = summary["counts"]
    assert len(counts) == 4
    assert summary["max"] == max(counts)
    assert summary["min"] == min(counts)
    assert summary["max_min_ratio"] == pytest.approx(summary["max"] / summary["min"])


def test_report_max_min_ratio_is_none_when_a_pair_has_zero_delta():
    same = np.array([[1, 1], [0, 0]], dtype=np.uint8)
    sheet = _sheet_from_cells([same, same, same, same], cols=2, rows=2)
    report = build_character_gate_report(
        sheet, {"motion_class": "idle"}, cols=2, rows=2, cell_px=2
    )
    assert report["pixel_delta_summary"]["min"] == 0
    assert report["pixel_delta_summary"]["max_min_ratio"] is None


def test_report_reuses_the_real_arm_c_and_cap_checks(sheet, provenance):
    report = build_character_gate_report(
        sheet, provenance, cols=2, rows=2, cell_px=2, sheet_name="x.png"
    )
    arm_c = check_character_arm_c_provenance(provenance, sheet_name="x.png")
    cap = check_character_frame_delta_cap(provenance, sheet_name="x.png")
    assert report["checks"]["character_arm_c_provenance"] == {
        "passed": arm_c.passed,
        "reason": arm_c.reason,
    }
    assert report["checks"]["character_frame_delta_cap"] == {
        "passed": cap.passed,
        "reason": cap.reason,
    }


def test_report_silhouette_delta_range_matches_frame_consistency_ratios(sheet, provenance):
    report = build_character_gate_report(sheet, provenance, cols=2, rows=2, cell_px=2)
    frames = slice_sheet_frames(sheet, cell_width=2, cell_height=2, cols=2, rows=2)
    pairs = [(0, 1), (1, 2), (2, 3), (3, 0)]
    expected_ratios = [
        check_frame_consistency(
            frames[a],
            frames[b],
            background_index=0,
            max_delta_ratio=report["thresholds"]["frame_delta_cap"],
        ).details["ratio"]
        for a, b in pairs
    ]
    assert report["silhouette_delta_range"] == [min(expected_ratios), max(expected_ratios)]


def test_report_rejects_frame_count_mismatch_with_grid():
    sheet = _sheet_from_cells([_FRAME_0, _FRAME_1, _FRAME_2, _FRAME_3], cols=2, rows=2)
    with pytest.raises(ValueError):
        build_character_gate_report(sheet, {}, cols=3, rows=3, cell_px=2)


# ---- T-0357: the motion-fidelity result joins the report's own checks,
# and the retired 0.50 cap is marked diagnostic-only for locomotion/
# transition/loop ----


def test_report_includes_a_motion_fidelity_check(sheet, provenance):
    """This fixture's provenance has no `layout`/`frame_generation` (no rig
    evidence to recompute from). Since the 2026-09-11 PR review's P1 fix, a
    locomotion/transition/loop asset with no rig evidence FAILS naming the
    missing evidence rather than falling back to the sidecar-trusting
    predicate -- but either way it must APPEAR in `checks` (T-0357 finding
    4; before this card it never did, so a failing motion result could not
    drive a non-zero exit)."""
    report = build_character_gate_report(
        sheet, provenance, cols=2, rows=2, cell_px=2, sheet_name="x.png"
    )
    check = report["checks"]["character_motion_fidelity"]
    assert check["passed"] is False
    assert "layout" in check["reason"]


def test_report_checks_aggregate_reflects_a_failing_motion_result(sheet, provenance):
    """`provenance`'s motion_class is locomotion but records no rig evidence
    (no `layout`/`frame_generation`) -- character_motion_fidelity must fail,
    and cli.py's own `all(check["passed"] for check in
    report["checks"].values())` must see it."""
    report = build_character_gate_report(sheet, provenance, cols=2, rows=2, cell_px=2)
    assert report["checks"]["character_motion_fidelity"]["passed"] is False
    assert not all(check["passed"] for check in report["checks"].values())


def test_report_marks_the_retired_frame_delta_cap_diagnostic_only_for_locomotion(sheet, provenance):
    report = build_character_gate_report(sheet, provenance, cols=2, rows=2, cell_px=2)
    assert report["thresholds"]["frame_delta_cap_diagnostic_only"] is True


def test_report_frame_delta_cap_is_not_diagnostic_only_for_idle(sheet):
    report = build_character_gate_report(
        sheet, {"motion_class": "idle"}, cols=2, rows=2, cell_px=2
    )
    assert report["thresholds"]["frame_delta_cap_diagnostic_only"] is False


def test_report_frame_delta_cap_is_not_diagnostic_only_when_motion_class_missing(sheet):
    report = build_character_gate_report(sheet, {}, cols=2, rows=2, cell_px=2)
    assert report["thresholds"]["frame_delta_cap_diagnostic_only"] is False
