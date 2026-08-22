"""Provenance validation gate tests (T-0151).

Tests for `asset_gate.provenance.check_provenance_model_hash`.  The
validation gate (T-0102) must reject any provenance record that is
missing a non-null `model_hash` -- a null hash means the exact weights
that produced an asset cannot be proven (PLAN.md §0).
"""

from __future__ import annotations

import json

from asset_gate.provenance import (
    check_provenance_model_hash,
    load_baseline,
    sweep_provenance_model_hash,
)


def test_passes_when_model_hash_is_present():
    prov = {
        "model": "sd_xl_base_1.0.safetensors",
        "model_hash": "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
        "seed": 42,
    }
    result = check_provenance_model_hash(prov)
    assert result.passed


def test_fails_when_model_hash_is_null():
    prov = {
        "model": "sd_xl_base_1.0.safetensors",
        "model_hash": None,
        "seed": 42,
    }
    result = check_provenance_model_hash(prov)
    assert not result.passed
    assert "null" in result.reason.lower() or "missing" in result.reason.lower()


def test_fails_when_model_hash_key_is_absent():
    prov = {
        "model": "sd_xl_base_1.0.safetensors",
        "seed": 42,
    }
    result = check_provenance_model_hash(prov)
    assert not result.passed


def test_fails_when_model_hash_is_empty_string():
    prov = {
        "model": "sd_xl_base_1.0.safetensors",
        "model_hash": "",
        "seed": 42,
    }
    result = check_provenance_model_hash(prov)
    assert not result.passed


def test_result_check_name_is_provenance_model_hash():
    prov = {"model": "x.safetensors", "model_hash": "abc123"}
    result = check_provenance_model_hash(prov)
    assert result.check == "provenance_model_hash"


# ---- Repo-wide sweep (HANDOFF §21): catches any writer's gap, not just one file ----


def _write_prov(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"model": "x.safetensors", "seed": 1, **fields}))


def test_sweep_passes_when_every_sidecar_has_a_model_hash(tmp_path):
    _write_prov(tmp_path / "a.provenance.json", model_hash="a" * 64)
    _write_prov(tmp_path / "nested" / "b.provenance.json", model_hash="b" * 64)

    results = sweep_provenance_model_hash(tmp_path)

    assert len(results) == 2
    assert all(r.passed for r in results)


def test_sweep_fails_for_each_sidecar_with_a_null_model_hash(tmp_path):
    _write_prov(tmp_path / "good.provenance.json", model_hash="a" * 64)
    _write_prov(tmp_path / "bad.provenance.json", model_hash=None)

    results = sweep_provenance_model_hash(tmp_path)

    assert len(results) == 2
    by_pass = {r.passed for r in results}
    assert by_pass == {True, False}
    failing = [r for r in results if not r.passed]
    assert "bad.provenance.json" in failing[0].reason


def test_sweep_ignores_non_provenance_json_files(tmp_path):
    (tmp_path / "recipe.json").write_text(json.dumps({"prompt": "x"}))
    _write_prov(tmp_path / "a.provenance.json", model_hash="a" * 64)

    results = sweep_provenance_model_hash(tmp_path)

    assert len(results) == 1


def test_sweep_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_provenance_model_hash(tmp_path) == []


# ---- Baseline exemption for documented pre-existing gaps (HANDOFF §21, PR #221) ----


def test_sweep_baseline_exempts_documented_pre_existing_gaps(tmp_path):
    _write_prov(tmp_path / "known_bad.provenance.json", model_hash=None)
    _write_prov(tmp_path / "unknown_bad.provenance.json", model_hash=None)

    results = sweep_provenance_model_hash(
        tmp_path, baseline=frozenset({"known_bad.provenance.json"})
    )

    by_path = {r.details["path"]: r for r in results}
    assert by_path["known_bad.provenance.json"].passed
    assert by_path["known_bad.provenance.json"].details["baseline_exempt"] is True
    assert not by_path["unknown_bad.provenance.json"].passed
    assert "baseline_exempt" not in by_path["unknown_bad.provenance.json"].details


def test_sweep_baseline_does_not_exempt_a_passing_file(tmp_path):
    _write_prov(tmp_path / "fine.provenance.json", model_hash="a" * 64)

    results = sweep_provenance_model_hash(tmp_path, baseline=frozenset({"fine.provenance.json"}))

    assert results[0].passed
    assert "baseline_exempt" not in results[0].details


def test_load_baseline_returns_empty_set_when_file_missing(tmp_path):
    assert load_baseline(tmp_path / "does_not_exist.txt") == frozenset()


def test_load_baseline_parses_lines_and_skips_comments_and_blanks(tmp_path):
    baseline_file = tmp_path / "baseline.txt"
    baseline_file.write_text("# a comment\nfoo/bar.provenance.json\n\nbaz.provenance.json\n")

    assert load_baseline(baseline_file) == frozenset(
        {"foo/bar.provenance.json", "baz.provenance.json"}
    )


def test_load_baseline_default_path_lists_remaining_in_flight_gaps():
    """After T-0215 removed 8 backfilled entries, the baseline holds 13 paths
    for the T-0198/T-0199/T-0200 sheets still owned by T-0212/T-0213/T-0214.
    (HANDOFF §21 / T-0215)
    """
    baseline = load_baseline()

    assert len(baseline) == 13
    # T-0215-owned paths must be gone (backfilled)
    assert "src/concept/player_character_concept_sheet_v1.provenance.json" not in baseline
    assert "src/concept/entities_concept_sheet_v1.provenance.json" not in baseline
    assert "final/tiles/signal_tower_concrete_wall_floor_transitions_16px.provenance.json" not in baseline
    assert "final/props/signal_tower/crate_stack_v1.provenance.json" not in baseline
    # T-0212/T-0213/T-0214 paths must still be present
    assert "final/character/player_idle_sheet_v1.provenance.json" in baseline
    assert "final/entity/watcher_idle_sheet_v1.provenance.json" in baseline
