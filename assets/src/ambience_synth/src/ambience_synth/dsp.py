"""DSP primitives for ambience synthesis.

Intentionally self-contained (not importing sfx_synth) — keeps ambience-synth
independent so the two packages can be installed in separate environments.
Same algorithms as sfx_synth.dsp; see that module's docstrings for derivation.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt


def white_noise(rng: np.random.Generator, n: int) -> np.ndarray:
    """Flat-spectrum white noise, float64 in approximately [-1, 1]."""
    return rng.standard_normal(n)


def pink_noise(rng: np.random.Generator, n: int) -> np.ndarray:
    """Approximate 1/f pink noise via weighted sum of white noise octave bands."""
    if n == 0:
        return np.zeros(0, dtype=np.float64)
    bands = max(1, int(np.ceil(np.log2(max(n, 2)))))
    out = np.zeros(n, dtype=np.float64)
    for k in range(bands):
        band_n = max(1, n >> k)
        band = rng.standard_normal(band_n)
        out += np.repeat(band, 1 << k)[:n]
    return out / np.sqrt(bands)


def resonant_bandpass(
    signal: np.ndarray,
    sample_rate: int,
    center_hz: float,
    q: float,
    order: int = 2,
) -> np.ndarray:
    """2nd-order Butterworth bandpass centred at center_hz with quality factor q."""
    nyquist = sample_rate / 2.0
    bandwidth_hz = center_hz / q
    low = max(1.0, center_hz - bandwidth_hz / 2.0)
    high = min(nyquist - 1.0, center_hz + bandwidth_hz / 2.0)
    if low >= high:
        raise ValueError(
            f"bandpass [{low:.1f}, {high:.1f}] Hz is invalid for center={center_hz} q={q} "
            f"sr={sample_rate}"
        )
    sos = butter(order, [low, high], btype="bandpass", fs=sample_rate, output="sos")
    return sosfilt(sos, signal).astype(np.float64)
