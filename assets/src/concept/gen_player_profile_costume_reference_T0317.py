#!/usr/bin/env python3
"""Green-costume side-profile reference generator (T-0317).

**Why this is a genuinely different bet from T-0272's own §24-e stack, not a
repeat of it.** T-0272 spent 36 attempts across 5 rounds proving that the
combination ControlNet(skeleton) + IP-Adapter(front sheet) cannot hold both a
side-facing pose and legible institutional-green costume colour at once --
round 3's own finding is that ControlNet's structural conditioning dominates
the text prompt's camera-angle request, so a prompt-only reframe "cannot work
by construction" against that stack. This generator carries **neither**
ControlNet nor IP-Adapter: plain txt2img + the style LoRA only, exactly the
stack `player_character_concept_sheet_v1.recipe.json` (T-0209) itself used.
Prompt steering therefore has authority here it never had under §24-e.

The concept sheet's own rightmost column already proves the *side view* half
of this is reachable from this generator (T-0272 round 5's own measurement:
genuine side/three-quarter panels exist there, just in the grey/tan
tactical-variant costume tier at 1.0-1.7% green, not the green cloth coat's
6,000-6,900 green-pixel band). What is unproven is steering the *costume
tier* of a side panel -- this script's whole job.

Reuses `gen_arm_a_idle_T0228`'s checkpoint/LoRA identifiers and stdlib-only
(urllib) ComfyUI HTTP helpers directly (submit/poll/fetch/upload), the same
family convention `gen_hybrid_profile_T0272.py`'s own docstring names --
never a shared parametrised generator, but plain reuse via import.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/concept/gen_player_profile_costume_reference_T0317.py --attempt 1 --seed 31700
    python3 assets/src/concept/gen_player_profile_costume_reference_T0317.py --promote-attempt 1

Writes (always, so every attempt is logged whether it is promoted or not):
    assets/out/costume_reference/attempt_<N>/main_1024.png
    assets/out/costume_reference/attempt_<N>/provenance_candidate.json
    assets/src/concept/ARM_COSTUME_REFERENCE_ATTEMPT_LOG_T0317.md (appended)

Promotion writes the committed deliverable:
    assets/src/concept/player_profile_costume_reference_T0317.png
    assets/src/concept/player_profile_costume_reference_T0317.provenance.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "assets" / "src" / "character"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    fetch_save_image,
    sha256_of,
    submit_prompt,
    wait_for_completion,
)
from green_content import count_green_pixels  # noqa: E402

GEN_PX = 1024  # matches player_character_concept_sheet_v1.recipe.json's 1024x1024

# T-0272 round 5's own calibration crop of the front sheet's confirmed
# green-coat panel (IDENTITY_REFERENCE_CROP_BOX in gen_hybrid_walk_T0259.py):
# 187x200px. This generator's single figure fills much more of a 1024x1024
# canvas than one panel of a 4-panel sheet, so a same-size crop centred on
# the figure -- not the raw whole-frame count -- is what is comparable to
# that benchmark.
GREEN_MEASURE_CROP_SIZE = (187, 200)

STYLE_LORA_WEIGHT = 0.70  # matches T-0209's own recipe

POSITIVE_PROMPT = (
    "flat side-on character concept reference panel, orthographic game asset, "
    "no perspective, no vanishing point, single reference panel, one figure only, "
    "full body side profile pose, exactly one shoulder visible, one arm forward, "
    "profile silhouette of the head and face turned to the side. Player character: "
    "40px tall humanoid figure in a 48x48 cell, wearing a long institutional green "
    "cloth coat, hooded, white gloves, concrete-grey head and skin tones, deep "
    "shadow values, vivid saturated institutional green coat colour covering the "
    "torso and legs of the coat. Soviet brutalist interior aesthetic, muted "
    "desaturated palette everywhere except the coat's own vivid green, hard value "
    "separation, dark darks and light lights, flat even lighting, no atmospheric "
    "haze, no depth of field, no scene composition, no background elements, solid "
    "flat black background. Game asset reference panel style, pixel art scale "
    "reference, side-view figure silhouette study"
)

NEGATIVE_PROMPT = (
    "front view, facing the camera, symmetric front-facing pose, three-quarter "
    "view, back view, both shoulders equally visible, "
    "grey tactical costume, tan tactical costume, khaki uniform, army fatigues, "
    "muted olive costume, brownish coat, washed out colour, pale colour, "
    "desaturated coat, grayscale, "
    "perspective, vanishing point, isometric, receding walls, atmospheric haze, "
    "depth of field, sky, clouds, foliage, scene, composed illustration, "
    "photorealistic, 3d render, soft gradient lighting, ambient occlusion, "
    "painterly, cartoon, cheerful, multiple figures, two figures, text, "
    "watermark, signature, blurry, low quality"
)

# ── Graph node ids -- named, not raw string literals re-derived per call ────
CHECKPOINT_NODE_ID = "1"
STYLE_LORA_NODE_ID = "2"
POSITIVE_PROMPT_NODE_ID = "3"
NEGATIVE_PROMPT_NODE_ID = "4"
LATENT_NODE_ID = "5"
SAMPLER_NODE_ID = "6"
VAE_DECODE_NODE_ID = "7"
SAVE_NODE_ID = "8"


def build_positive_prompt() -> str:
    return POSITIVE_PROMPT


def build_negative_prompt() -> str:
    return NEGATIVE_PROMPT


def build_graph(seed: int, style_lora_weight: float = STYLE_LORA_WEIGHT) -> dict:
    """Plain txt2img + style LoRA -- no ControlNet, no IP-Adapter, no identity/
    pose LoRA. See module docstring for why the absence of those two nodes is
    this script's entire premise, not an oversight."""
    g: dict = {}
    g[CHECKPOINT_NODE_ID] = {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": CHECKPOINT},
    }
    g[STYLE_LORA_NODE_ID] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": [CHECKPOINT_NODE_ID, 0],
            "clip": [CHECKPOINT_NODE_ID, 1],
            "lora_name": LORA_NAME,
            "strength_model": style_lora_weight,
            "strength_clip": style_lora_weight,
        },
    }
    g[POSITIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": build_positive_prompt(), "clip": [STYLE_LORA_NODE_ID, 1]},
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": build_negative_prompt(), "clip": [STYLE_LORA_NODE_ID, 1]},
    }
    g[LATENT_NODE_ID] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": GEN_PX, "height": GEN_PX, "batch_size": 1},
    }
    g[SAMPLER_NODE_ID] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [STYLE_LORA_NODE_ID, 0],
            "positive": [POSITIVE_PROMPT_NODE_ID, 0],
            "negative": [NEGATIVE_PROMPT_NODE_ID, 0],
            "latent_image": [LATENT_NODE_ID, 0],
            "seed": seed,
            "steps": 30,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    g[VAE_DECODE_NODE_ID] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": [SAMPLER_NODE_ID, 0], "vae": [CHECKPOINT_NODE_ID, 2]},
    }
    g[SAVE_NODE_ID] = {
        "class_type": "SaveImage",
        "inputs": {
            "filename_prefix": "costume_reference_T0317_main_1024",
            "images": [VAE_DECODE_NODE_ID, 0],
        },
    }
    return g


def measure_green_content(image: Image.Image) -> dict:
    """Whole-frame count plus a centred crop the same size as T-0272 round
    5's own front-panel calibration crop (187x200) -- see
    `GREEN_MEASURE_CROP_SIZE`'s own comment for why raw whole-frame counts
    are not directly comparable to that benchmark."""
    w, h = image.size
    cw, ch = GREEN_MEASURE_CROP_SIZE
    cw, ch = min(cw, w), min(ch, h)
    left = (w - cw) // 2
    upper = (h - ch) // 2
    crop_box = (left, upper, left + cw, upper + ch)
    return {
        "whole_frame_green_pixels": count_green_pixels(image),
        "centred_crop_green_pixels": count_green_pixels(image, crop=crop_box),
        "centred_crop_box": list(crop_box),
        "benchmark_green_band": [6000, 6900],
        "benchmark_noise_floor_fraction": [0.010, 0.017],
    }


ATTEMPT_LOG_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "ARM_COSTUME_REFERENCE_ATTEMPT_LOG_T0317.md"
)
FINAL_PATH = REPO_ROOT / "assets" / "src" / "concept" / "player_profile_costume_reference_T0317.png"
FINAL_PROVENANCE_PATH = (
    REPO_ROOT
    / "assets"
    / "src"
    / "concept"
    / "player_profile_costume_reference_T0317.provenance.json"
)

ATTEMPT_LOG_HEADER = (
    "# Green-costume side-profile reference attempt log (T-0317)\n\n"
    "Every attempt is recorded here whether promoted or not. This generator carries "
    "neither ControlNet nor IP-Adapter (see the generator module's own docstring for "
    "why that is the whole point) -- plain txt2img + style LoRA only, same stack as "
    "T-0209's own concept sheet. `green_content` measures both the whole frame and a "
    "centred crop the same size as T-0272 round 5's own front-panel calibration crop "
    "(187x200), against that round's recorded 6,000-6,900 green-pixel band.\n\n"
    "| Attempt | Seed | Style LoRA weight | GPU seconds | Whole-frame green px | "
    "Centred-crop green px | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    green = provenance["green_content"]
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['style_lora_weight']} | {provenance['gpu_seconds']} "
        f"| {green['whole_frame_green_pixels']} | {green['centred_crop_green_pixels']} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    lines = ATTEMPT_LOG_PATH.read_text().splitlines(keepends=True)
    attempt_str = str(provenance["attempt"])
    kept = [
        line
        for line in lines
        if not (line.startswith("|") and line.split("|")[1].strip() == attempt_str)
    ]
    kept.append(row)
    ATTEMPT_LOG_PATH.write_text("".join(kept))


def run_attempt(attempt: int, seed: int, style_lora_weight: float = STYLE_LORA_WEIGHT) -> dict:
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    style_lora_hash = sha256_of(LORA_PATH)

    out_dir = REPO_ROOT / "assets" / "out" / "costume_reference" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.monotonic()
    graph = build_graph(seed=seed, style_lora_weight=style_lora_weight)
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id, timeout_s=300)
    gpu_seconds = time.monotonic() - t0

    main_bytes = fetch_save_image(info, SAVE_NODE_ID)
    main_path = out_dir / "main_1024.png"
    main_path.write_bytes(main_bytes)

    main_img = Image.open(main_path).convert("RGB")
    green_content = measure_green_content(main_img)

    provenance = {
        "model": f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight})",
        "model_license": f"{CHECKPOINT_LICENSE} (base) / {LORA_LICENSE} (LoRA)",
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "style_lora_license": LORA_LICENSE,
        "prompt": build_positive_prompt(),
        "negative_prompt": build_negative_prompt(),
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "sampler": "euler",
        "scheduler": "normal",
        "comfyui_prompt_id": prompt_id,
        "method": (
            "Plain txt2img + LoraLoader(soviet_brutalism_style_v1) -> CLIPTextEncode "
            "-> KSampler -> VAEDecode -> SaveImage. No ControlNet, no IP-Adapter, no "
            "identity/pose LoRA -- deliberately the same stack as T-0209's own "
            "player_character_concept_sheet_v1.recipe.json, chosen because T-0272 round 3 "
            "found ControlNet's structural conditioning is what overrides camera-angle "
            "prompt steering under the §24-e stack."
        ),
        "generator": "assets/src/concept/gen_player_profile_costume_reference_T0317.py",
        "card": "T-0317",
        "route": "generated",
        "spec": (
            "docs/design/13-asset-pipeline.md §6.9-§6.11, T-0272's own ARM_PROFILE_"
            "ATTEMPT_LOG_T0272.md round 5 finding (feasibility gate)"
        ),
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "green_content": green_content,
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def promote_attempt(attempt: int, notes: str = "") -> None:
    out_dir = REPO_ROOT / "assets" / "out" / "costume_reference" / f"attempt_{attempt}"
    provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
    main_bytes = (out_dir / "main_1024.png").read_bytes()
    FINAL_PATH.write_bytes(main_bytes)
    import hashlib

    promoted = dict(provenance)
    promoted["concept_hash"] = hashlib.sha256(main_bytes).hexdigest()
    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")
    append_attempt_log(promoted, notes=notes)
    print(f"promoted attempt {attempt} -> {FINAL_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--style-lora-weight", type=float, default=STYLE_LORA_WEIGHT)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument("--promote-attempt", type=int)
    args = parser.parse_args()

    if args.promote_attempt is not None:
        promote_attempt(args.promote_attempt, notes=args.notes)
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --promote-attempt is passed")

    provenance = run_attempt(
        attempt=args.attempt, seed=args.seed, style_lora_weight=args.style_lora_weight
    )
    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "costume_reference" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
