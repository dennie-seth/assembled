"""Player character concept sheet generator for T-0209.

Generates player_character_concept_sheet_v1.png via the shared
comfy-client / gen-client-base plumbing (T-0104 workflow, §6.9 of
docs/design/13-asset-pipeline.md).  Uses generate_concept_lora from
comfy_client.concept, which enforces the license-allowlist gate via
gen_client_base.license_allowlist.assert_checkpoint_allowed before any
network call is made.

Prerequisites:
  1. ComfyUI running and reachable (see docs/comfyui-setup.md).
     Default URL resolved from the current WSL default route + port 8188.
     Override with COMFYUI_BASE_URL env var.
  2. soviet_brutalism_style_v1.safetensors in ComfyUI's models/loras/ directory.
  3. comfy-client and gen-client-base installed in a venv:
       cd tools/comfy-client && pip install -e ".[dev]"
       cd tools/gen-client-base && pip install -e ".[dev]"
  4. The checkpoint (sd_xl_base_1.0.safetensors) reachable at CHECKPOINT_DIR
     (default /mnt/f/ComfyUI/models/checkpoints, same as
     scripts/backfill_model_hash.py) so model_hash can be computed
     (HANDOFF §21 / T-0151) -- override with the CHECKPOINT_DIR env var.

Usage (from repo root, inside the comfy-client venv):
  python assets/src/concept/_run_sdxl_generation.py

Outputs (committed, not gitignored):
  assets/src/concept/player_character_concept_sheet_v1.png
  assets/src/concept/player_character_concept_sheet_v1.provenance.json
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[3]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
RECIPE_PATH = CONCEPT_DIR / "player_character_concept_sheet_v1.recipe.json"
DEFAULT_CHECKPOINT_DIR = "/mnt/f/ComfyUI/models/checkpoints"


def main() -> int:
    try:
        from comfy_client.base_url import resolve_base_url
        from comfy_client.concept import generate_concept_lora
        from comfy_client.recipe import Recipe
    except ImportError as exc:
        print(f"ERROR: comfy-client not installed — {exc}", file=sys.stderr)
        print(
            "Install with:\n"
            "  cd tools/comfy-client && pip install -e .[dev]\n"
            "  cd tools/gen-client-base && pip install -e .[dev]",
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
        name=raw["name"],
    )

    lora_name = raw["lora"]
    lora_weight = raw["lora_weight"]
    lora_license = "CreativeML OpenRAIL++-M"

    checkpoint_dir = os.environ.get("CHECKPOINT_DIR", DEFAULT_CHECKPOINT_DIR)

    base_url = resolve_base_url()
    print(f"ComfyUI URL: {base_url}")
    print(f"Generating: {recipe.name} (seed={recipe.seed})")
    print(f"  LoRA: {lora_name} @ {lora_weight}")
    print(f"  Checkpoint dir: {checkpoint_dir}")

    result = generate_concept_lora(
        recipe,
        lora_name=lora_name,
        lora_weight=lora_weight,
        lora_license=lora_license,
        out_dir=CONCEPT_DIR,
        timeout=600.0,
        checkpoint_dir=checkpoint_dir,
    )

    print(f"Generated: {result.path}")
    print(f"prompt_id: {result.prompt_id}")
    print(f"concept_hash: {result.provenance.concept_hash}")
    print(f"lora_name: {result.provenance.lora_name}")
    print()
    print("Next steps:")
    print("  1. Visually inspect the generated PNG.")
    print("  2. git add + commit the PNG and provenance JSON.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
