"""The one-shot-relevant descent chain (`13-asset-pipeline.md` §4.7).

    synthesize (deterministic script, one-shots)
      -> trim silence, remove DC offset
      -> [loop-fold at the seam]      -- SKIPPED, see below
      -> loudness normalize (EBU R128)
      -> encode
      -> validate ON THE ENCODED FILE

**Loop-fold is intentionally not implemented here.** §4.7 scopes it to
looping content ("a reproducible transform inside the chain" for a seam
that a one-shot doesn't have -- a one-shot plays once and stops). Applying
it to a one-shot would be meaningless at best. `tools/asset-gate`'s
loop-seam check is likewise N/A for this package's output and is not
called from its gate-integration test.
"""

from __future__ import annotations

import io

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

# Extra headroom below the gate's -1 dBTP ceiling (`asset_gate.audio.
# check_true_peak`). That check oversamples 4x to catch inter-sample
# peaks a plain sample-peak measurement misses; normalizing to this
# tighter ceiling absorbs the difference instead of gambling on it.
_PEAK_CEILING_DBFS = -2.0


def trim_silence(samples: np.ndarray, threshold: float = 1e-3) -> np.ndarray:
    """Drop leading/trailing samples below `threshold` (linear, [-1, 1])."""
    non_silent = np.flatnonzero(np.abs(samples) >= threshold)
    if len(non_silent) == 0:
        raise ValueError("audio is entirely below the silence threshold")
    return samples[non_silent[0] : non_silent[-1] + 1]


def remove_dc_offset(samples: np.ndarray) -> np.ndarray:
    return samples - np.mean(samples)


def measure_integrated_loudness(samples: np.ndarray, sample_rate: int) -> float:
    """EBU R128 integrated loudness (LUFS), via `pyloudnorm`.

    Mirrors the same fix `asset_gate.audio.check_integrated_loudness`
    applies: pyloudnorm's default 400ms gating block raises `ValueError`
    on anything shorter, which is most one-shots. Shrink the block to fit.
    """
    duration_s = len(samples) / sample_rate
    block_size = min(0.4, duration_s) if duration_s > 0 else 0.4
    meter = pyln.Meter(sample_rate, block_size=block_size)
    return float(meter.integrated_loudness(samples.astype(np.float64)))


def loudness_normalize(samples: np.ndarray, sample_rate: int, target_lufs: float) -> np.ndarray:
    """Apply gain so integrated loudness hits `target_lufs`, peak-limited.

    A near-silent input measures at -inf LUFS; there is no finite gain
    that "fixes" that; returned unchanged rather than dividing by
    infinity. A boost large enough to clip is capped at `_PEAK_CEILING_DBFS`
    -- shipping under-target rather than clipped, since a clipped file
    fails the gate outright while an under-target one only trips a
    tolerance check.
    """
    measured = measure_integrated_loudness(samples, sample_rate)
    if not np.isfinite(measured):
        return samples

    gain_db = target_lufs - measured
    gained = samples * (10.0 ** (gain_db / 20.0))

    peak = np.max(np.abs(gained))
    peak_dbfs = 20.0 * np.log10(peak) if peak > 0 else float("-inf")
    if peak_dbfs > _PEAK_CEILING_DBFS:
        gained = gained * (10.0 ** ((_PEAK_CEILING_DBFS - peak_dbfs) / 20.0))

    return gained


def encode_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode to WAV PCM_16 (`13-asset-pipeline.md` §4.7 format table:
    short one-shots ship as WAV 44.1kHz). Clips to [-1, 1] first --
    soundfile wraps rather than clips out-of-range float samples on
    PCM_16 write, which would corrupt anything that overshoots."""
    clipped = np.clip(samples, -1.0, 1.0)
    buffer = io.BytesIO()
    sf.write(buffer, clipped, sample_rate, subtype="PCM_16", format="WAV")
    return buffer.getvalue()
