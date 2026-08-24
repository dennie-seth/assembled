"""T-0226 — Signal Tower concept-sheet audit table gate.

`docs/design/13-asset-pipeline.md` §6 requires one concept sheet per asset
set, and P-6 (§23-h card body) says nothing generates without an approved
concept sheet. This card audits every Signal Tower asset set the deciding
run needs (per `docs/design/14-vertical-slice.md` §10's seven rooms)
against that requirement, rather than re-doing sheets that already exist.

The audit's own output — `signal_tower_concept_audit.json` — is the
artifact §23-d/e/f and §23-i/§23-j cite. This gate validates its structure
and, critically, its *honesty*: every row's `concept_hash` must actually
resolve against the sheet file it names, and no row may assert
`"approved": true` from this table alone — direction approval is a human
gate (§6 "two human gates, not one"; this card "parks for that verdict
rather than asserting it"), so an audit row can at most record that a
human verdict is still pending.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
AUDIT_JSON = CONCEPT_DIR / "signal_tower_concept_audit.json"

# One row required per Signal Tower asset set the deciding run will generate,
# enumerated from the seven rooms in `14` §10 plus the shared player/entity
# rosters. This is the enumeration the audit table is checked against.
REQUIRED_ASSET_SETS = {
    "base_wall_floor_tiles",
    "tile_material_detail",
    "player_character",
    "foreign_entities",
    "cover_and_hiding_props",
    "power_substation_panel_and_housing",
    "records_room_shelving",
    "ladder_traversal",
    "power_substation_catwalk_grating",
    "broadcast_deck_tear_centerpiece",
}


def _load_audit() -> dict:
    return json.loads(AUDIT_JSON.read_text())


def test_audit_table_exists():
    assert AUDIT_JSON.exists(), f"Missing audit table: {AUDIT_JSON}"


def test_audit_table_enumerates_every_required_asset_set():
    audit = _load_audit()
    rows = {row["asset_set"] for row in audit["asset_sets"]}
    missing = REQUIRED_ASSET_SETS - rows
    assert not missing, f"Audit table is missing rows for: {missing}"


def test_audit_table_rows_have_required_fields():
    audit = _load_audit()
    required = {"asset_set", "rooms", "sheet", "concept_hash", "approved", "note"}
    for row in audit["asset_sets"]:
        missing = required - row.keys()
        assert not missing, f"Row {row.get('asset_set')!r} missing fields: {missing}"


def test_audit_table_every_mapped_sheet_exists():
    audit = _load_audit()
    for row in audit["asset_sets"]:
        if row["sheet"] is None:
            continue
        sheet_path = WORKTREE / row["sheet"]
        assert sheet_path.exists(), (
            f"Row {row['asset_set']!r} maps to {row['sheet']!r}, which does not exist"
        )


def test_audit_table_concept_hash_resolves_against_the_actual_sheet():
    """The whole point of the gate: concept_hash must match the real file, not be copied text."""
    audit = _load_audit()
    for row in audit["asset_sets"]:
        if row["sheet"] is None:
            continue
        sheet_path = WORKTREE / row["sheet"]
        actual = hashlib.sha256(sheet_path.read_bytes()).hexdigest()
        assert row["concept_hash"] == actual, (
            f"Row {row['asset_set']!r}: concept_hash {row['concept_hash']!r} does not match "
            f"sha256 of {row['sheet']!r} ({actual!r})"
        )


def test_audit_table_no_row_self_asserts_approval():
    """Direction approval is a human gate (§6) — this table must never assert it for the human."""
    audit = _load_audit()
    for row in audit["asset_sets"]:
        assert row["approved"] is False, (
            f"Row {row['asset_set']!r} has approved={row['approved']!r}. "
            "The audit table may only ever record a pending verdict — approval is recorded "
            "on the card by a human, never asserted here."
        )


def test_audit_table_every_row_with_a_sheet_has_a_generator_that_resolves():
    """P-7: every sheet's generator must resolve to committed code, cited from the audit row."""
    audit = _load_audit()
    for row in audit["asset_sets"]:
        if row["sheet"] is None:
            continue
        generator = row.get("generator", "")
        assert generator, f"Row {row['asset_set']!r} has a sheet but no generator (P-7)"
        candidate = generator.split()[0]
        resolved = WORKTREE / candidate
        assert resolved.exists(), (
            f"Row {row['asset_set']!r}: generator {generator!r} does not resolve "
            f"(looked for {resolved})"
        )


def test_audit_table_not_applicable_rows_are_justified():
    """A row with sheet=None (no concept sheet needed) must explain why, not just omit one."""
    audit = _load_audit()
    for row in audit["asset_sets"]:
        if row["sheet"] is None:
            assert row.get("not_applicable") is True, (
                f"Row {row['asset_set']!r} has no sheet but isn't marked not_applicable — "
                "every row must either map to a sheet or be explicitly justified as N/A"
            )
            assert row["note"], f"Row {row['asset_set']!r} is N/A but has no justification note"
