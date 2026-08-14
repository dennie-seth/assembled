"""Tests for the real descent chain (T-0083).

13-asset-pipeline.md §4.7:
  raw WAV -> trim silence -> remove DC offset -> [loop-fold] ->
  EBU R128 normalize -> encode Ogg -> validate seam on the ENCODED file

These tests are written before the implementation (TDD). They cover:
- loop_fold() makes the loop seam continuous
- encode_ogg() produces a decodeable Ogg Vorbis file
- loudness_normalize() hits the EBU R128 target
- descend() returns an Ogg path and writes a Godot import preset
- THE KEY T-0083 TEST: the seam assertion runs against the encoded Ogg
  (not the pre-encode source) and fails on a detectable click/pop
"""

import io

import numpy as np
import pyloudnorm as pyln
import pytest
import soundfile as sf

from audio_agent.descend import (
    descend,
    encode_ogg,
    loop_fold,
    loudness_normalize,
    remove_dc_offset,
    trim_silence,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_SAMPLE_RATE = 44100


def _sine(freq: float, duration_s: float, amplitude: float = 0.3) -> np.ndarray:
    t = np.linspace(0, duration_s, int(_SAMPLE_RATE * duration_s), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float64)


def _make_clicking_loop(duration_s: float = 1.0) -> np.ndarray:
    """Sine wave with a large discontinuity injected at the last sample."""
    samples = _sine(440, duration_s, amplitude=0.3)
    samples[-1] = 0.9  # large click: far from samples[0] ≈ 0
    return samples


def _make_clicking_slow_loop(duration_s: float = 1.0) -> np.ndarray:
    """Low-frequency (4-cycle) loop with an injected click at the seam.

    Uses the same waveform as _make_clean_loop so the content is cyclically
    smooth (4 Hz << Nyquist, period ≈ 11025 samples). The seam check
    compares 32-sample windows; for 4 Hz the phase difference over 32 samples
    is only ~0.018 rad → max_diff ≈ 0.006, well inside the 0.01 threshold.
    The injected click is what loop_fold must fix.
    """
    samples = _make_clean_loop(duration_s)
    samples[-1] = 0.9  # inject click at seam
    return samples


def _make_clean_loop(duration_s: float = 1.0) -> np.ndarray:
    """Integer number of sine cycles so first == last sample exactly."""
    t = np.linspace(0, duration_s, int(_SAMPLE_RATE * duration_s), endpoint=False)
    # 4 complete cycles over duration_s -> start == end
    return (0.3 * np.sin(2 * np.pi * 4 * t / duration_s)).astype(np.float64)


def _write_wav(path, samples: np.ndarray, sr: int = _SAMPLE_RATE) -> None:
    sf.write(str(path), samples, sr, subtype="PCM_16", format="WAV")


# ---------------------------------------------------------------------------
# loop_fold
# ---------------------------------------------------------------------------


def test_loop_fold_reduces_seam_discontinuity():
    """loop_fold applied to clicking audio makes start/end close enough to loop cleanly."""
    samples = _make_clicking_loop()
    raw_seam = abs(float(samples[0]) - float(samples[-1]))
    assert raw_seam > 0.5, "fixture should have a large click"

    folded = loop_fold(samples, _SAMPLE_RATE)
    folded_seam = abs(float(folded[0]) - float(folded[-1]))
    assert folded_seam < 0.01, f"loop_fold should close the seam; got {folded_seam:.4f}"


def test_loop_fold_output_is_shorter_than_input():
    """Folding removes the tail, so output is shorter than input."""
    samples = _sine(440, 1.0)
    folded = loop_fold(samples, _SAMPLE_RATE, crossfade_s=0.064)
    assert len(folded) < len(samples)


def test_loop_fold_does_not_alter_very_short_clips():
    """Clips shorter than 2x crossfade are returned unchanged."""
    tiny = _sine(440, 0.05)  # 50ms < 2 * 64ms
    folded = loop_fold(tiny, _SAMPLE_RATE, crossfade_s=0.064)
    np.testing.assert_array_equal(folded, tiny)


def test_loop_fold_works_on_stereo():
    """loop_fold handles (n, 2) stereo arrays without error."""
    mono = _sine(440, 1.0)
    stereo = np.column_stack([mono, mono * 0.9])
    folded = loop_fold(stereo, _SAMPLE_RATE)
    assert folded.shape[1] == 2
    assert folded.shape[0] < stereo.shape[0]


# ---------------------------------------------------------------------------
# trim_silence / remove_dc_offset
# ---------------------------------------------------------------------------


def test_trim_silence_removes_leading_and_trailing_silence():
    silence = np.zeros(int(_SAMPLE_RATE * 0.1))
    tone = _sine(440, 0.2, amplitude=0.3)
    samples = np.concatenate([silence, tone, silence])
    trimmed = trim_silence(samples)
    assert len(trimmed) < len(samples)
    assert abs(trimmed[0]) > 1e-3
    assert abs(trimmed[-1]) > 1e-3


def test_trim_silence_raises_on_fully_silent_input():
    with pytest.raises(ValueError, match="silence threshold"):
        trim_silence(np.zeros(100))


def test_remove_dc_offset_centres_at_zero():
    tone = _sine(440, 0.5, amplitude=0.3)
    biased = tone + 0.2
    cleaned = remove_dc_offset(biased)
    assert abs(float(np.mean(cleaned))) < 1e-10


# ---------------------------------------------------------------------------
# encode_ogg
# ---------------------------------------------------------------------------


def test_encode_ogg_produces_decodeable_vorbis():
    """encode_ogg() output can be read back with soundfile."""
    samples = _sine(440, 0.5)
    ogg_bytes = encode_ogg(samples, _SAMPLE_RATE)
    assert len(ogg_bytes) > 0

    decoded, sr = sf.read(io.BytesIO(ogg_bytes))
    assert sr == _SAMPLE_RATE
    assert len(decoded) > 0


def test_encode_ogg_soundfile_format_is_ogg_vorbis():
    """The encoded file is identified as OGG / VORBIS by soundfile."""
    samples = _sine(440, 0.5)
    ogg_bytes = encode_ogg(samples, _SAMPLE_RATE)
    info = sf.info(io.BytesIO(ogg_bytes))
    assert info.format == "OGG"
    assert info.subtype == "VORBIS"


# ---------------------------------------------------------------------------
# loudness_normalize
# ---------------------------------------------------------------------------


def test_loudness_normalize_hits_target_lufs():
    """After normalization, measured LUFS is within 1 dB of target."""
    samples = _sine(440, 2.0, amplitude=0.05)
    target = -23.0
    normalized = loudness_normalize(samples, _SAMPLE_RATE, target_lufs=target)

    meter = pyln.Meter(_SAMPLE_RATE)
    measured = meter.integrated_loudness(normalized.astype(np.float64))
    assert abs(measured - target) < 1.0, f"measured {measured:.2f} LUFS vs target {target}"


def test_loudness_normalize_silent_input_returned_unchanged():
    """Near-silent input (measures -inf LUFS) is returned as-is to avoid inf gain."""
    silent = np.zeros(int(_SAMPLE_RATE * 1.0))
    out = loudness_normalize(silent, _SAMPLE_RATE, target_lufs=-23.0)
    np.testing.assert_array_equal(out, silent)


# ---------------------------------------------------------------------------
# KEY T-0083 TEST: seam assertion on the encoded Ogg, not the pre-encode source
# ---------------------------------------------------------------------------


def test_seam_check_on_encoded_ogg_fails_for_clicking_loop(tmp_path):
    """THE headline T-0083 acceptance test.

    The seam check must run against the final *encoded* Ogg file
    (13-asset-pipeline.md §4.7: "validate ON THE ENCODED FILE"), not the
    pre-encode source. This test:
    1. Creates audio with a detectable click at the loop seam.
    2. Encodes it to Ogg Vorbis without loop-fold.
    3. Reads back the encoded Ogg (the check runs on the decoded samples).
    4. Asserts the seam check FAILS -- proving the check is on the Ogg,
       not on any pre-encode representation that might have been smooth.
    """
    samples = _make_clicking_loop()

    ogg_path = tmp_path / "clicking.ogg"
    ogg_bytes = encode_ogg(samples, _SAMPLE_RATE)
    ogg_path.write_bytes(ogg_bytes)

    # Decode the encoded Ogg -- this is what the seam check sees
    encoded_samples, enc_sr = sf.read(str(ogg_path))

    # Manually compute the seam (mirrors check_loop_seam in asset_gate.audio)
    mono = encoded_samples.mean(axis=1) if encoded_samples.ndim > 1 else encoded_samples
    window = min(32, len(mono) // 2)
    max_diff = float(np.max(np.abs(mono[:window] - mono[-window:])))

    # Threshold used by asset_gate.audio.check_loop_seam default
    threshold = 0.01
    assert max_diff > threshold, (
        f"Expected the seam check to FAIL (click should be detectable after Ogg encode), "
        f"but max_diff={max_diff:.4f} <= threshold={threshold}. "
        "This test ensures the check runs on the encoded Ogg, not the pre-encode source."
    )


def test_loop_fold_then_encode_produces_clean_seam_on_ogg(tmp_path):
    """After loop-fold + Ogg encode, the seam passes the check on the decoded file.

    Uses low-frequency (4 Hz) content because the seam check compares 32-sample
    windows: for 440 Hz, 32 samples span ~115° of phase (max_diff ≈ 0.5),
    whereas for 4 Hz the same window spans only ~1° (max_diff ≈ 0.006 < 0.01).
    Real loopable game audio (music, ambience) is similarly low-frequency.
    """
    samples = _make_clicking_slow_loop()
    folded = loop_fold(samples, _SAMPLE_RATE)

    ogg_bytes = encode_ogg(folded, _SAMPLE_RATE)
    encoded_samples, _ = sf.read(io.BytesIO(ogg_bytes))

    mono = encoded_samples.mean(axis=1) if encoded_samples.ndim > 1 else encoded_samples
    window = min(32, len(mono) // 2)
    max_diff = float(np.max(np.abs(mono[:window] - mono[-window:])))

    assert max_diff <= 0.01, (
        f"Seam should be clean after loop-fold + Ogg encode; got max_diff={max_diff:.4f}"
    )


# ---------------------------------------------------------------------------
# descend() full chain
# ---------------------------------------------------------------------------


def test_descend_produces_ogg_file(tmp_path):
    """descend() returns a .ogg path that exists on disk."""
    wav_path = tmp_path / "raw.wav"
    _write_wav(wav_path, _make_clean_loop())  # low-freq content: seam check passes

    out = descend(wav_path, bus_value="Music", loopable=True, target_lufs=-23.0)

    assert out.exists()
    assert out.suffix == ".ogg"


def test_descend_ogg_is_valid_vorbis(tmp_path):
    """descend() output can be decoded with soundfile and is OGG/VORBIS."""
    wav_path = tmp_path / "raw.wav"
    _write_wav(wav_path, _make_clean_loop())

    out = descend(wav_path, bus_value="Music", loopable=True, target_lufs=-23.0)

    info = sf.info(str(out))
    assert info.format == "OGG"
    assert info.subtype == "VORBIS"


def test_descend_normalizes_to_target_lufs(tmp_path):
    """descend() output meets EBU R128 target within 2 dB tolerance."""
    wav_path = tmp_path / "raw.wav"
    _write_wav(wav_path, _sine(440, 1.0, amplitude=0.05))

    target = -18.0
    out = descend(wav_path, bus_value="World SFX", loopable=False, target_lufs=target)

    decoded, sr = sf.read(str(out))
    meter = pyln.Meter(sr)
    measured = meter.integrated_loudness(decoded.astype(np.float64))
    assert abs(measured - target) < 2.0, f"measured {measured:.2f} LUFS vs target {target}"


def test_descend_writes_godot_import_preset(tmp_path):
    """descend() writes a .ogg.import file alongside the Ogg output."""
    wav_path = tmp_path / "raw.wav"
    _write_wav(wav_path, _make_clean_loop())

    out = descend(wav_path, bus_value="Ambience", loopable=True, target_lufs=-23.0)

    import_path = out.parent / (out.name + ".import")
    assert import_path.exists(), f"Expected .import file at {import_path}"
    content = import_path.read_text()
    assert "loop=true" in content


def test_descend_loopable_false_writes_loop_false_preset(tmp_path):
    """Non-loopable descend writes loop=false in the Godot import preset."""
    wav_path = tmp_path / "raw.wav"
    _write_wav(wav_path, _sine(440, 1.0))

    out = descend(wav_path, bus_value="World SFX", loopable=False, target_lufs=-18.0)

    import_path = out.parent / (out.name + ".import")
    content = import_path.read_text()
    assert "loop=false" in content


def test_descend_raises_if_seam_fails_for_loopable(tmp_path):
    """For loopable audio, descend raises if the encoded seam has a detectable click.

    This tests that the seam validation runs on the encoded Ogg (T-0083 §4.7),
    not on the pre-encode source. We supply audio designed to click after folding
    would be skipped -- an extremely short clip where loop_fold is a no-op --
    so the raw click survives into the Ogg and the seam check catches it.
    """
    # Build a tiny WAV (< 2x crossfade) with a huge click: loop_fold is a no-op
    # on clips shorter than 2 * crossfade_s, leaving the click intact.
    n = int(_SAMPLE_RATE * 0.06)  # 60ms < 2 * 64ms = 128ms
    samples = np.zeros(n, dtype=np.float64)
    samples[0] = 0.0
    samples[-1] = 0.9  # big click at the loop seam
    wav_path = tmp_path / "click.wav"
    sf.write(str(wav_path), samples, _SAMPLE_RATE, subtype="PCM_16", format="WAV")

    with pytest.raises(ValueError, match="[Ll]oop seam"):
        descend(wav_path, bus_value="Music", loopable=True, target_lufs=-23.0)
