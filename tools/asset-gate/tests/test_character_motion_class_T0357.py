"""T-0357 finding 2: a missing or unrecognised `motion_class` must FAIL, not
silently skip.

Before this card, `check_character_frame_delta_cap` and
`check_character_motion_fidelity` both treat a missing/unrecognised
`motion_class` the same way they treat `idle` -- a deliberate, correct
fail-closed default for THOSE two checks (an unlabelled sheet keeps the
strict 0.30 cap rather than getting the permissive 0.50 one, see
`character.py`'s T-0271/T-0340 module notes). But nothing anywhere actually
required a NEW asset to say what it is: a sheet could ship with no
motion_class at all and pass every existing gate by riding the same skip
path idle legitimately uses.

`check_character_motion_class_declared` is the new, independent check that
closes that gap: it fails unless `motion_class` is one of the known values
(`idle`, `locomotion`, `transition`, `loop`), with an explicit,
reviewed baseline exemption list for the 18 legacy character sidecars that
predate this requirement entirely (`character_motion_class_baseline.txt`).
`player_walk_sheet_hybrid.provenance.json` is deliberately NOT on that list
-- it postdates T-0340's motion-fidelity gate and has a real, measured
failure (docs/decision-log.md DL-31), so it must fail this sweep on merit,
not skate through on an exemption.
"""

from __future__ import annotations

import json
from pathlib import Path

from asset_gate.character import (
    KNOWN_MOTION_CLASSES,
    check_character_motion_class_declared,
    load_character_motion_class_baseline,
    sweep_character_motion_class_declared,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _write_prov(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"model": "x.safetensors", "seed": 1, **fields}))


# ---- KNOWN_MOTION_CLASSES ----


def test_known_motion_classes_are_exactly_idle_and_the_three_higher_cap_classes():
    assert KNOWN_MOTION_CLASSES == {"idle", "locomotion", "transition", "loop"}


# ---- check_character_motion_class_declared ----


def test_passes_for_idle():
    result = check_character_motion_class_declared({"motion_class": "idle"})
    assert result.passed


def test_passes_for_locomotion():
    result = check_character_motion_class_declared({"motion_class": "locomotion"})
    assert result.passed


def test_passes_for_transition():
    result = check_character_motion_class_declared({"motion_class": "transition"})
    assert result.passed


def test_passes_for_loop():
    result = check_character_motion_class_declared({"motion_class": "loop"})
    assert result.passed


def test_fails_when_motion_class_missing():
    result = check_character_motion_class_declared({}, sheet_name="player_new_sheet.png")
    assert not result.passed
    assert "player_new_sheet.png" in result.reason


def test_fails_when_motion_class_is_none():
    result = check_character_motion_class_declared({"motion_class": None})
    assert not result.passed


def test_fails_for_unrecognised_motion_class_string():
    result = check_character_motion_class_declared(
        {"motion_class": "sprint"}, sheet_name="x.png"
    )
    assert not result.passed
    assert "sprint" in result.reason
    assert "x.png" in result.reason


def test_fails_for_non_string_motion_class():
    result = check_character_motion_class_declared({"motion_class": 3})
    assert not result.passed


# ---- sweep_character_motion_class_declared ----


def test_sweep_fails_new_character_sidecar_missing_motion_class(tmp_path):
    _write_prov(tmp_path / "character" / "player_new_sheet.provenance.json")

    results = sweep_character_motion_class_declared(tmp_path)

    assert len(results) == 1
    assert not results[0].passed
    assert "character/player_new_sheet.provenance.json" in results[0].reason


def test_sweep_fails_new_character_sidecar_unknown_motion_class(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_new_sheet.provenance.json", motion_class="sprint"
    )

    results = sweep_character_motion_class_declared(tmp_path)

    assert len(results) == 1
    assert not results[0].passed


def test_sweep_passes_character_sidecar_with_known_motion_class(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_new_sheet.provenance.json", motion_class="locomotion"
    )

    results = sweep_character_motion_class_declared(tmp_path)

    assert len(results) == 1
    assert results[0].passed


def test_sweep_does_not_fire_on_prop_tile_concept_or_entity_sheets(tmp_path):
    _write_prov(tmp_path / "props" / "signal_tower" / "crate_stack_v1.provenance.json")
    _write_prov(tmp_path / "tiles" / "signal_tower_concrete_wall_16px.provenance.json")
    _write_prov(tmp_path / "concept" / "player_character_concept_sheet_v1.provenance.json")
    _write_prov(tmp_path / "entity" / "watcher_idle_sheet_v1.provenance.json")

    results = sweep_character_motion_class_declared(tmp_path)

    assert len(results) == 4
    assert all(r.passed for r in results)
    assert all(r.details.get("skipped") for r in results)


def test_sweep_baseline_exempts_documented_legacy_gaps(tmp_path):
    _write_prov(tmp_path / "character" / "player_idle_sheet_v1.provenance.json")
    _write_prov(tmp_path / "character" / "player_new_sheet.provenance.json")

    results = sweep_character_motion_class_declared(
        tmp_path, baseline=frozenset({"character/player_idle_sheet_v1.provenance.json"})
    )

    by_path = {r.details["path"]: r for r in results}
    assert by_path["character/player_idle_sheet_v1.provenance.json"].passed
    assert by_path["character/player_idle_sheet_v1.provenance.json"].details["baseline_exempt"]
    new_entry = by_path["character/player_new_sheet.provenance.json"]
    assert not new_entry.passed
    assert "baseline_exempt" not in new_entry.details


def test_sweep_does_not_baseline_exempt_a_passing_file(tmp_path):
    _write_prov(
        tmp_path / "character" / "fine.provenance.json", motion_class="idle"
    )

    results = sweep_character_motion_class_declared(
        tmp_path, baseline=frozenset({"character/fine.provenance.json"})
    )

    assert results[0].passed
    assert "baseline_exempt" not in results[0].details


def test_sweep_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_character_motion_class_declared(tmp_path) == []


# ---- load_character_motion_class_baseline ----


def test_load_character_motion_class_baseline_returns_empty_set_when_file_missing(tmp_path):
    assert (
        load_character_motion_class_baseline(tmp_path / "does_not_exist.txt") == frozenset()
    )


def test_load_character_motion_class_baseline_parses_lines_and_skips_comments_and_blanks(
    tmp_path,
):
    baseline_file = tmp_path / "baseline.txt"
    baseline_file.write_text(
        "# a comment\ncharacter/foo.provenance.json\n\ncharacter/bar.provenance.json\n"
    )

    assert load_character_motion_class_baseline(baseline_file) == frozenset(
        {"character/foo.provenance.json", "character/bar.provenance.json"}
    )


def test_load_character_motion_class_baseline_default_excludes_the_shipped_walk():
    """The card's own explicit instruction: the shipped locomotion sheet with
    a real, measured motion-fidelity failure must NOT be exempted -- only
    pre-T-0357 sheets with no motion_class opinion at all belong here."""
    baseline = load_character_motion_class_baseline()

    assert "character/player_walk_sheet_hybrid.provenance.json" not in baseline


def test_load_character_motion_class_baseline_default_matches_every_committed_character_sidecar_lacking_a_class():
    """Every committed character provenance file that has no motion_class of
    its own (i.e. every one except the walk sheet) must be covered by the
    default baseline, or this sweep would red the whole existing asset tree
    the moment it starts running in CI."""
    character_dir = _REPO_ROOT / "assets" / "final" / "character"
    baseline = load_character_motion_class_baseline()

    for path in character_dir.glob("*.provenance.json"):
        rel = f"character/{path.name}"
        provenance = json.loads(path.read_text())
        if provenance.get("motion_class") in KNOWN_MOTION_CLASSES:
            continue
        assert rel in baseline, f"{rel} has no known motion_class and is not baseline-exempt"
