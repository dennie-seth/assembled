"""Session-scoped conftest: auto-generates the synthetic idle sheet before gate tests run.

The synthetic sheet is a programmatic reference image — not an AI-generated asset.
It exists to validate that the T-0102 gate infrastructure works correctly at the
target format (144×144, mode P, 3×3 grid of 48×48 cells, 40px humanoid figure).

Running `pytest` produces `assets/final/character/player_idle_sheet_v1.png` if it
doesn't already exist, so the gate tests are self-contained for the spike.
The SDXL-generated sheet (see MANUAL_GENERATION.md) replaces this file once
the Windows-side generation run is complete.

Also adds tools/asset-gate/src to sys.path at module level so that
`pytest.importorskip("asset_gate.art")` in the test module resolves correctly
without requiring a separate pip install step.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Make asset_gate importable from the monorepo's tools/asset-gate package
# without requiring `pip install -e tools/asset-gate` — conftest is loaded
# before test modules, so this is in place before pytest.importorskip runs.
_ASSET_GATE_SRC = Path(__file__).resolve().parents[4] / "tools" / "asset-gate" / "src"
if _ASSET_GATE_SRC.exists() and str(_ASSET_GATE_SRC) not in sys.path:
    sys.path.insert(0, str(_ASSET_GATE_SRC))

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from PIL import Image  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[4]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
OUT_PATH = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_v1.png"

CELL_SIZE = 48
COLS = 3
ROWS = 3
BG_IDX = 0
LEG_IDX = 4
BODY_IDX = 6
HEAD_IDX = 10


def _load_palette(path: Path) -> list[tuple[int, int, int]]:
    data = json.loads(path.read_text())
    slots = sorted(data["slots"], key=lambda s: int(s["index"]))
    result = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        result.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    return result


def _draw_figure(cell_arr: np.ndarray, head_offset: int = 0) -> None:
    cell_arr[:] = BG_IDX
    hr0, hr1 = 4 + head_offset, 12 + head_offset
    cell_arr[hr0:hr1, 18:30] = HEAD_IDX
    nr0, nr1 = 11 + head_offset, 15 + head_offset
    cell_arr[nr0:nr1, 21:27] = BODY_IDX
    cell_arr[14:30, 15:33] = BODY_IDX
    cell_arr[14:24, 12:16] = BODY_IDX
    cell_arr[14:24, 32:36] = BODY_IDX
    cell_arr[29:43, 17:22] = LEG_IDX
    cell_arr[29:43, 26:31] = LEG_IDX


def _generate_sheet() -> None:
    palette = _load_palette(PALETTE_PATH)
    sheet = np.zeros((ROWS * CELL_SIZE, COLS * CELL_SIZE), dtype=np.uint8)
    for sr, sc, ho in [(0, 0, 0), (0, 1, 1), (0, 2, 0), (1, 0, 1)]:
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        _draw_figure(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], head_offset=ho)
    img = Image.fromarray(sheet, mode="P")
    flat = [0] * (256 * 3)
    for i, (r, g, b) in enumerate(palette):
        flat[3 * i], flat[3 * i + 1], flat[3 * i + 2] = r, g, b
    img.putpalette(flat)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT_PATH)


# Generate the synthetic sheet at conftest import time so the PNG exists
# even when test collection is cut short (e.g. pytest.importorskip skips
# the test module before any fixture has a chance to run).
if not OUT_PATH.exists():
    _generate_sheet()


@pytest.fixture(scope="session", autouse=True)
def ensure_synth_sheet() -> None:
    """Re-generate the synthetic idle sheet if somehow absent at run time."""
    if not OUT_PATH.exists():  # pragma: no cover
        _generate_sheet()
