"""Signal Tower transition-tile sheet generator (T-0232) -- the
sliced-sheet path (`docs/design/13-asset-pipeline.md` §3.4), extended from
T-0153's single wall<->floor block to two material-pair blocks
(wall<->floor, concrete<->floor) -- enough breadth to dress all seven
Signal Tower rooms (`docs/design/14-vertical-slice.md` §10; room ->
surface mapping recorded in assets/src/tiles/SIGNAL_TOWER_ROOM_SURFACES.md).

Produces a deterministic 64x64 indexed (mode-P) PNG containing 16 tiles
arranged in a 4-col x 4-row grid at 16px per tile:

  Row 0: wall            | floor              | wall_floor_v       | wall_floor_h
  Row 1: wall_corner_tl   | wall_corner_tr     | wall_corner_bl     | wall_corner_br
  Row 2: concrete         | floor              | concrete_floor_v   | concrete_floor_h
  Row 3: concrete_corner_tl | concrete_corner_tr | concrete_corner_bl | concrete_corner_br

Tiles use the locked home palette (assets/final/palette/home_palette.json).
All edges satisfy T-0102's gate constraints -- see
`tests/test_signal_tower_transitions_gate.py` for the declared adjacency
set. Row 2 col 1 ("floor") is pixel-identical to row 0 col 1: both
material blocks share the one FLOOR field.

HANDOFF §23-i (T-0232).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from tile_gen.fields import (
    CONCRETE,
    TILE,
    WALL,
    make_concrete,
    make_corner_bl,
    make_corner_br,
    make_corner_tl,
    make_corner_tr,
    make_field_floor_h,
    make_field_floor_v,
    make_floor,
    make_wall,
)
from tile_gen.transition_sheet import _load_palette

COLS = 4
ROWS = 4
SHEET_W = TILE * COLS  # 64
SHEET_H = TILE * ROWS  # 64

REPO_ROOT = Path(__file__).resolve().parents[5]
OUT_PATH = (
    REPO_ROOT / "assets" / "final" / "tiles" / "signal_tower" / "transitions_16px.png"
)

# Left-to-right, top-to-bottom order matches TILE_LAYOUT in the test.
_TILE_MAKERS = [
    # wall <-> floor block
    make_wall,
    make_floor,
    lambda: make_field_floor_v(WALL),
    lambda: make_field_floor_h(WALL),
    lambda: make_corner_tl(WALL),
    lambda: make_corner_tr(WALL),
    make_corner_bl,
    make_corner_br,
    # concrete <-> floor block
    make_concrete,
    make_floor,
    lambda: make_field_floor_v(CONCRETE),
    lambda: make_field_floor_h(CONCRETE),
    lambda: make_corner_tl(CONCRETE),
    lambda: make_corner_tr(CONCRETE),
    make_corner_bl,
    make_corner_br,
]


def generate_sheet() -> Image.Image:
    """Compose and return the 64x64 indexed transition sheet."""
    sheet_arr = np.zeros((SHEET_H, SHEET_W), dtype=np.uint8)

    for idx, fn in enumerate(_TILE_MAKERS):
        col = idx % COLS
        row = idx // COLS
        x, y = col * TILE, row * TILE
        sheet_arr[y : y + TILE, x : x + TILE] = fn()

    img = Image.fromarray(sheet_arr, mode="P")
    img.putpalette(_load_palette())
    return img


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    sheet = generate_sheet()
    sheet.save(OUT_PATH, format="PNG")
    print(f"Saved {OUT_PATH} ({sheet.size[0]}x{sheet.size[1]} px, mode {sheet.mode})")


if __name__ == "__main__":
    main()
