"""T-0255 round-2 comparison gate (HANDOFF §24, handle §24-f).

`docs/decision-log.md` DL-21 pre-registers the decision rule; DL-23 records
@DennieSeth's authorship-grounds override that pursued round 2 (§24-a..§24-e)
with Arm C (T-0230, round 1) retained as both benchmark and shipping
fallback. T-0248/T-0249/T-0250/T-0252 each ran a round-2 arm and self-reported
a frame-delta result against both the 0.30 cap and Arm C's 0.072-0.112
benchmark; T-0251 (§24-d, AnimateDiff) stopped on a well-evidenced capability
check with no generation attempt. This card's own automatable work (per its
"Human-in-the-loop" section) is: assemble all four arms plus the Arm C
benchmark side by side, independently re-run the mechanical frame-delta gate
over each arm's own committed sheet, and record the state -- not to invent
the human criterion-1 (silhouette) verdict for the round-2 arms, which DL-21
reserves to a human and which this card records as PENDING-but-not-load-
bearing (see ROUND2_DECISION_T0255.md: none of the round-2 arms beat Arm C's
benchmark regardless of their own criterion-1 read, so no round-2 arm's
criterion-1 verdict is decisive either way).

RED state: char_gen.round2_compare does not exist yet -> the importorskip
           below fails collection; all referenced artefacts/records absent.
GREEN state: the comparison artefact/delta report exist and are correct,
             the skipped arm (T-0251) is recorded with its evidence, no
             round-2 arm beats Arm C's benchmark, the decision record and
             DL-24 decision-log entry exist and do not touch DL-21/DL-22/
             DL-23, the reference sheet is promoted with P-7-compliant
             provenance, and ASSET_PROVENANCE.md carries the new rows.

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

asset_gate_art = pytest.importorskip("asset_gate.art")
round2_compare = pytest.importorskip("char_gen.round2_compare")

REPO_ROOT = Path(__file__).resolve().parents[4]
CHAR_DIR = REPO_ROOT / "assets" / "src" / "character"
FINAL_DIR = REPO_ROOT / "assets" / "final" / "character"

COMPARISON_PATH = FINAL_DIR / "round2_comparison_T0255.webp"
DELTA_REPORT_PATH = FINAL_DIR / "round2_frame_delta_report_T0255.json"
DECISION_PATH = CHAR_DIR / "ROUND2_DECISION_T0255.md"
COST_TABLE_PATH = CHAR_DIR / "BAKEOFF_COST_TABLE_T0231.md"
DECISION_LOG_PATH = REPO_ROOT / "docs" / "decision-log.md"
PROVENANCE_INDEX_PATH = REPO_ROOT / "ASSET_PROVENANCE.md"
PIPELINE_DOC_PATH = REPO_ROOT / "docs" / "design" / "13-asset-pipeline.md"
REFERENCE_SHEET_PATH = FINAL_DIR / "player_idle_sheet_reference.png"
REFERENCE_PROVENANCE_PATH = FINAL_DIR / "player_idle_sheet_reference.provenance.json"
ARM_C_SHEET_PATH = FINAL_DIR / "player_idle_sheet_arm_c_T0230.png"
ARM_C_PROVENANCE_PATH = FINAL_DIR / "player_idle_sheet_arm_c_T0230.provenance.json"
CONCEPT_HASH_T0209 = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

ARMS = round2_compare.ARMS
SKIPPED_ARMS = round2_compare.SKIPPED_ARMS

# Sha256 of docs/decision-log.md's DL-21..DL-23 text (line 952 to EOF as of
# this card's own starting point, 2026-08-30) -- pins that DL-21/DL-22/DL-23
# are untouched by this card's DL-24 append. Computed once, before any edit
# in this PR, over `text[text.index("## DL-21") : text.index("## DL-24")]`.
DL21_THROUGH_DL23_SHA256 = "3797a5b287c3a5af51131f7f56e9ec0b18dc1a7738da015be63d0e0b9248aed9"


# ---------------------------------------------------------------------------
# Comparison artefact (acceptance bullet 1)
# ---------------------------------------------------------------------------


def test_round2_arms_are_exactly_the_ones_that_ran() -> None:
    """§24-b/c/e ran; §24-d was correctly skipped (see SKIPPED_ARMS below).
    Arm C (round 1) is always included as the benchmark."""
    assert {a.key for a in ARMS} == {"arm_c_benchmark", "pose_authority", "chained", "hybrid"}
    assert {s.key for s in SKIPPED_ARMS} == {"animatediff"}


def test_comparison_artefact_exists() -> None:
    assert COMPARISON_PATH.exists(), (
        f"comparison artefact not found: {COMPARISON_PATH}\n"
        "Run assets/src/character/compare_round2_arms_T0255.py to produce it."
    )


def test_comparison_artefact_is_animated_raster_with_one_frame_per_arm_pose() -> None:
    from PIL import Image

    with Image.open(COMPARISON_PATH) as im:
        assert im.format == "WEBP"
        assert getattr(im, "n_frames", 1) == 9, (
            f"expected 9 composited frames (3x3 idle grid), got {getattr(im, 'n_frames', 1)}"
        )


def test_comparison_artefact_references_all_arm_previews() -> None:
    for arm in ARMS:
        assert arm.preview_gif.exists(), f"referenced preview missing: {arm.preview_gif}"


def test_comparison_artefact_labels_all_arms_and_their_cards() -> None:
    labels = round2_compare.comparison_labels()
    for arm in ARMS:
        assert any(arm.label in label and arm.card in label for label in labels), (
            f"comparison artefact missing a label for {arm.label} ({arm.card})"
        )


def test_comparison_artefact_includes_arm_c_as_the_benchmark() -> None:
    labels = round2_compare.comparison_labels()
    assert any("Arm C" in label and "T-0230" in label for label in labels)


def test_comparison_artefact_embeds_each_arms_own_preview_pixels() -> None:
    """A real paste is pixel-identical to the source GIF's own frame 0 (both
    lossless); a placeholder panel would not match."""
    from PIL import Image

    width, height, y_panel = round2_compare.comparison_layout()
    with Image.open(COMPARISON_PATH) as composite:
        composite.seek(0)
        composite_frame0 = composite.convert("RGB")
    assert composite_frame0.size == (width, height)

    for i, arm in enumerate(ARMS):
        with Image.open(arm.preview_gif) as preview:
            preview.seek(0)
            preview_frame0 = preview.convert("RGB")
        x = round2_compare.panel_x(i)
        panel_w = round2_compare.COMPARISON_PANEL_W
        panel_h = round2_compare.COMPARISON_PANEL_H
        cropped = composite_frame0.crop((x, y_panel, x + panel_w, y_panel + panel_h))
        assert list(cropped.getdata()) == list(preview_frame0.getdata()), (
            f"{arm.key}: composite panel pixels do not match its own judging-preview frame 0"
        )


# ---------------------------------------------------------------------------
# Frame-silhouette delta gate, re-run per arm, against both bars
# (acceptance bullet 4)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("arm", ARMS, ids=[a.key for a in ARMS])
def test_frame_deltas_recomputed_from_committed_sheet(arm) -> None:
    deltas = round2_compare.compute_frame_deltas(arm.sheet)
    assert len(deltas) == 8, f"{arm.key}: expected 8 adjacent-cell transitions, got {len(deltas)}"
    provenance = json.loads(arm.provenance.read_text())
    recorded = provenance.get("frame_deltas")
    assert recorded and len(recorded) == 8, f"{arm.key}: provenance frame_deltas missing/short"
    for mine, theirs in zip(deltas, recorded, strict=True):
        assert mine["ratio"] == pytest.approx(theirs["ratio"], abs=1e-9), (
            f"{arm.key}: recomputed delta {mine['ratio']} != provenance-recorded {theirs['ratio']}"
        )


@pytest.mark.parametrize("key", ["pose_authority", "chained", "hybrid"])
def test_round2_arms_clear_030_cap(key: str) -> None:
    arm = next(a for a in ARMS if a.key == key)
    deltas = round2_compare.compute_frame_deltas(arm.sheet)
    assert round2_compare.clears_030_cap(deltas), f"{key}: expected to clear the 0.30 cap"


@pytest.mark.parametrize("key", ["pose_authority", "chained", "hybrid"])
def test_no_round2_arm_beats_arm_c_benchmark(key: str) -> None:
    """§24.3: 'Arm C's 0.072-0.112 is the bar to BEAT, not the gate to
    clear.' Every round-2 arm clears the 0.30 cap but none beats the bar --
    this is what makes Arm C the shipping fallback (see decision record)."""
    arm = next(a for a in ARMS if a.key == key)
    deltas = round2_compare.compute_frame_deltas(arm.sheet)
    assert not round2_compare.beats_benchmark(deltas), (
        f"{key}: unexpectedly beat Arm C's 0.072-0.112 benchmark -- decision record is stale"
    )


def test_arm_c_benchmark_is_its_own_bar() -> None:
    arm = next(a for a in ARMS if a.key == "arm_c_benchmark")
    deltas = round2_compare.compute_frame_deltas(arm.sheet)
    assert round2_compare.beats_benchmark(deltas)
    ratios = [d["ratio"] for d in deltas]
    assert min(ratios) == pytest.approx(0.072, abs=0.001)
    assert max(ratios) == pytest.approx(0.112, abs=0.001)


def test_delta_report_exists_and_matches_recomputation() -> None:
    assert DELTA_REPORT_PATH.exists(), f"delta report not found: {DELTA_REPORT_PATH}"
    report = json.loads(DELTA_REPORT_PATH.read_text())
    assert set(report["arms"]) == {a.key for a in ARMS}
    for arm in ARMS:
        entry = report["arms"][arm.key]
        expected = round2_compare.compute_frame_deltas(arm.sheet)
        for mine, theirs in zip(entry["deltas"], expected, strict=True):
            assert mine["ratio"] == pytest.approx(theirs["ratio"], abs=1e-9)
    assert set(report["skipped"]) == {s.key for s in SKIPPED_ARMS}


def test_delta_report_records_skipped_arm_with_reason_and_evidence() -> None:
    report = json.loads(DELTA_REPORT_PATH.read_text())
    entry = report["skipped"]["animatediff"]
    assert entry["card"] == "T-0251"
    assert "motion module" in entry["reason"].lower()
    evidence_path = REPO_ROOT / entry["evidence"]
    assert evidence_path.exists(), f"skipped-arm evidence file missing: {evidence_path}"


# ---------------------------------------------------------------------------
# Cost table (acceptance bullet 5) -- already assembled by each round-2 card
# ---------------------------------------------------------------------------


def test_cost_table_carries_every_round2_card() -> None:
    text = COST_TABLE_PATH.read_text()
    for card in ("T-0248", "T-0249", "T-0250", "T-0251", "T-0252"):
        assert f"HANDOFF §24-" in text and card in text, f"{card}'s round-2 section not found"


# ---------------------------------------------------------------------------
# Decision record (acceptance bullets 2, 3, 6, 7, 9)
# ---------------------------------------------------------------------------


def test_decision_record_exists() -> None:
    assert DECISION_PATH.exists(), f"decision record not found: {DECISION_PATH}"


def test_decision_record_states_shared_identity_lora() -> None:
    text = DECISION_PATH.read_text()
    assert "player_identity_v2" in text


def test_decision_record_lists_skipped_arm_with_reason() -> None:
    text = DECISION_PATH.read_text()
    assert "T-0251" in text
    assert "motion module" in text.lower()


def test_decision_record_reports_both_bars_per_ran_arm() -> None:
    text = DECISION_PATH.read_text()
    assert "0.30" in text
    assert "0.072" in text and "0.112" in text


def test_decision_record_designates_arm_c_as_shipping_fallback() -> None:
    text = DECISION_PATH.read_text()
    assert "Arm C" in text
    assert "shipping fallback" in text.lower() or "shipping-fallback" in text.lower()
    assert "manufactur" not in text.lower() or "not manufactur" in text.lower() or "does not manufacture" in text.lower()


def test_decision_record_does_not_fabricate_criterion1_verdicts() -> None:
    text = DECISION_PATH.read_text()
    assert "PENDING" in text
    assert "Dennie" in text
    assert "not load-bearing" in text.lower() or "load-bearing" in text.lower()


def test_decision_record_references_cost_table() -> None:
    text = DECISION_PATH.read_text()
    assert "BAKEOFF_COST_TABLE_T0231.md" in text


def test_decision_record_states_pipeline_doc_change() -> None:
    text = DECISION_PATH.read_text()
    assert "§3.5" in text
    assert "deterministic" in text.lower()


# ---------------------------------------------------------------------------
# decision-log.md -- new DL entry, DL-21/DL-22/DL-23 untouched
# ---------------------------------------------------------------------------


def test_decision_log_has_dl24_entry_with_24f_handle() -> None:
    text = DECISION_LOG_PATH.read_text()
    assert "## DL-24" in text, "DL-24 entry not found in decision-log.md"
    dl24 = text[text.index("## DL-24") :]
    assert "T-0255" in dl24
    assert "§24-f" in dl24
    assert "Arm C" in dl24


def test_decision_log_dl21_through_dl23_are_untouched() -> None:
    text = DECISION_LOG_PATH.read_text()
    assert "## DL-24" in text, "DL-24 must exist for this pin to check the right range"
    segment = text[text.index("## DL-21") : text.index("## DL-24")].rstrip() + "\n"
    digest = hashlib.sha256(segment.encode()).hexdigest()
    assert digest == DL21_THROUGH_DL23_SHA256, (
        "docs/decision-log.md's DL-21..DL-23 text changed -- these entries are permanent, "
        "append DL-24 after them instead of editing"
    )


# ---------------------------------------------------------------------------
# Reference-character promotion (acceptance bullet 8)
# ---------------------------------------------------------------------------


def test_reference_sheet_is_arm_c_bytes() -> None:
    assert REFERENCE_SHEET_PATH.exists(), f"reference sheet not found: {REFERENCE_SHEET_PATH}"
    ref_bytes = REFERENCE_SHEET_PATH.read_bytes()
    arm_c_bytes = ARM_C_SHEET_PATH.read_bytes()
    assert hashlib.sha256(ref_bytes).hexdigest() == hashlib.sha256(arm_c_bytes).hexdigest(), (
        "reference sheet must be Arm C's committed sheet, byte-identical -- Arm C is the "
        "shipping fallback, not a re-derived copy"
    )


def test_reference_provenance_is_p7_compliant() -> None:
    assert REFERENCE_PROVENANCE_PATH.exists()
    provenance = json.loads(REFERENCE_PROVENANCE_PATH.read_text())
    generator_path = REPO_ROOT / provenance["generator"]
    assert generator_path.exists(), f"generator does not resolve as a repo path: {provenance['generator']}"
    assert provenance.get("model_hash"), "model_hash must be non-null (P-7)"
    assert provenance.get("concept_hash") == CONCEPT_HASH_T0209


def test_asset_provenance_lists_new_rows() -> None:
    text = PROVENANCE_INDEX_PATH.read_text()
    assert "round2_comparison_T0255.webp" in text
    assert "player_idle_sheet_reference.png" in text


# ---------------------------------------------------------------------------
# docs/design/13-asset-pipeline.md §3.5
# ---------------------------------------------------------------------------


def test_pipeline_doc_records_round2_outcome_under_35() -> None:
    text = PIPELINE_DOC_PATH.read_text()
    assert "### 3.5 Props and Characters" in text
    section = text[text.index("### 3.5 Props and Characters") : text.index("### 3.6 Atlas")]
    assert "DL-24" in section or "DL-21" in section
    assert "deterministic" in section.lower()
