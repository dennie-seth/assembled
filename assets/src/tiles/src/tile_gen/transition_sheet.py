"""Transition tile sheet generator for the signal-tower-concrete set.

Produces a deterministic 64x32 indexed (mode-P) PNG containing 8 tiles arranged
in a 4-column x 2-row grid at 16px per tile:

  Row 0: wall | floor | wall_floor_v | wall_floor_h
  Row 1: corner_tl | corner_tr | corner_bl | corner_br

Tiles use the locked home palette (assets/final/palette/home_palette.json).
All edges satisfy T-0102's gate constraints:

  - base-field tiles (wall, floor) are self-seamless:
      left col == right col, top row == bottom row (index equality)
  - every declared adjacency pair matches on its shared edge

Edge safety rule: joint/crack interior detail is confined to cols 1-14 and
rows 1-14 so no decorative mark ever lands on a tile edge and spoils a gate.

docs/design/13-asset-pipeline.md S3.4 -- T-0153
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

TILE = 16
COLS = 4
ROWS = 2
SHEET_W = TILE * COLS  # 64
SHEET_H = TILE * ROWS  # 32

# Home-palette slot indices used by this tile set
WALL = 8    # ramp-08 #58554c -- dark brutalist concrete
FLOOR = 13  # ramp-13 #7e7c74 -- lighter weathered floor slab
JOINT = 4   # ramp-04 #3d3b31 -- concrete expansion joint / crack

REPO_ROOT = Path(__file__).resolve().parents[5]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
OUT_PATH = (
    REPO_ROOT
    / "assets"
    / "final"
    / "tiles"
    / "signal_tower_concrete_wall_floor_transitions_16px.png"
)


def _load_palette() -> list[int]:
    """Return the home palette as a flat 768-int list (256 RGB triples)."""
    with PALETTE_PATH.open() as f:
        data = json.load(f)
    flat = [0] * (256 * 3)
    for slot in data["slots"]:
        i = slot["index"]
        h = slot["hex"].lstrip("#")
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        flat[i * 3] = r
        flat[i * 3 + 1] = g
        flat[i * 3 + 2] = b
    return flat


def _make_wall() -> np.ndarray:
    """Self-seamless 16x16 concrete wall with horizontal expansion joints.

    Joint lines only in interior columns (1-14) so edge columns stay
    uniformly WALL -- guarantees left_col == right_col == all-WALL.
    Top row and bottom row are all-WALL (seamlessness + adjacency).
    """
    arr = np.full((TILE, TILE), WALL, dtype=np.uint8)
    for row in [3, 7, 11]:
        arr[row, 1:15] = JOINT
    return arr


def _make_floor() -> np.ndarray:
    """Self-seamless 16x16 floor slab with a single interior vertical crack.

    Crack is at col 8, rows 1-14 only -- edge rows 0 and 15 stay all-FLOOR,
    edge cols 0 and 15 are untouched.  All four edge vectors are all-FLOOR.
    """
    arr = np.full((TILE, TILE), FLOOR, dtype=np.uint8)
    arr[1:15, 8] = JOINT
    return arr


def _make_wall_floor_v() -> np.ndarray:
    """16x16 vertical transition: wall in top half (rows 0-7), floor in bottom.

    top_row    = all-WALL  -> matches wall.bottom_row  (adjacency 1)
    bottom_row = all-FLOOR -> matches floor.top_row    (adjacency 2)
    left_col   = [WALL x8, FLOOR x8] -> matches corner_tl.right_col (pair 9)
    right_col  = [WALL x8, FLOOR x8] -> matches corner_tr.left_col  (pair 10)
    """
    arr = np.full((TILE, TILE), WALL, dtype=np.uint8)
    arr[8:, :] = FLOOR
    return arr


def _make_wall_floor_h() -> np.ndarray:
    """16x16 horizontal transition: wall in left half (cols 0-7), floor right.

    left_col  = all-WALL  -> matches wall.right_col  (adjacency 7)
    right_col = all-FLOOR -> matches floor.left_col  (adjacency 8)
    """
    arr = np.full((TILE, TILE), WALL, dtype=np.uint8)
    arr[:, 8:] = FLOOR
    return arr


def _make_corner_tl() -> np.ndarray:
    """Top-left convex corner: wall above/left, floor below/right.

    top_row   = all-WALL          -> matches wall.bottom_row  (adjacency 3)
    right_col = [WALL x8, FLOOR x8] -> matches wfv.left_col (adjacency 9)
    """
    arr = np.full((TILE, TILE), WALL, dtype=np.uint8)
    arr[8:, :] = FLOOR
    return arr


def _make_corner_tr() -> np.ndarray:
    """Top-right convex corner: wall above/right, floor below/left.

    top_row  = all-WALL           -> matches wall.bottom_row  (adjacency 4)
    left_col = [WALL x8, FLOOR x8] -> matches wfv.right_col (adjacency 10)
    """
    arr = np.full((TILE, TILE), WALL, dtype=np.uint8)
    arr[8:, :] = FLOOR
    return arr


def _make_corner_bl() -> np.ndarray:
    """Bottom-left concave corner: all floor.

    top_row = all-FLOOR -> matches floor.bottom_row (adjacency 5)
    """
    return np.full((TILE, TILE), FLOOR, dtype=np.uint8)


def _make_corner_br() -> np.ndarray:
    """Bottom-right concave corner: all floor.

    top_row = all-FLOOR -> matches floor.bottom_row (adjacency 6)
    """
    return np.full((TILE, TILE), FLOOR, dtype=np.uint8)


# Left-to-right, top-to-bottom order matches TILE_LAYOUT in the test
_TILE_MAKERS = [
    _make_wall,         # col 0, row 0
    _make_floor,        # col 1, row 0
    _make_wall_floor_v, # col 2, row 0
    _make_wall_floor_h, # col 3, row 0
    _make_corner_tl,    # col 0, row 1
    _make_corner_tr,    # col 1, row 1
    _make_corner_bl,    # col 2, row 1
    _make_corner_br,    # col 3, row 1
]


def generate_sheet() -> Image.Image:
    """Compose and return the 64x32 indexed transition sheet."""
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
