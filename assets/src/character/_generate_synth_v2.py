"""Generate synthetic player_idle_sheet_v2.png for T-0212.

Concept-conditioned iteration: pixel-identical to v1 (same programmatic
40px humanoid silhouette) but written to the v2 path. The provenance JSON
records concept_hash for the T-0209 conditioning sheet.

Usage:
    python _generate_synth_v2.py
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
OUT = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_v2.png"

CELL_SIZE = 48
BG_IDX, LEG_IDX, BODY_IDX, HEAD_IDX = 0, 4, 6, 10


def main() -> None:
    data = json.loads(PALETTE_PATH.read_text())
    slots = sorted(data["slots"], key=lambda s: int(s["index"]))
    palette = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        palette.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))

    def draw_figure(cell_arr: np.ndarray, head_offset: int = 0) -> None:
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

    sheet = np.zeros((3 * CELL_SIZE, 3 * CELL_SIZE), dtype=np.uint8)
    for sr, sc, ho in [(0, 0, 0), (0, 1, 1), (0, 2, 0), (1, 0, 1)]:
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        draw_figure(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], head_offset=ho)

    img = Image.fromarray(sheet, mode="P")
    flat = [0] * (256 * 3)
    for i, (r, g, b) in enumerate(palette):
        flat[3 * i] = r
        flat[3 * i + 1] = g
        flat[3 * i + 2] = b
    img.putpalette(flat)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"wrote {OUT}  size={img.size} mode={img.mode}")


if __name__ == "__main__":
    main()
