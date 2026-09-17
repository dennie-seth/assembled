"""T-0242 — Signal Tower / Broadcast Deck room prop manifest gate (HANDOFF §23-j-g).

Broadcast Deck (`signal_tower.broadcast_deck`) needs exactly two prop slots
per `docs/design/14-vertical-slice.md` §10: deck-edge dressing and
transmitter-side dressing, both `cover` class. Both slots are fully covered
by props already committed under `assets/final/props/signal_tower/`
(T-0201/T-0221/T-0223) against the approved
`signal_tower_props_concept_sheet_v1.png` sheet (DL-5) — this card generates
no new prop geometry, it only records the room's slot -> prop mapping.

Unlike Ground Relay (T-0240) and Storage Cache (T-0241), this room places
**no hiding-class prop** — its centerpiece is the tear, a shader effect
(`13-asset-pipeline.md` §4) out of prop-pack scope, and the room's own
design row (`14-vertical-slice.md` §10) reads "No entity — breathing room
before the crossing." With zero hiding-class slots, this room places zero
cover/hiding pairs, so the P-3 16px separation gate (which only constrains
cover-vs-hiding legibility) has nothing to check here — it is vacuously
satisfied, not skipped. This file asserts that explicitly rather than
fabricating a pair or silently omitting the gate section.

Gate references:
  - DL-5 / P-6 — concept art precedes generation (no new geometry here).
  - P-3 — 16px legibility: >= 15.0 luma16 gap between any cover/hiding pair
    co-located in a room. Vacuously true for this room (no hiding-class
    slot exists to pair against).
  - P-7 (amended 2026-08-29) — provenance is required only for props a card
    *newly generates*. Broadcast Deck reuses two already-committed,
    already-provenanced props as-is.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
MANIFEST_PATH = PROPS_DIR / "broadcast_deck.manifest.json"


@pytest.fixture(scope="session")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"Missing room manifest: {MANIFEST_PATH}"
    return json.loads(MANIFEST_PATH.read_text())


def test_manifest_identifies_room(manifest):
    assert manifest["room"] == "signal_tower.broadcast_deck"


def test_manifest_declares_no_new_geometry(manifest):
    """This card generates no props — DL-5 has nothing new to check against."""
    assert manifest["generated_new_props"] is False


def test_manifest_has_exactly_the_two_slots(manifest):
    slot_names = {s["slot"] for s in manifest["slots"]}
    assert slot_names == {
        "Deck-edge dressing",
        "Transmitter-side dressing",
    }


def test_manifest_slots_resolve_to_committed_props(manifest):
    """Every slot -> prop mapping must point at a prop already committed
    under assets/final/props/signal_tower/, referenced (not regenerated)."""
    for slot in manifest["slots"]:
        assert slot["status"] == "committed"
        assert slot["reused"] is True
        prop_png = PROPS_DIR / f"{slot['prop']}.png"
        prop_prov = PROPS_DIR / f"{slot['prop']}.provenance.json"
        assert prop_png.exists(), f"{slot['slot']}: {prop_png} does not exist"
        assert prop_prov.exists(), f"{slot['slot']}: {prop_prov} does not exist"


def test_manifest_slot_classes_match_expected_props(manifest):
    expected = {
        "Deck-edge dressing": ("cover", "low_duct_v1"),
        "Transmitter-side dressing": ("cover", "relay_cabinet_v1"),
    }
    for slot in manifest["slots"]:
        exp_class, exp_prop = expected[slot["slot"]]
        assert slot["class"] == exp_class
        assert slot["prop"] == exp_prop


def test_manifest_has_no_hiding_class_slots(manifest):
    """This room places no hiding-class prop — confirms the P-3 cover/hiding
    gate has no pair to check (vacuous, not skipped)."""
    classes = {s["class"] for s in manifest["slots"]}
    assert classes == {"cover"}


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
