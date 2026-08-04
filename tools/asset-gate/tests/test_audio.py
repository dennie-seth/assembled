import numpy as np
import soundfile as sf

from asset_gate.audio import (
    BusLoudnessTarget,
    bit_depth_from_subtype,
    check_dc_offset,
    check_determinism,
    check_format,
    check_integrated_loudness,
    check_length_bounds,
    check_loop_seam,
    check_silence_trimmed,
    check_true_peak,
    load_loudness_targets,
)


def _sine(freq, duration_s, sample_rate=44100, amplitude=0.3):
    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    return amplitude * np.sin(2 * np.pi * freq * t)


def test_loop_seam_passes_for_clean_loop(clean_loop_wav):
    samples, sample_rate = sf.read(clean_loop_wav)
    result = check_loop_seam(samples, sample_rate, threshold=0.01)
    assert result.passed


def test_loop_seam_fails_for_clicking_loop(clicking_loop_wav):
    samples, sample_rate = sf.read(clicking_loop_wav)
    result = check_loop_seam(samples, sample_rate, threshold=0.01)
    assert not result.passed


def test_load_loudness_targets_reads_bus_config(tmp_path):
    import json

    path = tmp_path / "targets.json"
    path.write_text(
        json.dumps({"buses": {"gameplay_sfx": {"target_lufs": -16.0, "tolerance_db": 3.0}}})
    )
    targets = load_loudness_targets(path)
    assert targets["gameplay_sfx"] == BusLoudnessTarget(-16.0, 3.0)


def test_load_placeholder_loudness_targets_is_well_formed():
    import pathlib

    path = pathlib.Path(__file__).parent.parent / "config" / "loudness_targets.placeholder.json"
    targets = load_loudness_targets(path)
    for bus in ("ambience", "music", "world_sfx", "gameplay_sfx"):
        assert bus in targets


def test_integrated_loudness_passes_when_within_tolerance():
    samples = _sine(440, 2.0, amplitude=0.3)
    sample_rate = 44100
    import pyloudnorm as pyln

    measured = pyln.Meter(sample_rate).integrated_loudness(samples.astype(np.float64))
    targets = {"gameplay_sfx": BusLoudnessTarget(target_lufs=measured, tolerance_db=1.0)}
    result = check_integrated_loudness(samples, sample_rate, bus="gameplay_sfx", targets=targets)
    assert result.passed


def test_integrated_loudness_fails_when_outside_tolerance():
    samples = _sine(440, 2.0, amplitude=0.3)
    sample_rate = 44100
    targets = {"gameplay_sfx": BusLoudnessTarget(target_lufs=-50.0, tolerance_db=1.0)}
    result = check_integrated_loudness(samples, sample_rate, bus="gameplay_sfx", targets=targets)
    assert not result.passed


def test_integrated_loudness_does_not_raise_on_a_block_size_fp_boundary():
    # `duration_s * rate` doesn't always round-trip back to exactly
    # `len(samples)` in floating point -- it can round *up* by a hair,
    # which flips pyloudnorm's `block_size * rate <= len(samples)` check
    # and raises on a clip whose length legitimately *is* the block size.
    # 3547 samples @ 44100Hz is a real example a synthesized one-shot hit.
    sample_rate = 44100
    n = 3547
    samples = _sine(1000, n / sample_rate, sample_rate=sample_rate, amplitude=0.3)
    targets = {"gameplay_sfx": BusLoudnessTarget(target_lufs=-16.0, tolerance_db=20.0)}
    result = check_integrated_loudness(samples, sample_rate, bus="gameplay_sfx", targets=targets)
    assert np.isfinite(result.details["measured_lufs"])


def test_integrated_loudness_measures_a_one_shot_shorter_than_400ms():
    # pyloudnorm's default 400ms gating block raises ValueError on anything
    # shorter (T-0101 one-shots are 20-400ms) -- the check must shrink its
    # measurement block to fit rather than blow up on legitimate input.
    samples = _sine(1000, 0.15, amplitude=0.3)
    sample_rate = 44100
    import pyloudnorm as pyln

    measured = pyln.Meter(sample_rate, block_size=0.15).integrated_loudness(
        samples.astype(np.float64)
    )
    targets = {"gameplay_sfx": BusLoudnessTarget(target_lufs=measured, tolerance_db=1.0)}
    result = check_integrated_loudness(samples, sample_rate, bus="gameplay_sfx", targets=targets)
    assert result.passed


def test_true_peak_fails_for_full_scale_signal():
    samples = _sine(1000, 0.5, amplitude=0.999)
    result = check_true_peak(samples, max_dbtp=-1.0)
    assert not result.passed


def test_true_peak_passes_for_quiet_signal():
    samples = _sine(1000, 0.5, amplitude=0.3)  # ~ -10 dBFS
    result = check_true_peak(samples, max_dbtp=-1.0)
    assert result.passed


def test_bit_depth_from_subtype():
    assert bit_depth_from_subtype("PCM_16") == 16
    assert bit_depth_from_subtype("PCM_24") == 24
    assert bit_depth_from_subtype("VORBIS") is None


def test_check_format_passes_when_matching():
    result = check_format(44100, 16, expected_sample_rate=44100, expected_bit_depth=16)
    assert result.passed


def test_check_format_fails_on_sample_rate_mismatch():
    result = check_format(48000, 16, expected_sample_rate=44100, expected_bit_depth=16)
    assert not result.passed


def test_check_format_ignores_bit_depth_when_expected_is_none():
    # Lossy formats (Ogg Vorbis) don't have a PCM bit depth.
    result = check_format(44100, None, expected_sample_rate=44100, expected_bit_depth=None)
    assert result.passed


def test_length_bounds_passes_within_range():
    result = check_length_bounds(1.5, min_s=1.0, max_s=2.0)
    assert result.passed


def test_length_bounds_fails_outside_range():
    result = check_length_bounds(5.0, min_s=1.0, max_s=2.0)
    assert not result.passed


def test_silence_trimmed_passes_when_no_leading_trailing_silence():
    samples = _sine(440, 0.2, amplitude=0.5)
    result = check_silence_trimmed(samples, 44100, silence_threshold=1e-3, max_silence_s=0.01)
    assert result.passed


def test_silence_trimmed_fails_when_leading_silence_too_long():
    sample_rate = 44100
    silence = np.zeros(int(sample_rate * 0.5))
    tone = _sine(440, 0.2, sample_rate=sample_rate, amplitude=0.5)
    samples = np.concatenate([silence, tone])
    result = check_silence_trimmed(samples, sample_rate, silence_threshold=1e-3, max_silence_s=0.01)
    assert not result.passed
    assert result.details["leading_s"] > 0.01


def test_dc_offset_passes_for_zero_mean_signal():
    samples = _sine(440, 0.2, amplitude=0.5)
    result = check_dc_offset(samples, max_abs_offset=1e-3)
    assert result.passed


def test_dc_offset_fails_for_offset_signal():
    samples = _sine(440, 0.2, amplitude=0.5) + 0.1
    result = check_dc_offset(samples, max_abs_offset=1e-3)
    assert not result.passed


def test_determinism_passes_for_reproducible_synth():
    def produce():
        rng = np.random.default_rng(seed=42)
        return rng.standard_normal(100).tobytes()

    result = check_determinism(produce)
    assert result.passed


def test_determinism_fails_for_nonreproducible_synth():
    def produce():
        rng = np.random.default_rng()  # unseeded -> different every call
        return rng.standard_normal(100).tobytes()

    result = check_determinism(produce)
    assert not result.passed
