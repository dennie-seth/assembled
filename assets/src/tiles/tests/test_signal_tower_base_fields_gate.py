"""Integration test: T-0102's tile-seamlessness gate against T-0232's
Signal Tower base-field tiles -- the circular-pad path.

docs/design/13-asset-pipeline.md §3.4 ("Base fields (wall, floor,
concrete) | Circular-pad / seamless sampling. Self-seamless for infinite
repeat."), HANDOFF §23-i (T-0232).

RED state:  assets/final/tiles/signal_tower/{wall,floor,concrete}_16px.png
            absent -> fixture AssertionError, all tests ERROR.
GREEN state: all three tiles present, mode 'P', 16x16, self-seamless.

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
TILE_DIR = REPO_ROOT / "assets" / "final" / "tiles" / "signal_tower"

TILE_SIZE = 16

# The three base fields T-0232 dresses all seven Signal Tower rooms with --
# see the room -> surface mapping recorded in
# assets/src/tiles/SIGNAL_TOWER_ROOM_SURFACES.md.
BASE_FIELD_TILES: list[str] = ["wall", "floor", "concrete"]


@pytest.mark.parametrize("tile_name", BASE_FIELD_TILES)
def test_base_field_tile_exists_and_is_indexed(tile_name):
    path = TILE_DIR / f"{tile_name}_16px.png"
    assert path.exists(), (
        f"base field tile not found: {path}\n"
        "Run `python -m tile_gen.base_fields` to generate it."
    )
    img = Image.open(path)
    assert img.mode == "P", f"{tile_name}: expected indexed mode 'P', got {img.mode!r}"
    assert img.size == (TILE_SIZE, TILE_SIZE), f"{tile_name}: size {img.size} != (16, 16)"


@pytest.mark.parametrize("tile_name", BASE_FIELD_TILES)
def test_base_field_tile_is_seamless(tile_name):
    """T-0102 seamlessness: left col == right col AND top row == bottom row."""
    path = TILE_DIR / f"{tile_name}_16px.png"
    assert path.exists(), f"base field tile not found: {path}"
    img = Image.open(path)
    result = asset_gate_art.check_tile_seamlessness(img)
    assert result.passed, f"{tile_name}: {result.reason}"
