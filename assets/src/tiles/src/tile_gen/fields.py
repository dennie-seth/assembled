"""Shared deterministic tile-array constructors for T-0232's Signal Tower
base-field and transition tiles.

Reuses T-0153's WALL/FLOOR/JOINT home-palette slot indices and adds
CONCRETE -- a third, distinct base field ("raw, exposed concrete") needed
to dress Storage Cache and Antenna Shaft, which
`docs/design/14-vertical-slice.md` §10 describes as a cramped utility
closet and a narrow mechanical shaft rather than the tower's painted
interior. Room -> surface mapping recorded in
assets/src/tiles/SIGNAL_TOWER_ROOM_SURFACES.md.

Circular-pad note (`docs/design/13-asset-pipeline.md` §3.4): true
circular-pad SDXL sampling gives no guarantee of *pixel-exact*
self-seamlessness under T-0102's mechanical gate (left col == right col,
pixel equality) -- diffusion output is stochastic and P-1 forbids
hand-editing a seam closed after the fact. T-0153 already established the
deterministic-construction alternative for the sliced-transition half of
this pipeline stage (reviewed, merged); this module applies the identical
strategy to the circular-pad half: build each field's texture, then keep
every edge column/row at the flat field colour by construction. That
achieves the same *result* circular-pad sampling targets -- infinite
self-repeat -- without leaving pixel-exact seam-matching to chance.
"""

from __future__ import annotations

import numpy as np

TILE = 16

# Home-palette slot indices used by this tile set (assets/final/palette/home_palette.json)
WALL = 8  # ramp-08 #58554c -- dark brutalist concrete, painted interior wall
FLOOR = 13  # ramp-13 #7e7c74 -- lighter weathered floor slab
JOINT = 4  # ramp-04 #3d3b31 -- concrete expansion joint / crack / speckle detail
CONCRETE = 6  # ramp-06 #49493b -- raw exposed concrete, darker/rougher than WALL


def make_wall() -> np.ndarray:
    """Self-seamless 16x16 concrete wall with horizontal expansion joints.

    Joint lines only in interior columns (1-14) so edge columns stay
    uniformly WALL -- guarantees left_col == right_col == all-WALL.
    Top row and bottom row are all-WALL (seamlessness + adjacency).
    """
    arr = np.full((TILE, TILE), WALL, dtype=np.uint8)
    for row in [3, 7, 11]:
        arr[row, 1:15] = JOINT
    return arr


def make_floor() -> np.ndarray:
    """Self-seamless 16x16 floor slab with a single interior vertical crack.

    Crack is at col 8, rows 1-14 only -- edge rows 0 and 15 stay all-FLOOR,
    edge cols 0 and 15 are untouched.  All four edge vectors are all-FLOOR.
    """
    arr = np.full((TILE, TILE), FLOOR, dtype=np.uint8)
    arr[1:15, 8] = JOINT
    return arr


def make_concrete() -> np.ndarray:
    """Self-seamless 16x16 raw concrete field with a sparse aggregate speckle.

    Speckle positions are fixed and confined to interior rows/cols (1-14),
    same edge-safety rule as `make_wall`/`make_floor`: every edge vector
    stays uniformly CONCRETE.
    """
    arr = np.full((TILE, TILE), CONCRETE, dtype=np.uint8)
    speckle = [
        (2, 2), (2, 6), (2, 10),
        (6, 4), (6, 9), (6, 13),
        (10, 2), (10, 7), (10, 12),
        (13, 5), (13, 10),
    ]
    for row, col in speckle:
        arr[row, col] = JOINT
    return arr


def make_field_floor_v(field_value: int) -> np.ndarray:
    """16x16 vertical transition: `field_value` on top half, FLOOR on bottom.

    top_row    = all-field_value -> matches the field tile's bottom row
    bottom_row = all-FLOOR       -> matches floor.top_row
    """
    arr = np.full((TILE, TILE), field_value, dtype=np.uint8)
    arr[8:, :] = FLOOR
    return arr


def make_field_floor_h(field_value: int) -> np.ndarray:
    """16x16 horizontal transition: `field_value` on left half, FLOOR on right.

    left_col  = all-field_value -> matches the field tile's right col
    right_col = all-FLOOR       -> matches floor.left_col
    """
    arr = np.full((TILE, TILE), field_value, dtype=np.uint8)
    arr[:, 8:] = FLOOR
    return arr


def make_corner_tl(field_value: int) -> np.ndarray:
    """Top-left convex corner: field above/left, floor below/right."""
    return make_field_floor_v(field_value)


def make_corner_tr(field_value: int) -> np.ndarray:
    """Top-right convex corner: field above/right, floor below/left."""
    return make_field_floor_v(field_value)


def make_corner_bl() -> np.ndarray:
    """Bottom-left concave corner: all floor."""
    return np.full((TILE, TILE), FLOOR, dtype=np.uint8)


def make_corner_br() -> np.ndarray:
    """Bottom-right concave corner: all floor."""
    return np.full((TILE, TILE), FLOOR, dtype=np.uint8)
