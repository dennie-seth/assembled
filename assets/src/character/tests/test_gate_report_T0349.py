"""T-0349: machine-readable gate report reproduces the known values against
the committed T-0266 walk sheet.

Every T-0259 reviewer re-computed frame deltas from
`player_walk_sheet_hybrid.png` by hand, and they did not always agree -- one
measurement on the wrong (8x1) grid gave 1.29x where the true value on the
correct 4x2 grid is 5.3077x. This test proves `build_character_gate_report`
(the gate's own computation, not a hand re-derivation) reproduces those exact
per-pair pixel-delta counts and the 5.3077x max/min ratio on the 4x2 grid,
and that a report has been committed alongside the sheet a reviewer can read
instead of recomputing anything.

Deliberately a *different* metric than `test_player_walk_hybrid_T0259_gate.py`'s
`frame_deltas` field (silhouette fg/bg-*state* delta ratio, already gated on
the 0.30/0.50 cap): `pixel_delta_summary.counts` here is ANY palette-index
change between two frames, the raw number a reviewer eyeballing the sheet by
hand actually sees.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from PIL import Image

asset_gate_character = pytest.importorskip("asset_gate.character")

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
SHEET_PATH = FINAL_CHARACTER_DIR / "player_walk_sheet_hybrid.png"
PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_walk_sheet_hybrid.provenance.json"
REPORT_PATH = FINAL_CHARACTER_DIR / "player_walk_sheet_hybrid.gate_report.json"

if not SHEET_PATH.exists():
    pytest.skip(
        f"{SHEET_PATH} does not exist yet -- this suite activates automatically once "
        "a passing sheet is promoted (mirrors test_player_walk_hybrid_T0259_gate.py's "
        "own skip guard).",
        allow_module_level=True,
    )

COLS = 4
ROWS = 2
CELL_PX = 48

# Known values (tasks/T-0349.md's card body): a hand-derivation off the wrong
# (8x1) grid previously produced 1.29x; the true value on the correct 4x2
# grid is 5.3077x (= 414 / 78).
EXPECTED_COUNTS = [414, 84, 145, 136, 164, 78, 181, 369]
EXPECTED_MAX_MIN_RATIO = 414 / 78


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    return Image.open(SHEET_PATH)


@pytest.fixture(scope="module")
def provenance() -> dict:
    return json.loads(PROVENANCE_PATH.read_text())


@pytest.fixture(scope="module")
def report(sheet: Image.Image, provenance: dict) -> dict:
    return asset_gate_character.build_character_gate_report(
        sheet,
        provenance,
        cols=COLS,
        rows=ROWS,
        cell_px=CELL_PX,
        sheet_name="player_walk_sheet_hybrid.png",
    )


def test_grid_is_recorded_explicitly(report: dict) -> None:
    assert report["grid"]["cols"] == COLS
    assert report["grid"]["rows"] == ROWS
    assert report["grid"]["cell_px"] == CELL_PX


def test_reproduces_the_known_pixel_delta_counts(report: dict) -> None:
    assert report["pixel_delta_summary"]["counts"] == EXPECTED_COUNTS


def test_reproduces_the_known_max_min_ratio(report: dict) -> None:
    assert report["pixel_delta_summary"]["max"] == max(EXPECTED_COUNTS)
    assert report["pixel_delta_summary"]["min"] == min(EXPECTED_COUNTS)
    assert report["pixel_delta_summary"]["max_min_ratio"] == pytest.approx(
        EXPECTED_MAX_MIN_RATIO
    )
    assert report["pixel_delta_summary"]["max_min_ratio"] == pytest.approx(5.3077, abs=1e-4)


def test_threshold_reflects_the_sheets_own_recorded_motion_class(
    report: dict, provenance: dict
) -> None:
    """No new gate semantics -- the cap reported is exactly what
    `frame_delta_cap_for_motion_class` already resolves for this sheet's own
    (possibly absent) `motion_class`, never a value invented by this report."""
    assert report["motion_class"] == provenance.get("motion_class")
    assert report["thresholds"][
        "frame_delta_cap"
    ] == asset_gate_character.frame_delta_cap_for_motion_class(provenance.get("motion_class"))


def test_checks_block_matches_the_real_enforcement_predicates(
    report: dict, provenance: dict
) -> None:
    arm_c = asset_gate_character.check_character_arm_c_provenance(
        provenance, sheet_name="player_walk_sheet_hybrid.png"
    )
    cap = asset_gate_character.check_character_frame_delta_cap(
        provenance, sheet_name="player_walk_sheet_hybrid.png"
    )
    assert report["checks"]["character_arm_c_provenance"]["passed"] == arm_c.passed
    assert report["checks"]["character_frame_delta_cap"]["passed"] == cap.passed


def test_committed_report_file_exists_and_matches_a_fresh_computation(report: dict) -> None:
    assert REPORT_PATH.exists(), (
        f"{REPORT_PATH} must be committed alongside the sheet -- run "
        "`asset-gate character-gate-report` and commit the output"
    )
    committed = json.loads(REPORT_PATH.read_text())
    assert committed == report


def test_provenance_points_reviewers_at_the_report(provenance: dict) -> None:
    assert (
        provenance.get("gate_report")
        == "assets/final/character/player_walk_sheet_hybrid.gate_report.json"
    )
