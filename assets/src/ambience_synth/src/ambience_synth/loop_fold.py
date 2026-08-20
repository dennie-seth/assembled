"""Loop-fold crossfade for seamless looping audio.

13-asset-pipeline.md §4.7:
  "loop-fold (deterministic crossfade at the seam)"

The loop-fold blends the extra tail material synthesized beyond the loop body
into the head of the loop body, so that at the loop point (result[-1] →
result[0]) the audio is a continuation of adjacent raw samples — no click.

                  ┌── body_n ──────────────────────┐
raw:  [ …  crossfade_n   │   body middle   │  body_end ][ tail_n ]
                 ↓ blend ↓                              ↑ from ↑
result: [ blend_head    │   body middle   │  body_end ]
          (0 → body_n)

At the loop boundary:
  result[-1] = raw[body_n - 1]          (last sample of body)
  result[ 0] ≈ raw[body_n]              (first sample of tail, fade_out=1 at i=0)

These are consecutive samples in the raw signal → no sample-level discontinuity.
Over a 32-sample window the difference is bounded by the raw signal's derivative,
which is small for low-frequency ambient content (see analysis in T-0202).
"""

from __future__ import annotations

import numpy as np


def loop_fold(samples: np.ndarray, sample_rate: int, crossfade_s: float) -> np.ndarray:
    """Apply loop-fold crossfade to create a seamless loop body.

    Args:
        samples:     raw audio, shape (body_n + crossfade_n,), float64
        sample_rate: samples per second
        crossfade_s: crossfade duration in seconds; must satisfy
                     crossfade_n < len(samples)

    Returns:
        shape (body_n,) where the first crossfade_n samples blend from
        tail material (fading out) to head material (fading in).
    """
    crossfade_n = round(crossfade_s * sample_rate)
    if crossfade_n <= 0:
        raise ValueError(f"crossfade_s {crossfade_s!r} yields crossfade_n <= 0")
    if len(samples) <= crossfade_n:
        raise ValueError(
            f"samples length {len(samples)} must exceed crossfade_n {crossfade_n}"
        )

    body_n = len(samples) - crossfade_n
    tail = samples[body_n:]  # the extra material beyond the loop body

    fade_out = np.linspace(1.0, 0.0, crossfade_n)  # applied to tail
    fade_in = 1.0 - fade_out  # applied to head

    result = samples[:body_n].copy()
    result[:crossfade_n] = tail * fade_out + samples[:crossfade_n] * fade_in
    return result
