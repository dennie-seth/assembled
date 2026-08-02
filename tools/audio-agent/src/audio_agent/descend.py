"""Descent-chain handoff seam (13-asset-pipeline.md §4.7).

`recipe -> generate -> descend -> validate -> provenance`. T-0082 only
owns `generate`; the real audio descent chain (trim silence, remove DC
offset, loop-fold crossfade, EBU R128 loudness normalize, encode) is
T-0083, and it validates the *encoded* file, not the source (Ogg padding
can break a seam that was clean pre-encode). This stub is the seam
`pipeline.generate` calls so wiring doesn't change when T-0083 lands --
only this function's body does. Mirrors `comfy_client.descend.descend_stub`.
"""

from __future__ import annotations

from pathlib import Path


def descend_stub(raw_path: Path) -> Path:
    """Identity passthrough. TODO(T-0083): replace with the real descent chain."""
    return raw_path
