"""Descent-chain handoff seam.

`recipe -> generate -> descend -> validate -> provenance`
(13-asset-pipeline.md §1/§3.1). T-0071 only owns `generate`; the real
descent chain (box downscale, Oklab/CIELAB palette quantize with dithering
off, orphan-pixel/edge cleanup) is T-0073, and it's blocked on V-5 (the
home palette hex set) for the quantizer step. This stub is the seam
`pipeline.generate` calls so that wiring doesn't have to change when T-0073
lands -- only this function's body does.
"""

from __future__ import annotations

from pathlib import Path


def descend_stub(raw_path: Path) -> Path:
    """Identity passthrough. TODO(T-0073): replace with the real descent chain."""
    return raw_path
