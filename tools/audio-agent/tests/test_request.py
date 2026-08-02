"""MusicRecipe -> ACE-Step /generate request rendering. Mirrors
tools/comfy-client/tests/test_workflow.py's role for `render_workflow`."""

from __future__ import annotations

from audio_agent.recipe import MusicRecipe
from audio_agent.request import render_request, request_hash


def test_render_request_maps_recipe_fields():
    recipe = MusicRecipe(prompt="a collapsing signal tower drone", seed=7, duration=45.0)
    req = render_request(recipe, output_filename="out_7.wav")

    assert req["prompt"] == recipe.prompt
    assert req["audio_duration"] == 45.0
    assert req["actual_seeds"] == [7]
    assert req["infer_step"] == recipe.infer_step
    assert req["scheduler_type"] == recipe.scheduler_type
    assert req["cfg_type"] == recipe.cfg_type
    assert req["output_path"] == "out_7.wav"
    assert req["lyrics"] == "[instrumental]"


def test_render_request_uses_the_given_checkpoint_path():
    recipe = MusicRecipe(prompt="x", seed=1)
    req = render_request(recipe, output_filename="x.wav", checkpoint_path="/custom/checkpoints")
    assert req["checkpoint_path"] == "/custom/checkpoints"


def test_render_request_returns_a_fresh_dict_each_call():
    recipe = MusicRecipe(prompt="x", seed=1)
    a = render_request(recipe, output_filename="x.wav")
    b = render_request(recipe, output_filename="x.wav")
    assert a == b
    assert a is not b


def test_request_hash_is_deterministic_for_equal_requests():
    recipe = MusicRecipe(prompt="x", seed=1)
    a = render_request(recipe, output_filename="x.wav")
    b = render_request(recipe, output_filename="x.wav")
    assert request_hash(a) == request_hash(b)


def test_request_hash_differs_for_different_requests():
    recipe = MusicRecipe(prompt="x", seed=1)
    a = render_request(recipe, output_filename="x.wav")
    b = render_request(recipe, output_filename="y.wav")
    assert request_hash(a) != request_hash(b)
