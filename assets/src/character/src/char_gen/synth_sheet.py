"""Synthetic player idle sheet generator for T-0198 spike.

Generates a 144×144 indexed PNG (mode P, home palette) containing a
40px humanoid silhouette in 4 idle animation cells and 5 spare cells
on a 3×3 grid of 48×48 cells.

This is a programmatic reference image used to validate the T-0102 gate
infrastructure BEFORE SDXL generation is available from WSL (ComfyUI is on
the Windows host; see assets/src/character/MANUAL_GENERATION.md for the
SDXL path). It answers whether the gate checks run correctly against the
correct sheet format; SDXL visual quality requires the Windows-side run.

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class).

Usage:
    python -m char_gen.synth_sheet
    python -m char_gen.synth_sheet --out /path/to/output.png
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from char_gen.sprite_io import save_sprite_sheet

REPO_ROOT = Path(__file__).resolve().parents[5]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
DEFAULT_OUT = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_v1.png"

CELL_SIZE = 48
COLS = 3
ROWS = 3
SHEET_W = COLS * CELL_SIZE  # 144
SHEET_H = ROWS * CELL_SIZE  # 144

# Palette indices used by the synthetic figure
BG_IDX = 0   # background / transparent (#12110e — darkest)
LEG_IDX = 4  # legs (#3d3b31 — dark grey-brown)
BODY_IDX = 6  # torso + arms (#49493b — medium-dark grey)
HEAD_IDX = 10  # head (#646258 — medium grey)


def _load_palette(path: Path) -> list[tuple[int, int, int]]:
    """Load home palette as an index-ordered list of RGB tuples."""
    data = json.loads(path.read_text())
    slots = sorted(data["slots"], key=lambda s: int(s["index"]))
    result = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        result.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    return result


def _draw_figure(cell_arr: np.ndarray, head_offset: int = 0) -> None:
    """Draw a 40px humanoid silhouette into a (CELL_SIZE, CELL_SIZE) array.

    Figure sits at rows 4+head_offset..43, cols 12..35 within the 48x48 cell.
    All parts are 4-connected to the whole so no orphan blobs are created.

    head_offset shifts the HEAD and NECK vertically by ±N pixels for idle
    breathing animation. The TORSO, ARMS, and LEGS stay fixed.
    """
    cell_arr[:] = BG_IDX  # clear to background

    # HEAD (8px tall, 12px wide) — floats with head_offset
    hr0, hr1 = 4 + head_offset, 12 + head_offset
    cell_arr[hr0:hr1, 18:30] = HEAD_IDX

    # NECK (4px tall, 6px wide) — bridges head to torso
    nr0, nr1 = 11 + head_offset, 15 + head_offset
    cell_arr[nr0:nr1, 21:27] = BODY_IDX

    # TORSO (16px tall, 18px wide) — fixed, provides 4-connected base
    cell_arr[14:30, 15:33] = BODY_IDX

    # LEFT ARM (10px tall, 4px wide) — adjacent to torso left edge at col 15
    cell_arr[14:24, 12:16] = BODY_IDX

    # RIGHT ARM (10px tall, 4px wide) — adjacent to torso right edge at col 32
    cell_arr[14:24, 32:36] = BODY_IDX

    # LEFT LEG (14px tall, 5px wide) — adjacent to torso bottom at row 29
    cell_arr[29:43, 17:22] = LEG_IDX

    # RIGHT LEG (14px tall, 5px wide)
    cell_arr[29:43, 26:31] = LEG_IDX


def generate(palette: list[tuple[int, int, int]], out_path: Path) -> Path:
    """Build the 144×144 idle sheet and save as a mode-P indexed PNG with a
    transparent background (tRNS on BG_IDX)."""
    # (height, width) — numpy convention
    sheet = np.zeros((SHEET_H, SHEET_W), dtype=np.uint8)

    # 4 idle frames: subtle 1-pixel head-bob for breathing animation
    # Alternates between head_offset=0 and head_offset=1
    frames: list[tuple[int, int, int]] = [
        (0, 0, 0),  # (sheet_row, sheet_col, head_offset)
        (0, 1, 1),
        (0, 2, 0),
        (1, 0, 1),
    ]
    for sr, sc, ho in frames:
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        cell_view = sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE]
        _draw_figure(cell_view, head_offset=ho)
    # Remaining cells (1,1), (1,2), (2,0), (2,1), (2,2) stay at BG_IDX — spare.

    # Assemble the mode-P image with the full home palette embedded and write
    # it with BG_IDX marked transparent (P-6). This used to call Image.save()
    # directly, which emits no tRNS chunk -- the sheet's own comment has said
    # "background / transparent" since T-0198 while the file said otherwise.
    return save_sprite_sheet(sheet, out_path, palette=palette, background_index=BG_IDX)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic idle sheet (T-0198 spike)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--palette",
        type=Path,
        default=PALETTE_PATH,
        help="home_palette.json path",
    )
    args = parser.parse_args()
    palette = _load_palette(args.palette)
    out = generate(palette, args.out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
