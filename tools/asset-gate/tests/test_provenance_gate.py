"""Provenance validation gate tests (T-0151).

Tests for `asset_gate.provenance.check_provenance_model_hash`.  The
validation gate (T-0102) must reject any provenance record that is
missing a non-null `model_hash` -- a null hash means the exact weights
that produced an asset cannot be proven (PLAN.md §0).
"""

from __future__ import annotations

import json

from asset_gate.provenance import check_provenance_model_hash, sweep_provenance_model_hash


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
