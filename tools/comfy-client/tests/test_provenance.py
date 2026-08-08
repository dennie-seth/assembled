"""Provenance seam (T-0075): model + license + prompt + seed + workflow
hash, captured alongside every generation for the (not-yet-built)
ASSET_PROVENANCE.md writer -- conduct.md requires an entry for every
generated asset."""

from __future__ import annotations

import pytest

from comfy_client.errors import MissingModelHashError
from comfy_client.provenance import build_provenance_record, provenance_to_dict
from comfy_client.recipe import Recipe


def test_build_provenance_record_captures_recipe_and_workflow_fields():
    r = Recipe(prompt="a rusted hospital corridor", seed=7, steps=25, cfg=6.5)
    rec = build_provenance_record(r, workflow_hash="deadbeef", prompt_id="p1")

    assert rec.model == r.checkpoint
    assert rec.model_license == "CreativeML Open RAIL++-M"
    assert rec.prompt == r.prompt
    assert rec.negative_prompt == r.negative_prompt
    assert rec.seed == 7
    assert rec.steps == 25
    assert rec.cfg == 6.5
    assert rec.workflow_hash == "deadbeef"
    assert rec.prompt_id == "p1"


def test_provenance_to_dict_round_trips_fields():
    r = Recipe(prompt="x", seed=1, model_hash="a" * 64)
    rec = build_provenance_record(r, workflow_hash="h", prompt_id="p")
    d = provenance_to_dict(rec)
    assert d["prompt"] == "x"
    assert d["workflow_hash"] == "h"
    assert d["prompt_id"] == "p"


# ---- T-0151: model_hash required ----------------------------------------


def test_build_provenance_record_raises_when_model_hash_is_none():
    """build_provenance_record must refuse a recipe with model_hash=None (T-0151)."""
    r = Recipe(prompt="x", seed=1)  # model_hash defaults to None
    with pytest.raises(MissingModelHashError):
        build_provenance_record(r, workflow_hash="h", prompt_id="p")


def test_build_provenance_record_accepts_non_null_model_hash():
    r = Recipe(prompt="x", seed=1, model_hash="b" * 64)
    rec = build_provenance_record(r, workflow_hash="h", prompt_id="p")
    assert rec.model_hash == "b" * 64
