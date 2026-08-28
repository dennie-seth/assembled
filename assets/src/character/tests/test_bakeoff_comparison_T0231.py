"""T-0231 bake-off comparison gate (HANDOFF §23-g).

docs/decision-log.md DL-21 pre-registers the decision rule; T-0227's cost
template pins the shared columns; T-0228/T-0229/T-0230 (Arms A/B/C) each
already filled their own row and ran DL-21 criterion 2's mechanical gate
over their own sheet. This card's automatable work (per its own acceptance)
is to put all three side by side, re-run the mechanical gate over each arm's
committed sheet, assemble the cost table, and record the state -- not to
invent the human silhouette-read (criterion 1) or human drift verdict
(criterion 2's other half), which DL-21 reserves to a human and this card
leaves PENDING (see BAKEOFF_DECISION_T0231.md).

RED state: assets/final/character/bakeoff_comparison_T0231.webp,
           bakeoff_frame_delta_report_T0231.json, and
           assets/src/character/BAKEOFF_COST_TABLE_T0231.md all absent ->
           existence asserts fail; char_gen.bakeoff_compare does not exist
           yet -> the importorskip below fails collection too.
GREEN state: all three artefacts exist, the comparison artefact is a real
             raster composite (each arm's own judging-preview pixels pasted
             into the frame, not an external reference), the delta report's
             numbers match an independent re-run of the same mechanical gate
             over each arm's own committed sheet, the cost table's rows
             match each arm's own filled §23-c template verbatim, the
             decision record exists and states Arm A's elimination plus the
             still-open human verdicts, and both the DL-22 decision-log
             entry and an ASSET_PROVENANCE.md row for the comparison
             artefact are present.

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

asset_gate_art = pytest.importorskip("asset_gate.art")
bakeoff_compare = pytest.importorskip("char_gen.bakeoff_compare")

REPO_ROOT = Path(__file__).resolve().parents[4]
CHAR_DIR = REPO_ROOT / "assets" / "src" / "character"
FINAL_DIR = REPO_ROOT / "assets" / "final" / "character"

COMPARISON_PATH = FINAL_DIR / "bakeoff_comparison_T0231.webp"
DELTA_REPORT_PATH = FINAL_DIR / "bakeoff_frame_delta_report_T0231.json"
COST_TABLE_PATH = CHAR_DIR / "BAKEOFF_COST_TABLE_T0231.md"
DECISION_PATH = CHAR_DIR / "BAKEOFF_DECISION_T0231.md"
DECISION_LOG_PATH = REPO_ROOT / "docs" / "decision-log.md"
PROVENANCE_INDEX_PATH = REPO_ROOT / "ASSET_PROVENANCE.md"

ARMS = bakeoff_compare.ARMS


# ---------------------------------------------------------------------------
# Comparison artefact (acceptance bullet 1 + bullet 8's attach target)
# ---------------------------------------------------------------------------


def test_comparison_artefact_exists() -> None:
    assert COMPARISON_PATH.exists(), (
        f"comparison artefact not found: {COMPARISON_PATH}\n"
        "Run assets/src/character/compare_bakeoff_arms_T0231.py to produce it."
    )


def test_comparison_artefact_is_animated_raster_with_one_frame_per_arm_pose() -> None:
    """Board attachments reject SVG/HTML outright (tools/board/src/server/
    httpApi.js's resolveMimeType) -- the artefact must be a real raster
    image, and 'in motion' means it actually animates."""
    from PIL import Image

    with Image.open(COMPARISON_PATH) as im:
        assert im.format == "WEBP"
        assert getattr(im, "n_frames", 1) == 9, (
            f"expected 9 composited frames (3x3 idle grid), got {getattr(im, 'n_frames', 1)}"
        )


def test_comparison_artefact_references_all_three_arm_previews() -> None:
    for arm in ARMS:
        assert arm.preview_gif.exists(), f"referenced preview missing: {arm.preview_gif}"


def test_comparison_artefact_labels_all_three_arms() -> None:
    labels = bakeoff_compare.comparison_labels()
    for arm in ARMS:
        assert any(arm.label in label and arm.card in label for label in labels), (
            f"comparison artefact missing a label for {arm.label}"
        )


def test_comparison_artefact_embeds_each_arms_own_preview_pixels() -> None:
    """The composite must actually embed each arm's own preview frames --
    not merely reference the GIF filenames as text. Crop each arm's panel
    out of the composite's first frame and diff it against that arm's own
    judging-preview first frame; a real paste is pixel-identical (both are
    lossless), an unrendered/placeholder panel would not match."""
    from PIL import Image

    width, height, y_panel = bakeoff_compare.comparison_layout()
    with Image.open(COMPARISON_PATH) as composite:
        composite.seek(0)
        composite_frame0 = composite.convert("RGB")
    assert composite_frame0.size == (width, height)

    for i, arm in enumerate(ARMS):
        with Image.open(arm.preview_gif) as preview:
            preview.seek(0)
            preview_frame0 = preview.convert("RGB")
        x = bakeoff_compare.panel_x(i)
        panel_w = bakeoff_compare.COMPARISON_PANEL_W
        panel_h = bakeoff_compare.COMPARISON_PANEL_H
        cropped = composite_frame0.crop((x, y_panel, x + panel_w, y_panel + panel_h))
        assert list(cropped.getdata()) == list(preview_frame0.getdata()), (
            f"{arm.key}: composite panel pixels do not match its own judging-preview frame 0"
        )


# ---------------------------------------------------------------------------
# Frame-silhouette delta gate, re-run per arm (acceptance bullet 2)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("arm", ARMS, ids=[a.key for a in ARMS])
def test_frame_deltas_recomputed_from_committed_sheet(arm) -> None:
    """Independently re-runs DL-21 criterion 2's mechanical gate
    (asset_gate.art.check_frame_consistency) over each arm's own committed
    sheet -- not a trust of the arm's self-reported numbers."""
    deltas = bakeoff_compare.compute_frame_deltas(arm.sheet)
    assert len(deltas) == 8, f"{arm.key}: expected 8 adjacent-cell transitions, got {len(deltas)}"
    provenance = json.loads(arm.provenance.read_text())
    recorded = provenance.get("frame_deltas")
    assert recorded and len(recorded) == 8, f"{arm.key}: provenance frame_deltas missing/short"
    for mine, theirs in zip(deltas, recorded, strict=True):
        assert mine["ratio"] == pytest.approx(theirs["ratio"], abs=1e-9), (
            f"{arm.key}: recomputed delta {mine['ratio']} != provenance-recorded {theirs['ratio']}"
        )
        assert mine["passed"] == theirs["passed"]


def test_arm_a_mechanical_gate_fails() -> None:
    """Arm A's own report: 4 of 8 adjacent-cell ratios exceed the 0.30 cap."""
    arm = next(a for a in ARMS if a.key == "arm_a")
    deltas = bakeoff_compare.compute_frame_deltas(arm.sheet)
    failed = [d for d in deltas if not d["passed"]]
    assert len(failed) == 4, f"expected 4 failing transitions for Arm A, got {len(failed)}"


@pytest.mark.parametrize("key", ["arm_b", "arm_c"])
def test_arm_b_and_c_mechanical_gate_passes(key: str) -> None:
    arm = next(a for a in ARMS if a.key == key)
    deltas = bakeoff_compare.compute_frame_deltas(arm.sheet)
    failed = [d for d in deltas if not d["passed"]]
    assert not failed, f"{key}: expected all 8 transitions within cap, {len(failed)} failed"


def test_delta_report_exists_and_matches_recomputation() -> None:
    assert DELTA_REPORT_PATH.exists(), f"delta report not found: {DELTA_REPORT_PATH}"
    report = json.loads(DELTA_REPORT_PATH.read_text())
    assert set(report["arms"]) == {a.key for a in ARMS}
    for arm in ARMS:
        entry = report["arms"][arm.key]
        expected = bakeoff_compare.compute_frame_deltas(arm.sheet)
        for mine, theirs in zip(entry["deltas"], expected, strict=True):
            assert mine["ratio"] == pytest.approx(theirs["ratio"], abs=1e-9)
    assert report["arms"]["arm_a"]["all_passed"] is False
    assert report["arms"]["arm_a"]["num_failed"] == 4
    assert report["arms"]["arm_b"]["all_passed"] is True
    assert report["arms"]["arm_c"]["all_passed"] is True


# ---------------------------------------------------------------------------
# Cost table (acceptance bullet 3)
# ---------------------------------------------------------------------------


def test_cost_table_exists() -> None:
    assert COST_TABLE_PATH.exists(), f"cost table not found: {COST_TABLE_PATH}"


def test_cost_table_contains_all_three_arm_rows_verbatim() -> None:
    table_text = COST_TABLE_PATH.read_text()
    for arm in ARMS:
        row = bakeoff_compare.extract_cost_row(arm.report)
        assert row in table_text, (
            f"{arm.key}'s §23-c row not found verbatim in the assembled table -- "
            "DL-21 recording rule: 'same template, same columns, same units'"
        )


@pytest.mark.parametrize(
    "needle",
    [
        "28.0",  # Arm A GPU minutes
        "8 / 8",  # Arm A attempts-to-first-pass (no pass)
        "165.5",  # Arm B GPU minutes (training + generation, T-0229 acceptance)
        "7/8",  # Arm B attempts-to-first-pass
        "0.0",  # Arm C GPU minutes
        "1/8",  # Arm C attempts-to-first-pass
    ],
)
def test_cost_table_carries_key_figures(needle: str) -> None:
    assert needle in COST_TABLE_PATH.read_text()


# ---------------------------------------------------------------------------
# Decision record (acceptance bullets 4-7) -- human verdicts left PENDING
# ---------------------------------------------------------------------------


def test_decision_record_exists() -> None:
    assert DECISION_PATH.exists(), f"decision record not found: {DECISION_PATH}"


def test_decision_record_states_arm_a_elimination() -> None:
    text = DECISION_PATH.read_text()
    assert "criterion-3 failure" in text.lower() or "criterion 3 failure" in text.lower()
    assert "Arm A" in text


def test_decision_record_does_not_fabricate_human_verdicts() -> None:
    """DL-21 reserves criterion 1 and criterion 2's drift verdict to a human
    (Dennie). This card must record them as PENDING, not invent a PASS/FAIL
    on their behalf -- the whole point of the card's human-in-the-loop note."""
    text = DECISION_PATH.read_text()
    assert "PENDING" in text
    assert "Dennie" in text


def test_decision_record_states_contingent_doc_changes() -> None:
    """Acceptance: the record states what changes in 13-asset-pipeline.md
    under each possible winner."""
    text = DECISION_PATH.read_text()
    assert "§3.5" in text
    assert "§6.14 stage 2" in text
    assert "mandatory" in text.lower()
    assert "deterministic character synthesis" in text.lower()


def test_decision_record_reports_cost_comparison() -> None:
    text = DECISION_PATH.read_text()
    assert "165.5" in text
    assert "0.0" in text


# ---------------------------------------------------------------------------
# decision-log.md + ASSET_PROVENANCE.md
# ---------------------------------------------------------------------------


def test_decision_log_has_dl22_entry() -> None:
    text = DECISION_LOG_PATH.read_text()
    assert re.search(r"^## DL-22\b", text, re.MULTILINE), "DL-22 entry not found in decision-log.md"
    dl22 = text[text.index("## DL-22") :]
    assert "T-0231" in dl22
    assert "PENDING" in dl22 or "PROVISIONAL" in dl22 or "PARKED" in dl22


def test_asset_provenance_lists_comparison_artefact() -> None:
    text = PROVENANCE_INDEX_PATH.read_text()
    assert "bakeoff_comparison_T0231.webp" in text
