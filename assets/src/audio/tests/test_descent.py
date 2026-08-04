import io

import numpy as np
import pyloudnorm as pyln
import pytest
import soundfile as sf

from sfx_synth.descent import (
    encode_wav_bytes,
    loudness_normalize,
    measure_integrated_loudness,
    remove_dc_offset,
    trim_silence,
)

SAMPLE_RATE = 44100


def _sine(freq, duration_s, sample_rate=SAMPLE_RATE, amplitude=0.3):
    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    # Phase offset so sample 0 isn't itself a zero-crossing -- otherwise
    # trim_silence legitimately (and correctly) trims it, which would
    # make length-preservation assertions flaky by construction.
    return amplitude * np.sin(2 * np.pi * freq * t + 0.3)


def test_trim_silence_removes_leading_and_trailing_zeros():
    tone = _sine(440, 0.05, amplitude=0.5)
    padded = np.concatenate([np.zeros(2000), tone, np.zeros(3000)])
    trimmed = trim_silence(padded, threshold=1e-3)
    assert len(trimmed) == len(tone)
    assert np.allclose(trimmed, tone)


def test_trim_silence_keeps_all_when_no_silence():
    tone = _sine(440, 0.05, amplitude=0.5)
    trimmed = trim_silence(tone, threshold=1e-3)
    assert np.array_equal(trimmed, tone)


def test_trim_silence_raises_when_entirely_silent():
    with pytest.raises(ValueError):
        trim_silence(np.zeros(1000), threshold=1e-3)


def test_remove_dc_offset_zeroes_mean():
    tone = _sine(440, 0.05, amplitude=0.5) + 0.2
    fixed = remove_dc_offset(tone)
    assert abs(np.mean(fixed)) < 1e-9


def test_measure_integrated_loudness_matches_direct_pyloudnorm_reference():
    tone = _sine(1000, 2.0, amplitude=0.3)
    expected = pyln.Meter(SAMPLE_RATE).integrated_loudness(tone.astype(np.float64))
    measured = measure_integrated_loudness(tone, SAMPLE_RATE)
    assert measured == pytest.approx(expected, abs=1e-6)


def test_measure_integrated_loudness_handles_clip_shorter_than_400ms():
    tone = _sine(1000, 0.15, amplitude=0.3)
    # Must not raise (pyloudnorm's default 400ms gating block would).
    measured = measure_integrated_loudness(tone, SAMPLE_RATE)
    assert np.isfinite(measured)


def test_loudness_normalize_hits_target_within_tolerance():
    tone = _sine(1000, 0.2, amplitude=0.05)
    target_lufs = -18.0
    normalized = loudness_normalize(tone, SAMPLE_RATE, target_lufs=target_lufs)
    measured = measure_integrated_loudness(normalized, SAMPLE_RATE)
    assert measured == pytest.approx(target_lufs, abs=0.5)


def test_loudness_normalize_respects_peak_ceiling_when_boost_would_clip():
    # A near-full-scale tone asked to hit a loud target would clip without
    # a peak ceiling -- the ceiling must win over hitting LUFS exactly.
    tone = _sine(1000, 0.2, amplitude=0.98)
    normalized = loudness_normalize(tone, SAMPLE_RATE, target_lufs=0.0)
    peak_dbfs = 20 * np.log10(np.max(np.abs(normalized)))
    assert peak_dbfs <= -1.0


def test_loudness_normalize_leaves_near_silent_audio_unchanged():
    near_silent = np.zeros(4410)
    normalized = loudness_normalize(near_silent, SAMPLE_RATE, target_lufs=-16.0)
    assert np.array_equal(normalized, near_silent)


def test_encode_wav_bytes_round_trips_as_pcm16_44100():
    tone = _sine(440, 0.05, amplitude=0.4)
    encoded = encode_wav_bytes(tone, SAMPLE_RATE)
    info = sf.info(io.BytesIO(encoded))
    assert info.samplerate == SAMPLE_RATE
    assert info.subtype == "PCM_16"
    samples, sr = sf.read(io.BytesIO(encoded))
    assert sr == SAMPLE_RATE
    assert np.allclose(samples, tone, atol=2e-4)


def test_encode_wav_bytes_is_deterministic():
    tone = _sine(440, 0.05, amplitude=0.4)
    a = encode_wav_bytes(tone, SAMPLE_RATE)
    b = encode_wav_bytes(tone, SAMPLE_RATE)
    assert a == b


def test_encode_wav_bytes_clips_out_of_range_samples():
    hot = _sine(440, 0.02, amplitude=1.5)  # intentionally > full scale
    encoded = encode_wav_bytes(hot, SAMPLE_RATE)
    samples, _ = sf.read(io.BytesIO(encoded))
    assert np.max(np.abs(samples)) <= 1.0
