"""TextureRecipe -- the reproducible texture-SFX generation unit
(13-asset-pipeline.md §4.5: entity vocalizations, room events, drones via
Stable Audio Open). Mirrors test_recipe.py's role for MusicRecipe."""

from __future__ import annotations

import json

import pytest

from audio_agent.bus import Bus
from audio_agent.texture_recipe import TextureRecipe, load_texture_recipe, texture_recipe_to_dict


def test_texture_recipe_defaults():
    r = TextureRecipe(prompt="a low mechanical drone", seed=1)
    assert r.seconds == 6.0
    assert r.steps == 100
    assert r.cfg == 7.0
    assert r.negative_prompt == "music, melody, singing, low quality"
    assert r.checkpoint == "stabilityai/stable-audio-open-1.0"
    assert r.bus is Bus.WORLD_SFX


def test_texture_recipe_rejects_empty_prompt():
    with pytest.raises(ValueError, match="prompt must not be empty"):
        TextureRecipe(prompt="   ", seed=1)


def test_texture_recipe_rejects_nonpositive_seconds():
    with pytest.raises(ValueError, match="seconds must be positive"):
        TextureRecipe(prompt="x", seed=1, seconds=0)


def test_texture_recipe_rejects_nonpositive_steps():
    with pytest.raises(ValueError, match="steps must be positive"):
        TextureRecipe(prompt="x", seed=1, steps=0)


def test_texture_recipe_accepts_gameplay_sfx_bus_for_entity_vocalizations():
    r = TextureRecipe(prompt="a wet guttural growl", seed=1, bus=Bus.GAMEPLAY_SFX)
    assert r.bus is Bus.GAMEPLAY_SFX


def test_texture_recipe_accepts_ambience_bus_for_drones():
    r = TextureRecipe(prompt="a collapse-stage drone bed", seed=1, bus=Bus.AMBIENCE)
    assert r.bus is Bus.AMBIENCE


def test_texture_recipe_to_dict_serializes_bus_as_its_string_value():
    r = TextureRecipe(prompt="x", seed=1)
    d = texture_recipe_to_dict(r)
    assert d["bus"] == "World SFX"
    assert d["prompt"] == "x"


def test_load_texture_recipe_round_trips_through_json(tmp_path):
    original = TextureRecipe(prompt="a room-anchored ventilation hum", seed=99, bus=Bus.AMBIENCE)
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps(texture_recipe_to_dict(original)))

    loaded = load_texture_recipe(path)
    assert loaded == original


def test_load_texture_recipe_defaults_bus_when_omitted(tmp_path):
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps({"prompt": "x", "seed": 1}))

    loaded = load_texture_recipe(path)
    assert loaded.bus is Bus.WORLD_SFX
