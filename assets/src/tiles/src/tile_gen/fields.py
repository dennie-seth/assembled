"""Shared deterministic tile-array constructors for T-0232's Signal Tower
transition tiles (the sliced-sheet path, `docs/design/13-asset-pipeline.md`
§3.4). Base fields (wall/floor/concrete) are *not* built here any more --
see `tile_gen.base_fields`, which drives real SDXL generation through the
circular-pad path. This module keeps only the deterministic-construction
strategy T-0153 already established (reviewed, merged) for the *sliced
transition sheet*, extended to a second material pair.

Reuses T-0153's WALL/FLOOR/JOINT home-palette slot indices and adds
CONCRETE -- a third, distinct base field ("raw, exposed concrete") needed
to dress Storage Cache and Antenna Shaft, which
`docs/design/14-vertical-slice.md` §10 describes as a cramped utility
closet and a narrow mechanical shaft rather than the tower's painted
interior. Room -> surface mapping recorded in
assets/src/tiles/SIGNAL_TOWER_ROOM_SURFACES.md.

Why transitions stay flat-constructed while base fields don't: T-0102's
seamlessness/adjacency gates are pixel-exact (left col == right col, top
row == bottom row; a declared pair's shared edge matches pixel-for-pixel).
A transition tile's *entire* footprint is edge -- every pixel sits on one
declared boundary or another -- so there is no interior left for organic
texture the way a base field has one. Building it from the same flat
WALL/FLOOR/CONCRETE indices the (real, SDXL-generated) base fields' outer
ring is seam-forced to keeps every declared pair trivially, deterministically
exact. See `tile_gen.base_fields` for why the base fields' *border* is
forced to these same flat indices.
"""

from __future__ import annotations

import numpy as np

TILE = 16

# Home-palette slot indices used by this tile set (assets/final/palette/home_palette.json)
WALL = 8  # ramp-08 #58554c -- dark brutalist concrete, painted interior wall
FLOOR = 13  # ramp-13 #7e7c74 -- lighter weathered floor slab
JOINT = 4  # ramp-04 #3d3b31 -- concrete expansion joint / crack / speckle detail
CONCRETE = 6  # ramp-06 #49493b -- raw exposed concrete, darker/rougher than WALL


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


def _make_quadrant_corner(
    top_left: int, top_right: int, bottom_left: int, bottom_right: int
) -> np.ndarray:
    """16x16 tile split into four 8x8 quadrants, each a flat index.

    HALF = TILE // 2 so a corner tile's top_row is exactly its top-quadrant
    row and its left/right_col is exactly its left/right-quadrant column --
    each corner is checked against a neighbour's single edge vector, which
    only ever touches two of the four quadrants.
    """
    half = TILE // 2
    arr = np.empty((TILE, TILE), dtype=np.uint8)
    arr[:half, :half] = top_left
    arr[:half, half:] = top_right
    arr[half:, :half] = bottom_left
    arr[half:, half:] = bottom_right
    return arr


def make_corner_tl(field_value: int) -> np.ndarray:
    """Top-left convex corner: field fills top band + left column (an L),
    floor cuts into the bottom-right quadrant only.

    top_row = all-field (top-left + top-right quadrants both field) ->
      matches the field tile's own bottom row (adjacency: field above).
    right_col = top half field, bottom half floor -> matches
      make_field_floor_v(field_value)'s left/right col (adjacency: beside
      the plain vertical edge tile).
    """
    return _make_quadrant_corner(field_value, field_value, field_value, FLOOR)


def make_corner_tr(field_value: int) -> np.ndarray:
    """Top-right convex corner: field fills top band + right column (an L),
    floor cuts into the bottom-left quadrant only.

    top_row = all-field, same adjacency as `make_corner_tl`.
    left_col = top half field, bottom half floor -> matches
      make_field_floor_v(field_value)'s left/right col on its other side.
    """
    return _make_quadrant_corner(field_value, field_value, FLOOR, field_value)


def make_corner_bl(field_value: int) -> np.ndarray:
    """Bottom-left concave corner: floor fills the top band, field pokes up
    into the bottom-left quadrant only.

    top_row = all-floor -> matches the floor tile's own bottom row
    (adjacency: floor above).
    """
    return _make_quadrant_corner(FLOOR, FLOOR, field_value, FLOOR)


def make_corner_br(field_value: int) -> np.ndarray:
    """Bottom-right concave corner: floor fills the top band, field pokes up
    into the bottom-right quadrant only. Same top_row adjacency as
    `make_corner_bl`; distinct from every other corner by construction."""
    return _make_quadrant_corner(FLOOR, FLOOR, FLOOR, field_value)
