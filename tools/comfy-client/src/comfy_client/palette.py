"""Load a locked home-palette LUT (T-0105 output) as an index-ordered RGB
list for the descend chain's quantize step.

Same JSON schema `asset_gate.palette.load_palette` reads
(`{"slots": [{"index", "hex", ...}]}`) -- not imported directly (each
`tools/` package is self-contained), but contract-compatible so
`palette-extract`'s output works for both without translation.
"""

from __future__ import annotations

import json
from pathlib import Path


def _hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def load_palette_lut(path: str | Path) -> list[tuple[int, int, int]]:
    """Returns RGB tuples ordered by slot index (result[i] is slot i).

    Raises `ValueError` if slots aren't a contiguous 0..N-1 set -- a gap or
    duplicate would silently break P-4 (index N must mean slot N).
    """
    data = json.loads(Path(path).read_text())
    by_index = {int(slot["index"]): _hex_to_rgb(slot["hex"]) for slot in data["slots"]}
    n = len(by_index)
    if set(by_index.keys()) != set(range(n)):
        raise ValueError(
            f"palette slots must be a contiguous 0..{n - 1} index set, got {sorted(by_index)}"
        )
    return [by_index[i] for i in range(n)]
