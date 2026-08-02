"""Recipe -> shippable WAV bytes, end to end (`13-asset-pipeline.md` §4.7).

    render_recipe_raw   (sfx_synth.synth)
      -> trim_silence, remove_dc_offset, loudness_normalize   (sfx_synth.descent)
      -> encode_wav_bytes                                     (sfx_synth.descent)

This is the function the determinism acceptance criterion is checked
against (T-0101: "same seed produces a byte-identical WAV output") and
the one both the CLI and the gate-integration test call -- one code path,
so there is no way for what ships to diverge from what gets validated.
"""

from __future__ import annotations

from sfx_synth.bus_targets import BUS_LOUDNESS_TARGETS
from sfx_synth.descent import (
    encode_wav_bytes,
    loudness_normalize,
    remove_dc_offset,
    trim_silence,
)
from sfx_synth.recipe import Recipe
from sfx_synth.synth import render_recipe_raw


def render_recipe_to_wav_bytes(recipe: Recipe) -> bytes:
    raw = render_recipe_raw(recipe)
    trimmed = trim_silence(raw)
    dc_fixed = remove_dc_offset(trimmed)
    target = BUS_LOUDNESS_TARGETS[recipe.bus]
    normalized = loudness_normalize(dc_fixed, recipe.sample_rate, target.target_lufs)
    return encode_wav_bytes(normalized, recipe.sample_rate)
