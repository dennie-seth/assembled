import numpy as np

from sfx_synth.recipe import Layer, Recipe
from sfx_synth.synth import render_layer, render_recipe_raw

SAMPLE_RATE = 44100


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


def test_render_layer_length_matches_attack_plus_decay():
    layer = make_layer(attack_s=0.01, decay_s=0.09)
    rng = np.random.default_rng(1)
    out = render_layer(layer, SAMPLE_RATE, rng)
    assert len(out) == round(0.1 * SAMPLE_RATE)


def test_render_layer_is_silent_when_gain_is_very_low():
    loud = render_layer(make_layer(gain_db=0.0), SAMPLE_RATE, np.random.default_rng(1))
    quiet = render_layer(make_layer(gain_db=-60.0), SAMPLE_RATE, np.random.default_rng(1))
    assert np.max(np.abs(quiet)) < np.max(np.abs(loud)) * 0.01


def test_render_recipe_raw_is_deterministic_same_seed():
    # THE HEADLINE TEST (13-asset-pipeline.md §4.8): same recipe + seed ->
    # byte-identical output. This must hold at the raw-samples stage
    # already, before descent/encoding even enter the picture.
    recipe = make_recipe(seed=42)
    a = render_recipe_raw(recipe)
    b = render_recipe_raw(recipe)
    assert np.array_equal(a, b)


def test_render_recipe_raw_differs_across_seeds():
    a = render_recipe_raw(make_recipe(seed=1))
    b = render_recipe_raw(make_recipe(seed=2))
    assert not np.array_equal(a, b)


def test_render_recipe_raw_places_layer_at_its_onset():
    early = Layer(
        onset_s=0.0, noise_color="white", center_hz=500.0, q=4.0, attack_s=0.002, decay_s=0.01
    )
    late = Layer(
        onset_s=0.05, noise_color="white", center_hz=500.0, q=4.0, attack_s=0.002, decay_s=0.01
    )
    recipe = make_recipe(layers=(early, late), max_s=0.2)
    samples = render_recipe_raw(recipe)
    onset_n = round(0.05 * SAMPLE_RATE)
    # Nothing has been rendered yet at a point well before the second
    # layer's onset but after the first layer's burst has fully decayed.
    quiet_gap = samples[round(0.02 * SAMPLE_RATE) : onset_n - 10]
    assert np.max(np.abs(quiet_gap)) < 0.05


def test_render_recipe_raw_sums_overlapping_layers_exactly():
    # Two overlapping layers must sum sample-for-sample, consuming the
    # *same* rng stream sequentially -- reproduce that by hand (fresh rng,
    # same seed, same layer-call order) and require an exact match. A
    # statistical comparison (peak/RMS) would be flaky: two independent
    # noise draws can happen to destructively interfere for any given seed.
    layer = make_layer(onset_s=0.0)
    recipe = make_recipe(layers=(layer, layer), seed=7)
    combined = render_recipe_raw(recipe)

    rng = np.random.default_rng(7)
    first = render_layer(layer, SAMPLE_RATE, rng)
    second = render_layer(layer, SAMPLE_RATE, rng)
    expected = np.zeros(max(len(first), len(second)))
    expected[: len(first)] += first
    expected[: len(second)] += second

    assert np.array_equal(combined, expected)


def test_render_recipe_raw_length_covers_latest_layer_tail():
    layer = make_layer(onset_s=0.1, attack_s=0.005, decay_s=0.02)
    recipe = make_recipe(layers=(layer,), max_s=0.5)
    samples = render_recipe_raw(recipe)
    expected_min_len = round((0.1 + 0.005 + 0.02) * SAMPLE_RATE)
    assert len(samples) >= expected_min_len
