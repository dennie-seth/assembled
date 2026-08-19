"""Session-scoped conftest: auto-generates synthetic sheets before gate tests run.

The synthetic sheets are programmatic reference images — not AI-generated assets.
They exist to validate that the T-0102 gate infrastructure works correctly at the
target format (mode P, 48×48 cells, 40px humanoid figure).

  idle:        144×144, 3×3 grid, 4 frames  (T-0198)
  move:        144×192, 3×4 grid, 10 frames (T-0199)
  crouch-hide: 144×144, 3×3 grid, 9 frames  (T-0199)
  die:         144×144, 3×3 grid, 9 frames  (T-0199)

Also adds tools/asset-gate/src to sys.path at module level so that
`pytest.importorskip("asset_gate.art")` in the test modules resolves correctly
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
CHAR_OUT = REPO_ROOT / "assets" / "final" / "character"
IDLE_PATH = CHAR_OUT / "player_idle_sheet_v1.png"
MOVE_PATH = CHAR_OUT / "player_move_sheet_v1.png"
CROUCH_PATH = CHAR_OUT / "player_crouch_hide_sheet_v1.png"
DIE_PATH = CHAR_OUT / "player_die_sheet_v1.png"

CELL_SIZE = 48
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


def _to_pil(arr: np.ndarray, palette: list[tuple[int, int, int]]) -> Image.Image:
    img = Image.fromarray(arr, mode="P")
    flat = [0] * (256 * 3)
    for i, (r, g, b) in enumerate(palette):
        flat[3 * i], flat[3 * i + 1], flat[3 * i + 2] = r, g, b
    img.putpalette(flat)
    return img


# ---------------------------------------------------------------------------
# Idle sheet (T-0198) — unchanged from original conftest
# ---------------------------------------------------------------------------


def _draw_idle_figure(cell_arr: np.ndarray, head_offset: int = 0) -> None:
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


def _generate_idle_sheet() -> None:
    palette = _load_palette(PALETTE_PATH)
    sheet = np.zeros((3 * CELL_SIZE, 3 * CELL_SIZE), dtype=np.uint8)
    for sr, sc, ho in [(0, 0, 0), (0, 1, 1), (0, 2, 0), (1, 0, 1)]:
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        _draw_idle_figure(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], head_offset=ho)
    CHAR_OUT.mkdir(parents=True, exist_ok=True)
    _to_pil(sheet, palette).save(IDLE_PATH)


# ---------------------------------------------------------------------------
# Move sheet (T-0199) — 3×4 grid, 10 walk-cycle frames
# ---------------------------------------------------------------------------

_WALK_OFFSETS: list[tuple[int, int]] = [
    (0, 0), (-2, 2), (-4, 4), (-2, 2), (0, 0),
    (2, -2), (4, -4), (2, -2), (0, 0), (-2, 2),
]


def _draw_walk_frame(cell_arr: np.ndarray, l_off: int, r_off: int) -> None:
    cell_arr[:] = BG_IDX
    cell_arr[13:42, 8:42] = BODY_IDX
    cell_arr[4:14, 16:28] = HEAD_IDX
    cell_arr[13:23, 2:10] = BODY_IDX
    cell_arr[13:23, 40:46] = BODY_IDX
    ll_c0 = 14 + l_off
    cell_arr[29:35, ll_c0 : ll_c0 + 6] = LEG_IDX
    rl_c0 = 30 + r_off
    cell_arr[29:35, rl_c0 : rl_c0 + 6] = LEG_IDX


def _generate_move_sheet() -> None:
    palette = _load_palette(PALETTE_PATH)
    sheet = np.zeros((4 * CELL_SIZE, 3 * CELL_SIZE), dtype=np.uint8)
    frame_cells = [
        (0, 0), (0, 1), (0, 2),
        (1, 0), (1, 1), (1, 2),
        (2, 0), (2, 1), (2, 2),
        (3, 0),
    ]
    for idx, (sr, sc) in enumerate(frame_cells):
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        l_off, r_off = _WALK_OFFSETS[idx]
        _draw_walk_frame(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], l_off, r_off)
    CHAR_OUT.mkdir(parents=True, exist_ok=True)
    _to_pil(sheet, palette).save(MOVE_PATH)


# ---------------------------------------------------------------------------
# Crouch-hide sheet (T-0199) — 3×3 grid, 9 frames
# ---------------------------------------------------------------------------


def _draw_crouch_frame(cell_arr: np.ndarray, step: int) -> None:
    cell_arr[:] = BG_IDX
    cell_arr[20:42, 10:38] = BODY_IDX
    head_top = 4 + 2 * step
    head_bot = head_top + 10
    cell_arr[head_top:head_bot, 16:28] = HEAD_IDX
    if head_bot <= 20:
        neck_top = head_bot - 1
        if neck_top < 21:
            cell_arr[neck_top:21, 20:28] = BODY_IDX
    leg_top = 40 - step
    leg_bot = min(leg_top + 5, 46)
    if leg_top < leg_bot:
        cell_arr[leg_top:leg_bot, 14:20] = LEG_IDX
        cell_arr[leg_top:leg_bot, 30:36] = LEG_IDX


def _generate_crouch_hide_sheet() -> None:
    palette = _load_palette(PALETTE_PATH)
    sheet = np.zeros((3 * CELL_SIZE, 3 * CELL_SIZE), dtype=np.uint8)
    step = 0
    for sr in range(3):
        for sc in range(3):
            y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
            _draw_crouch_frame(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], step)
            step += 1
    CHAR_OUT.mkdir(parents=True, exist_ok=True)
    _to_pil(sheet, palette).save(CROUCH_PATH)


# ---------------------------------------------------------------------------
# Die sheet (T-0199) — 3×3 grid, 9 frames
# ---------------------------------------------------------------------------


def _draw_die_frame(cell_arr: np.ndarray, step: int) -> None:
    cell_arr[:] = BG_IDX
    cell_arr[13:42, 8:40] = BODY_IDX
    head_r0 = 4 + 2 * step
    head_c0 = 16 + 2 * step
    cell_arr[head_r0 : head_r0 + 10, head_c0 : head_c0 + 12] = HEAD_IDX
    leg_r0 = 41 - step
    leg_r1 = min(leg_r0 + 5, 46)
    if leg_r0 < leg_r1:
        cell_arr[leg_r0:leg_r1, 14:20] = LEG_IDX
        cell_arr[leg_r0:leg_r1, 30:36] = LEG_IDX


def _generate_die_sheet() -> None:
    palette = _load_palette(PALETTE_PATH)
    sheet = np.zeros((3 * CELL_SIZE, 3 * CELL_SIZE), dtype=np.uint8)
    step = 0
    for sr in range(3):
        for sc in range(3):
            y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
            _draw_die_frame(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], step)
            step += 1
    CHAR_OUT.mkdir(parents=True, exist_ok=True)
    _to_pil(sheet, palette).save(DIE_PATH)


# ---------------------------------------------------------------------------
# Auto-generate missing sheets at import time
# ---------------------------------------------------------------------------

if not IDLE_PATH.exists():
    _generate_idle_sheet()
if not MOVE_PATH.exists():
    _generate_move_sheet()
if not CROUCH_PATH.exists():
    _generate_crouch_hide_sheet()
if not DIE_PATH.exists():
    _generate_die_sheet()


@pytest.fixture(scope="session", autouse=True)
def ensure_synth_sheets() -> None:
    """Re-generate synthetic sheets if somehow absent at run time."""
    if not IDLE_PATH.exists():  # pragma: no cover
        _generate_idle_sheet()
    if not MOVE_PATH.exists():  # pragma: no cover
        _generate_move_sheet()
    if not CROUCH_PATH.exists():  # pragma: no cover
        _generate_crouch_hide_sheet()
    if not DIE_PATH.exists():  # pragma: no cover
        _generate_die_sheet()
