"""Provenance validation gate tests (T-0151).

Tests for `asset_gate.provenance.check_provenance_model_hash`.  The
validation gate (T-0102) must reject any provenance record that is
missing a non-null `model_hash` -- a null hash means the exact weights
that produced an asset cannot be proven (PLAN.md §0).
"""

from __future__ import annotations

from asset_gate.provenance import check_provenance_model_hash


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
