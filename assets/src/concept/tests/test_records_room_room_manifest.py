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
prop geometry, and is **superseded**. The shelving slot was re-gated on
**T-0257** (real prop concept art, generated via the style LoRA +
`comfy_client.cutout` path).

**Merge-forward fix (2026-09-02 validation FAIL, runs 1-3 of 5).** T-0257's
real sheet (`signal_tower_props_concept_sheet_v3.png`) landed on `develop`
(commit `958c561`) with an "ARCHIVE SHELVING -- COVER" panel, but the sheet's
own `ASSET_PROVENANCE.md` row still read "Not yet approved" and no human
direction verdict had been recorded — so the slot stayed blocked for the
accurate reason, across three FAILs, until a human recorded one.

**Approval landed (2026-09-02, this cycle).** PR #307 (merged, commit
`9757b16`) propagated an *existing* board approval verdict for T-0257
(`approved_by`/`approved_at`, card moved to `done` via PR #291) into
`ASSET_PROVENANCE.md`: the v3 sheet's row now reads "APPROVED 2026-08-30".
DL-5's human-approval gate is therefore cleared for this slot, and
`archive_shelving_v1` is generated this run through the committed cutout
path (`tools/comfy-client/src/comfy_client/cutout.py`) against the
approved v3 sheet, using the exact "ARCHIVE SHELVING -- COVER" panel prompt
already reviewed and shipped as part of that sheet.

Gate references:
  - DL-5 / P-6 — concept art precedes generation. The manifest must cite the
    specific approval record (ASSET_PROVENANCE.md's "APPROVED" line for the
    v3 sheet), not merely the sheet's existence.
  - P-3 — 16px legibility: >= 15.0 luma16 gap between any cover/hiding pair
    co-located in a room. Both of this room's committed slots are
    cover-class, so (like Broadcast Deck, T-0242) it places zero cover/hiding
    pairs — the gate is vacuously satisfied, not skipped.
  - P-7 — provenance is required for props this card newly generates.
    `archive_shelving_v1` ships a sidecar whose `concept_hash` resolves to
    the approved v3 sheet and whose `generator` resolves to the committed
    cutout module. `crate_stack_v1` is reused as-is (no new sidecar
    obligation).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
MANIFEST_PATH = PROPS_DIR / "records_room.manifest.json"
ASSET_PROVENANCE_PATH = WORKTREE / "ASSET_PROVENANCE.md"

V2_SHEET_PROV_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.provenance.json"
V3_SHEET_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.png"

SHELVING_SLOT = "Archive shelving rows (primary dressing)"
SHELVING_PROP_NAME = "archive_shelving_v1"
EXPECTED_GENERATOR = "tools/comfy-client/src/comfy_client/cutout.py"


@pytest.fixture(scope="session")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"Missing room manifest: {MANIFEST_PATH}"
    return json.loads(MANIFEST_PATH.read_text())


@pytest.fixture(scope="session")
def shelving_provenance() -> dict:
    path = PROPS_DIR / f"{SHELVING_PROP_NAME}.provenance.json"
    assert path.exists(), f"Missing provenance sidecar: {path}"
    return json.loads(path.read_text())


# ── The approval this run depends on ─────────────────────────────────────────


def test_t0257_concept_sheet_is_approved():
    """DL-5 is only clear because ASSET_PROVENANCE.md now records an actual
    human approval verdict for the v3 sheet (PR #307, propagating T-0257's
    board approval) -- not because the sheet merely exists."""
    assert V3_SHEET_PATH.exists(), (
        f"Expected T-0257's sheet to exist at {V3_SHEET_PATH}."
    )
    assert ASSET_PROVENANCE_PATH.exists(), f"Missing {ASSET_PROVENANCE_PATH}"
    row = next(
        line
        for line in ASSET_PROVENANCE_PATH.read_text().splitlines()
        if line.startswith("| `assets/src/concept/signal_tower_props_concept_sheet_v3.png`")
    )
    assert "APPROVED" in row, (
        "signal_tower_props_concept_sheet_v3.png's ASSET_PROVENANCE.md row "
        "must record an APPROVED verdict before this card may generate "
        "against it."
    )
    assert "Not yet approved" not in row


def test_v2_sheet_provenance_still_marked_unapproved():
    """Guards against silently flipping the *declined, superseded* v2
    sheet's own approval marker -- its approval status never changes,
    unlike v3's."""
    assert V2_SHEET_PROV_PATH.exists(), f"Missing v2 sheet provenance: {V2_SHEET_PROV_PATH}"
    prov = json.loads(V2_SHEET_PROV_PATH.read_text())
    assert "approved" not in prov or prov["approved"] is not True


# ── Manifest shape ──────────────────────────────────────────────────────────


def test_manifest_identifies_room(manifest):
    assert manifest["room"] == "signal_tower.records_room"


def test_manifest_declares_new_geometry_now_unblocked(manifest):
    assert manifest["generated_new_props"] is True
    assert manifest["status"] == "committed"


def test_manifest_has_exactly_the_two_slots(manifest):
    slot_names = {s["slot"] for s in manifest["slots"]}
    assert slot_names == {SHELVING_SLOT, "Incidental crates"}


def test_shelving_slot_resolves_to_generated_prop(manifest):
    slot = next(s for s in manifest["slots"] if s["slot"] == SHELVING_SLOT)
    assert slot["status"] == "committed"
    assert slot["class"] == "cover"
    assert slot["prop"] == SHELVING_PROP_NAME
    assert slot["reused"] is False
    prop_png = PROPS_DIR / f"{slot['prop']}.png"
    prop_prov = PROPS_DIR / f"{slot['prop']}.provenance.json"
    assert prop_png.exists(), f"{slot['slot']}: {prop_png} does not exist"
    assert prop_prov.exists(), f"{slot['slot']}: {prop_prov} does not exist"


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


def test_manifest_records_no_gate_measurement_fabrication(manifest):
    """With zero cover/hiding pairs, gate_measurements must not be present
    (or must be empty) -- there is nothing real to measure."""
    assert manifest.get("gate_measurements") in (None, {}, [])


def test_manifest_non_regression_note_present(manifest):
    assert "non_regression" in manifest
    assert manifest["non_regression"]


def test_manifest_generation_note_cites_the_approval(manifest):
    """The manifest must explain *why* generation was allowed this run --
    citing the actual approval record, not merely the sheet's presence."""
    note = manifest.get("generation_note", "")
    assert "T-0257" in note
    assert "APPROVED" in note or "approv" in note.lower()
    assert "signal_tower_props_concept_sheet_v3" in note


# ── Newly-generated prop provenance (P-7) ────────────────────────────────────


def test_shelving_prop_generator_resolves_to_committed_cutout_module(shelving_provenance):
    generator = shelving_provenance.get("generator", "")
    assert generator == EXPECTED_GENERATOR
    assert (WORKTREE / generator).resolve().is_file()


def test_shelving_prop_concept_hash_resolves_to_approved_v3_sheet(shelving_provenance):
    concept_hash = shelving_provenance.get("concept_hash")
    assert concept_hash, "archive_shelving_v1.provenance.json missing concept_hash"
    actual = hashlib.sha256(V3_SHEET_PATH.read_bytes()).hexdigest()
    assert concept_hash == actual, (
        f"concept_hash {concept_hash} does not match sha256 of the approved "
        f"v3 sheet ({actual})"
    )
    assert shelving_provenance.get("concept_source", "").endswith(
        "signal_tower_props_concept_sheet_v3.png"
    )


def test_shelving_prop_model_hash_recorded(shelving_provenance):
    assert shelving_provenance.get("model_hash")


def test_shelving_prop_class_is_cover(shelving_provenance):
    assert shelving_provenance.get("prop_class") == "cover"


def test_shelving_prop_not_generated_with_a_prop_lora(shelving_provenance):
    """Per the 2026-08-30 human re-gate comment: no prop LoRA is trained or
    used for this generation path -- style LoRA only."""
    lora_name = shelving_provenance.get("lora_name", "")
    assert lora_name == "soviet_brutalism_style_v1.safetensors"


def test_shelving_prop_is_rgba_with_opaque_pixels():
    from PIL import Image
    import numpy as np

    png_path = PROPS_DIR / f"{SHELVING_PROP_NAME}.png"
    assert png_path.exists()
    img = Image.open(png_path).convert("RGBA")
    alpha = np.array(img)[:, :, 3]
    assert int(alpha.max()) > 0, f"{png_path.name}: fully transparent"


# ── Art direction (2026-09-02 human comment: camera-facing, no isometry) ───


def test_manifest_records_camera_facing_projection_check(manifest):
    """@DennieSeth, 2026-09-02: 'object should face the camera, no isometry
    or perspective.' archive_shelving_v1 was generated by the same
    generator/prompt family as the sibling prop cards that came back
    isometric, so this card must specifically re-verify it by looking at
    the committed PNG (not the prompt) and record the verdict -- trusting
    the prompt's 'orthographic'/'no perspective' language is exactly what
    burned the sibling cards."""
    check = manifest.get("art_direction_check")
    assert check, (
        "records_room.manifest.json must record the 2026-09-02 camera-facing "
        "projection verification (checked_props, method, result)"
    )
    assert SHELVING_PROP_NAME in check.get("checked_props", []), (
        f"{SHELVING_PROP_NAME} must be listed as checked -- it is the prop "
        "this direction specifically calls out for re-verification"
    )
    assert check.get("method") == "visual inspection of the committed PNG"
    assert check.get("result") == "pass"


def test_manifest_projection_check_not_based_on_prompt_trust(manifest):
    """The verification method must not be the prompt text -- the sibling
    prop cards' prompts already claimed 'orthographic, no perspective' and
    still came back isometric, which is why this check exists at all."""
    check = manifest.get("art_direction_check")
    assert check, "art_direction_check must be present to assert its method"
    method = check.get("method", "")
    assert "prompt" not in method.lower()
