"""Ogg Vorbis encoding with explicit loop metadata.

13-asset-pipeline.md §4.7: "Ogg Vorbis — music, ambience, collapse layer
(streamed, with explicit loop offset)"

Writes an Ogg file via soundfile then injects LOOP_START / LOOP_END Vorbis
comments via mutagen. Godot 4 reads these comment tags to configure the
loop point for streamed AudioStreamOggVorbis resources.
"""

from __future__ import annotations

import pathlib

import numpy as np
import soundfile as sf
from mutagen.oggvorbis import OggVorbis


def write_ogg(
    path: str | pathlib.Path,
    samples: np.ndarray,
    sample_rate: int,
    loop_start_sample: int = 0,
    loop_end_sample: int | None = None,
) -> None:
    """Encode samples to Ogg Vorbis at path, adding loop Vorbis comments.

    Args:
        path:               output file path (created or overwritten)
        samples:            float64 in [-1, 1], shape (n,) or (n, channels)
        sample_rate:        Hz
        loop_start_sample:  sample offset Godot jumps back to on loop (default 0)
        loop_end_sample:    last sample of the loop body (default: len(samples)-1)
    """
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    clipped = np.clip(samples, -1.0, 1.0)
    sf.write(str(path), clipped, sample_rate, format="OGG", subtype="VORBIS")

    if loop_end_sample is None:
        mono_len = len(samples) if samples.ndim == 1 else samples.shape[0]
        loop_end_sample = mono_len - 1

    # Inject Vorbis comment tags for Godot loop support
    ogg = OggVorbis(str(path))
    ogg["LOOP_START"] = [str(loop_start_sample)]
    ogg["LOOP_END"] = [str(loop_end_sample)]
    ogg.save()
