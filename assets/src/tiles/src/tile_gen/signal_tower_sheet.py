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
The plain-field cells ("wall", "floor", "concrete") are not built here --
they are loaded byte-for-byte from `tile_gen.base_fields`'s real,
SDXL-generated standalone tiles (the circular-pad path, `13` §3.4), so run
`python -m tile_gen.base_fields` before this module. The corner/edge cells
are still built deterministically from `tile_gen.fields` (the sliced-sheet
path's own, separate T-0153 precedent) using the flat WALL/FLOOR/CONCRETE
indices the base fields' outer ring is seam-forced to match.

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
    make_corner_bl,
    make_corner_br,
    make_corner_tl,
    make_corner_tr,
    make_field_floor_h,
    make_field_floor_v,
)
from tile_gen.transition_sheet import _load_palette

COLS = 4
ROWS = 4
SHEET_W = TILE * COLS  # 64
SHEET_H = TILE * ROWS  # 64

REPO_ROOT = Path(__file__).resolve().parents[5]
TILE_DIR = REPO_ROOT / "assets" / "final" / "tiles" / "signal_tower"
OUT_PATH = TILE_DIR / "transitions_16px.png"


def _load_standalone_tile(name: str) -> np.ndarray:
    """Load a real, already-generated standalone base-field tile's index
    array (`tile_gen.base_fields.generate_base_field_tile` must have run
    first) -- the sheet's own base-field cells must be pixel-identical to
    these, not independently reconstructed (test_signal_tower_transitions_
    gate.py's test_sheet_base_cell_matches_standalone_base_field)."""
    path = TILE_DIR / f"{name}_16px.png"
    if not path.exists():
        raise FileNotFoundError(
            f"standalone base-field tile not found: {path}\n"
            "Run `python -m tile_gen.base_fields` first."
        )
    return np.array(Image.open(path), dtype=np.uint8)


# Left-to-right, top-to-bottom order matches TILE_LAYOUT in the test.
_TILE_MAKERS = [
    # wall <-> floor block
    lambda: _load_standalone_tile("wall"),
    lambda: _load_standalone_tile("floor"),
    lambda: make_field_floor_v(WALL),
    lambda: make_field_floor_h(WALL),
    lambda: make_corner_tl(WALL),
    lambda: make_corner_tr(WALL),
    lambda: make_corner_bl(WALL),
    lambda: make_corner_br(WALL),
    # concrete <-> floor block
    lambda: _load_standalone_tile("concrete"),
    lambda: _load_standalone_tile("floor"),
    lambda: make_field_floor_v(CONCRETE),
    lambda: make_field_floor_h(CONCRETE),
    lambda: make_corner_tl(CONCRETE),
    lambda: make_corner_tr(CONCRETE),
    lambda: make_corner_bl(CONCRETE),
    lambda: make_corner_br(CONCRETE),
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
