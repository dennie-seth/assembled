"""Synthesize raw ambience samples from an AmbienceRecipe.

Produces `recipe.raw_s` seconds of float64 samples (mono) in roughly [-1, 1].
Determinism contract: same recipe.seed → byte-identical output every call.
One RNG, consumed layer-by-layer in recipe.layers order (tuple → fixed order).
"""

from __future__ import annotations

import numpy as np

from ambience_synth.dsp import pink_noise, resonant_bandpass, white_noise
from ambience_synth.recipe import AmbienceRecipe

_NOISE_GENERATORS = {
    "pink": pink_noise,
    "white": white_noise,
}


def synthesize(recipe: AmbienceRecipe) -> np.ndarray:
    """Return raw float64 samples of shape (raw_n,) for the given recipe.

    raw_n = round(recipe.raw_s * recipe.sample_rate)
    """
    sr = recipe.sample_rate
    raw_n = round(recipe.raw_s * sr)
    rng = np.random.default_rng(recipe.seed)

    buffer = np.zeros(raw_n, dtype=np.float64)
    for layer in recipe.layers:
        noise_fn = _NOISE_GENERATORS[layer.noise_color]
        noise = noise_fn(rng, raw_n)
        filtered = resonant_bandpass(noise, sr, layer.center_hz, layer.q)
        gain = 10.0 ** (layer.gain_db / 20.0)
        buffer += filtered * gain

    return buffer
