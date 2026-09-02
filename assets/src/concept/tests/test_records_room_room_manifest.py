"""T-0243 — Signal Tower / Records Room prop manifest gate (HANDOFF §23-j-b).

Records Room (`signal_tower.records_room`) needs exactly two prop slots per
`docs/design/14-vertical-slice.md` §10: dense archive shelving rows (primary
dressing) and incidental crates.

**Fix cycle (2026-08-29 validation FAIL).** The first GREEN generated
`archive_shelving_v1` against `signal_tower_props_concept_sheet_v2.png`
(T-0239). That sheet was not an approved concept sheet and the artifact was
reverted; the shelving slot was reported **blocked** on T-0239's approval.

**Re-gate (2026-08-30 human comment).** @DennieSeth declined the v2 sheet
outright — it is synthetic composited icon art, not real LoRA-generated
prop geometry, and is **superseded**; its "not yet approved" provenance
rows are not something a future approval record would ever clear. The
shelving slot is now gated on **T-0257** (real prop concept art, generated
via the style LoRA + IP-Adapter + `comfy_client.cutout` path, no prop LoRA)
instead of T-0239.

**Merge-forward fix (2026-09-02 validation FAIL, run 1 of 5).** This branch
had gone stale against `develop`: T-0257's real sheet
(`signal_tower_props_concept_sheet_v3.png`) landed on `develop` (commit
`958c561`) with an "ARCHIVE SHELVING -- COVER" panel, but this branch's
manifest and this test file still claimed T-0257 "has no concept sheet and
no task card anywhere in this repo" — true only inside the stale worktree,
and the `test_t0257_concept_sheet_does_not_exist_yet` guard that made that
claim globbed for a `*0257*`-named file that no concept sheet in this repo
is ever named after (sheets are named subject+version), so it could never
have caught the sheet landing. After merging `develop` in, the sheet is
real and present, but `ASSET_PROVENANCE.md`'s own row for it
(`signal_tower_props_concept_sheet_v3.png`) still reads "**Not yet
approved**", the sidecar carries no `approved: true`, and
`docs/decision-log.md` still has zero `T-0257` entries — so the slot stays
**blocked** on the same DL-5 human-approval gate, just for the accurate
reason: the sheet exists and depicts the geometry, but no human direction
verdict has been recorded for it yet.

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
DECISION_LOG_PATH = WORKTREE / "docs" / "decision-log.md"
ASSET_PROVENANCE_PATH = WORKTREE / "ASSET_PROVENANCE.md"

V2_SHEET_PROV_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.provenance.json"
V3_SHEET_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.png"
V3_SHEET_PROV_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.provenance.json"

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


def test_manifest_blocked_reason_cites_current_gate_t0257(manifest):
    """DL-5: the manifest must explain *why* the slot is blocked, pointing at
    the *current* gate -- T-0257 -- per the 2026-08-30 human re-gate comment,
    not at T-0239/the superseded v2 sheet's own approval status."""
    reason = manifest.get("blocked_reason", "")
    assert "T-0257" in reason
    assert "decision-log" in reason or "approval" in reason


def test_manifest_blocked_reason_notes_v2_sheet_declined_not_pending(manifest):
    """The v2 sheet was reviewed and declined outright (2026-08-29 human
    comment) -- it is superseded, not merely 'not yet approved'. The
    blocked_reason must not read as if a future approval of v2 would clear
    this slot."""
    reason = manifest.get("blocked_reason", "")
    assert "declined" in reason.lower() or "supersed" in reason.lower()


def test_shelving_slot_blocked_on_cites_t0257(manifest):
    slot = next(s for s in manifest["slots"] if s["slot"] == BLOCKED_SLOT)
    assert "T-0257" in slot["blocked_on"]


def test_manifest_does_not_falsely_claim_t0257_sheet_is_missing(manifest):
    """2026-09-02 validation FAIL: this branch had gone stale against
    develop, and its blocked_reason/blocked_on text claimed T-0257 'has no
    concept sheet ... anywhere in this repo' -- true only inside the stale
    worktree. The sheet (signal_tower_props_concept_sheet_v3.png) landed on
    develop via commit 958c561 well before this run. The record must not
    assert a fact contradicted by the repo it is committed into."""
    reason = manifest.get("blocked_reason", "")
    slot = next(s for s in manifest["slots"] if s["slot"] == BLOCKED_SLOT)
    blocked_on = slot["blocked_on"]
    for text in (reason, blocked_on):
        assert "no concept sheet" not in text.lower()
        assert "has not landed" not in text.lower()


def test_manifest_blocked_reason_states_sheet_exists_but_unapproved(manifest):
    """The accurate reason: T-0257's sheet exists and depicts the shelving
    geometry, but carries no recorded human approval verdict -- DL-5 still
    forbids generating against it."""
    reason = manifest.get("blocked_reason", "")
    assert "v3" in reason.lower() or "signal_tower_props_concept_sheet_v3" in reason
    assert "approv" in reason.lower()


def test_v2_sheet_provenance_still_marked_unapproved():
    """Guards against silently flipping the v2 sheet's own approval marker
    to make this card's job easier -- approval is a human gate this card
    cannot grant itself. (The sheet is also superseded/declined per the
    2026-08-30 human comment, but that does not make "not yet approved"
    false -- it never became true.)"""
    assert V2_SHEET_PROV_PATH.exists(), f"Missing v2 sheet provenance: {V2_SHEET_PROV_PATH}"
    prov = json.loads(V2_SHEET_PROV_PATH.read_text())
    # the sidecar carries no approval field at all -- absence, not a false "approved: true"
    assert "approved" not in prov or prov["approved"] is not True


def test_t0257_concept_sheet_exists_but_is_not_yet_approved():
    """T-0257's real sheet has landed (assets/src/concept/
    signal_tower_props_concept_sheet_v3.png, commit 958c561 on develop) --
    unlike the prior guard here, this asserts against the sheet's *actual*
    filename, not a `*0257*` glob that no concept sheet in this repo is ever
    named to match (sheets are named subject+version, never by card id), so
    this guard actually fires. The sheet's existence alone does not clear
    DL-5: its sidecar carries no `approved: true`, and ASSET_PROVENANCE.md's
    own row for it must still read as unapproved. If ASSET_PROVENANCE.md
    stops saying "not yet approved" for this sheet, a human approval verdict
    has been recorded and this card's shelving slot should be re-examined --
    that is the signal to re-run this card, not a regression."""
    assert V3_SHEET_PATH.exists(), (
        f"Expected T-0257's sheet to exist at {V3_SHEET_PATH} (it landed on "
        "develop via commit 958c561) -- if it is genuinely absent, this "
        "branch has gone stale against develop again and needs re-merging."
    )
    assert V3_SHEET_PROV_PATH.exists(), f"Missing v3 sheet provenance: {V3_SHEET_PROV_PATH}"
    prov = json.loads(V3_SHEET_PROV_PATH.read_text())
    assert "approved" not in prov or prov["approved"] is not True

    assert ASSET_PROVENANCE_PATH.exists(), f"Missing {ASSET_PROVENANCE_PATH}"
    provenance_text = ASSET_PROVENANCE_PATH.read_text()
    assert "signal_tower_props_concept_sheet_v3.png" in provenance_text
    assert "Not yet approved" in provenance_text


def test_decision_log_has_no_t0257_approval_entry():
    """Mirrors the human instruction: do not run this card's generation path
    until T-0257's approval verdict is recorded in docs/decision-log.md."""
    assert DECISION_LOG_PATH.exists(), f"Missing {DECISION_LOG_PATH}"
    text = DECISION_LOG_PATH.read_text()
    assert "T-0257" not in text


# ── Gate measurement re-derivation ──────────────────────────────────────────


def test_manifest_records_no_gate_measurement_fabrication(manifest):
    """With zero cover/hiding pairs, gate_measurements must not be present
    (or must be empty) -- there is nothing real to measure."""
    assert manifest.get("gate_measurements") in (None, {}, [])
