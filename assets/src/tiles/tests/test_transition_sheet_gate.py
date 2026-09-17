"""Integration test: run T-0102's tile-seamlessness and transition-adjacency
checks against the real wall→floor transition tile sheet.

docs/design/13-asset-pipeline.md §3.4 and HANDOFF.md §12-c (T-0153).

RED state:  signal_tower_concrete_wall_floor_transitions_16px.png absent →
            fixture AssertionError, all tests ERROR.
GREEN state: sheet is present and passes both gate checks.

Install:
    pip install -e ".[dev]"
    (asset_gate itself is resolved via tests/conftest.py's sys.path shim
    onto ../../../tools/asset-gate/src -- no separate editable install of
    tools/asset-gate is required.)
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")

REPO_ROOT = Path(__file__).resolve().parents[4]
SHEET_PATH = (
    REPO_ROOT
    / "assets"
    / "final"
    / "tiles"
    / "signal_tower_concrete_wall_floor_transitions_16px.png"
)

TILE_SIZE = 16

# (col, row) position of each named tile in the 4×2 sheet
TILE_LAYOUT: dict[str, tuple[int, int]] = {
    "wall":         (0, 0),  # base-field wall, self-seamless
    "floor":        (1, 0),  # base-field floor, self-seamless
    "wall_floor_v": (2, 0),  # vertical transition: wall above, floor below
    "wall_floor_h": (3, 0),  # horizontal transition: wall left, floor right
    "corner_tl":    (0, 1),  # top-left corner
    "corner_tr":    (1, 1),  # top-right corner
    "corner_bl":    (2, 1),  # bottom-left corner
    "corner_br":    (3, 1),  # bottom-right corner
}

# Base-field tiles must be self-seamless (left col == right col, top row == bottom row)
SEAMLESS_TILES: list[str] = ["wall", "floor"]

# Declared adjacency pairs checked by check_transition_adjacency.
# edge="vertical"   → a sits above b: a.bottom_row must == b.top_row
# edge="horizontal" → a sits left of b: a.right_col must == b.left_col
ADJACENCY_PAIRS: list[tuple[str, str, str]] = [
    # vertical (a above b)
    ("wall",         "wall_floor_v", "vertical"),
    ("wall_floor_v", "floor",        "vertical"),
    ("wall",         "corner_tl",    "vertical"),
    ("wall",         "corner_tr",    "vertical"),
    ("floor",        "corner_bl",    "vertical"),
    ("floor",        "corner_br",    "vertical"),
    # horizontal (a left of b)
    ("wall",         "wall_floor_h", "horizontal"),
    ("wall_floor_h", "floor",        "horizontal"),
    ("corner_tl",    "wall_floor_v", "horizontal"),
    ("wall_floor_v", "corner_tr",    "horizontal"),
]


@pytest.fixture(scope="module")
def tiles() -> dict[str, Image.Image]:
    assert SHEET_PATH.exists(), (
        f"transition tile sheet not found: {SHEET_PATH}\n"
        "Run `python -m tile_gen.transition_sheet` to generate it."
    )
    sheet = Image.open(SHEET_PATH)
    assert sheet.mode == "P", f"expected indexed mode 'P', got {sheet.mode!r}"
    expected_w = len(TILE_LAYOUT) // 2 * TILE_SIZE  # 4 cols × 16
    expected_h = 2 * TILE_SIZE                       # 2 rows × 16
    assert sheet.size == (expected_w, expected_h), (
        f"sheet size {sheet.size} != expected ({expected_w}, {expected_h})"
    )
    out: dict[str, Image.Image] = {}
    for name, (col, row) in TILE_LAYOUT.items():
        x, y = col * TILE_SIZE, row * TILE_SIZE
        out[name] = sheet.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))
    return out


@pytest.mark.parametrize("tile_name", SEAMLESS_TILES)
def test_base_field_tile_is_seamless(tiles, tile_name):
    """T-0102 seamlessness: left col == right col AND top row == bottom row."""
    result = asset_gate_art.check_tile_seamlessness(tiles[tile_name])
    assert result.passed, f"{tile_name}: {result.reason}"


@pytest.mark.parametrize("tile_a,tile_b,edge", ADJACENCY_PAIRS)
def test_transition_adjacency(tiles, tile_a, tile_b, edge):
    """T-0102 adjacency: declared tile pairs match on their shared edge."""
    result = asset_gate_art.check_transition_adjacency(
        tiles[tile_a], tiles[tile_b], edge=edge
    )
    assert result.passed, f"{tile_a} | {tile_b} ({edge}): {result.reason}"
