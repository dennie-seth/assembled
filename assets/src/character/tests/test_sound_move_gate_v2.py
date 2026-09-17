"""Sound entity move sheet v2 — T-0214 gate validation.

Concept-conditioned re-run of T-0200 sound move sheet, conditioned on the
T-0210 entities concept sheet (IP-Adapter/img2img via ComfyUI).

docs/design/13-asset-pipeline.md §3.5:
  cell 48×48, grid 4×2, native 192×96.

Sheet: assets/final/entity/sound_move_sheet_v2.png (8 move frames).

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")

REPO_ROOT = Path(__file__).resolve().parents[4]
SHEET_PATH = REPO_ROOT / "assets" / "final" / "entity" / "sound_move_sheet_v2.png"
PROV_PATH = REPO_ROOT / "assets" / "final" / "entity" / "sound_move_sheet_v2.provenance.json"
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

CELL_SIZE = 48
COLS = 4
ROWS = 2

FRAME_CELLS: list[tuple[int, int]] = [
    (0, 0), (0, 1), (0, 2), (0, 3),
    (1, 0), (1, 1), (1, 2), (1, 3),
]

ADJACENT_PAIRS: list[tuple[tuple[int, int], tuple[int, int]]] = [
    ((0, 0), (0, 1)),
    ((0, 1), (0, 2)),
    ((0, 2), (0, 3)),
    ((0, 3), (1, 0)),
    ((1, 0), (1, 1)),
    ((1, 1), (1, 2)),
    ((1, 2), (1, 3)),
]

BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.60
ORPHAN_SIZE_THRESHOLD = 4


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"sound move sheet v2 not found: {SHEET_PATH}\n"
        "Run assets/src/character/gen_entities_v2.py to produce it."
    )
    img = Image.open(SHEET_PATH)
    assert img.mode == "P", f"expected indexed mode 'P', got {img.mode!r}"
    assert img.size == (COLS * CELL_SIZE, ROWS * CELL_SIZE), (
        f"sheet size {img.size} != expected ({COLS * CELL_SIZE}, {ROWS * CELL_SIZE})"
    )
    return img


@pytest.fixture(scope="module")
def palette() -> asset_gate_palette.Palette:
    assert PALETTE_PATH.exists(), f"home palette not found: {PALETTE_PATH}"
    return asset_gate_palette.load_palette(PALETTE_PATH)


@pytest.fixture(scope="module")
def frame_images(sheet: Image.Image) -> dict[tuple[int, int], Image.Image]:
    cells: dict[tuple[int, int], Image.Image] = {}
    for sr, sc in FRAME_CELLS:
        x0, y0 = sc * CELL_SIZE, sr * CELL_SIZE
        cells[(sr, sc)] = sheet.crop((x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE))
    return cells


def test_concept_hash_in_provenance() -> None:
    """concept_hash of T-0210 entities concept sheet must be in provenance (T-0106)."""
    assert PROV_PATH.exists(), f"provenance not found: {PROV_PATH}"
    prov = json.loads(PROV_PATH.read_text())
    assert "concept_hash" in prov, "provenance missing 'concept_hash' field"
    assert prov["concept_hash"], "provenance concept_hash is empty/null"


def test_palette_membership(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    result = asset_gate_palette.check_palette_membership(sheet, palette)
    assert result.passed, result.reason


def test_index_semantics(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    result = asset_gate_palette.check_index_semantics(sheet, palette)
    assert result.passed, result.reason


def test_cell_fit() -> None:
    sheet = Image.open(SHEET_PATH)
    results = asset_gate_art.check_cell_fit(
        sheet,
        cell_width=CELL_SIZE,
        cell_height=CELL_SIZE,
        cols=COLS,
        rows=ROWS,
        background_index=BACKGROUND_INDEX,
    )
    failures = [r for r in results if not r.passed]
    assert not failures, "\n".join(f"cell {r.details['cell']}: {r.reason}" for r in failures)


@pytest.mark.parametrize("cell", FRAME_CELLS)
def test_orphan_pixels(
    cell: tuple[int, int], frame_images: dict[tuple[int, int], Image.Image]
) -> None:
    result = asset_gate_art.check_orphan_pixels(
        frame_images[cell],
        background_index=BACKGROUND_INDEX,
        size_threshold=ORPHAN_SIZE_THRESHOLD,
    )
    assert result.passed, f"cell {cell}: {result.reason}"


@pytest.mark.parametrize("cell_a,cell_b", ADJACENT_PAIRS)
def test_frame_consistency(
    cell_a: tuple[int, int],
    cell_b: tuple[int, int],
    frame_images: dict[tuple[int, int], Image.Image],
) -> None:
    result = asset_gate_art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    assert result.passed, f"cells {cell_a}->{cell_b}: {result.reason}"
