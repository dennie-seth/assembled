"""T-0240 — Signal Tower / Ground Relay room prop manifest gate (HANDOFF §23-j-a).

Ground Relay (`signal_tower.ground_relay`) needs exactly two prop slots per
`docs/design/14-vertical-slice.md` §10: one dedicated hiding-spot (teaching
instance) and one incidental cover slot for floor dressing. Both slots are
fully covered by props already committed under
`assets/final/props/signal_tower/` (T-0201/T-0221/T-0223) against the
approved `signal_tower_props_concept_sheet_v1.png` sheet (DL-5) — this card
generates no new prop geometry. It only records the room's slot -> prop
mapping and confirms that mapping is covered by the already-enforced
pack-wide 16px separation gate.

Design note on the 16px gate check: `test_signal_tower_prop_pack.py`'s
`test_cover_vs_hiding_distinguishable_at_16px` already proves, for the
*whole* five-prop pack, that every cover prop is >= 15.0 luma16 brighter
than every hiding prop (per-prop strict ordering — see that test's
docstring). This file does not re-derive that measurement (no independent
Lanczos/luma recomputation); it instead confirms Ground Relay's specific
pair (`crate_stack_v1` cover, `locker_v1` hiding) is a member of the exact
`COVER_PROPS`/`HIDE_PROPS` sets that gate already covers. Since that gate
enforces the bound across *every* cover/hiding combination in the pack, any
pair drawn from those sets — including this room's — is covered by
construction as long as membership holds and the pack gate itself is green
(P-3, `docs/design/13-asset-pipeline.md` §6.9). A membership check plus an
upstream passing gate is a stronger and more honest guarantee here than an
independently-authored recomputation would be if that recomputation could
not itself be executed and verified in this environment.

Gate references:
  - DL-5 / P-6 — concept art precedes generation (no new geometry here).
  - P-3 — 16px legibility, enforced pack-wide by test_signal_tower_prop_pack.py.
  - P-7 (amended 2026-08-29) — provenance is required only for props a card
    *newly generates*. Ground Relay reuses five already-committed,
    already-provenanced props as-is.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.test_signal_tower_prop_pack import (
    COVER_PROPS,
    HIDE_PROPS,
    PROPS_DIR as PACK_PROPS_DIR,
    _MIN_COVER_HIDE_GAP,
)

WORKTREE = Path(__file__).resolve().parents[4]
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
MANIFEST_PATH = PROPS_DIR / "ground_relay.manifest.json"

EXPECTED_SLOTS = {
    "Dedicated hiding spot (teaching instance)": ("hiding", "locker_v1"),
    "Incidental floor dressing": ("cover", "crate_stack_v1"),
}


@pytest.fixture(scope="session")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"Missing room manifest: {MANIFEST_PATH}"
    return json.loads(MANIFEST_PATH.read_text())


def test_pack_dir_matches_room_props_dir():
    """Sanity check the two test files agree on where the pack lives."""
    assert PACK_PROPS_DIR == PROPS_DIR


def test_manifest_identifies_room(manifest):
    assert manifest["room"] == "signal_tower.ground_relay"


def test_manifest_declares_no_new_geometry(manifest):
    """This card generates no props — DL-5 has nothing new to check against."""
    assert manifest["generated_new_props"] is False


def test_manifest_has_exactly_the_two_slots(manifest):
    assert {s["slot"] for s in manifest["slots"]} == set(EXPECTED_SLOTS)


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
    for slot in manifest["slots"]:
        exp_class, exp_prop = EXPECTED_SLOTS[slot["slot"]]
        assert slot["class"] == exp_class
        assert slot["prop"] == exp_prop


def test_room_pair_is_covered_by_pack_wide_gate(manifest):
    """Ground Relay's cover/hiding pair must be drawn from the exact prop
    sets the pack-wide 16px separation gate enforces (see module docstring
    for why membership + an upstream-passing gate is the check here, not an
    independent recomputation)."""
    cover_prop = manifest["gate_16px_separation"]["room_pair"]["cover_prop"]
    hiding_prop = manifest["gate_16px_separation"]["room_pair"]["hiding_prop"]

    assert f"{cover_prop}.png" in COVER_PROPS, (
        f"{cover_prop} is not in the pack-wide gate's COVER_PROPS set — "
        "the 16px separation floor is not established for it."
    )
    assert f"{hiding_prop}.png" in HIDE_PROPS, (
        f"{hiding_prop} is not in the pack-wide gate's HIDE_PROPS set — "
        "the 16px separation floor is not established for it."
    )


def test_manifest_records_the_enforced_floor(manifest):
    """The floor recorded on the card must match the floor the pack-wide
    gate actually enforces — guards against the two drifting apart."""
    assert manifest["gate_16px_separation"]["min_required_gap_luma16"] == _MIN_COVER_HIDE_GAP


def test_manifest_points_at_the_authoritative_gate_test(manifest):
    assert manifest["gate_16px_separation"]["authoritative_test"] == (
        "assets/src/concept/tests/test_signal_tower_prop_pack.py"
        "::test_cover_vs_hiding_distinguishable_at_16px"
    )
