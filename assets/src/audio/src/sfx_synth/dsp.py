"""Physically-inspired synthesis primitives (`13-asset-pipeline.md` §4.5).

Three building blocks, composed by `sfx_synth.synth`: a seeded noise
source, a resonant bandpass filter (approximates a struck/tapped
resonator -- this is what gives a filtered noise burst its "material"
character instead of reading as static), and an amplitude envelope. This
is deliberately *not* an oscillator bank -- no sine/square/triangle tones,
which is what would tip the result into sfxr-style chiptune territory.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt


def white_noise(rng: np.random.Generator, n: int) -> np.ndarray:
    """Flat-spectrum noise, `n` samples, drawn from the given generator."""
    return rng.standard_normal(n)


def pink_noise(rng: np.random.Generator, n: int) -> np.ndarray:
    """~1/f-power noise: shape a white draw in the frequency domain.

    Frequency-domain shaping (rather than a recursive IIR approximation)
    keeps this a pure function of the white draw -- same input samples,
    same output, no filter warm-up state to get wrong.
    """
    white = rng.standard_normal(n)
    spectrum = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n)
    scaling = np.ones_like(freqs)
    # freqs[0] is DC (0 Hz); 1/sqrt(f) is undefined there, so leave DC
    # untouched (its own bin's scale is irrelevant to the audible tilt).
    nonzero = freqs > 0
    scaling[nonzero] = 1.0 / np.sqrt(freqs[nonzero])
    pink = np.fft.irfft(spectrum * scaling, n)
    # Frequency-domain shaping changes overall RMS; renormalize to the
    # white draw's RMS so callers get a comparable, predictable amplitude.
    white_rms = np.sqrt(np.mean(white**2))
    pink_rms = np.sqrt(np.mean(pink**2))
    if pink_rms > 0:
        pink = pink * (white_rms / pink_rms)
    return pink


NOISE_GENERATORS = {
    "white": white_noise,
    "pink": pink_noise,
}


def resonant_bandpass(
    x: np.ndarray, sample_rate: int, center_hz: float, q: float, order: int = 2
) -> np.ndarray:
    """Narrow bandpass around `center_hz` with bandwidth `center_hz / q`.

    Applied causally (`sosfilt`, not the zero-phase `sosfiltfilt`) so a
    high-`Q` band rings after a short burst the way a struck physical
    resonator would -- that ring is doing real synthesis work, not just
    filtering noise.
    """
    nyquist = sample_rate / 2.0
    if center_hz <= 0 or center_hz >= nyquist:
        raise ValueError(f"center_hz={center_hz} must be in (0, {nyquist}) (Nyquist)")
    bandwidth = center_hz / q
    low = (center_hz - bandwidth / 2.0) / nyquist
    high = (center_hz + bandwidth / 2.0) / nyquist
    low = max(low, 1e-6)
    high = min(high, 1.0 - 1e-6)
    if low >= high:
        raise ValueError(
            f"resonant band [{low * nyquist:.1f}, {high * nyquist:.1f}]Hz "
            f"is empty or exceeds Nyquist ({nyquist:.1f}Hz) for "
            f"center_hz={center_hz}, q={q}"
        )
    sos = butter(order, [low, high], btype="bandpass", output="sos")
    return sosfilt(sos, x)


ENVELOPE_CURVES = {"exponential", "linear"}


def envelope(n: int, sample_rate: int, attack_s: float, decay_s: float, curve: str) -> np.ndarray:
    """Attack-decay amplitude envelope, `n` samples long.

    Linear ramp 0 -> 1 over `attack_s`, then decay 1 -> ~0 over whatever
    samples remain (either linearly, or exponentially with a time
    constant tuned so the tail reaches ~1% by the end of the decay
    portion -- audibly "done" without a hard cut).
    """
    if curve not in ENVELOPE_CURVES:
        raise ValueError(f"unknown envelope curve {curve!r}, expected one of {ENVELOPE_CURVES}")

    attack_n = min(n, max(0, round(attack_s * sample_rate)))
    env = np.zeros(n, dtype=np.float64)
    env[:attack_n] = np.linspace(0.0, 1.0, attack_n, endpoint=False)

    decay_n = n - attack_n
    if decay_n <= 0:
        return env

    if curve == "linear":
        env[attack_n:] = np.linspace(1.0, 0.0, decay_n)
    else:
        # tau chosen so exp(-decay_n/tau) ~= 0.01 (-40dB) at the last sample.
        tau = decay_n / np.log(100.0)
        t = np.arange(decay_n)
        env[attack_n:] = np.exp(-t / tau)

    return env
