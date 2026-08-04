import pytest

from sfx_synth.recipe import Layer, Recipe


def make_layer(**overrides):
    defaults = dict(
        onset_s=0.0,
        noise_color="white",
        center_hz=200.0,
        q=4.0,
        attack_s=0.005,
        decay_s=0.05,
    )
    defaults.update(overrides)
    return Layer(**defaults)


def make_recipe(**overrides):
    defaults = dict(
        name="test_sound",
        seed=1,
        bus="gameplay_sfx",
        layers=(make_layer(),),
        min_s=0.02,
        max_s=0.5,
    )
    defaults.update(overrides)
    return Recipe(**defaults)


def test_layer_defaults_are_sane():
    layer = make_layer()
    assert layer.filter_order == 2
    assert layer.envelope_curve == "exponential"
    assert layer.gain_db == 0.0


def test_layer_rejects_non_positive_attack_or_decay():
    with pytest.raises(ValueError):
        make_layer(attack_s=0.0, decay_s=0.0)


def test_layer_rejects_unknown_noise_color():
    with pytest.raises(ValueError):
        make_layer(noise_color="brown")


def test_layer_rejects_non_positive_center_hz_or_q():
    with pytest.raises(ValueError):
        make_layer(center_hz=0.0)
    with pytest.raises(ValueError):
        make_layer(q=0.0)


def test_layer_rejects_negative_onset():
    with pytest.raises(ValueError):
        make_layer(onset_s=-0.01)


def test_recipe_requires_at_least_one_layer():
    with pytest.raises(ValueError):
        make_recipe(layers=())


def test_recipe_rejects_bus_outside_one_shot_set():
    # D-20 / 13-asset-pipeline.md §4.1: one-shots are Gameplay or World SFX
    # only -- Ambience/Music are looping beds and collapse layers, not
    # synthesized here.
    with pytest.raises(ValueError):
        make_recipe(bus="ambience")
    with pytest.raises(ValueError):
        make_recipe(bus="music")


def test_recipe_accepts_world_and_gameplay_sfx_buses():
    assert make_recipe(bus="world_sfx").bus == "world_sfx"
    assert make_recipe(bus="gameplay_sfx").bus == "gameplay_sfx"


def test_recipe_rejects_min_s_not_less_than_max_s():
    with pytest.raises(ValueError):
        make_recipe(min_s=0.5, max_s=0.5)
    with pytest.raises(ValueError):
        make_recipe(min_s=0.6, max_s=0.5)


def test_recipe_is_frozen_and_hashable():
    recipe = make_recipe()
    with pytest.raises(Exception):
        recipe.seed = 2  # type: ignore[misc]
    hash(recipe)  # must not raise


def test_recipe_default_sample_rate_is_44100():
    assert make_recipe().sample_rate == 44100
