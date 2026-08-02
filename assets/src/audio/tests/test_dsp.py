import numpy as np
import pytest

from sfx_synth.dsp import envelope, pink_noise, resonant_bandpass, white_noise

SAMPLE_RATE = 44100


def test_white_noise_reproducible_from_same_seed():
    a = white_noise(np.random.default_rng(7), 1000)
    b = white_noise(np.random.default_rng(7), 1000)
    assert np.array_equal(a, b)


def test_white_noise_differs_across_seeds():
    a = white_noise(np.random.default_rng(1), 1000)
    b = white_noise(np.random.default_rng(2), 1000)
    assert not np.array_equal(a, b)


def test_pink_noise_reproducible_from_same_seed():
    a = pink_noise(np.random.default_rng(7), 4096)
    b = pink_noise(np.random.default_rng(7), 4096)
    assert np.array_equal(a, b)


def test_pink_noise_differs_from_white_noise_given_same_seed():
    a = white_noise(np.random.default_rng(7), 4096)
    b = pink_noise(np.random.default_rng(7), 4096)
    assert not np.array_equal(a, b)


def test_pink_noise_biases_energy_toward_low_frequencies():
    # Pink noise has a ~1/f power spectrum -- low-frequency energy should
    # dominate high-frequency energy far more than it does for white noise,
    # which is spectrally flat.
    n = 1 << 15
    rng = np.random.default_rng(42)
    pink = pink_noise(rng, n)
    spectrum = np.abs(np.fft.rfft(pink)) ** 2
    freqs = np.fft.rfftfreq(n)
    low = spectrum[(freqs > 0.001) & (freqs < 0.01)].mean()
    high = spectrum[(freqs > 0.4) & (freqs < 0.49)].mean()
    assert low > high * 10


def test_resonant_bandpass_concentrates_energy_near_center():
    rng = np.random.default_rng(3)
    noise = white_noise(rng, SAMPLE_RATE)  # 1s of white noise
    center_hz = 2000.0
    filtered = resonant_bandpass(noise, SAMPLE_RATE, center_hz=center_hz, q=8.0)
    spectrum = np.abs(np.fft.rfft(filtered))
    freqs = np.fft.rfftfreq(len(filtered), d=1.0 / SAMPLE_RATE)
    peak_freq = freqs[np.argmax(spectrum)]
    assert abs(peak_freq - center_hz) < center_hz * 0.25


def test_resonant_bandpass_rejects_band_outside_nyquist():
    noise = white_noise(np.random.default_rng(1), 100)
    with pytest.raises(ValueError):
        resonant_bandpass(noise, SAMPLE_RATE, center_hz=SAMPLE_RATE, q=0.01)


def test_envelope_ramps_up_then_decays_to_near_zero():
    n = 4410  # 100ms @ 44.1kHz
    env = envelope(n, SAMPLE_RATE, attack_s=0.01, decay_s=0.09, curve="exponential")
    assert len(env) == n
    assert env[0] < 0.05
    assert env.max() == pytest.approx(1.0, abs=1e-6)
    assert env[-1] < 0.05
    # Monotonic decay after the attack peak.
    peak_idx = int(np.argmax(env))
    assert np.all(np.diff(env[peak_idx:]) <= 1e-9)


def test_envelope_linear_curve_is_a_straight_ramp_down():
    n = 1000
    env = envelope(n, SAMPLE_RATE, attack_s=0.0, decay_s=n / SAMPLE_RATE, curve="linear")
    diffs = np.diff(env)
    assert np.allclose(diffs, diffs[0], atol=1e-9)


def test_envelope_rejects_unknown_curve():
    with pytest.raises(ValueError):
        envelope(1000, SAMPLE_RATE, attack_s=0.01, decay_s=0.09, curve="chiptune")
