import io

import pytest
import soundfile as sf

from sfx_synth.bus_targets import BUS_LOUDNESS_TARGETS
from sfx_synth.descent import measure_integrated_loudness
from sfx_synth.pipeline import render_recipe_to_wav_bytes
from sfx_synth.recipe import Layer, Recipe


def make_recipe(**overrides):
    layer = Layer(
        onset_s=0.0,
        noise_color="white",
        center_hz=200.0,
        q=4.0,
        attack_s=0.005,
        decay_s=0.08,
    )
    defaults = dict(
        name="test_sound",
        seed=42,
        bus="gameplay_sfx",
        layers=(layer,),
        min_s=0.02,
        max_s=0.5,
    )
    defaults.update(overrides)
    return Recipe(**defaults)


def test_bus_loudness_targets_cover_both_one_shot_buses():
    assert set(BUS_LOUDNESS_TARGETS) == {"world_sfx", "gameplay_sfx"}


def test_render_recipe_to_wav_bytes_is_byte_identical_across_calls():
    # THE headline acceptance criterion (T-0101 / 13-asset-pipeline.md
    # §4.8): same recipe + seed -> byte-identical WAV, at the actual
    # shippable-artifact level (not just raw samples).
    recipe = make_recipe()
    a = render_recipe_to_wav_bytes(recipe)
    b = render_recipe_to_wav_bytes(recipe)
    assert a == b


def test_render_recipe_to_wav_bytes_differs_for_different_seeds():
    a = render_recipe_to_wav_bytes(make_recipe(seed=1))
    b = render_recipe_to_wav_bytes(make_recipe(seed=2))
    assert a != b


def test_render_recipe_to_wav_bytes_is_a_valid_44100_pcm16_wav():
    encoded = render_recipe_to_wav_bytes(make_recipe())
    info = sf.info(io.BytesIO(encoded))
    assert info.samplerate == 44100
    assert info.subtype == "PCM_16"


def test_render_recipe_to_wav_bytes_hits_its_bus_loudness_target():
    recipe = make_recipe(bus="world_sfx")
    encoded = render_recipe_to_wav_bytes(recipe)
    samples, sr = sf.read(io.BytesIO(encoded))
    measured = measure_integrated_loudness(samples, sr)
    target = BUS_LOUDNESS_TARGETS["world_sfx"]
    assert measured == pytest.approx(target.target_lufs, abs=target.tolerance_db)


def test_render_recipe_to_wav_bytes_has_no_leading_trailing_silence():
    encoded = render_recipe_to_wav_bytes(make_recipe())
    samples, sr = sf.read(io.BytesIO(encoded))
    assert abs(samples[0]) > 1e-4
    assert abs(samples[-1]) > 1e-4
