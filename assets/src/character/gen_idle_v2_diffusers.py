#!/usr/bin/env python3
"""Generate player_idle_sheet_v2.png via SDXL img2img conditioned on the T-0209 concept sheet.

T-0212: concept-conditioned re-run of T-0198 (archetype-first coherence guard, T-0106 path).
Uses diffusers StableDiffusionXLImg2ImgPipeline + the LoRA from assets/final/lora/.
Run with the WSL-native lora-train-venv (~/dev/lora-train-venv) — it has torch+cu121 and
diffusers==0.32.1.

Usage (from the worktree root):
    ~/dev/lora-train-venv/bin/python assets/src/character/gen_idle_v2_diffusers.py

Writes:
    assets/out/player_idle_sheet_v2_raw.png     raw 1152x1152 SDXL output
    assets/final/character/player_idle_sheet_v2.png   descended 144x144 indexed
    assets/final/character/player_idle_sheet_v2.provenance.json  updated provenance

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) + §6 (archetype-first
coherence guard).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

CONCEPT_SHEET = REPO_ROOT / "assets/src/concept/player_character_concept_sheet_v1.png"
CHECKPOINT = Path("/mnt/f/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors")
LORA_PATH = REPO_ROOT / "assets/final/lora/soviet_brutalism_style_v1.safetensors"
RAW_OUT = REPO_ROOT / "assets/out/player_idle_sheet_v2_raw.png"
FINAL_OUT = REPO_ROOT / "assets/final/character/player_idle_sheet_v2.png"
PROVENANCE_OUT = REPO_ROOT / "assets/final/character/player_idle_sheet_v2.provenance.json"
PALETTE_PATH = REPO_ROOT / "assets/final/palette/home_palette.json"

# Recipe parameters (player_idle_sheet_v2.recipe.json)
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
STRENGTH = 0.7   # img2img denoise (= 1 - init_image_strength)
WIDTH = 1152
HEIGHT = 1152
LORA_WEIGHT = 0.70
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"


def _verify_concept_hash() -> str:
    data = CONCEPT_SHEET.read_bytes()
    got = hashlib.sha256(data).hexdigest()
    if got != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet SHA-256 mismatch:\n  got: {got}\n  want: {EXPECTED_CONCEPT_HASH}\n"
            "Verify assets/src/concept/player_character_concept_sheet_v1.png is the T-0209 sheet."
        )
    return got


def _load_palette() -> list[tuple[int, int, int]]:
    # Add comfy-client to path so we can use its palette loader
    comfy_client_src = REPO_ROOT / "tools/comfy-client/src"
    if str(comfy_client_src) not in sys.path:
        sys.path.insert(0, str(comfy_client_src))
    from comfy_client.palette import load_palette_lut  # noqa: PLC0415
    return load_palette_lut(PALETTE_PATH)


def main() -> None:
    import torch
    from PIL import Image

    # Add comfy-client to path for descent chain
    comfy_client_src = REPO_ROOT / "tools/comfy-client/src"
    if str(comfy_client_src) not in sys.path:
        sys.path.insert(0, str(comfy_client_src))
    from comfy_client.descend import descend  # noqa: PLC0415

    # 1. Verify the T-0209 concept sheet hash before touching any model
    print("Verifying T-0209 concept sheet hash...")
    concept_hash = _verify_concept_hash()
    print(f"  concept_hash: {concept_hash}  OK")

    if not CHECKPOINT.exists():
        raise FileNotFoundError(
            f"SDXL checkpoint not found: {CHECKPOINT}\n"
            "Ensure ComfyUI is installed at F:\\ComfyUI and the checkpoint exists."
        )
    if not LORA_PATH.exists():
        raise FileNotFoundError(
            f"LoRA not found: {LORA_PATH}\n"
            "Run the T-0072 full training pass to produce soviet_brutalism_style_v1.safetensors."
        )

    # 2. Load SDXL img2img pipeline
    print("Loading StableDiffusionXLImg2ImgPipeline from single file (this takes ~30s)...")
    from diffusers import StableDiffusionXLImg2ImgPipeline  # noqa: PLC0415

    pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(
        str(CHECKPOINT),
        torch_dtype=torch.float16,
        use_safetensors=True,
        variant="fp16",
    )
    # CPU offload to stay within 8GB VRAM on the RTX 3070 Ti
    pipe.enable_model_cpu_offload()
    pipe.enable_vae_slicing()
    print("  pipeline loaded.")

    # 3. Load LoRA
    print(f"Loading LoRA: {LORA_PATH.name} (weight={LORA_WEIGHT})...")
    pipe.load_lora_weights(str(LORA_PATH), adapter_name="soviet_brutalism")
    pipe.set_adapters(["soviet_brutalism"], adapter_weights=[LORA_WEIGHT])
    print("  LoRA loaded.")

    # 4. Load concept sheet as init image (resize to generation resolution)
    print(f"Loading concept sheet: {CONCEPT_SHEET.name}, resizing to {WIDTH}x{HEIGHT}...")
    concept_img = Image.open(CONCEPT_SHEET).convert("RGB").resize(
        (WIDTH, HEIGHT), Image.LANCZOS
    )
    print("  done.")

    # 5. Generate
    print(
        f"Generating: seed={SEED}, steps={STEPS}, cfg={CFG}, "
        f"strength={STRENGTH} (img2img denoise)..."
    )
    generator = torch.Generator(device="cpu").manual_seed(SEED)
    result = pipe(
        prompt=PROMPT,
        negative_prompt=NEGATIVE_PROMPT,
        image=concept_img,
        strength=STRENGTH,
        num_inference_steps=STEPS,
        guidance_scale=CFG,
        generator=generator,
    )
    raw_img: Image.Image = result.images[0]

    RAW_OUT.parent.mkdir(parents=True, exist_ok=True)
    raw_img.save(RAW_OUT)
    print(f"  raw output saved: {RAW_OUT}  size={raw_img.size}")

    # 6. Descent chain: 1152x1152 → 144x144 indexed palette
    print("Running descent chain: box downscale → Oklab palette quantize → orphan cleanup...")
    palette = _load_palette()
    FINAL_OUT.parent.mkdir(parents=True, exist_ok=True)
    descended = descend(raw_path=RAW_OUT, palette=palette, target_size=144, out_path=FINAL_OUT)
    print(f"  descended: {descended}")

    # 7. Write provenance JSON (replaces the synthetic placeholder provenance)
    prov = {
        "model": (
            "sd_xl_base_1.0.safetensors + LoRA soviet_brutalism_style_v1.safetensors "
            f"(weight {LORA_WEIGHT})"
        ),
        "model_license": "CreativeML Open RAIL++-M (base) / CreativeML OpenRAIL++-M (LoRA)",
        "model_hash": None,  # hashing the 7GB checkpoint would take too long at runtime
        "prompt": PROMPT,
        "negative_prompt": NEGATIVE_PROMPT,
        "seed": SEED,
        "steps": STEPS,
        "cfg": CFG,
        "width": WIDTH,
        "height": HEIGHT,
        "concept_hash": concept_hash,
        "concept_source": str(CONCEPT_SHEET.relative_to(REPO_ROOT)),
        "concept_card": "T-0209",
        "method": (
            "img2img concept-conditioned via diffusers StableDiffusionXLImg2ImgPipeline "
            f"(strength={STRENGTH}); T-0106 archetype-first coherence guard. "
            "IP-Adapter weights not installed in WSL venv — img2img conditioning used alone."
        ),
        "img2img_denoise": STRENGTH,
        "lora_name": "soviet_brutalism_style_v1.safetensors",
        "lora_weight": LORA_WEIGHT,
        "lora_license": "CreativeML OpenRAIL++-M",
        "generator": "assets/src/character/gen_idle_v2_diffusers.py",
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
    print(f"  provenance written: {PROVENANCE_OUT}")
    print("\nDone. Run gate tests:")
    print(f"  cd {REPO_ROOT / 'assets/src/character'}")
    print("  .venv/bin/pytest tests/test_player_idle_v2_gate.py -v")


if __name__ == "__main__":
    main()
