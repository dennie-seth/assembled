#!/usr/bin/env python3
"""T-0167 LoRA handshake — generate signal_tower_material_sheet_lora.png.

Regenerates the approved Signal Tower material sheet (signal_tower_material_sheet.png)
through the T-0072 style LoRA (soviet_brutalism_style_v1) using the same prompt,
seed, and conditioning template as the original to isolate the LoRA's effect.
Per 13-asset-pipeline.md §6.5.

Prerequisites:
  1. ComfyUI running and reachable (see docs/comfyui-setup.md).
     Default URL: http://172.18.192.1:8188 (WSL gateway to Windows host).
     Override with COMFYUI_BASE_URL env var.
  2. soviet_brutalism_style_v1.safetensors in ComfyUI's models/loras/ directory.
  3. comfy-client and gen-client-base installed in a venv:
       cd tools/comfy-client && pip install -e ".[dev]"
       cd tools/gen-client-base && pip install -e ".[dev]"

Usage (from repo root, inside the comfy-client venv):
  python assets/src/lora_handshake/run_handshake.py

Outputs (committed, not gitignored):
  assets/src/concept/signal_tower_material_sheet_lora.png
  assets/src/concept/signal_tower_material_sheet_lora.provenance.json

After generation, update ASSET_PROVENANCE.md (replace the PENDING row) and
record the visual comparison result in docs/decision-log.md DL-15.
"""

from __future__ import annotations

import json
import pathlib
import sys

REPO = pathlib.Path(__file__).parents[3]
RECIPE_PATH = REPO / "assets/src/concept/signal_tower_material_sheet_lora.recipe.json"
INIT_IMAGE_PATH = REPO / "assets/src/concept/signal_tower_material_template.png"
BASE_CONCEPT_PATH = REPO / "assets/src/concept/signal_tower_material_sheet.png"
OUT_DIR = REPO / "assets/src/concept"


def main() -> int:
    # Import here so the script is importable for inspection even without the venv.
    try:
        from comfy_client.base_url import resolve_base_url
        from comfy_client.concept import generate_concept_conditioned_lora
        from comfy_client.recipe import Recipe
    except ImportError as exc:
        print(f"ERROR: comfy-client not installed — {exc}", file=sys.stderr)
        print(
            "Install with: cd tools/comfy-client && pip install -e .[dev]",
            file=sys.stderr,
        )
        return 1

    raw = json.loads(RECIPE_PATH.read_text())

    recipe = Recipe(
        prompt=raw["prompt"],
        negative_prompt=raw["negative_prompt"],
        seed=raw["seed"],
        steps=raw["steps"],
        cfg=raw["cfg"],
        width=raw["width"],
        height=raw["height"],
        checkpoint=raw["checkpoint"],
        sampler=raw.get("sampler", "euler"),
        scheduler=raw.get("scheduler", "normal"),
        denoise=raw["denoise"],
        name="signal_tower_material_sheet_lora",
    )

    lora_name = raw["lora_name"]
    lora_weight = raw["lora_weight"]
    lora_license = "CreativeML Open RAIL++-M"

    base_url = resolve_base_url()
    print(f"ComfyUI URL: {base_url}")
    print(f"Generating: {recipe.name} (seed={recipe.seed}, denoise={recipe.denoise})")
    print(f"  LoRA: {lora_name} @ {lora_weight}")
    print(f"  init: {INIT_IMAGE_PATH.name}")
    print(f"  compare against: {BASE_CONCEPT_PATH.name}")

    result = generate_concept_conditioned_lora(
        recipe,
        init_image_path=INIT_IMAGE_PATH,
        lora_name=lora_name,
        lora_weight=lora_weight,
        lora_license=lora_license,
        base_concept_path=BASE_CONCEPT_PATH,
        out_dir=OUT_DIR,
        timeout=600.0,
    )

    print(f"Generated: {result.path}")
    print(f"prompt_id: {result.prompt_id}")
    print(f"lora_name: {result.provenance.lora_name}")
    print(f"base_concept_hash: {result.provenance.base_concept_hash}")
    print(f"concept_hash (template): {result.provenance.concept_hash}")
    print()
    print("Next steps:")
    print("  1. Visually compare the generated PNG against the original:")
    print(f"     {BASE_CONCEPT_PATH}")
    print("  2. Update ASSET_PROVENANCE.md: replace the PENDING row with real data.")
    print("  3. Update docs/decision-log.md DL-15 with the actual comparison result.")
    print("  4. git add + commit the PNG, provenance JSON, updated MD files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
