"""MusicRecipe -- the reproducible generation unit (13-asset-pipeline.md §1).
Mirrors tools/comfy-client/tests/test_recipe.py."""

from __future__ import annotations

import json

import pytest

from audio_agent.bus import Bus
from audio_agent.recipe import MusicRecipe, load_recipe, recipe_to_dict


def test_recipe_defaults():
    r = MusicRecipe(prompt="a slow industrial drone", seed=1)
    assert r.duration == 30.0
    assert r.lyrics == "[instrumental]"
    assert r.infer_step == 27
    assert r.checkpoint == "ACE-Step-v1-3.5B"
    assert r.bus is Bus.MUSIC


def test_recipe_rejects_empty_prompt():
    with pytest.raises(ValueError, match="prompt must not be empty"):
        MusicRecipe(prompt="   ", seed=1)


def test_recipe_rejects_nonpositive_duration():
    with pytest.raises(ValueError, match="duration must be positive"):
        MusicRecipe(prompt="x", seed=1, duration=0)


def test_recipe_rejects_nonpositive_infer_step():
    with pytest.raises(ValueError, match="infer_step must be positive"):
        MusicRecipe(prompt="x", seed=1, infer_step=0)


def test_recipe_to_dict_serializes_bus_as_its_string_value():
    r = MusicRecipe(prompt="x", seed=1)
    d = recipe_to_dict(r)
    assert d["bus"] == "Music"
    assert d["prompt"] == "x"


def test_load_recipe_round_trips_through_json(tmp_path):
    original = MusicRecipe(prompt="a room-anchored music cue", seed=99, bus=Bus.MUSIC)
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps(recipe_to_dict(original)))

    loaded = load_recipe(path)
    assert loaded == original


def test_load_recipe_defaults_bus_when_omitted(tmp_path):
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps({"prompt": "x", "seed": 1}))

    loaded = load_recipe(path)
    assert loaded.bus is Bus.MUSIC
