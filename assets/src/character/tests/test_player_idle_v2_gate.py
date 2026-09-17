"""Player idle sheet v2 — T-0102 gate validation (T-0212, concept-conditioned).

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class):
  cell 48×48, grid 3×3, native 144×144, figure 40px tall.

Differences from T-0198 (test_player_idle_gate.py / v1):
  - Targets player_idle_sheet_v2.png — the concept-conditioned iteration.
  - Adds test_concept_hash: verifies provenance JSON contains `concept_hash`
    matching the SHA-256 of the approved T-0209 player concept sheet
    (assets/src/concept/player_character_concept_sheet_v1.png).

RED state:  assets/final/character/player_idle_sheet_v2.png absent
            → SHEET_PATH fixture raises AssertionError, all tests ERROR.
GREEN state: sheet present, mode P, 144×144; passes palette-membership,
             index-semantics, cell-fit (3×3, 48×48), orphan-pixel per frame
             cell, frame-consistency between adjacent idle frames, and
             concept_hash in provenance JSON.

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
SHEET_PATH = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_v2.png"
PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_v2.provenance.json"
)
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209).
# This is the conditioning input for the concept-conditioned v2 generation.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CELL_SIZE = 48
COLS = 3
ROWS = 3

# (sheet_row, sheet_col) of each declared idle animation frame.
# Remaining cells are spare (background-only); spare cells are excluded from
# orphan and frame-consistency checks to avoid degenerate zero-union ratios.
FRAME_CELLS: list[tuple[int, int]] = [(0, 0), (0, 1), (0, 2), (1, 0)]

# Adjacent pairs for frame-consistency (idle loop order)
ADJACENT_PAIRS: list[tuple[tuple[int, int], tuple[int, int]]] = [
    ((0, 0), (0, 1)),
    ((0, 1), (0, 2)),
    ((0, 2), (1, 0)),
]

BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.30  # 30% max silhouette change between adjacent idle frames
ORPHAN_SIZE_THRESHOLD = 4  # blobs < 4 connected px are orphans (downscale noise)


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"v2 idle sheet not found: {SHEET_PATH}\n"
        "Ensure conftest generates it (player_idle_sheet_v2.png auto-generated at import)\n"
        "or follow MANUAL_GENERATION.md for the SDXL concept-conditioned run."
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
    """Extract each declared frame cell as a mode-P sub-image."""
    cells: dict[tuple[int, int], Image.Image] = {}
    for sr, sc in FRAME_CELLS:
        x0, y0 = sc * CELL_SIZE, sr * CELL_SIZE
        cells[(sr, sc)] = sheet.crop((x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE))
    return cells


# ---------------------------------------------------------------------------
# Provenance check (T-0212 specific — concept conditioning)
# ---------------------------------------------------------------------------


def test_concept_hash() -> None:
    """Provenance JSON must contain concept_hash matching the T-0209 concept sheet (T-0106).

    This check ensures the v2 sheet's provenance records which concept art was used
    as the IP-Adapter/img2img conditioning input, satisfying T-0212 AC §4.
    """
    assert PROVENANCE_PATH.exists(), (
        f"provenance sidecar not found: {PROVENANCE_PATH}\n"
        "Commit player_idle_sheet_v2.provenance.json with a concept_hash field."
    )
    data = json.loads(PROVENANCE_PATH.read_text())
    assert "concept_hash" in data, (
        "provenance JSON missing 'concept_hash' field — "
        "T-0212 requires the conditioning sheet's SHA-256 to be recorded."
    )
    got = data["concept_hash"]
    assert got == EXPECTED_CONCEPT_HASH, (
        f"concept_hash mismatch:\n  got:      {got}\n  expected: {EXPECTED_CONCEPT_HASH}\n"
        "Verify assets/src/concept/player_character_concept_sheet_v1.png is the T-0209 sheet."
    )


# ---------------------------------------------------------------------------
# Whole-sheet checks
# ---------------------------------------------------------------------------


def test_palette_membership(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    """All used pixel colours must be exact members of the home palette (P-4)."""
    result = asset_gate_palette.check_palette_membership(sheet, palette)
    assert result.passed, result.reason


def test_index_semantics(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    """P-4: index N must resolve to the same RGB as home_palette slot N in every asset."""
    result = asset_gate_palette.check_index_semantics(sheet, palette)
    assert result.passed, result.reason


def test_cell_fit() -> None:
    """Each cell — frame and spare — must not bleed foreground pixels into a
    neighbouring cell (13-asset-pipeline.md §2 cell-fit check)."""
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


# ---------------------------------------------------------------------------
# Per-frame checks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cell", FRAME_CELLS)
def test_orphan_pixels(
    cell: tuple[int, int], frame_images: dict[tuple[int, int], Image.Image]
) -> None:
    """No orphan pixel blobs smaller than ORPHAN_SIZE_THRESHOLD in any frame cell."""
    result = asset_gate_art.check_orphan_pixels(
        frame_images[cell],
        background_index=BACKGROUND_INDEX,
        size_threshold=ORPHAN_SIZE_THRESHOLD,
    )
    assert result.passed, f"cell {cell}: {result.reason}"


# ---------------------------------------------------------------------------
# Frame-consistency (silhouette-delta) checks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cell_a,cell_b", ADJACENT_PAIRS)
def test_frame_consistency(
    cell_a: tuple[int, int],
    cell_b: tuple[int, int],
    frame_images: dict[tuple[int, int], Image.Image],
) -> None:
    """Silhouette delta between adjacent frames must stay within MAX_FRAME_DELTA_RATIO."""
    result = asset_gate_art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    assert result.passed, f"cells {cell_a}->{cell_b}: {result.reason}"
