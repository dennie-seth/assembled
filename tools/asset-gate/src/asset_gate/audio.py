"""Audio-side validation checks, `13-asset-pipeline.md` §4.7-4.8.

Every check here takes decoded samples (`numpy.ndarray`, float64 in
[-1, 1], mono or `(n, channels)`) plus the sample rate, so callers control
I/O. **Always decode the encoded file** (Ogg/WAV as shipped), never the
generation source -- encoder padding can break a seam that was clean before
encoding (`13` §4.7).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
from scipy.signal import resample_poly

from asset_gate.determinism import check_reproducible
from asset_gate.result import CheckResult


@dataclass(frozen=True)
class BusLoudnessTarget:
    target_lufs: float
    tolerance_db: float


def load_loudness_targets(path: str | Path) -> dict[str, BusLoudnessTarget]:
    data = json.loads(Path(path).read_text())
    return {
        bus: BusLoudnessTarget(cfg["target_lufs"], cfg["tolerance_db"])
        for bus, cfg in data["buses"].items()
    }


def _to_mono(samples: np.ndarray) -> np.ndarray:
    return samples.mean(axis=1) if samples.ndim > 1 else samples


_SUBTYPE_BIT_DEPTH = {
    "PCM_16": 16,
    "PCM_24": 24,
    "PCM_32": 32,
    "PCM_U8": 8,
    "FLOAT": 32,
    "DOUBLE": 64,
}


def bit_depth_from_subtype(subtype: str) -> int | None:
    """Bit depth for PCM subtypes; None for subtypes without one (e.g. VORBIS)."""
    return _SUBTYPE_BIT_DEPTH.get(subtype)


def check_loop_seam(
    samples: np.ndarray, sample_rate: int, threshold: float, window: int = 32
) -> CheckResult:
    """Encoded file's start and end must match within `threshold` (linear
    amplitude, samples in [-1, 1]). The audio analog of tile seamlessness."""
    mono = _to_mono(samples)
    n = min(window, len(mono) // 2) if len(mono) >= 2 else len(mono)
    if n == 0:
        return CheckResult(
            check="loop_seam",
            passed=False,
            reason="audio too short to evaluate a seam",
            details={},
        )
    start, end = mono[:n], mono[-n:]
    max_diff = float(np.max(np.abs(start - end)))
    passed = max_diff <= threshold
    return CheckResult(
        check="loop_seam",
        passed=passed,
        reason=(
            f"max start/end sample delta {max_diff:.6f} "
            f"{'<=' if passed else '>'} threshold {threshold}"
        ),
        details={"max_diff": max_diff, "window": n},
    )


def check_integrated_loudness(
    samples: np.ndarray,
    sample_rate: int,
    bus: str,
    targets: dict[str, BusLoudnessTarget],
) -> CheckResult:
    """EBU R128 integrated loudness must land within `tolerance_db` of the
    bus's target LUFS. TODO(AU-2): targets are placeholders, see
    config/loudness_targets.placeholder.json.

    pyloudnorm's default 400ms gating block raises `ValueError` on anything
    shorter -- fine for loops/music, not for a T-0101 one-shot (a footstep
    or click can be well under 400ms). Shrink the block to fit the clip
    instead of rejecting legitimate short input; a single undersized block
    is still a meaningful (if less statistically stable) K-weighted measure.
    """
    if bus not in targets:
        raise ValueError(f"no loudness target configured for bus {bus!r}")
    target = targets[bus]

    duration_s = len(_to_mono(samples)) / sample_rate
    block_size = min(0.4, duration_s) if duration_s > 0 else 0.4
    meter = pyln.Meter(sample_rate, block_size=block_size)
    measured = meter.integrated_loudness(samples.astype(np.float64))

    if not np.isfinite(measured):
        return CheckResult(
            check="integrated_loudness",
            passed=False,
            reason="measured loudness is -inf (silent or near-silent input)",
            details={"measured_lufs": measured, "bus": bus},
        )

    delta = abs(measured - target.target_lufs)
    passed = delta <= target.tolerance_db
    return CheckResult(
        check="integrated_loudness",
        passed=passed,
        reason=(
            f"{measured:.2f} LUFS vs target {target.target_lufs:.2f} +/- {target.tolerance_db} "
            f"({bus}): delta {delta:.2f}dB"
        ),
        details={"measured_lufs": measured, "target_lufs": target.target_lufs, "bus": bus},
    )


def check_true_peak(
    samples: np.ndarray,
    max_dbtp: float = -1.0,
    oversample: int = 4,
) -> CheckResult:
    """True peak (inter-sample peak, via oversampling) must be <= max_dbtp."""
    mono = _to_mono(samples).astype(np.float64)
    oversampled = resample_poly(mono, up=oversample, down=1)
    peak = float(np.max(np.abs(oversampled))) if len(oversampled) else 0.0
    peak_dbtp = 20.0 * np.log10(peak) if peak > 0 else float("-inf")
    passed = peak_dbtp <= max_dbtp
    return CheckResult(
        check="true_peak",
        passed=passed,
        reason=f"{peak_dbtp:.2f} dBTP {'<=' if passed else '>'} max {max_dbtp} dBTP",
        details={"peak_dbtp": peak_dbtp, "oversample": oversample},
    )


def check_format(
    sample_rate: int,
    bit_depth: int | None,
    expected_sample_rate: int,
    expected_bit_depth: int | None,
) -> CheckResult:
    """Sample rate / bit depth must match the format table (`13` §4.7).
    `bit_depth` is None for lossy formats (Ogg Vorbis) where it doesn't apply."""
    sr_ok = sample_rate == expected_sample_rate
    bd_ok = expected_bit_depth is None or bit_depth == expected_bit_depth
    passed = sr_ok and bd_ok
    return CheckResult(
        check="format",
        passed=passed,
        reason=(
            f"sample_rate={sample_rate} (expected {expected_sample_rate}), "
            f"bit_depth={bit_depth} (expected {expected_bit_depth})"
        ),
        details={
            "sample_rate": sample_rate,
            "expected_sample_rate": expected_sample_rate,
            "bit_depth": bit_depth,
            "expected_bit_depth": expected_bit_depth,
        },
    )


def check_length_bounds(duration_s: float, min_s: float, max_s: float) -> CheckResult:
    """Length must fall within the recipe's declared range."""
    passed = min_s <= duration_s <= max_s
    return CheckResult(
        check="length_bounds",
        passed=passed,
        reason=f"duration {duration_s:.3f}s within [{min_s}, {max_s}]s" if passed
        else f"duration {duration_s:.3f}s outside [{min_s}, {max_s}]s",
        details={"duration_s": duration_s, "min_s": min_s, "max_s": max_s},
    )


def check_silence_trimmed(
    samples: np.ndarray,
    sample_rate: int,
    silence_threshold: float = 1e-3,
    max_silence_s: float = 0.05,
) -> CheckResult:
    """Leading/trailing silence must be trimmed below `max_silence_s`.
    A sample counts as silent when its absolute amplitude is below
    `silence_threshold` (linear, in [-1, 1])."""
    mono = _to_mono(samples)
    non_silent = np.flatnonzero(np.abs(mono) >= silence_threshold)

    if len(non_silent) == 0:
        return CheckResult(
            check="silence_trimmed",
            passed=False,
            reason="entire clip is below the silence threshold",
            details={},
        )

    leading_samples = int(non_silent[0])
    trailing_samples = int(len(mono) - 1 - non_silent[-1])
    leading_s = leading_samples / sample_rate
    trailing_s = trailing_samples / sample_rate

    passed = leading_s <= max_silence_s and trailing_s <= max_silence_s
    return CheckResult(
        check="silence_trimmed",
        passed=passed,
        reason=f"leading {leading_s * 1000:.1f}ms, trailing {trailing_s * 1000:.1f}ms "
        f"(max {max_silence_s * 1000:.1f}ms)",
        details={"leading_s": leading_s, "trailing_s": trailing_s},
    )


def check_dc_offset(samples: np.ndarray, max_abs_offset: float = 1e-3) -> CheckResult:
    """DC offset (mean sample value) must be approximately zero."""
    mono = _to_mono(samples)
    offset = float(np.mean(mono))
    passed = abs(offset) <= max_abs_offset
    return CheckResult(
        check="dc_offset",
        passed=passed,
        reason=f"mean sample value {offset:.6f} {'<=' if passed else '>'} max {max_abs_offset}",
        details={"offset": offset},
    )


def check_determinism(produce: Callable[[], bytes], runs: int = 2) -> CheckResult:
    """Same recipe + seed -> byte-identical output (one-shots especially)."""
    return check_reproducible("audio_determinism", produce, runs=runs)
