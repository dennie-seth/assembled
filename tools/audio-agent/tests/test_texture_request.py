"""TextureRecipe -> Stable Audio Open /generate request rendering. Mirrors
test_request.py's role for MusicRecipe/ACE-Step."""

from __future__ import annotations

from audio_agent.texture_recipe import TextureRecipe
from audio_agent.texture_request import render_texture_request, texture_request_hash


def test_render_texture_request_maps_recipe_fields():
    recipe = TextureRecipe(prompt="a collapsing signal tower drone", seed=7, seconds=12.0)
    req = render_texture_request(recipe, output_filename="out_7.wav")

    assert req["prompt"] == recipe.prompt
    assert req["negative_prompt"] == recipe.negative_prompt
    assert req["seconds"] == 12.0
    assert req["steps"] == recipe.steps
    assert req["cfg"] == recipe.cfg
    assert req["seed"] == 7
    assert req["output_path"] == "out_7.wav"


def test_render_texture_request_returns_a_fresh_dict_each_call():
    recipe = TextureRecipe(prompt="x", seed=1)
    a = render_texture_request(recipe, output_filename="x.wav")
    b = render_texture_request(recipe, output_filename="x.wav")
    assert a == b
    assert a is not b


def test_texture_request_hash_is_deterministic_for_equal_requests():
    recipe = TextureRecipe(prompt="x", seed=1)
    a = render_texture_request(recipe, output_filename="x.wav")
    b = render_texture_request(recipe, output_filename="x.wav")
    assert texture_request_hash(a) == texture_request_hash(b)


def test_texture_request_hash_differs_for_different_requests():
    recipe = TextureRecipe(prompt="x", seed=1)
    a = render_texture_request(recipe, output_filename="x.wav")
    b = render_texture_request(recipe, output_filename="y.wav")
    assert texture_request_hash(a) != texture_request_hash(b)
