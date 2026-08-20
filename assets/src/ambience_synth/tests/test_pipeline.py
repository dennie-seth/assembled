"""Integration tests for the ambience_synth pipeline.

These exercise the full T-0083 chain (synthesize → DC offset → loop-fold →
loudness normalize → Ogg encode) using a fast trimmed recipe — not the full
30-second Signal Tower recipe (that's the artifact test).
"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from ambience_synth.pipeline import render_to_ogg
from ambience_synth.recipe import AmbienceLayer, AmbienceRecipe


def _fast_recipe(**overrides) -> AmbienceRecipe:
    """Tiny recipe for fast in-test rendering (3s body + 0.5s crossfade)."""
    defaults = dict(
        name="test_ambience",
        seed=1,
        bus="ambience",
        body_s=3.0,
        crossfade_s=0.5,
        sample_rate=44100,
        layers=(AmbienceLayer(noise_color="pink", center_hz=60.0, q=10.0, gain_db=0.0),),
    )
    defaults.update(overrides)
    return AmbienceRecipe(**defaults)


def test_render_to_ogg_produces_ogg_file(tmp_path):
    out = tmp_path / "test.ogg"
    render_to_ogg(_fast_recipe(), out)
    assert out.exists()
    info = sf.info(str(out))
    assert info.format == "OGG"
    assert info.samplerate == 44100


def test_render_to_ogg_output_duration_matches_body_s(tmp_path):
    recipe = _fast_recipe(body_s=3.0, crossfade_s=0.5)
    out = tmp_path / "test.ogg"
    render_to_ogg(recipe, out)
    samples, sr = sf.read(str(out))
    duration_s = len(samples) / sr
    # Allow 1 sample tolerance (rounding in round())
    expected_s = recipe.body_s
    assert abs(duration_s - expected_s) < 1.5 / sr


def test_render_to_ogg_loudness_near_target(tmp_path):
    import pyloudnorm as pyln

    recipe = _fast_recipe()
    out = tmp_path / "test.ogg"
    render_to_ogg(recipe, out)
    samples, sr = sf.read(str(out))
    meter = pyln.Meter(sr, block_size=0.4)
    measured = float(meter.integrated_loudness(samples.astype(np.float64)))
    assert abs(measured - (-23.0)) <= 2.0, f"loudness {measured:.2f} LUFS not within -23 ±2"


def test_render_to_ogg_loop_seam_passes(tmp_path):
    """Loop seam check on decoded Ogg (the T-0202 core criterion)."""
    recipe = _fast_recipe(body_s=5.0, crossfade_s=1.0)
    out = tmp_path / "test.ogg"
    render_to_ogg(recipe, out)
    samples, sr = sf.read(str(out))
    mono = samples if samples.ndim == 1 else samples.mean(axis=1)
    n = 32
    max_diff = float(np.max(np.abs(mono[:n] - mono[-n:])))
    assert max_diff <= 0.10, f"loop seam failed after Ogg encode: {max_diff:.5f}"


def test_render_to_ogg_has_loop_start_comment(tmp_path):
    OggVorbis = pytest.importorskip("mutagen.oggvorbis").OggVorbis
    out = tmp_path / "test.ogg"
    render_to_ogg(_fast_recipe(), out)
    tags = OggVorbis(str(out))
    keys_lower = {k.lower() for k in tags.keys()}
    assert "loop_start" in keys_lower


def test_render_to_ogg_different_seeds_differ(tmp_path):
    out1 = tmp_path / "a.ogg"
    out2 = tmp_path / "b.ogg"
    render_to_ogg(_fast_recipe(seed=1), out1)
    render_to_ogg(_fast_recipe(seed=2), out2)
    assert out1.read_bytes() != out2.read_bytes()


def test_render_to_ogg_same_seed_is_reproducible(tmp_path):
    out1 = tmp_path / "a.ogg"
    out2 = tmp_path / "b.ogg"
    recipe = _fast_recipe(seed=42)
    render_to_ogg(recipe, out1)
    render_to_ogg(recipe, out2)
    # Compare decoded samples — Ogg Vorbis embeds a random serial per stream so
    # raw byte equality is never guaranteed even for identical audio content.
    samples1, sr1 = sf.read(str(out1), dtype="float64")
    samples2, sr2 = sf.read(str(out2), dtype="float64")
    assert sr1 == sr2
    np.testing.assert_array_equal(samples1, samples2)
