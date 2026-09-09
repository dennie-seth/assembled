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
from pathlib import Path

from asset_gate.character import (
    IDENTITY_STABILITY_HISTOGRAM_CAP,
    POSE_FIDELITY_IOU_FLOOR,
    asset_class,
    check_character_arm_c_provenance,
    check_character_frame_delta_cap,
    check_character_motion_fidelity,
    frame_delta_cap_for_motion_class,
    load_character_arm_c_baseline,
    sweep_character_arm_c_provenance,
    sweep_character_frame_delta_cap,
    sweep_character_motion_fidelity,
)

# The real, shipped provenance sidecar T-0340's positive control is measured
# against -- docs/decision-log.md DL-30. Not a fixture: this is the actual
# committed file, so a regression in the idle path (untouched by this card)
# would be caught against the real artifact, not a copy of it.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_T0252_IDLE_PROVENANCE_PATH = (
    _REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_hybrid_T0252.provenance.json"
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


def test_check_frame_delta_cap_is_retired_for_locomotion_T0340():
    """T-0340 retires the whole-silhouette XOR/union cap for locomotion --
    it was measurably unpassable there (rendering the rig's own skeletons as
    capsules, perfect pose, zero drift, already consumed 0.23-0.49 of this
    same 0.50 cap; docs/decision-log.md DL-30). `check_character_frame_delta_cap`
    now reports locomotion as not-applicable/skipped regardless of the
    measured range -- even a range this cap would previously have rejected
    passes, because this check no longer evaluates it at all;
    `check_character_motion_fidelity` is what grades it now."""
    prov = {"frame_delta_range": [0.10, 0.55], "motion_class": "locomotion"}
    result = check_character_frame_delta_cap(prov)
    assert result.passed
    assert result.details["skipped"]


def test_check_frame_delta_cap_is_retired_for_transition_T0340():
    prov = {"frame_delta_range": [0.10, 0.61], "motion_class": "transition"}
    result = check_character_frame_delta_cap(prov)
    assert result.passed
    assert result.details["skipped"]


def test_check_frame_delta_cap_is_retired_for_loop_T0340():
    prov = {"frame_delta_range": [0.10, 0.58], "motion_class": "loop"}
    result = check_character_frame_delta_cap(prov)
    assert result.passed
    assert result.details["skipped"]


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


# ---- sweep_character_frame_delta_cap (T-0271) ----
#
# check_character_frame_delta_cap above is only a predicate -- these tests
# cover the actual enforcement path a real `assets/final/character/*.provenance.json`
# tree is graded through (`asset-gate character-frame-delta-cap-sweep`, cli.py),
# the thing the T-0271 reviewer found nothing invoked. Mirrors
# sweep_character_arm_c_provenance's own shape/scope/baseline tests above.


def test_sweep_frame_delta_cap_fails_idle_sidecar_exceeding_030(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_idle_sheet_new.provenance.json",
        frame_delta_range=[0.05, 0.34],
        motion_class="idle",
    )

    results = sweep_character_frame_delta_cap(tmp_path)

    assert len(results) == 1
    assert not results[0].passed
    assert "character/player_idle_sheet_new.provenance.json" in results[0].reason


def test_sweep_frame_delta_cap_skips_locomotion_sheet_using_attempt6_range_T0340(tmp_path):
    """The fixture proving the enforcement path -- not just the predicate:
    T-0259 attempt 6's measured range (0.212-0.375) exceeds the idle-only
    0.30 cap, but since T-0340 this sweep no longer evaluates locomotion
    against any XOR/union cap at all -- it is reported skipped/passing
    regardless of the range, same as `check_character_frame_delta_cap`."""
    _write_prov(
        tmp_path / "character" / "player_walk_sheet_hybrid.provenance.json",
        frame_delta_range=_T0259_ATTEMPT_6_REALISTIC_WALK,
        motion_class="locomotion",
    )

    results = sweep_character_frame_delta_cap(tmp_path)

    assert len(results) == 1
    assert results[0].passed
    assert results[0].details["skipped"]


def test_sweep_frame_delta_cap_skips_gross_drift_for_locomotion_sheet_T0340(tmp_path):
    """T-0340: this sweep is retired for locomotion, so even a range that
    would have been gross drift under the old 0.50 cap is now skipped here
    -- `sweep_character_motion_fidelity` is what catches drift now."""
    _write_prov(
        tmp_path / "character" / "player_walk_sheet_drifted.provenance.json",
        frame_delta_range=[0.10, 0.55],
        motion_class="locomotion",
    )

    results = sweep_character_frame_delta_cap(tmp_path)

    assert len(results) == 1
    assert results[0].passed
    assert results[0].details["skipped"]


def test_sweep_frame_delta_cap_fails_closed_for_sidecar_missing_motion_class(tmp_path):
    """A range that would pass locomotion's 0.50 cap must still fail the
    sweep when no motion class is recorded at all."""
    _write_prov(
        tmp_path / "character" / "unlabelled.provenance.json",
        frame_delta_range=[0.34, 0.40],
    )

    results = sweep_character_frame_delta_cap(tmp_path)

    assert len(results) == 1
    assert not results[0].passed


def test_sweep_frame_delta_cap_does_not_fire_on_prop_tile_concept_or_entity_sheets(tmp_path):
    _write_prov(tmp_path / "props" / "signal_tower" / "crate_stack_v1.provenance.json")
    _write_prov(tmp_path / "tiles" / "signal_tower_concrete_wall_16px.provenance.json")
    _write_prov(tmp_path / "concept" / "player_character_concept_sheet_v1.provenance.json")
    _write_prov(tmp_path / "entity" / "watcher_idle_sheet_v1.provenance.json")

    results = sweep_character_frame_delta_cap(tmp_path)

    assert len(results) == 4
    assert all(r.passed for r in results)
    assert all(r.details.get("skipped") for r in results)


def test_sweep_frame_delta_cap_baseline_exempts_documented_pre_existing_gaps(tmp_path):
    """Sidecars predating CHR-1 (no frame_delta_range at all) are exempt from
    this sweep the same way they are exempt from the CHR-1 presence sweep --
    reuses the same baseline file/set, since a range that was never measured
    has no cap to evaluate it against either."""
    _write_prov(tmp_path / "character" / "player_idle_sheet_v1.provenance.json")
    _write_prov(
        tmp_path / "character" / "player_idle_sheet_new.provenance.json",
        frame_delta_range=[0.05, 0.09],
        motion_class="idle",
    )

    results = sweep_character_frame_delta_cap(
        tmp_path, baseline=frozenset({"character/player_idle_sheet_v1.provenance.json"})
    )

    by_path = {r.details["path"]: r for r in results}
    assert by_path["character/player_idle_sheet_v1.provenance.json"].passed
    assert by_path["character/player_idle_sheet_v1.provenance.json"].details["baseline_exempt"]
    assert by_path["character/player_idle_sheet_new.provenance.json"].passed


def test_sweep_frame_delta_cap_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_character_frame_delta_cap(tmp_path) == []


# ---- pose-fidelity IoU + identity-stability histogram (T-0340) ----
#
# Replaces the whole-silhouette XOR/union cap (`check_character_frame_delta_cap`,
# now retired above for locomotion/transition/loop) with two measures that
# separate motion from drift, per docs/decision-log.md DL-30:
#
#   - pose_fidelity_range: IoU of the rendered silhouette against the
#     rig-predicted (capsule) silhouette for that frame's own commanded
#     pose. Floor 0.7 -- the worst frame's match must still clear it.
#   - identity_stability_range: torso palette-histogram distance frame to
#     frame. Cap 0.15 -- the worst pair's drift must stay under it.
#
# `idle` is untouched -- it keeps using check_character_frame_delta_cap's
# 0.30 XOR/union cap exclusively (DL-26 is not contradicted); this check
# reports idle (and any unrecognised/missing class) as not-applicable.

# A synthetic reproduction of session 13's sequential-chained candidate
# (real pixels live under a gitignored `assets/out/` path, never committed
# -- see docs/decision-log.md DL-30). The identity-stability number below
# is not invented: it is the exact `distance` measured by `test_art.py`'s
# `test_identity_stability_catches_drift_that_frame_consistency_missed`,
# which reproduces the qualitative failure the review described (colour
# drift shrinking the silhouette, deceptively passing the old whole-frame
# delta ratio) at pixel level and is quoted here as the calibration number.
_SESSION13_DRIFT_CANDIDATE = {
    "pose_fidelity_range": [0.58, 0.81],
    "identity_stability_range": [0.09, 0.5],
}


def test_pose_fidelity_iou_floor_is_070():
    assert POSE_FIDELITY_IOU_FLOOR == 0.7


def test_identity_stability_histogram_cap_is_015():
    assert IDENTITY_STABILITY_HISTOGRAM_CAP == 0.15


def test_motion_fidelity_skipped_for_idle():
    """idle keeps using the XOR/union cap exclusively -- this check does not
    apply to it at all (DL-26 is not contradicted)."""
    prov = {
        "pose_fidelity_range": [0.1, 0.2],  # would fail the floor outright if evaluated
        "identity_stability_range": [0.9, 0.9],  # would fail the cap outright if evaluated
        "motion_class": "idle",
    }
    result = check_character_motion_fidelity(prov)
    assert result.passed
    assert result.details["skipped"]


def test_motion_fidelity_skipped_for_missing_motion_class():
    prov = {"pose_fidelity_range": [0.1, 0.2], "identity_stability_range": [0.9, 0.9]}
    result = check_character_motion_fidelity(prov)
    assert result.passed
    assert result.details["skipped"]


def test_motion_fidelity_skipped_for_unrecognised_motion_class():
    prov = {
        "pose_fidelity_range": [0.1, 0.2],
        "identity_stability_range": [0.9, 0.9],
        "motion_class": "sprint",
    }
    result = check_character_motion_fidelity(prov)
    assert result.passed
    assert result.details["skipped"]


def test_motion_fidelity_fails_when_pose_fidelity_range_missing():
    prov = {"identity_stability_range": [0.05, 0.1], "motion_class": "locomotion"}
    result = check_character_motion_fidelity(prov, sheet_name="x.png")
    assert not result.passed
    assert "pose_fidelity_range" in result.reason
    assert "x.png" in result.reason


def test_motion_fidelity_fails_when_identity_stability_range_missing():
    prov = {"pose_fidelity_range": [0.75, 0.9], "motion_class": "locomotion"}
    result = check_character_motion_fidelity(prov)
    assert not result.passed
    assert "identity_stability_range" in result.reason


def test_motion_fidelity_fails_when_both_fields_missing():
    result = check_character_motion_fidelity({"motion_class": "locomotion"})
    assert not result.passed
    assert "pose_fidelity_range" in result.reason
    assert "identity_stability_range" in result.reason


def test_motion_fidelity_fails_when_pose_fidelity_range_malformed():
    prov = {
        "pose_fidelity_range": [0.9],  # only one element
        "identity_stability_range": [0.05, 0.1],
        "motion_class": "locomotion",
    }
    result = check_character_motion_fidelity(prov)
    assert not result.passed


def test_motion_fidelity_passes_when_pose_matches_and_identity_is_stable():
    prov = {
        "pose_fidelity_range": [0.75, 0.92],
        "identity_stability_range": [0.03, 0.09],
        "motion_class": "locomotion",
    }
    result = check_character_motion_fidelity(prov)
    assert result.passed


def test_motion_fidelity_fails_when_pose_fidelity_below_floor():
    """A render that doesn't match what the rig commanded -- a non-walk, or
    a walk so timid the model barely drew it (T-0259 attempt 4's own
    measured range: docs/decision-log.md DL-30)."""
    prov = {
        "pose_fidelity_range": [0.39, 0.63],  # T-0259 attempt 4's real measured range
        "identity_stability_range": [0.03, 0.09],
        "motion_class": "locomotion",
    }
    result = check_character_motion_fidelity(prov)
    assert not result.passed


def test_motion_fidelity_fails_when_identity_stability_above_cap():
    prov = {
        "pose_fidelity_range": [0.75, 0.92],
        "identity_stability_range": [0.03, 0.20],
        "motion_class": "locomotion",
    }
    result = check_character_motion_fidelity(prov)
    assert not result.passed


def test_motion_fidelity_applies_to_transition_and_loop_too():
    for motion_class in ("transition", "loop"):
        passing = check_character_motion_fidelity(
            {
                "pose_fidelity_range": [0.75, 0.92],
                "identity_stability_range": [0.03, 0.09],
                "motion_class": motion_class,
            }
        )
        assert passing.passed

        failing = check_character_motion_fidelity(
            {
                "pose_fidelity_range": [0.75, 0.92],
                "identity_stability_range": [0.03, 0.5],
                "motion_class": motion_class,
            }
        )
        assert not failing.passed


def test_motion_fidelity_does_not_affect_chr1_pass():
    """CHR-1's own presence/shape gate is unrelated and unaffected."""
    prov = {
        "frame_delta_range": [0.10, 0.55],
        "arm_c_benchmark": [0.072, 0.112],
        "beats_arm_c_benchmark": False,
        "pose_fidelity_range": [0.75, 0.92],
        "identity_stability_range": [0.03, 0.09],
        "motion_class": "locomotion",
    }
    result = check_character_arm_c_provenance(prov)
    assert result.passed


# ---- Negative control (T-0340 acceptance): session 13's drift candidate ----


def test_negative_control_session13_drift_candidate_fails_motion_fidelity():
    """T-0340's acceptance criterion: session 13's sequential-chained walk
    candidate must FAIL the new gate -- if it passed, the thresholds would
    be wrong. It is not measured from the real asset (gitignored, never
    committed, see the module-level comment above); the identity-stability
    number is the real distance `test_art.py`'s pixel-level reproduction of
    the same failure mode measured."""
    prov = {**_SESSION13_DRIFT_CANDIDATE, "motion_class": "locomotion"}
    result = check_character_motion_fidelity(prov, sheet_name="session13_drift_candidate")
    assert not result.passed
    assert not result.details["identity_ok"]


# ---- Positive control (T-0340 acceptance): the shipped T-0252 idle sheet ----


def test_positive_control_shipped_T0252_idle_still_passes_unchanged():
    """T-0340's acceptance criterion: the shipped T-0252 idle must still
    pass its (unmodified) gate. Loaded from the real, committed provenance
    sidecar -- not a copy of its numbers -- so a regression in the idle
    path this card must not touch would fail here against the real
    artifact."""
    provenance = json.loads(_T0252_IDLE_PROVENANCE_PATH.read_text())
    result = check_character_frame_delta_cap(provenance, sheet_name="player_idle_sheet_hybrid")
    assert result.passed
    # T-0340 does not touch idle's evaluation path at all -- confirm it's
    # genuinely graded against the 0.30 cap, not accidentally skipped.
    assert "skipped" not in result.details


# ---- sweep_character_motion_fidelity (T-0340) ----


def test_sweep_motion_fidelity_fails_locomotion_sidecar_missing_fields(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_walk_sheet_new.provenance.json",
        motion_class="locomotion",
    )

    results = sweep_character_motion_fidelity(tmp_path)

    assert len(results) == 1
    assert not results[0].passed
    assert "character/player_walk_sheet_new.provenance.json" in results[0].reason


def test_sweep_motion_fidelity_passes_locomotion_sidecar_with_both_fields(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_walk_sheet_good.provenance.json",
        motion_class="locomotion",
        pose_fidelity_range=[0.75, 0.92],
        identity_stability_range=[0.03, 0.09],
    )

    results = sweep_character_motion_fidelity(tmp_path)

    assert len(results) == 1
    assert results[0].passed


def test_sweep_motion_fidelity_skips_idle_sidecar(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_idle_sheet_hybrid_T0252.provenance.json",
        motion_class="idle",
        frame_delta_range=[0.157, 0.182],
    )

    results = sweep_character_motion_fidelity(tmp_path)

    assert len(results) == 1
    assert results[0].passed
    assert results[0].details["skipped"]


def test_sweep_motion_fidelity_does_not_fire_on_prop_tile_concept_or_entity_sheets(tmp_path):
    _write_prov(tmp_path / "props" / "signal_tower" / "crate_stack_v1.provenance.json")
    _write_prov(tmp_path / "tiles" / "signal_tower_concrete_wall_16px.provenance.json")
    _write_prov(tmp_path / "concept" / "player_character_concept_sheet_v1.provenance.json")
    _write_prov(tmp_path / "entity" / "watcher_idle_sheet_v1.provenance.json")

    results = sweep_character_motion_fidelity(tmp_path)

    assert len(results) == 4
    assert all(r.passed for r in results)
    assert all(r.details.get("skipped") for r in results)


def test_sweep_motion_fidelity_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_character_motion_fidelity(tmp_path) == []
