"""CHR-1 character asset-gate tests (T-0258, docs/board-invariants.md CHR-1).

CHR-1 (DL-25, PR #287) requires every character-generation output to record
both its own `frame_delta_range` and its Arm-C benchmark comparison
(`arm_c_benchmark` + `beats_arm_c_benchmark`) in its provenance sidecar. Until
this card that was convention only -- no gate enforced it, so a new character
generator could drop the fields silently. These tests are for
`asset_gate.character.check_character_arm_c_provenance` and
`sweep_character_arm_c_provenance`, mirroring
`asset_gate.generator`'s check/sweep/baseline shape.

CHR-2 is the other half of the contract this gate must respect: the Arm-C
comparison is *recorded, not deciding* -- the shipped winning arm (§24-e,
T-0252) does not itself beat the benchmark. A gate that rejected
`beats_arm_c_benchmark: false` would reject the shipped character, so that is
tested explicitly below (the most likely way to get this card wrong, per the
card's own edge-case note).
"""

from __future__ import annotations

import json

from asset_gate.character import (
    asset_class,
    check_character_arm_c_provenance,
    load_character_arm_c_baseline,
    sweep_character_arm_c_provenance,
)


def _write_prov(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"model": "x.safetensors", "seed": 1, **fields}))


_BOTH_FIELDS = {
    "frame_delta_range": [0.05, 0.09],
    "arm_c_benchmark": [0.072, 0.112],
    "beats_arm_c_benchmark": True,
}


# ---- check_character_arm_c_provenance unit tests ----


def test_passes_when_both_fields_present_and_well_formed():
    result = check_character_arm_c_provenance(_BOTH_FIELDS)
    assert result.passed


def test_fails_when_frame_delta_range_missing():
    prov = {k: v for k, v in _BOTH_FIELDS.items() if k != "frame_delta_range"}
    result = check_character_arm_c_provenance(prov, sheet_name="player_idle_sheet_x.png")
    assert not result.passed
    assert "player_idle_sheet_x.png" in result.reason
    assert "frame_delta_range" in result.reason


def test_fails_when_beats_arm_c_benchmark_missing():
    prov = {k: v for k, v in _BOTH_FIELDS.items() if k != "beats_arm_c_benchmark"}
    result = check_character_arm_c_provenance(prov, sheet_name="player_idle_sheet_x.png")
    assert not result.passed
    assert "beats_arm_c_benchmark" in result.reason


def test_fails_when_arm_c_benchmark_missing():
    prov = {k: v for k, v in _BOTH_FIELDS.items() if k != "arm_c_benchmark"}
    result = check_character_arm_c_provenance(prov)
    assert not result.passed
    assert "arm_c_benchmark" in result.reason


def test_fails_when_neither_field_present():
    result = check_character_arm_c_provenance({"model": "x", "seed": 1})
    assert not result.passed
    assert "frame_delta_range" in result.reason
    assert "beats_arm_c_benchmark" in result.reason


def test_fails_when_frame_delta_range_is_malformed():
    """A 1-element or non-numeric range is not well-formed -- must fail, not
    crash and must not be treated as present."""
    prov = {**_BOTH_FIELDS, "frame_delta_range": [0.05]}
    result = check_character_arm_c_provenance(prov)
    assert not result.passed


def test_fails_when_frame_delta_range_lo_exceeds_hi():
    prov = {**_BOTH_FIELDS, "frame_delta_range": [0.09, 0.05]}
    result = check_character_arm_c_provenance(prov)
    assert not result.passed


def test_fails_when_beats_arm_c_benchmark_is_not_a_bool():
    prov = {**_BOTH_FIELDS, "beats_arm_c_benchmark": "yes"}
    result = check_character_arm_c_provenance(prov)
    assert not result.passed


def test_passes_when_beats_arm_c_benchmark_is_false():
    """CHR-2: the comparison is recorded, not deciding. A sheet that honestly
    does not beat Arm C's benchmark (the shipped §24-e winner does not) must
    still pass this gate -- only a missing/malformed field fails it."""
    prov = {**_BOTH_FIELDS, "beats_arm_c_benchmark": False}
    result = check_character_arm_c_provenance(prov)
    assert result.passed


# ---- asset_class ----


def test_asset_class_of_character_path():
    assert asset_class("character/player_idle_sheet_v1.provenance.json") == "character"


def test_asset_class_of_entity_path():
    assert asset_class("entity/watcher_idle_sheet_v1.provenance.json") == "entity"


def test_asset_class_of_bare_path_is_empty():
    assert asset_class("standalone.provenance.json") == ""


# ---- sweep_character_arm_c_provenance ----


def test_sweep_fails_for_character_sidecar_missing_fields(tmp_path):
    _write_prov(tmp_path / "character" / "player_idle_sheet_new.provenance.json")

    results = sweep_character_arm_c_provenance(tmp_path)

    assert len(results) == 1
    assert not results[0].passed
    assert "character/player_idle_sheet_new.provenance.json" in results[0].reason


def test_sweep_passes_for_character_sidecar_with_both_fields(tmp_path):
    _write_prov(tmp_path / "character" / "player_idle_sheet_hybrid_T0252.provenance.json", **_BOTH_FIELDS)

    results = sweep_character_arm_c_provenance(tmp_path)

    assert len(results) == 1
    assert results[0].passed


def test_sweep_does_not_fire_on_prop_tile_concept_or_entity_sheets(tmp_path):
    """The gate must be scoped to the `character` asset class only -- a prop,
    tile, concept or entity sheet with no frame-delta fields at all must
    still pass. Over-firing here would red-CI the whole asset tree."""
    _write_prov(tmp_path / "props" / "signal_tower" / "crate_stack_v1.provenance.json")
    _write_prov(tmp_path / "tiles" / "signal_tower_concrete_wall_16px.provenance.json")
    _write_prov(tmp_path / "concept" / "player_character_concept_sheet_v1.provenance.json")
    _write_prov(tmp_path / "entity" / "watcher_idle_sheet_v1.provenance.json")

    results = sweep_character_arm_c_provenance(tmp_path)

    assert len(results) == 4
    assert all(r.passed for r in results)
    assert all(r.details.get("skipped") for r in results)


def test_sweep_ignores_non_provenance_json_files(tmp_path):
    (tmp_path / "character").mkdir()
    (tmp_path / "character" / "notes.json").write_text(json.dumps({"x": 1}))
    _write_prov(tmp_path / "character" / "a.provenance.json", **_BOTH_FIELDS)

    results = sweep_character_arm_c_provenance(tmp_path)

    assert len(results) == 1


def test_sweep_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_character_arm_c_provenance(tmp_path) == []


def test_sweep_baseline_exempts_documented_pre_existing_gaps(tmp_path):
    _write_prov(tmp_path / "character" / "player_idle_sheet_v1.provenance.json")
    _write_prov(tmp_path / "character" / "player_idle_sheet_new.provenance.json")

    results = sweep_character_arm_c_provenance(
        tmp_path, baseline=frozenset({"character/player_idle_sheet_v1.provenance.json"})
    )

    by_path = {r.details["path"]: r for r in results}
    assert by_path["character/player_idle_sheet_v1.provenance.json"].passed
    assert by_path["character/player_idle_sheet_v1.provenance.json"].details["baseline_exempt"]
    assert not by_path["character/player_idle_sheet_new.provenance.json"].passed
    assert "baseline_exempt" not in by_path["character/player_idle_sheet_new.provenance.json"].details


def test_sweep_does_not_baseline_exempt_a_passing_file(tmp_path):
    _write_prov(tmp_path / "character" / "fine.provenance.json", **_BOTH_FIELDS)

    results = sweep_character_arm_c_provenance(
        tmp_path, baseline=frozenset({"character/fine.provenance.json"})
    )

    assert results[0].passed
    assert "baseline_exempt" not in results[0].details


# ---- load_character_arm_c_baseline ----


def test_load_character_arm_c_baseline_returns_empty_set_when_file_missing(tmp_path):
    assert load_character_arm_c_baseline(tmp_path / "does_not_exist.txt") == frozenset()


def test_load_character_arm_c_baseline_parses_lines_and_skips_comments_and_blanks(tmp_path):
    baseline_file = tmp_path / "baseline.txt"
    baseline_file.write_text("# a comment\ncharacter/foo.provenance.json\n\ncharacter/bar.provenance.json\n")

    assert load_character_arm_c_baseline(baseline_file) == frozenset(
        {"character/foo.provenance.json", "character/bar.provenance.json"}
    )


def test_load_character_arm_c_baseline_default_path_excludes_the_three_round2_winners():
    """pose_authority_T0249, chained_T0250 and hybrid_T0252 already record both
    fields on merit -- they must never acquire a baseline exemption."""
    baseline = load_character_arm_c_baseline()

    assert "character/player_idle_sheet_pose_authority_T0249.provenance.json" not in baseline
    assert "character/player_idle_sheet_chained_T0250.provenance.json" not in baseline
    assert "character/player_idle_sheet_hybrid_T0252.provenance.json" not in baseline
