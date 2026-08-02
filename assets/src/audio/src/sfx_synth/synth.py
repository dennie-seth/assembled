"""The synthesis engine: renders a `Recipe` to raw float samples.

`13-asset-pipeline.md` §4.5's chain, per layer: noise burst -> resonant
filter -> envelope. `render_recipe_raw` is the determinism boundary --
same recipe + seed must return byte-identical samples every call, which
is why it constructs exactly one seeded RNG and consumes it in a fixed
(list) order across layers. Descent (trim/DC/loudness/encode) happens
downstream in `sfx_synth.descent`, not here.
"""

from __future__ import annotations

import numpy as np

from sfx_synth.dsp import NOISE_GENERATORS, envelope, resonant_bandpass
from sfx_synth.recipe import Layer, Recipe


def render_layer(layer: Layer, sample_rate: int, rng: np.random.Generator) -> np.ndarray:
    n = max(1, round(layer.duration_s * sample_rate))
    noise = NOISE_GENERATORS[layer.noise_color](rng, n)
    filtered = resonant_bandpass(noise, sample_rate, layer.center_hz, layer.q, layer.filter_order)
    env = envelope(n, sample_rate, layer.attack_s, layer.decay_s, layer.envelope_curve)
    gain = 10.0 ** (layer.gain_db / 20.0)
    return filtered * env * gain


def render_recipe_raw(recipe: Recipe) -> np.ndarray:
    """Sum every layer at its onset into one float64 buffer, [-1, 1]-ish.

    One `Generator` seeded from `recipe.seed`, consumed once per layer in
    `recipe.layers` order -- the whole reason `Recipe.layers` is a tuple
    (fixed order) rather than a set.
    """
    rng = np.random.default_rng(recipe.seed)
    sample_rate = recipe.sample_rate

    rendered_layers: list[tuple[int, np.ndarray]] = []
    total_len = 0
    for layer in recipe.layers:
        onset_n = round(layer.onset_s * sample_rate)
        samples = render_layer(layer, sample_rate, rng)
        rendered_layers.append((onset_n, samples))
        total_len = max(total_len, onset_n + len(samples))

    buffer = np.zeros(total_len, dtype=np.float64)
    for onset_n, samples in rendered_layers:
        buffer[onset_n : onset_n + len(samples)] += samples
    return buffer
