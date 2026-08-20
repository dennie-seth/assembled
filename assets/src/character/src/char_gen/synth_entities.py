"""Synthetic entity sprite-sheet generators for T-0200.

Three entity characters — Watcher, Sound, Still Air — each with three
animation states: idle, move, trapped. Entities never die.

Frame counts and grids (cell size 48×48, home palette, mode-P indexed PNG):

  Watcher (surveillance orb — wide and compact):
    idle:    3×2 grid, 144×96,  6 frames, v-float  ±2px, delta ≤ 30%
    move:    4×2 grid, 192×96,  8 frames, h-drift  ±6px, delta ≤ 60%
    trapped: 2×2 grid,  96×96,  4 frames, v-float  ±1px, delta ≤ 30%

  Sound (wave-band — wide and flat):
    idle:    3×2 grid, 144×96,  6 frames, v-float  ±2px, delta ≤ 30%
    move:    4×2 grid, 192×96,  8 frames, h-drift  ±6px, delta ≤ 60%
    trapped: 2×2 grid,  96×96,  4 frames, v-float  ±1px, delta ≤ 30%

  Still Air (atmospheric column — tall and narrow):
    idle:    3×2 grid, 144×96,  6 frames, v-float  ±2px, delta ≤ 30%
    move:    4×2 grid, 192×96,  8 frames, h-drift  ±3px, delta ≤ 60%
    trapped: 2×2 grid,  96×96,  4 frames, v-float  ±1px, delta ≤ 30%

Total: 3 entities × 18 frames = 54 frames (T-0200 §story).

All figures use solid-rectangle silhouettes with an accent zone inside the
main body rectangle — no separate blobs, so the orphan check always passes.
Figures are kept ≥ 4px from all cell edges (no cell-bleed at cell boundaries).

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[5]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
ENTITY_OUT = REPO_ROOT / "assets" / "final" / "entity"

CELL_SIZE = 48

# Palette indices (same as player sheets for consistency)
BG_IDX = 0    # background / transparent
LEG_IDX = 4   # darker accent
BODY_IDX = 6  # main entity body
HEAD_IDX = 10  # lighter accent

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


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
        flat[3 * i] = r
        flat[3 * i + 1] = g
        flat[3 * i + 2] = b
    img.putpalette(flat)
    return img


def _save(arr: np.ndarray, palette: list[tuple[int, int, int]], out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _to_pil(arr, palette).save(out_path)
    return out_path


def _make_sheet(
    rows: int, cols: int, palette: list[tuple[int, int, int]], out_path: Path,
    draw_fn,  # callable(cell_arr: np.ndarray, frame_idx: int) -> None
    frame_cells: list[tuple[int, int]],
) -> Path:
    sheet = np.zeros((rows * CELL_SIZE, cols * CELL_SIZE), dtype=np.uint8)
    for frame_idx, (sr, sc) in enumerate(frame_cells):
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        draw_fn(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], frame_idx)
    return _save(sheet, palette, out_path)


# ---------------------------------------------------------------------------
# Watcher — wide compact surveillance orb
#
# Body:   rows 14:34, cols 10:38 (20×28=560px) — BODY_IDX
# Accent: rows 28:34, cols 16:32 (6×16=96px) — LEG_IDX (inside body, no orphan)
#
# Cell-fit safety: at max v-offset ±2, body rows 12:36 — well inside [1:47].
#                  at max h-offset ±6, body cols 4:44 — well inside [1:47].
# Frame-consistency (shift 1-2px per step, large constant body):
#   idle  Δ ≤ 2×28/560 ≈ 10% << 30%
#   move  Δ ≤ 2×6/600 ≈ 13% << 60%  (6px shift, union grows to ~600px)
#   trapped Δ ≤ 2×28/560 ≈ 5% << 30%
# ---------------------------------------------------------------------------

_WATCHER_IDLE_V_OFFSETS: list[int] = [0, -1, -2, -1, 0, 1]       # 6 frames
_WATCHER_MOVE_H_OFFSETS: list[int] = [0, -2, -4, -6, -4, -2, 0, 2]  # 8 frames
_WATCHER_TRAPPED_V_OFFSETS: list[int] = [0, -1, -1, 0]              # 4 frames


def _draw_watcher(cell_arr: np.ndarray, v_off: int = 0, h_off: int = 0) -> None:
    cell_arr[:] = BG_IDX
    r0, r1 = 14 + v_off, 34 + v_off
    c0, c1 = 10 + h_off, 38 + h_off
    cell_arr[r0:r1, c0:c1] = BODY_IDX
    # Accent strip inside lower portion of body (lens/sensor highlight)
    ar0, ar1 = 28 + v_off, 34 + v_off
    ac0, ac1 = 16 + h_off, 32 + h_off
    cell_arr[ar0:ar1, ac0:ac1] = LEG_IDX


def generate_watcher_idle_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """144×96 (3×2) Watcher idle sheet — 6 frames, vertical float."""
    frame_cells = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_watcher(cell_arr, v_off=_WATCHER_IDLE_V_OFFSETS[idx])

    return _make_sheet(2, 3, palette, out_path, draw, frame_cells)


def generate_watcher_move_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """192×96 (4×2) Watcher move sheet — 8 frames, horizontal drift."""
    frame_cells = [
        (0, 0), (0, 1), (0, 2), (0, 3),
        (1, 0), (1, 1), (1, 2), (1, 3),
    ]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_watcher(cell_arr, h_off=_WATCHER_MOVE_H_OFFSETS[idx])

    return _make_sheet(2, 4, palette, out_path, draw, frame_cells)


def generate_watcher_trapped_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """96×96 (2×2) Watcher trapped sheet — 4 frames, micro vertical float."""
    frame_cells = [(0, 0), (0, 1), (1, 0), (1, 1)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_watcher(cell_arr, v_off=_WATCHER_TRAPPED_V_OFFSETS[idx])

    return _make_sheet(2, 2, palette, out_path, draw, frame_cells)


# ---------------------------------------------------------------------------
# Sound — wide flat wave-band entity
#
# Body:   rows 18:30, cols 8:40 (12×32=384px) — BODY_IDX
# Accent: rows 18:22, cols 14:34 (4×20=80px) — HEAD_IDX (inside body top, no orphan)
#
# Cell-fit safety: at max v-offset ±2, body rows 16:32 — inside [1:47].
#                  at max h-offset ±6, body cols 2:46 — inside [1:47].
# Frame-consistency: large constant body anchors δ/union well inside limits.
#   idle  Δ ≤ 2×32/384 ≈ 17% << 30%
#   move  Δ ≤ 2×6×12/420 ≈ 17% << 60%
#   trapped Δ ≤ 1×32/384 ≈ 8% << 30%
# ---------------------------------------------------------------------------

_SOUND_IDLE_V_OFFSETS: list[int] = [0, -1, -2, -1, 0, 1]
_SOUND_MOVE_H_OFFSETS: list[int] = [0, -2, -4, -6, -4, -2, 0, 2]
_SOUND_TRAPPED_V_OFFSETS: list[int] = [0, -1, -1, 0]


def _draw_sound(cell_arr: np.ndarray, v_off: int = 0, h_off: int = 0) -> None:
    cell_arr[:] = BG_IDX
    r0, r1 = 18 + v_off, 30 + v_off
    c0, c1 = 8 + h_off, 40 + h_off
    cell_arr[r0:r1, c0:c1] = BODY_IDX
    # Accent crest inside upper portion of body
    ar0, ar1 = 18 + v_off, 22 + v_off
    ac0, ac1 = 14 + h_off, 34 + h_off
    cell_arr[ar0:ar1, ac0:ac1] = HEAD_IDX


def generate_sound_idle_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """144×96 (3×2) Sound idle sheet — 6 frames, vertical float."""
    frame_cells = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_sound(cell_arr, v_off=_SOUND_IDLE_V_OFFSETS[idx])

    return _make_sheet(2, 3, palette, out_path, draw, frame_cells)


def generate_sound_move_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """192×96 (4×2) Sound move sheet — 8 frames, horizontal drift."""
    frame_cells = [
        (0, 0), (0, 1), (0, 2), (0, 3),
        (1, 0), (1, 1), (1, 2), (1, 3),
    ]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_sound(cell_arr, h_off=_SOUND_MOVE_H_OFFSETS[idx])

    return _make_sheet(2, 4, palette, out_path, draw, frame_cells)


def generate_sound_trapped_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """96×96 (2×2) Sound trapped sheet — 4 frames, micro vertical float."""
    frame_cells = [(0, 0), (0, 1), (1, 0), (1, 1)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_sound(cell_arr, v_off=_SOUND_TRAPPED_V_OFFSETS[idx])

    return _make_sheet(2, 2, palette, out_path, draw, frame_cells)


# ---------------------------------------------------------------------------
# Still Air — tall narrow atmospheric column entity
#
# Body:   rows 8:40, cols 20:28 (32×8=256px) — BODY_IDX
# Accent: rows 8:12, cols 22:26 (4×4=16px) — HEAD_IDX (inside body top, no orphan)
#
# Cell-fit safety: at max v-offset ±2, body rows 6:42 — inside [1:47].
#                  at max h-offset ±3, body cols 17:31 — inside [1:47].
# Frame-consistency:
#   idle  Δ ≤ 2×8/256 ≈ 6.25% << 30%
#   move  Δ ≤ 2×3×32/280 ≈ 7% << 60%   (3px h-shift, union ~280px)
#   trapped Δ ≤ 1×8/256 ≈ 3% << 30%
# ---------------------------------------------------------------------------

_STILL_AIR_IDLE_V_OFFSETS: list[int] = [0, -1, -2, -1, 0, 1]
_STILL_AIR_MOVE_H_OFFSETS: list[int] = [0, -1, -2, -3, -2, -1, 0, 1]
_STILL_AIR_TRAPPED_V_OFFSETS: list[int] = [0, -1, -1, 0]


def _draw_still_air(cell_arr: np.ndarray, v_off: int = 0, h_off: int = 0) -> None:
    cell_arr[:] = BG_IDX
    r0, r1 = 8 + v_off, 40 + v_off
    c0, c1 = 20 + h_off, 28 + h_off
    cell_arr[r0:r1, c0:c1] = BODY_IDX
    # Accent cap inside top of column (ethereal glow effect)
    ar0, ar1 = 8 + v_off, 12 + v_off
    ac0, ac1 = 22 + h_off, 26 + h_off
    cell_arr[ar0:ar1, ac0:ac1] = HEAD_IDX


def generate_still_air_idle_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """144×96 (3×2) Still Air idle sheet — 6 frames, vertical float."""
    frame_cells = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_still_air(cell_arr, v_off=_STILL_AIR_IDLE_V_OFFSETS[idx])

    return _make_sheet(2, 3, palette, out_path, draw, frame_cells)


def generate_still_air_move_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """192×96 (4×2) Still Air move sheet — 8 frames, horizontal drift."""
    frame_cells = [
        (0, 0), (0, 1), (0, 2), (0, 3),
        (1, 0), (1, 1), (1, 2), (1, 3),
    ]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_still_air(cell_arr, h_off=_STILL_AIR_MOVE_H_OFFSETS[idx])

    return _make_sheet(2, 4, palette, out_path, draw, frame_cells)


def generate_still_air_trapped_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """96×96 (2×2) Still Air trapped sheet — 4 frames, micro vertical float."""
    frame_cells = [(0, 0), (0, 1), (1, 0), (1, 1)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_still_air(cell_arr, v_off=_STILL_AIR_TRAPPED_V_OFFSETS[idx])

    return _make_sheet(2, 2, palette, out_path, draw, frame_cells)


# ---------------------------------------------------------------------------
# CLI entry points (registered in pyproject.toml [project.scripts])
# ---------------------------------------------------------------------------


def main_watcher_idle() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_watcher_idle_sheet(palette, ENTITY_OUT / "watcher_idle_sheet_v1.png")
    print(f"wrote {out}")


def main_watcher_move() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_watcher_move_sheet(palette, ENTITY_OUT / "watcher_move_sheet_v1.png")
    print(f"wrote {out}")


def main_watcher_trapped() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_watcher_trapped_sheet(palette, ENTITY_OUT / "watcher_trapped_sheet_v1.png")
    print(f"wrote {out}")


def main_sound_idle() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_sound_idle_sheet(palette, ENTITY_OUT / "sound_idle_sheet_v1.png")
    print(f"wrote {out}")


def main_sound_move() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_sound_move_sheet(palette, ENTITY_OUT / "sound_move_sheet_v1.png")
    print(f"wrote {out}")


def main_sound_trapped() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_sound_trapped_sheet(palette, ENTITY_OUT / "sound_trapped_sheet_v1.png")
    print(f"wrote {out}")


def main_still_air_idle() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_still_air_idle_sheet(palette, ENTITY_OUT / "still_air_idle_sheet_v1.png")
    print(f"wrote {out}")


def main_still_air_move() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_still_air_move_sheet(palette, ENTITY_OUT / "still_air_move_sheet_v1.png")
    print(f"wrote {out}")


def main_still_air_trapped() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_still_air_trapped_sheet(palette, ENTITY_OUT / "still_air_trapped_sheet_v1.png")
    print(f"wrote {out}")
