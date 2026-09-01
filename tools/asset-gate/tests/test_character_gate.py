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
    check_character_frame_delta_cap,
    frame_delta_cap_for_motion_class,
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
    _write_prov(
        tmp_path / "character" / "player_idle_sheet_hybrid_T0252.provenance.json", **_BOTH_FIELDS
    )

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
    new_entry = by_path["character/player_idle_sheet_new.provenance.json"]
    assert not new_entry.passed
    assert "baseline_exempt" not in new_entry.details


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
    baseline_file.write_text(
        "# a comment\ncharacter/foo.provenance.json\n\ncharacter/bar.provenance.json\n"
    )

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


# ---- motion-class-aware frame-delta cap (T-0271) ----
#
# DL-21's 0.30 cap was pre-registered against the player IDLE sheet. Every
# character animation since inherited that number regardless of what the
# character is doing, and T-0259's walk-cycle calibration trail shows the
# result: a correct, smooth walk legitimately moves far more silhouette
# pixels per frame than an idle, so it scores *worse* against a cap sized for
# standing still. These tests pin the fix -- idle keeps 0.30 unchanged,
# locomotion/transition/loop get the higher ~0.50 cap DL-26 justifies from
# T-0259's own measured data, a missing/unrecognised class fails closed to
# 0.30, and gross drift still fails even under the higher cap.

# T-0259 attempt 4 (committed, §24/hybrid-walk lineage) -- motion barely
# visible, well inside the idle cap.
_T0259_ATTEMPT_4_IDLE_LIKE = [0.034, 0.253]
# T-0259 attempt 6 -- reads as a real walk on human review, and its own
# upper bound (0.375) exceeds the idle-only 0.30 cap outright.
_T0259_ATTEMPT_6_REALISTIC_WALK = [0.212, 0.375]


def test_frame_delta_cap_for_idle_is_030():
    assert frame_delta_cap_for_motion_class("idle") == 0.30


def test_frame_delta_cap_for_locomotion_is_050():
    assert frame_delta_cap_for_motion_class("locomotion") == 0.50


def test_frame_delta_cap_for_transition_is_050():
    assert frame_delta_cap_for_motion_class("transition") == 0.50


def test_frame_delta_cap_for_loop_is_050():
    assert frame_delta_cap_for_motion_class("loop") == 0.50


def test_frame_delta_cap_fails_closed_to_idle_cap_for_missing_class():
    assert frame_delta_cap_for_motion_class(None) == 0.30


def test_frame_delta_cap_fails_closed_to_idle_cap_for_unrecognised_class():
    assert frame_delta_cap_for_motion_class("sprint") == 0.30


def test_check_frame_delta_cap_passes_idle_sheet_within_030():
    prov = {"frame_delta_range": _T0259_ATTEMPT_4_IDLE_LIKE, "motion_class": "idle"}
    result = check_character_frame_delta_cap(prov)
    assert result.passed


def test_check_frame_delta_cap_fails_idle_sheet_exceeding_030():
    """(a) idle stays capped at 0.30, unchanged -- this is not a loosening."""
    prov = {"frame_delta_range": [0.05, 0.34], "motion_class": "idle"}
    result = check_character_frame_delta_cap(prov)
    assert not result.passed


def test_check_frame_delta_cap_passes_realistic_walk_that_030_would_reject():
    """(b) a locomotion sheet whose measured range 0.30 would reject (T-0259
    attempt 6, human-confirmed as reading like a real walk) passes under the
    locomotion cap."""
    assert _T0259_ATTEMPT_6_REALISTIC_WALK[1] > 0.30  # sanity: 0.30 would reject this
    prov = {"frame_delta_range": _T0259_ATTEMPT_6_REALISTIC_WALK, "motion_class": "locomotion"}
    result = check_character_frame_delta_cap(prov)
    assert result.passed


def test_check_frame_delta_cap_still_fails_gross_drift_under_locomotion():
    """(c) the gate is not defanged -- drift beyond the new ~0.50 cap still
    fails even for a locomotion-class sheet."""
    prov = {"frame_delta_range": [0.10, 0.55], "motion_class": "locomotion"}
    result = check_character_frame_delta_cap(prov)
    assert not result.passed


def test_check_frame_delta_cap_still_fails_gross_drift_under_transition():
    prov = {"frame_delta_range": [0.10, 0.61], "motion_class": "transition"}
    result = check_character_frame_delta_cap(prov)
    assert not result.passed


def test_check_frame_delta_cap_still_fails_gross_drift_under_loop():
    prov = {"frame_delta_range": [0.10, 0.58], "motion_class": "loop"}
    result = check_character_frame_delta_cap(prov)
    assert not result.passed


def test_check_frame_delta_cap_fails_closed_when_motion_class_missing():
    """A range that would pass locomotion's 0.50 cap must still fail when no
    motion class is recorded at all -- an unlabelled sheet never gets the
    permissive cap."""
    prov = {"frame_delta_range": [0.34, 0.40]}
    result = check_character_frame_delta_cap(prov)
    assert not result.passed


def test_check_frame_delta_cap_fails_closed_for_unrecognised_motion_class():
    prov = {"frame_delta_range": [0.34, 0.40], "motion_class": "sprint"}
    result = check_character_frame_delta_cap(prov)
    assert not result.passed


def test_check_frame_delta_cap_fails_when_frame_delta_range_missing():
    result = check_character_frame_delta_cap({"motion_class": "idle"})
    assert not result.passed
    assert "frame_delta_range" in result.reason


def test_check_frame_delta_cap_fails_when_frame_delta_range_malformed():
    prov = {"frame_delta_range": [0.05], "motion_class": "idle"}
    result = check_character_frame_delta_cap(prov)
    assert not result.passed


def test_check_frame_delta_cap_reason_names_sheet_and_cap():
    prov = {"frame_delta_range": [0.05, 0.34], "motion_class": "idle"}
    result = check_character_frame_delta_cap(prov, sheet_name="player_walk_sheet_x.png")
    assert "player_walk_sheet_x.png" in result.reason
    assert "0.3" in result.reason


def test_check_frame_delta_cap_does_not_affect_chr1_pass():
    """CHR-1's own gate (presence/shape of frame_delta_range +
    arm_c_benchmark comparison) is unchanged by this card -- it must keep
    passing regardless of motion class or the new cap."""
    prov = {
        "frame_delta_range": _T0259_ATTEMPT_6_REALISTIC_WALK,
        "arm_c_benchmark": [0.072, 0.112],
        "beats_arm_c_benchmark": False,
        "motion_class": "locomotion",
    }
    result = check_character_arm_c_provenance(prov)
    assert result.passed
