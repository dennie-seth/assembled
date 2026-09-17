#!/usr/bin/env python3
"""Render Arm B's delivered sheet as a judgeable, in-motion preview (T-0229).

Mirrors render_judging_preview.py (T-0228) -- DL-21 judges every bake-off arm
"at 40px, in motion, inside the T-0192 blockout room", explicitly not at
native generation resolution and not as a static contact sheet. This repo
has no committed screenshot of the blockout room
(`client/scenes/blockout_room_sideon.tscn` is a Godot scene, outside this
agent's tool scope), so this composites onto a flat mockup at the room's own
committed pixel dimensions (384x216, DL-18) instead of an actual in-engine
capture.

Usage (from the repo root):
    python3 assets/src/character/render_judging_preview_arm_b_T0229.py

Reads:
    assets/final/character/player_idle_sheet_arm_b_T0229.png
Writes:
    assets/final/character/arm_b_judging_preview_T0229.gif
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
SHEET_PATH = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_b_T0229.png"
OUT_PATH = REPO_ROOT / "assets" / "final" / "character" / "arm_b_judging_preview_T0229.gif"

CELL_SIZE = 48
COLS, ROWS = 3, 3
BACKGROUND_INDEX = 0
ROOM_SIZE = (384, 216)  # DL-18 committed blockout-room pixel dimensions
FIGURE_HEIGHT_PX = 40  # §3.5: figure height at the game's own internal resolution
FRAME_MS = 220


def _cell_to_rgba(cell_indexed: Image.Image) -> Image.Image:
    """Indexed cell -> RGBA with background_index pixels made transparent, so
    the silhouette composites onto the room mockup without a background box."""
    rgba = cell_indexed.convert("RGBA")
    arr = np.array(rgba)
    mask = np.array(cell_indexed) == BACKGROUND_INDEX
    arr[mask, 3] = 0
    return Image.fromarray(arr, mode="RGBA")


def build_preview() -> list[Image.Image]:
    sheet = Image.open(SHEET_PATH)
    room_bg = (0x58, 0x55, 0x4C)  # home_palette index 8 -- a mid wall tone, flat mockup only
    scale = FIGURE_HEIGHT_PX / CELL_SIZE

    frames = []
    for r in range(ROWS):
        for c in range(COLS):
            cell = sheet.crop(
                (c * CELL_SIZE, r * CELL_SIZE, (c + 1) * CELL_SIZE, (r + 1) * CELL_SIZE)
            )
            cell = _cell_to_rgba(cell)
            scaled_size = (round(CELL_SIZE * scale), round(CELL_SIZE * scale))
            cell = cell.resize(scaled_size, Image.NEAREST)

            room = Image.new("RGBA", ROOM_SIZE, room_bg + (255,))
            x = (ROOM_SIZE[0] - scaled_size[0]) // 2
            y = ROOM_SIZE[1] - scaled_size[1] - 8  # feet near the floor line, not centered
            room.alpha_composite(cell, (x, y))
            frames.append(room.convert("RGB"))

    return frames


def main() -> None:
    frames = build_preview()
    frames[0].save(
        OUT_PATH,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_MS,
        loop=0,
    )
    print(f"wrote {OUT_PATH} ({len(frames)} frames, {FRAME_MS}ms/frame)")


if __name__ == "__main__":
    main()
