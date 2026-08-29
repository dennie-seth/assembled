"""T-0243 — Signal Tower / Records Room prop manifest gate (HANDOFF §23-j-b).

Records Room (`signal_tower.records_room`) needs exactly two prop slots per
`docs/design/14-vertical-slice.md` §10: dense archive shelving rows (primary
dressing) and incidental crates.

**Fix cycle (2026-08-29 validation FAIL).** The prior GREEN generated
`archive_shelving_v1` against `signal_tower_props_concept_sheet_v2.png`
(T-0239). That sheet is not an approved concept sheet: its own
`ASSET_PROVENANCE.md` row and `.provenance.json` sidecar both say it "parks
for human direction approval ... not yet approved", and
`docs/decision-log.md` has no approval entry for T-0239 or the v2 sheet.
Merging a sheet to `develop` is not the human direction-approval gate DL-5
requires. Per this card's own instruction ("If a slot has no approved
coverage, the card stops and reports it rather than generating"), the
shelving slot is now reported as **blocked** and no new prop geometry is
generated. Only the already-committed `crate_stack_v1` slot is resolved
this run.

Gate references:
  - DL-5 / P-6 — concept art precedes generation. No prop may be generated
    against a sheet that is not recorded as human-approved. The manifest
    must say so explicitly rather than silently omitting the slot.
  - P-3 — 16px legibility: >= 15.0 luma16 gap between any cover/hiding pair
    co-located in a room. This room's only committed slot is cover-class,
    so (like Broadcast Deck, T-0242) it places zero cover/hiding pairs — the
    gate is vacuously satisfied, not skipped.
  - P-7 — provenance is required only for props a card *newly generates*.
    This run generates nothing new, so no new sidecar is required.
    `crate_stack_v1` is reused as-is.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
MANIFEST_PATH = PROPS_DIR / "records_room.manifest.json"

V2_SHEET_PROV_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.provenance.json"

BLOCKED_SLOT = "Archive shelving rows (primary dressing)"
BLOCKED_PROP_NAME = "archive_shelving_v1"


@pytest.fixture(scope="session")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"Missing room manifest: {MANIFEST_PATH}"
    return json.loads(MANIFEST_PATH.read_text())


# ── Manifest shape ──────────────────────────────────────────────────────────


def test_manifest_identifies_room(manifest):
    assert manifest["room"] == "signal_tower.records_room"


def test_manifest_declares_no_new_geometry_while_blocked(manifest):
    """The v2 sheet is not recorded as human-approved (DL-5) -- this run
    must not generate the shelving prop against it."""
    assert manifest["generated_new_props"] is False
    assert manifest["status"] == "blocked"


def test_manifest_has_exactly_the_two_slots(manifest):
    slot_names = {s["slot"] for s in manifest["slots"]}
    assert slot_names == {BLOCKED_SLOT, "Incidental crates"}


def test_shelving_slot_reports_blocked_not_generated(manifest):
    slot = next(s for s in manifest["slots"] if s["slot"] == BLOCKED_SLOT)
    assert slot["status"] == "blocked"
    assert slot["prop"] is None
    assert slot["reused"] is False
    assert "blocked_on" in slot and slot["blocked_on"]


def test_shelving_prop_was_not_generated_on_disk():
    """DL-5: no prop geometry may exist for a slot this run reports as
    blocked -- if generation had happened, the report would be a lie."""
    assert not (PROPS_DIR / f"{BLOCKED_PROP_NAME}.png").exists()
    assert not (PROPS_DIR / f"{BLOCKED_PROP_NAME}.provenance.json").exists()


def test_crate_slot_resolves_to_committed_reused_prop(manifest):
    slot = next(s for s in manifest["slots"] if s["slot"] == "Incidental crates")
    assert slot["status"] == "committed"
    assert slot["class"] == "cover"
    assert slot["prop"] == "crate_stack_v1"
    assert slot["reused"] is True
    prop_png = PROPS_DIR / f"{slot['prop']}.png"
    prop_prov = PROPS_DIR / f"{slot['prop']}.provenance.json"
    assert prop_png.exists(), f"{slot['slot']}: {prop_png} does not exist"
    assert prop_prov.exists(), f"{slot['slot']}: {prop_prov} does not exist"


def test_manifest_has_no_hiding_class_slots(manifest):
    """No committed slot this run places a hiding-class prop -- confirms
    the P-3 cover/hiding gate has no pair to check (vacuous, not skipped)."""
    committed_classes = {
        s["class"] for s in manifest["slots"] if s["status"] == "committed"
    }
    assert committed_classes == {"cover"}


def test_manifest_gate_section_records_vacuous_pairing(manifest):
    """The manifest must explicitly record that zero cover/hiding pairs
    exist in this room, rather than silently omitting the gate section or
    fabricating a measurement against a prop this room doesn't place."""
    gate = manifest["gate_16px_separation"]
    assert gate["cover_hide_pairs_in_room"] == []
    assert gate["applicable"] is False


def test_manifest_non_regression_note_present(manifest):
    assert "non_regression" in manifest
    assert manifest["non_regression"]


def test_manifest_blocked_reason_cites_lack_of_recorded_approval(manifest):
    """DL-5: the manifest must explain *why* the slot is blocked, and that
    explanation must point at the actual gap -- no recorded human approval
    verdict for the v2 sheet -- not at a vaguer or incorrect reason."""
    reason = manifest.get("blocked_reason", "")
    assert "signal_tower_props_concept_sheet_v2.png" in reason
    assert "decision-log" in reason or "approval" in reason


def test_v2_sheet_provenance_still_marked_unapproved():
    """Guards against silently flipping the v2 sheet's own approval marker
    to make this card's job easier -- approval is a human gate this card
    cannot grant itself."""
    assert V2_SHEET_PROV_PATH.exists(), f"Missing v2 sheet provenance: {V2_SHEET_PROV_PATH}"
    prov = json.loads(V2_SHEET_PROV_PATH.read_text())
    # the sidecar carries no approval field at all -- absence, not a false "approved: true"
    assert "approved" not in prov or prov["approved"] is not True


# ── Gate measurement re-derivation ──────────────────────────────────────────


def test_manifest_records_no_gate_measurement_fabrication(manifest):
    """With zero cover/hiding pairs, gate_measurements must not be present
    (or must be empty) -- there is nothing real to measure."""
    assert manifest.get("gate_measurements") in (None, {}, [])
