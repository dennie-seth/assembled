"""Recipe: the reproducible generation unit (13-asset-pipeline.md §1 --
prompt + seed + steps + cfg + dimensions + model hash)."""

from __future__ import annotations

import json

import pytest

from comfy_client.recipe import Recipe, load_recipe, recipe_to_dict


def test_recipe_defaults():
    r = Recipe(prompt="a derelict signal tower", seed=42)
    assert r.negative_prompt == ""
    assert r.steps == 20
    assert r.cfg == 7.0
    assert r.width == 1024 and r.height == 1024
    assert r.checkpoint == "sd_xl_base_1.0.safetensors"
    assert r.sampler == "euler"
    assert r.scheduler == "normal"
    assert r.model_hash is None


def test_recipe_rejects_empty_prompt():
    with pytest.raises(ValueError, match="prompt"):
        Recipe(prompt="   ", seed=1)


def test_recipe_rejects_non_positive_steps():
    with pytest.raises(ValueError, match="steps"):
        Recipe(prompt="x", seed=1, steps=0)


def test_recipe_rejects_non_positive_dimensions():
    with pytest.raises(ValueError, match="width/height"):
        Recipe(prompt="x", seed=1, width=0)
    with pytest.raises(ValueError, match="width/height"):
        Recipe(prompt="x", seed=1, height=-10)


def test_recipe_to_dict_round_trips():
    r = Recipe(prompt="x", seed=7, steps=30)
    d = recipe_to_dict(r)
    assert d["prompt"] == "x"
    assert d["seed"] == 7
    assert d["steps"] == 30
    assert Recipe(**d) == r


def test_load_recipe_from_json_file(tmp_path):
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps({"prompt": "a rusted hospital corridor", "seed": 99, "cfg": 6.5}))
    r = load_recipe(path)
    assert r.prompt == "a rusted hospital corridor"
    assert r.seed == 99
    assert r.cfg == 6.5
    assert r.steps == 20  # default, not present in the file
