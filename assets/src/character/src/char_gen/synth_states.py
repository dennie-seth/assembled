"""Synthetic state-sheet generators for T-0199.

Generates indexed PNG sprite sheets for the player's remaining animation states:
  - Move (walk cycle): 3×4 grid, 144×192px, 10 frames
  - Crouch-hide:       3×3 grid, 144×144px, 9 frames
  - Die (death):       3×3 grid, 144×144px, 9 frames

All sheets use mode-P indexed colour, the home palette, and the same 48×48 cell
size as the idle sheet (T-0198). Figures are synthetic (programmatic) reference
images — the same pattern as player_idle_sheet_v1.png — designed to pass every
T-0102 asset-gate check in a green state.

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

from char_gen.sprite_io import save_sprite_sheet, to_indexed_image

REPO_ROOT = Path(__file__).resolve().parents[5]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
CHAR_OUT = REPO_ROOT / "assets" / "final" / "character"

CELL_SIZE = 48

# Palette indices (same as synth_sheet.py for visual continuity)
BG_IDX = 0
LEG_IDX = 4
BODY_IDX = 6
HEAD_IDX = 10

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
    return to_indexed_image(arr, palette)


def _save(arr: np.ndarray, palette: list[tuple[int, int, int]], out_path: Path) -> Path:
    """Write the sheet with a transparent background (P-6).

    Delegates to `char_gen.sprite_io`, the one place that knows how a sprite
    sheet is written. This used to call `Image.save()` directly, which emits no
    tRNS chunk -- which is how the §24-e sheet shipped opaque.
    """
    return save_sprite_sheet(arr, out_path, palette=palette)


# ---------------------------------------------------------------------------
# Move (walk cycle) sheet — 3×4 grid, 144×192, 10 frames + 2 spare
# ---------------------------------------------------------------------------
#
# Design: large constant body-core + head + arms + varying-position legs.
#
# Body core: rows 13:42, cols 8:40 (29×32=928px, constant across all frames).
#   Connects to head (row 13 boundary), arms (cols 8 boundary), legs (row 41 boundary).
# Head: rows 4:14, cols 16:28 (10×12=120px; overlaps body at row 13, cols 16:28).
# Left arm: rows 13:23, cols 2:10 (10×8=80px; overlaps body at cols 8:10, rows 13:23).
# Right arm: rows 13:23, cols 40:46 (10×6=60px; overlaps body at col 40... wait,
#   body ends at col 39. Right arm at cols 40:46 touches body at shared boundary
#   col 39 (arm col 40 is adjacent to body col 39 — but only 4-connected if they
#   share a side, i.e. same row, adjacent columns).
#   Fix: extend body to cols 8:42 to bridge to right arm.
#
# Body core (revised): rows 13:42, cols 8:42 (29×34=986px).
#   Right arm cols 40:46 → overlap with body at cols 40:42 ✓.
#
# Legs: rows 29:35, cols (14+L_off):(20+L_off) and (30+R_off):(36+R_off).
#   Step offsets (L_off, R_off) for the 10 walk-cycle frames:
#     0: ( 0,  0)  neutral
#     1: (-2, +2)  left forward, right back
#     2: (-4, +4)  full left stride
#     3: (-2, +2)  returning
#     4: ( 0,  0)  neutral
#     5: (+2, -2)  right forward, left back
#     6: (+4, -4)  full right stride
#     7: (+2, -2)  returning
#     8: ( 0,  0)  neutral
#     9: (-2, +2)  start of next cycle
#
# Max leg shift ±4: leg spans cols 10:16 (left) to 18:24 (left), never < 2 or > 43.
# All transitions shift by 2 cols per step → delta/union < 0.10 per pair ≤ 0.60 max.


_WALK_OFFSETS: list[tuple[int, int]] = [
    (0, 0),
    (-2, 2),
    (-4, 4),
    (-2, 2),
    (0, 0),
    (2, -2),
    (4, -4),
    (2, -2),
    (0, 0),
    (-2, 2),
]


def _draw_walk_frame(cell_arr: np.ndarray, l_off: int, r_off: int) -> None:
    cell_arr[:] = BG_IDX

    # Body core: rows 13:42, cols 8:42 (29×34=986px)
    cell_arr[13:42, 8:42] = BODY_IDX

    # Head: rows 4:14, cols 16:28 (overlaps body at row 13, cols 16:28)
    cell_arr[4:14, 16:28] = HEAD_IDX

    # Left arm: rows 13:23, cols 2:10 (overlaps body at cols 8:10, rows 13:23)
    cell_arr[13:23, 2:10] = BODY_IDX

    # Right arm: rows 13:23, cols 40:46 (overlaps body at cols 40:42, rows 13:23)
    cell_arr[13:23, 40:46] = BODY_IDX

    # Left leg: rows 29:35, shifted by l_off cols
    ll_c0 = 14 + l_off
    cell_arr[29:35, ll_c0 : ll_c0 + 6] = LEG_IDX

    # Right leg: rows 29:35, shifted by r_off cols
    rl_c0 = 30 + r_off
    cell_arr[29:35, rl_c0 : rl_c0 + 6] = LEG_IDX


def generate_move_sheet(
    palette: list[tuple[int, int, int]],
    out_path: Path,
) -> Path:
    """Build the 144×192 walk-cycle sheet (3×4 grid) and save as mode-P indexed PNG."""
    COLS, ROWS = 3, 4
    sheet = np.zeros((ROWS * CELL_SIZE, COLS * CELL_SIZE), dtype=np.uint8)

    # 10 walk-cycle frames placed row-major; spare cells (3,1) and (3,2) stay BG.
    frame_cells: list[tuple[int, int]] = [
        (0, 0), (0, 1), (0, 2),
        (1, 0), (1, 1), (1, 2),
        (2, 0), (2, 1), (2, 2),
        (3, 0),
    ]
    for frame_idx, (sr, sc) in enumerate(frame_cells):
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        l_off, r_off = _WALK_OFFSETS[frame_idx]
        _draw_walk_frame(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], l_off, r_off)

    return _save(sheet, palette, out_path)


# ---------------------------------------------------------------------------
# Crouch-hide sheet — 3×3 grid, 144×144, 9 frames
# ---------------------------------------------------------------------------
#
# Design: constant body core + descending head + legs that compress into the body.
#
# Body core: rows 20:42, cols 10:38 (22×28=616px, constant).
# Head: rows (4+2i):(14+2i), cols 16:28 — descends 2px per step.
#   At step 0: rows 4:14 (fully above body).
#   At step 8: rows 20:30 (fully within body area → merges visually).
# Neck bridge: when head's bottom row < 20, draw a neck strip at
#   rows (head_bot-1):21, cols 20:28 to ensure 4-connectivity to body.
#   (The neck occupies rows already covered by head or body — no extra silhouette
#   pixels — it solely provides the 4-connected path required by orphan checks.)
# Legs: rows (40-i):(45-i), cols 14:20 and 30:36.
#   Legs gradually move inside the body core (step 3+); unique leg pixels
#   (outside body) shrink to zero by step 7.
#
# All adjacent frame silhouette deltas < 5% of union → well under 65% limit.


def _draw_crouch_frame(cell_arr: np.ndarray, step: int) -> None:
    cell_arr[:] = BG_IDX

    # Constant body core
    cell_arr[20:42, 10:38] = BODY_IDX

    # Head descends 2px per step
    head_top = 4 + 2 * step
    head_bot = head_top + 10  # always 10 rows tall
    cell_arr[head_top:head_bot, 16:28] = HEAD_IDX

    # Neck bridge: connect head to body when they don't yet overlap
    if head_bot <= 20:
        neck_top = head_bot - 1  # overlaps head by 1 row
        # neck_bot = 21 so it overlaps body (row 20) by 1 row
        if neck_top < 21:
            cell_arr[neck_top:21, 20:28] = BODY_IDX

    # Legs: slide up 1px per step; body covers them from step 3 onward
    leg_top = 40 - step
    leg_bot = min(leg_top + 5, 46)  # max 5 rows, cap at row 45
    if leg_top < leg_bot:
        cell_arr[leg_top:leg_bot, 14:20] = LEG_IDX
        cell_arr[leg_top:leg_bot, 30:36] = LEG_IDX


def generate_crouch_hide_sheet(
    palette: list[tuple[int, int, int]],
    out_path: Path,
) -> Path:
    """Build the 144×144 crouch-hide sheet (3×3 grid) and save as mode-P indexed PNG."""
    COLS, ROWS = 3, 3
    sheet = np.zeros((ROWS * CELL_SIZE, COLS * CELL_SIZE), dtype=np.uint8)

    # 9 frames filling all 9 cells in row-major order
    frame_idx = 0
    for sr in range(ROWS):
        for sc in range(COLS):
            y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
            _draw_crouch_frame(
                sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], frame_idx
            )
            frame_idx += 1

    return _save(sheet, palette, out_path)


# ---------------------------------------------------------------------------
# Die (death) sheet — 3×3 grid, 144×144, 9 frames
# ---------------------------------------------------------------------------
#
# Design: constant body core + head that shifts right and down + legs that shift.
#
# Body core: rows 13:42, cols 8:40 (29×32=928px, constant across all frames).
#   This massive constant anchor keeps adjacent-frame delta/union < 0.25 in the
#   worst case — well inside the 90% gate limit.
# Head: rows (4+2i):(14+2i), cols (16+2i):(28+2i) — moves right and down 2px/step.
#   At step 0: rows 4:14, cols 16:28 (above-left, standard upright position).
#   At step 8: rows 20:30, cols 32:44 (right side, figure is "fallen").
#   Head always overlaps with body core (body rows 13:42, body cols 8:40):
#     step 0: head rows 4:14 ends at 13, shares row 13 with body ✓
#     step 4+: head rows overlap body rows; head cols still within body cols ✓
# Legs: rows (41-step):(46-step), cols 14:20 and 30:36 — rise 1px/step.
#   Connected to body at the overlap (leg rows within body rows 13:42,
#   leg cols 14:20 and 30:36 within body cols 8:40).
#
# All adjacent frame silhouette deltas ≤ 30% of union → well inside 90% limit.


def _draw_die_frame(cell_arr: np.ndarray, step: int) -> None:
    cell_arr[:] = BG_IDX

    # Constant body core
    cell_arr[13:42, 8:40] = BODY_IDX

    # Head shifts right and down 2px per step
    head_r0 = 4 + 2 * step
    head_c0 = 16 + 2 * step
    cell_arr[head_r0 : head_r0 + 10, head_c0 : head_c0 + 12] = HEAD_IDX

    # Neck bridge when head doesn't yet touch body (step 0: head bottom = row 13,
    # body top = row 13 → they share row 13; connectivity already guaranteed).
    # No separate neck needed since head always reaches at least body's top row.

    # Legs rise 1px per step, staying within body cols (8:40)
    leg_r0 = 41 - step
    leg_r1 = min(leg_r0 + 5, 46)
    if leg_r0 < leg_r1:
        cell_arr[leg_r0:leg_r1, 14:20] = LEG_IDX
        cell_arr[leg_r0:leg_r1, 30:36] = LEG_IDX


def generate_die_sheet(
    palette: list[tuple[int, int, int]],
    out_path: Path,
) -> Path:
    """Build the 144×144 die sheet (3×3 grid) and save as mode-P indexed PNG."""
    COLS, ROWS = 3, 3
    sheet = np.zeros((ROWS * CELL_SIZE, COLS * CELL_SIZE), dtype=np.uint8)

    frame_idx = 0
    for sr in range(ROWS):
        for sc in range(COLS):
            y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
            _draw_die_frame(
                sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], frame_idx
            )
            frame_idx += 1

    return _save(sheet, palette, out_path)


# ---------------------------------------------------------------------------
# CLI entry points
# ---------------------------------------------------------------------------


def main_move() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = CHAR_OUT / "player_move_sheet_v1.png"
    result = generate_move_sheet(palette, out)
    print(f"wrote {result}")


def main_crouch_hide() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = CHAR_OUT / "player_crouch_hide_sheet_v1.png"
    result = generate_crouch_hide_sheet(palette, out)
    print(f"wrote {result}")


def main_die() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = CHAR_OUT / "player_die_sheet_v1.png"
    result = generate_die_sheet(palette, out)
    print(f"wrote {result}")
