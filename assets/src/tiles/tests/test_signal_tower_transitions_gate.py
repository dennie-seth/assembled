"""Integration test: T-0102's tile-seamlessness and transition-adjacency
checks against T-0232's Signal Tower transition sheet -- the sliced-sheet
path (`docs/design/13-asset-pipeline.md` §3.4), covering two material
pairs (wall<->floor, concrete<->floor) so the declared adjacency set spans
enough breadth to dress all seven Signal Tower rooms (room -> surface
mapping recorded on tasks/T-0232.md).

T-0153 proved this gate against one wall<->floor sheet only (HANDOFF
§12-c). This extends that proof to the "real, multi-surface tileset large
enough to dress the archetype" HANDOFF §23-i asks for.

RED state:  signal_tower/transitions_16px.png absent -> fixture
            AssertionError, all tests ERROR.
GREEN state: sheet present, mode 'P', 64x64, passes both gate checks for
             every declared pair.

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")

REPO_ROOT = Path(__file__).resolve().parents[4]
TILE_DIR = REPO_ROOT / "assets" / "final" / "tiles" / "signal_tower"
SHEET_PATH = TILE_DIR / "transitions_16px.png"

TILE_SIZE = 16
COLS = 4
ROWS = 4

# (col, row) position of each named tile in the 4x4 sheet.
# Rows 0-1: wall<->floor block (Ground Relay, Records Room, Power
#   Substation, Equipment Floor, Broadcast Deck).
# Rows 2-3: concrete<->floor block (Storage Cache, Antenna Shaft).
TILE_LAYOUT: dict[str, tuple[int, int]] = {
    "wall": (0, 0),
    "floor": (1, 0),
    "wall_floor_v": (2, 0),
    "wall_floor_h": (3, 0),
    "wall_corner_tl": (0, 1),
    "wall_corner_tr": (1, 1),
    "wall_corner_bl": (2, 1),
    "wall_corner_br": (3, 1),
    "concrete": (0, 2),
    "concrete_floor_dup": (1, 2),  # same pixels as "floor" -- shared field
    "concrete_floor_v": (2, 2),
    "concrete_floor_h": (3, 2),
    "concrete_corner_tl": (0, 3),
    "concrete_corner_tr": (1, 3),
    "concrete_corner_bl": (2, 3),
    "concrete_corner_br": (3, 3),
}

# Declared adjacency pairs checked by check_transition_adjacency.
# edge="vertical"   -> a sits above b: a.bottom_row must == b.top_row
# edge="horizontal" -> a sits left of b: a.right_col must == b.left_col
ADJACENCY_PAIRS: list[tuple[str, str, str]] = [
    # wall <-> floor, vertical (a above b)
    ("wall", "wall_floor_v", "vertical"),
    ("wall_floor_v", "floor", "vertical"),
    ("wall", "wall_corner_tl", "vertical"),
    ("wall", "wall_corner_tr", "vertical"),
    ("floor", "wall_corner_bl", "vertical"),
    ("floor", "wall_corner_br", "vertical"),
    # wall <-> floor, horizontal (a left of b)
    ("wall", "wall_floor_h", "horizontal"),
    ("wall_floor_h", "floor", "horizontal"),
    ("wall_corner_tl", "wall_floor_v", "horizontal"),
    ("wall_floor_v", "wall_corner_tr", "horizontal"),
    # concrete <-> floor, vertical (a above b)
    ("concrete", "concrete_floor_v", "vertical"),
    ("concrete_floor_v", "concrete_floor_dup", "vertical"),
    ("concrete", "concrete_corner_tl", "vertical"),
    ("concrete", "concrete_corner_tr", "vertical"),
    ("concrete_floor_dup", "concrete_corner_bl", "vertical"),
    ("concrete_floor_dup", "concrete_corner_br", "vertical"),
    # concrete <-> floor, horizontal (a left of b)
    ("concrete", "concrete_floor_h", "horizontal"),
    ("concrete_floor_h", "concrete_floor_dup", "horizontal"),
    ("concrete_corner_tl", "concrete_floor_v", "horizontal"),
    ("concrete_floor_v", "concrete_corner_tr", "horizontal"),
]


@pytest.fixture(scope="module")
def tiles() -> dict[str, Image.Image]:
    assert SHEET_PATH.exists(), (
        f"transition tile sheet not found: {SHEET_PATH}\n"
        "Run `python -m tile_gen.signal_tower_sheet` to generate it."
    )
    sheet = Image.open(SHEET_PATH)
    assert sheet.mode == "P", f"expected indexed mode 'P', got {sheet.mode!r}"
    expected_w = COLS * TILE_SIZE
    expected_h = ROWS * TILE_SIZE
    assert sheet.size == (expected_w, expected_h), (
        f"sheet size {sheet.size} != expected ({expected_w}, {expected_h})"
    )
    out: dict[str, Image.Image] = {}
    for name, (col, row) in TILE_LAYOUT.items():
        x, y = col * TILE_SIZE, row * TILE_SIZE
        out[name] = sheet.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))
    return out


@pytest.mark.parametrize("tile_a,tile_b,edge", ADJACENCY_PAIRS)
def test_transition_adjacency(tiles, tile_a, tile_b, edge):
    """T-0102 adjacency: declared tile pairs match on their shared edge."""
    result = asset_gate_art.check_transition_adjacency(tiles[tile_a], tiles[tile_b], edge=edge)
    assert result.passed, f"{tile_a} | {tile_b} ({edge}): {result.reason}"


@pytest.mark.parametrize("tile_name", ["wall", "floor", "concrete"])
def test_sheet_base_cell_matches_standalone_base_field(tiles, tile_name):
    """The sheet's own wall/floor/concrete cells must be pixel-identical to
    the standalone circular-pad base-field tiles they dress rooms with --
    one texture, used both as a repeating field and as a transition anchor.
    """
    standalone_path = TILE_DIR / f"{tile_name}_16px.png"
    assert standalone_path.exists(), f"base field tile not found: {standalone_path}"
    standalone = Image.open(standalone_path)
    assert list(tiles[tile_name].getdata()) == list(standalone.getdata()), (
        f"sheet's {tile_name!r} cell diverges from the standalone base-field tile"
    )
