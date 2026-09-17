"""EBU R128 loudness normalization for ambience beds.

Same algorithm as sfx_synth.descent.loudness_normalize; self-contained copy
so the two packages stay independently installable.
"""

from __future__ import annotations

import numpy as np
import pyloudnorm as pyln

_PEAK_CEILING_DBFS = -2.0  # headroom below -1 dBTP gate ceiling


def loudness_normalize(samples: np.ndarray, sample_rate: int, target_lufs: float) -> np.ndarray:
    """Scale samples so integrated loudness hits target_lufs (EBU R128).

    Near-silent input (-inf LUFS) is returned unchanged. A boost that would
    clip is capped at _PEAK_CEILING_DBFS — under-target is better than clipped.
    """
    # Ambience beds are long (≥20s) so the 400ms gating block is always valid.
    meter = pyln.Meter(sample_rate, block_size=0.4)
    measured = float(meter.integrated_loudness(samples.astype(np.float64)))
    if not np.isfinite(measured):
        return samples

    gain_db = target_lufs - measured
    gained = samples * (10.0 ** (gain_db / 20.0))

    peak = np.max(np.abs(gained))
    if peak > 0:
        peak_dbfs = 20.0 * np.log10(peak)
        if peak_dbfs > _PEAK_CEILING_DBFS:
            gained = gained * (10.0 ** ((_PEAK_CEILING_DBFS - peak_dbfs) / 20.0))

    return gained
