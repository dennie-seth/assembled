"""Unit tests for ambience_synth.loop_fold."""

from __future__ import annotations

import numpy as np
import pytest

from ambience_synth.loop_fold import loop_fold

SR = 44100


def _ramp(n: int) -> np.ndarray:
    return np.linspace(0.0, 1.0, n)


def test_loop_fold_output_length_is_body_n():
    body_n = SR * 10
    crossfade_n = SR * 2
    raw = np.random.default_rng(1).standard_normal(body_n + crossfade_n)
    result = loop_fold(raw, SR, crossfade_s=2.0)
    assert len(result) == body_n


def test_loop_fold_middle_is_unchanged():
    body_n = SR * 10
    crossfade_n = SR * 2
    raw = np.random.default_rng(2).standard_normal(body_n + crossfade_n)
    result = loop_fold(raw, SR, crossfade_s=2.0)
    # Samples from crossfade_n to body_n are the raw body middle, unchanged.
    np.testing.assert_array_equal(result[crossfade_n:], raw[crossfade_n:body_n])


def test_loop_fold_head_blends_tail_into_head():
    # The first sample of the result should approximate the first sample of
    # the tail (fade_out=1 at index 0 → tail dominates).
    body_n = SR * 5
    crossfade_n = SR * 1
    raw = np.random.default_rng(3).standard_normal(body_n + crossfade_n)
    result = loop_fold(raw, SR, crossfade_s=1.0)
    # result[0] = raw[body_n] * 1.0 + raw[0] * 0.0 = raw[body_n]
    assert result[0] == pytest.approx(raw[body_n], abs=1e-12)


def test_loop_fold_loop_boundary_is_adjacent_raw_samples():
    """result[-1] and result[0] are raw[body_n-1] and raw[body_n] — consecutive."""
    body_n = SR * 5
    crossfade_n = SR * 1
    raw = np.random.default_rng(4).standard_normal(body_n + crossfade_n)
    result = loop_fold(raw, SR, crossfade_s=1.0)
    # result[-1] = raw[body_n - 1]
    assert result[-1] == pytest.approx(raw[body_n - 1], abs=1e-12)
    # result[0] ≈ raw[body_n] (fade_out=1 at i=0)
    assert result[0] == pytest.approx(raw[body_n], abs=1e-12)


def test_loop_fold_rejects_too_short_input():
    crossfade_n = SR * 2
    raw = np.zeros(crossfade_n)  # exactly crossfade_n — should raise
    with pytest.raises(ValueError, match="must exceed"):
        loop_fold(raw, SR, crossfade_s=2.0)


def test_loop_fold_seam_delta_is_small_for_low_frequency_content():
    """For 60 Hz content at typical ambience amplitude, seam check passes.

    Regression for the core T-0202 acceptance criterion: the loop-fold must
    produce a body where max(|body[0:32] - body[-32:]|) ≤ 0.10 at -23 LUFS.
    """
    import pyloudnorm as pyln

    # Synthesize a simple 60 Hz sine (the dominant tone in the Signal Tower bed).
    body_n = SR * 30
    crossfade_n = SR * 2
    total_n = body_n + crossfade_n
    t = np.arange(total_n) / SR
    raw = 0.3 * np.sin(2 * np.pi * 60.0 * t)  # amplitude 0.3, well within [-1, 1]

    folded = loop_fold(raw, SR, crossfade_s=2.0)

    # Normalize to -23 LUFS (ambience bus target)
    meter = pyln.Meter(SR, block_size=0.4)
    measured = meter.integrated_loudness(folded.astype(np.float64))
    gain = 10.0 ** ((-23.0 - measured) / 20.0)
    normalized = folded * gain

    n = 32
    max_diff = float(np.max(np.abs(normalized[:n] - normalized[-n:])))
    assert max_diff <= 0.10, (
        f"seam max_diff {max_diff:.5f} exceeds 0.10 for 60 Hz content at -23 LUFS"
    )
