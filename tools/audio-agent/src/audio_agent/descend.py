"""Real descent chain for generated music/texture audio (T-0083).

13-asset-pipeline.md §4.7: after generation (ACE-Step / Stable Audio Open):

  raw WAV
    -> trim silence
    -> remove DC offset
    -> [loop-fold crossfade at the seam]  -- loopable buses only
    -> EBU R128 loudness normalize
    -> encode Ogg Vorbis
    -> validate seam on the ENCODED Ogg (not the pre-encode source)
    -> write Godot import preset (.import)

Seam validation runs on the decoded Ogg, not the pre-encode samples, because
Ogg Vorbis encoder padding can break a seam that was clean before encoding
(§4.7: "validate ON THE ENCODED FILE").

Replaces the identity-passthrough `descend_stub` that was the T-0082 seam.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

from audio_agent.godot_preset import GodotAudioPreset, write_godot_import

# Extra headroom below the gate's -1 dBTP ceiling. Oversampled true-peak
# measurement in asset_gate.audio.check_true_peak catches inter-sample peaks;
# normalizing to this tighter ceiling absorbs that without gambling.
_PEAK_CEILING_DBFS = -2.0

# Maximum allowed start/end sample delta (linear, [-1, 1]) for a loop seam.
# Matches the default threshold in asset_gate.audio.check_loop_seam.
_LOOP_SEAM_THRESHOLD = 0.01

# EBU R128 loudness targets per bus (AU-2 placeholder values, matching
# tools/asset-gate/config/loudness_targets.placeholder.json).
BUS_TARGET_LUFS: dict[str, float] = {
    "Music": -23.0,
    "Ambience": -23.0,
    "World SFX": -18.0,
    "Gameplay SFX": -16.0,
}

# Buses whose content loops in-game; loop-fold is applied to these.
LOOPABLE_BUSES: frozenset[str] = frozenset({"Music", "Ambience"})


# ---------------------------------------------------------------------------
# DSP helpers
# ---------------------------------------------------------------------------


def _to_mono(samples: np.ndarray) -> np.ndarray:
    return samples.mean(axis=1) if samples.ndim > 1 else samples


def trim_silence(samples: np.ndarray, threshold: float = 1e-3) -> np.ndarray:
    """Drop leading/trailing samples below `threshold` (linear, [-1, 1])."""
    mono = _to_mono(samples)
    non_silent = np.flatnonzero(np.abs(mono) >= threshold)
    if len(non_silent) == 0:
        raise ValueError("audio is entirely below the silence threshold")
    return samples[non_silent[0] : non_silent[-1] + 1]


def remove_dc_offset(samples: np.ndarray) -> np.ndarray:
    """Subtract per-channel mean so that `np.mean(output, axis=0) ≈ 0`."""
    return samples - np.mean(samples, axis=0)


def loop_fold(
    samples: np.ndarray, sample_rate: int, crossfade_s: float = 0.064
) -> np.ndarray:
    """Crossfade the tail of `samples` into the head to make the loop seam continuous.

    Takes the last `n = int(sample_rate * crossfade_s)` samples (the fold
    region) and blends them into the first `n` samples with complementary
    fade curves, then discards the original tail. The result is
    `len(samples) - n` samples long.

    At the resulting loop point:
    - output[0]  = samples[-n]   (first sample of the discarded tail)
    - output[-1] = samples[-n-1] (last sample before the tail)
    These are adjacent samples in the original clip, so the seam is
    continuous for any audio that is locally smooth near the fold point.

    13-asset-pipeline.md §4.7: loop-fold is a deterministic transform,
    not hand-editing. It is applied only to loopable buses (Music, Ambience).

    Clips shorter than 2 × crossfade_s are returned unchanged (a fold
    would consume the entire clip).
    """
    n = int(sample_rate * crossfade_s)
    if n == 0 or len(samples) < 2 * n:
        return samples

    fade_out = np.linspace(1.0, 0.0, n, dtype=np.float64)
    fade_in = 1.0 - fade_out

    result = samples[:-n].copy().astype(np.float64)
    if samples.ndim == 1:
        result[:n] = (
            samples[:n].astype(np.float64) * fade_in
            + samples[-n:].astype(np.float64) * fade_out
        )
    else:
        # Multi-channel: apply fade per channel
        result[:n] = (
            samples[:n].astype(np.float64) * fade_in[:, None]
            + samples[-n:].astype(np.float64) * fade_out[:, None]
        )
    return result


def _measure_integrated_loudness(samples: np.ndarray, sample_rate: int) -> float:
    """EBU R128 integrated loudness (LUFS) via pyloudnorm.

    Mirrors the same short-clip fix in sfx_synth.descent and
    asset_gate.audio: pyloudnorm's 400ms gating block raises ValueError
    on anything shorter; shrink the block to fit instead.
    """
    duration_s = len(_to_mono(samples)) / sample_rate
    if duration_s >= 0.4:
        block_size = 0.4
    else:
        block_size = duration_s * (1 - 1e-9) if duration_s > 0 else 0.4
    meter = pyln.Meter(sample_rate, block_size=block_size)
    return float(meter.integrated_loudness(samples.astype(np.float64)))


def loudness_normalize(
    samples: np.ndarray, sample_rate: int, target_lufs: float
) -> np.ndarray:
    """Apply gain so integrated loudness hits `target_lufs`, peak-limited.

    Near-silent input (-inf LUFS) is returned unchanged rather than
    amplifying by infinite gain. A boost large enough to clip is capped at
    `_PEAK_CEILING_DBFS` -- shipping under-target beats shipping clipped.
    """
    measured = _measure_integrated_loudness(samples, sample_rate)
    if not np.isfinite(measured):
        return samples

    gain_db = target_lufs - measured
    gained = samples * (10.0 ** (gain_db / 20.0))

    peak = np.max(np.abs(gained))
    peak_dbfs = 20.0 * np.log10(peak) if peak > 0 else float("-inf")
    if peak_dbfs > _PEAK_CEILING_DBFS:
        gained = gained * (10.0 ** ((_PEAK_CEILING_DBFS - peak_dbfs) / 20.0))

    return gained


def encode_ogg(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode to Ogg Vorbis (13-asset-pipeline.md §4.7 format table:
    music, ambience, collapse layer are streamed as Ogg).

    Clips to [-1, 1] before writing -- soundfile wraps out-of-range
    float samples on lossy formats, which would corrupt anything that
    overshoots the normalizer's peak ceiling.
    """
    clipped = np.clip(samples, -1.0, 1.0)
    buffer = io.BytesIO()
    sf.write(buffer, clipped, sample_rate, format="OGG", subtype="VORBIS")
    return buffer.getvalue()


def _seam_passes_on_encoded(
    ogg_bytes: bytes, threshold: float = _LOOP_SEAM_THRESHOLD
) -> bool:
    """Decode the Ogg bytes and check whether the loop seam is within `threshold`.

    The check runs on the *decoded* Ogg samples -- not on any pre-encode
    array -- because Ogg Vorbis encoder padding can alter the sample count
    and break a seam that was clean before encoding (§4.7).
    """
    decoded, _ = sf.read(io.BytesIO(ogg_bytes))
    mono = _to_mono(decoded)
    window = min(32, len(mono) // 2)
    if window == 0:
        return False
    max_diff = float(np.max(np.abs(mono[:window] - mono[-window:])))
    return max_diff <= threshold


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def descend(
    raw_path: Path,
    *,
    bus_value: str,
    loopable: bool,
    target_lufs: float,
    crossfade_s: float = 0.064,
) -> Path:
    """Full descent chain for a generated audio file (13-asset-pipeline.md §4.7).

    Reads `raw_path` (WAV from ACE-Step or Stable Audio Open), processes it
    through the chain, writes the result as `<raw_path>.ogg`, writes a Godot
    import preset alongside it, and returns the Ogg path.

    Raises `ValueError` if `loopable` is True and the seam check fails on
    the encoded Ogg -- the seam check runs on the decoded Ogg file, not on
    the pre-encode samples (§4.7 "validate ON THE ENCODED FILE").
    """
    samples, sample_rate = sf.read(str(raw_path))
    samples = samples.astype(np.float64)

    samples = trim_silence(samples)
    samples = remove_dc_offset(samples)

    if loopable:
        samples = loop_fold(samples, sample_rate, crossfade_s=crossfade_s)

    samples = loudness_normalize(samples, sample_rate, target_lufs)

    ogg_bytes = encode_ogg(samples, sample_rate)

    # Validate the seam on the encoded Ogg, not the pre-encode source (§4.7).
    if loopable and not _seam_passes_on_encoded(ogg_bytes):
        raise ValueError(
            f"Loop seam check failed on encoded Ogg output from {raw_path.name!r}. "
            "A detectable click/pop remains after Ogg encoding. "
            "Regenerate with a different seed or adjust the crossfade length."
        )

    ogg_path = raw_path.with_suffix(".ogg")
    ogg_path.write_bytes(ogg_bytes)

    write_godot_import(ogg_path, GodotAudioPreset(loop=loopable))

    return ogg_path
