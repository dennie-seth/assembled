"""Standalone script to generate the synthetic idle sheet (no package install needed)."""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
OUT_PATH = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_v1.png"

try:
    import numpy as np
    from PIL import Image
except ImportError as e:
    print(f"ERROR: {e}. Install: pip install pillow numpy", file=sys.stderr)
    sys.exit(1)

CELL_SIZE = 48
COLS = 3
ROWS = 3
BG_IDX = 0
LEG_IDX = 4
BODY_IDX = 6
HEAD_IDX = 10


def load_palette(path):
    data = json.loads(path.read_text())
    slots = sorted(data["slots"], key=lambda s: int(s["index"]))
    result = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        result.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    return result


def draw_figure(cell_arr, head_offset=0):
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


palette = load_palette(PALETTE_PATH)
sheet = np.zeros((ROWS * CELL_SIZE, COLS * CELL_SIZE), dtype=np.uint8)

frames = [(0, 0, 0), (0, 1, 1), (0, 2, 0), (1, 0, 1)]
for sr, sc, ho in frames:
    y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
    draw_figure(sheet[y0:y0 + CELL_SIZE, x0:x0 + CELL_SIZE], head_offset=ho)

img = Image.fromarray(sheet, mode="P")
flat = [0] * (256 * 3)
for i, (r, g, b) in enumerate(palette):
    flat[3 * i], flat[3 * i + 1], flat[3 * i + 2] = r, g, b
img.putpalette(flat)

OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT_PATH)
print(f"wrote {OUT_PATH}")
print(f"size={img.size} mode={img.mode}")
