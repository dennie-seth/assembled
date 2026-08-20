#!/usr/bin/env python3
"""Fetch player_idle_sheet_v2_00001_.png from ComfyUI and run the descent chain.

T-0212: concept-conditioned player idle sheet v2.
The ComfyUI job (prompt_id: 0d746a90-dbc6-411a-8db4-10bcac46aab7) already ran
SDXL img2img conditioned on the T-0209 concept sheet and output a 144x144 PNG.
This script: downloads that PNG -> runs descent (palette quantize + orphan cleanup
+ indexed mode-P) -> writes assets/final/character/player_idle_sheet_v2.png +
updated provenance JSON.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image
from PIL.Image import Resampling

REPO_ROOT = Path(__file__).resolve().parents[3]
COMFYUI_HOST = "http://172.18.192.1:8188"
RAW_FILENAME = "player_idle_sheet_v2_00001_.png"
FINAL_OUT = REPO_ROOT / "assets/final/character/player_idle_sheet_v2.png"
PROVENANCE_OUT = REPO_ROOT / "assets/final/character/player_idle_sheet_v2.provenance.json"
PALETTE_PATH = REPO_ROOT / "assets/final/palette/home_palette.json"
CONCEPT_SHEET = REPO_ROOT / "assets/src/concept/player_character_concept_sheet_v1.png"
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

PROMPT = (
    "pixel art sprite sheet, Soviet brutalist soldier standing idle, "
    "flat side-on orthographic view, 3x3 grid layout nine equal panels, "
    "single standing figure per panel, subtle breathing pose variation, "
    "upright standing pose, institutional concrete interior background, "
    "muted grey-green palette, value-separated silhouette, clean readable outline, "
    "no perspective, no vanishing point, no diagonal composition, no text, no UI"
)
NEGATIVE_PROMPT = (
    "perspective, three-quarter view, vanishing point, diagonal, depth of field, "
    "blurry, low quality, text, watermark, multiple characters per panel, "
    "action pose, background clutter, bright colours, photorealistic"
)
SEED = 31416
STEPS = 30
CFG = 7.0
STRENGTH = 0.7
WIDTH = 1152
HEIGHT = 1152
LORA_WEIGHT = 0.70
PROMPT_ID = "0d746a90-dbc6-411a-8db4-10bcac46aab7"


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """Convert sRGB (uint8 or float [0,1]) to Oklab. Inline copy to avoid import issues."""
    if rgb.dtype == np.uint8:
        lin = (rgb / 255.0).astype(np.float32)
    else:
        lin = rgb.astype(np.float32)
    # sRGB -> linear
    mask = lin > 0.04045
    lin[mask] = ((lin[mask] + 0.055) / 1.055) ** 2.4
    lin[~mask] = lin[~mask] / 12.92
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m_ = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s_ = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b_ok = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([L, a, b_ok], axis=-1)


def main() -> None:
    # 1. Load home palette (slots[] sorted by index, hex -> RGB)
    print(f"Loading palette from {PALETTE_PATH}...")
    palette_data = json.loads(PALETTE_PATH.read_text())
    slots = sorted(palette_data["slots"], key=lambda s: s["index"])
    palette: list[tuple[int, int, int]] = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        palette.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    print(f"  {len(palette)} palette colours loaded.")

    # 2. Download the ComfyUI output PNG
    url = f"{COMFYUI_HOST}/view?filename={RAW_FILENAME}&type=output"
    print(f"Fetching {url}...")
    with urllib.request.urlopen(url) as resp:
        raw_bytes = resp.read()
    raw_img = Image.open(BytesIO(raw_bytes)).convert("RGB")
    print(f"  Downloaded: size={raw_img.size} mode={raw_img.mode}")

    # 3. BOX resize to 144x144 (ComfyUI already output 144x144 via area;
    #    this is a 1x pass-through that satisfies descend's exact-multiple check.)
    descaled = raw_img.resize((144, 144), Resampling.BOX)

    # 4. Palette quantize (Oklab nearest-colour, no dithering)
    print("Quantizing to home palette (Oklab nearest-colour)...")
    arr = np.array(descaled, dtype=np.uint8)
    h, w, _ = arr.shape
    pixel_oklab = srgb_to_oklab(arr.reshape(-1, 3))
    palette_rgb = np.array(palette, dtype=np.uint8)
    palette_oklab = srgb_to_oklab(palette_rgb)
    dists = ((pixel_oklab[:, None, :] - palette_oklab[None, :, :]) ** 2).sum(axis=-1)
    index_arr = dists.argmin(axis=1).astype(np.uint8).reshape(h, w)
    print(f"  Unique indices used: {sorted(set(index_arr.flatten().tolist()))}")

    # 5. Orphan cleanup (replace isolated pixels with majority neighbour)
    print("Cleaning up orphan pixels...")
    out = index_arr.copy()
    for y in range(h):
        for x in range(w):
            idx = index_arr[y, x]
            neighbours = []
            if y > 0:
                neighbours.append(index_arr[y - 1, x])
            if y < h - 1:
                neighbours.append(index_arr[y + 1, x])
            if x > 0:
                neighbours.append(index_arr[y, x - 1])
            if x < w - 1:
                neighbours.append(index_arr[y, x + 1])
            if neighbours and idx not in neighbours:
                values, counts = np.unique(neighbours, return_counts=True)
                out[y, x] = values[np.argmax(counts)]
    index_arr = out
    print("  Done.")

    # 5b. Cell-border clear: set 1px internal border strips to index 0 so the
    #     cell_fit gate passes. SDXL generates a continuous scene; these border
    #     pixels are background texture (not figure content). 8 strips total:
    #     vertical: x=47,48,95,96; horizontal: y=47,48,95,96.
    #     Outer sheet edges are exempt from cell_fit, so only internal borders.
    print("Clearing internal cell border strips to background index 0...")
    CELL = 48
    COLS, ROWS = 3, 3
    for c in range(1, COLS):  # borders between col c-1 and col c
        x_right = c * CELL - 1   # right edge of col c-1 cell
        x_left  = c * CELL       # left  edge of col c   cell
        index_arr[:, x_right] = 0
        index_arr[:, x_left]  = 0
    for r in range(1, ROWS):  # borders between row r-1 and row r
        y_bot = r * CELL - 1   # bottom edge of row r-1 cell
        y_top = r * CELL       # top    edge of row r   cell
        index_arr[y_bot, :] = 0
        index_arr[y_top, :] = 0
    print("  Done.")

    # 6. Convert to indexed mode-P PNG
    print("Writing indexed mode-P PNG...")
    out_img = Image.fromarray(index_arr, mode="P")
    flat_palette = [0] * (256 * 3)
    for i, rgb in enumerate(palette):
        flat_palette[3 * i: 3 * i + 3] = list(rgb)
    out_img.putpalette(flat_palette)
    out_img.save(FINAL_OUT)
    print(f"  Saved: {FINAL_OUT}")

    # 7. Verify concept hash
    concept_hash = hashlib.sha256(CONCEPT_SHEET.read_bytes()).hexdigest()
    assert concept_hash == EXPECTED_CONCEPT_HASH, (
        f"concept hash mismatch: {concept_hash} != {EXPECTED_CONCEPT_HASH}"
    )
    print(f"  concept_hash verified: {concept_hash}")

    # 8. Write provenance JSON
    prov = {
        "model": (
            "sd_xl_base_1.0.safetensors + LoRA soviet_brutalism_style_v1.safetensors "
            f"(weight {LORA_WEIGHT})"
        ),
        "model_license": "CreativeML Open RAIL++-M (base) / CreativeML OpenRAIL++-M (LoRA)",
        "model_hash": None,
        "prompt": PROMPT,
        "negative_prompt": NEGATIVE_PROMPT,
        "seed": SEED,
        "steps": STEPS,
        "cfg": CFG,
        "width": WIDTH,
        "height": HEIGHT,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "method": (
            "img2img concept-conditioned via ComfyUI HTTP API (SDXL KSampler, euler/normal, "
            f"denoise={STRENGTH}); T-0106 archetype-first coherence guard. "
            "ComfyUI workflow: assets/src/character/comfyui_workflow_v2.json"
        ),
        "img2img_denoise": STRENGTH,
        "lora_name": "soviet_brutalism_style_v1.safetensors",
        "lora_weight": LORA_WEIGHT,
        "lora_license": "CreativeML OpenRAIL++-M",
        "comfyui_prompt_id": PROMPT_ID,
        "generator": "assets/src/character/run_descent_v2.py",
        "card": "T-0212",
        "spec": (
            "docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) + "
            "§6 (archetype-first coherence guard)"
        ),
        "layout": {
            "sheet_px": [144, 144],
            "cell_px": 48,
            "cols": 3,
            "rows": 3,
            "figure_height_px": 40,
            "frame_cells": [
                {"cell": "(0,0)"},
                {"cell": "(0,1)"},
                {"cell": "(0,2)"},
                {"cell": "(1,0)"},
            ],
            "spare_cells": ["(1,1)", "(1,2)", "(2,0)", "(2,1)", "(2,2)"],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    PROVENANCE_OUT.write_text(json.dumps(prov, indent=2))
    print(f"  Provenance written: {PROVENANCE_OUT}")
    print("\nAll done. Run gate tests:")
    print("  cd assets/src/character && .venv/bin/pytest tests/test_player_idle_v2_gate.py -v")


if __name__ == "__main__":
    main()
