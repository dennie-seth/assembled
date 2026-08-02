"""Dogfood tools/asset-gate against real T-0101 output.

`13-asset-pipeline.md` §4.8's audio gate is meant to run on the encoded
file, not the synthesis source -- these tests decode the actual rendered
WAV bytes and run them through the real `asset_gate.audio` checks (the
same functions/config `tools/asset-gate`'s own test suite exercises),
not a reimplementation.

**Loop seam is deliberately not checked here.** `check_loop_seam` is the
audio analog of tile seamlessness -- it asserts a file's start and end
match, which only means something for something that loops. A one-shot
plays once and stops; running that check against one would be asserting
a property the file was never meant to have. See `sfx_synth.descent`'s
module docstring for the same point on loop-fold.

Requires `asset-gate` installed in this venv:
    pip install -e ".[dev]" -e ../../../tools/asset-gate
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
import soundfile as sf

asset_gate_audio = pytest.importorskip("asset_gate.audio")

from sfx_synth.pipeline import render_recipe_to_wav_bytes  # noqa: E402
from sfx_synth.recipes import ALL_RECIPES  # noqa: E402

LOUDNESS_TARGETS_PATH = (
    Path(__file__).resolve().parents[4]
    / "tools"
    / "asset-gate"
    / "config"
    / "loudness_targets.placeholder.json"
)


@pytest.fixture(scope="module")
def loudness_targets():
    assert LOUDNESS_TARGETS_PATH.exists(), (
        f"expected tools/asset-gate's real config at {LOUDNESS_TARGETS_PATH}"
    )
    return asset_gate_audio.load_loudness_targets(LOUDNESS_TARGETS_PATH)


@pytest.mark.parametrize("recipe", ALL_RECIPES.values(), ids=list(ALL_RECIPES))
def test_one_shot_passes_the_real_audio_gate(recipe, loudness_targets):
    encoded = render_recipe_to_wav_bytes(recipe)
    info = sf.info(io.BytesIO(encoded))
    samples, sample_rate = sf.read(io.BytesIO(encoded))

    results = [
        asset_gate_audio.check_integrated_loudness(
            samples, sample_rate, bus=recipe.bus, targets=loudness_targets
        ),
        asset_gate_audio.check_true_peak(samples, max_dbtp=-1.0),
        asset_gate_audio.check_format(
            sample_rate,
            asset_gate_audio.bit_depth_from_subtype(info.subtype),
            expected_sample_rate=44100,
            expected_bit_depth=16,
        ),
        asset_gate_audio.check_length_bounds(
            len(samples) / sample_rate, recipe.min_s, recipe.max_s
        ),
        asset_gate_audio.check_silence_trimmed(samples, sample_rate),
        asset_gate_audio.check_dc_offset(samples),
        asset_gate_audio.check_determinism(lambda r=recipe: render_recipe_to_wav_bytes(r)),
        # No check_loop_seam: N/A for one-shots, see module docstring.
    ]

    failures = [r for r in results if not r.passed]
    assert not failures, "\n".join(f"{r.check}: {r.reason}" for r in failures)
