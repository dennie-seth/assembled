#!/usr/bin/env python3
"""Manual, NOT-CI end-to-end proof-of-plumbing run for the art pipeline
(feature/art-pipeline-e2e). Like `live_smoke.py`, never invoked by pytest
or CI.

Chain exercised: approved concept sheet (already committed, already fed
T-0105) -> generate a Signal Tower concrete wall tile via SDXL -> descend
(box downscale -> Oklab quantize -> orphan cleanup, T-0073) -> commit the
final 16px indexed tile + a provenance sidecar to `assets/final/tiles/`.
The validation gate (`tools/asset-gate`, a separate self-contained
package) is invoked afterwards by CLI, not from this script -- see the
branch's top-level report for the pass/fail results.

Usage (from tools/comfy-client, with the venv set up):

    .venv/bin/python scripts/e2e_wall_tile.py
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from comfy_client.base_url import resolve_base_url
from comfy_client.descend import descend
from comfy_client.palette import load_palette_lut
from comfy_client.pipeline import generate
from comfy_client.provenance import provenance_to_dict
from comfy_client.recipe import Recipe

PALETTE_PATH = Path("assets/final/palette/home_palette.json")
RAW_OUT_DIR = Path("assets/out/tiles")
FINAL_DIR = Path("assets/final/tiles")
TARGET_SIZE = 16

PROMPT = (
    "flat brutalist concrete wall texture, straight-on orthographic surface "
    "photograph, uniform tileable pattern, muted concrete grey with subtle "
    "oxide rust stains and institutional green patina, weathered stained "
    "surface detail, interior industrial concrete panel, even lighting, no border"
)
NEGATIVE_PROMPT = (
    "perspective, three-quarter view, isometric, vanishing point, vignette, "
    "frame border, sky, floor, furniture, equipment, control panel, "
    "machinery, character, creature, text, watermark, blurry, low quality, "
    "gradient, depth of field"
)


def main() -> int:
    base_url = resolve_base_url()
    print(f"resolved ComfyUI base URL: {base_url}")

    palette = load_palette_lut(PALETTE_PATH)
    print(f"loaded locked home palette: {len(palette)} slots from {PALETTE_PATH}")

    recipe = Recipe(
        prompt=PROMPT,
        negative_prompt=NEGATIVE_PROMPT,
        seed=4201,
        steps=30,
        cfg=7.0,
        width=1024,
        height=1024,
        name="signal_tower_concrete_wall",
    )

    print(f"generating raw tile (seed={recipe.seed}) ...")
    result = generate(recipe, out_dir=RAW_OUT_DIR, timeout=300.0)
    print(f"  raw -> {result.path}")
    print(f"  prompt_id: {result.prompt_id}")

    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    final_path = FINAL_DIR / f"{recipe.name}_16px.png"
    print(f"descending {result.path} -> {final_path} (target_size={TARGET_SIZE}) ...")
    # background_index=None: a base-field tile is opaque by design (§3.4/§3.7).
    # A transparent floor tile is a hole in the world, not a cutout.
    descend(
        result.path,
        palette=palette,
        target_size=TARGET_SIZE,
        out_path=final_path,
        background_index=None,
    )
    print(f"  final -> {final_path}")

    palette_bytes = PALETTE_PATH.read_bytes()
    palette_hash = hashlib.sha256(palette_bytes).hexdigest()
    palette_def = json.loads(palette_bytes)

    provenance = provenance_to_dict(result.provenance)
    provenance["descend"] = {
        "target_size": TARGET_SIZE,
        "raw_path": str(result.path),
        "chain": "box_downscale -> oklab_quantize -> orphan_cleanup (T-0073)",
    }
    provenance["palette_source"] = f"{PALETTE_PATH.as_posix()} (sha256:{palette_hash})"
    provenance["palette_lineage"] = palette_def.get("source")

    provenance_path = final_path.parent / f"{final_path.stem}.provenance.json"
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"  provenance -> {provenance_path}")

    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
