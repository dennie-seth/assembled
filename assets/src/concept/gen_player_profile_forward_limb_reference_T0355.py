#!/usr/bin/env python3
"""Forward-limb green-costume side-profile reference generator (T-0355).

**Why this card exists -- the one thing T-0351's 21 attempts proved.**
T-0351's own conclusion: side_left_forward and side_right_forward have now
never once been compliant across 21 total attempts, under three
fundamentally different conditioning architectures. The one side panel that
*does* converge (side_neutral) works because T-0317's own reference is a
*neutral standing* pose, which matches that panel's target pose exactly --
so the mechanism is pose-matched reference conditioning, not merely
view-matched. **The forward-limb reference simply does not exist yet.** This
generator produces it, the same move T-0317 itself made to get a
colour-bearing side reference out of front-facing-only material.

**Why this reuses T-0317's exact architecture, not a new one.** T-0317's own
docstring: T-0272 round 3 found ControlNet's structural conditioning
dominates the text prompt's camera-angle request, so a prompt-only reframe
"cannot work by construction" under that stack. T-0317 proved the inverse
stack -- plain txt2img + style LoRA only, **no** ControlNet, **no**
IP-Adapter -- gives prompt steering the authority it never had under
ControlNet, and that stack alone was enough to produce a genuine, green,
side-facing reference (attempt 3/3). This generator is that identical stack
with two prompt changes: the pose clause (neutral standing -> near arm AND
near leg each extended forward ~90 degrees, a walking-phase profile) and an
explicit canonical coat-length constraint ("full-length coat reaching past
the knee" -- the exact phrase `gen_master_sheet_T0336.py`'s own
`build_single_pose_positive_prompt` already settled project-wide,
2026-09-10 dedicated-legs-panel amendment). T-0351 attempt 21 saw the coat
shorten to mid-thigh with no code change touching coat wording -- the
finding reads that as seed variance on an unconstrained clause, so this
generator states the canonical length explicitly rather than leaving it
implicit.

Reuses `gen_arm_a_idle_T0228`'s checkpoint/LoRA identifiers and stdlib-only
(urllib) ComfyUI HTTP helpers directly (submit/poll/fetch/upload), and
`derive_profile_style_reference_T0272.extract_panel_reference` for panel
cleanup on promotion -- the same reuse pattern
`gen_player_profile_costume_reference_T0317.py` itself uses.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/concept/gen_player_profile_forward_limb_reference_T0355.py --attempt 1 --seed 31700
    python3 assets/src/concept/gen_player_profile_forward_limb_reference_T0355.py --promote-attempt 1

Writes (always, so every attempt is logged whether it is promoted or not):
    assets/out/forward_limb_reference/attempt_<N>/main_1024.png
    assets/out/forward_limb_reference/attempt_<N>/provenance_candidate.json
    assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_ATTEMPT_LOG_T0355.md (appended)

Promotion writes the committed deliverable:
    assets/src/concept/player_profile_forward_limb_reference_T0355.png
    assets/src/concept/player_profile_forward_limb_reference_T0355.provenance.json
"""

from __future__ import annotations

import argparse
import hashlib
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

# Must follow the gen_arm_a_idle_T0228 import: see
# gen_player_profile_costume_reference_T0317.py's own identical comment --
# that module's own top-level sys.path.insert is what makes char_gen
# importable, which extract_panel_reference needs but does not insert itself.
from derive_profile_style_reference_T0272 import extract_panel_reference  # noqa: E402
from green_content import count_green_pixels  # noqa: E402

GEN_PX = 1024  # matches player_character_concept_sheet_v1.recipe.json's 1024x1024

# T-0272 round 5's own calibration crop of the front sheet's confirmed
# green-coat panel (187x200px) -- see T-0317's own identical comment for why
# a same-size centred crop, not the raw whole-frame count, is what is
# comparable to that benchmark.
GREEN_MEASURE_CROP_SIZE = (187, 200)

STYLE_LORA_WEIGHT = 0.70  # matches T-0209's own recipe, reused unchanged by T-0317

# Panel box for promotion, set once the winning attempt's own layout is known
# by direct visual inspection (same "hardcode a known source's own panel box"
# precedent as T-0317's own PROMOTED_PANEL_BOX -- attempt-specific, not
# meant to generalise). None means "use the whole 1024x1024 frame" -- this
# generator's prompt asks for a single reference panel, not a turnaround
# sheet, so a multi-panel layout is not assumed by default.
PROMOTED_PANEL_BOX: tuple[int, int, int, int] | None = None
PROMOTED_PANEL_MARGIN = 4

POSITIVE_PROMPT = (
    "flat side-on character concept reference sheet, orthographic game asset, "
    "no perspective, no vanishing point, one reference panel: full-body side "
    "profile walking pose, mid-stride, figure's face and nose seen in strict "
    "profile facing right, one shoulder visible, (near arm raised and bent "
    "forward at roughly 90 degrees at the elbow:1.3), (near leg raised and "
    "swung forward at roughly 90 degrees at the hip:1.3), far arm and far leg "
    "hidden behind the body, weight on the trailing leg, dynamic mid-step "
    "silhouette, not a neutral standing pose. Player character: 40px tall "
    "humanoid figure in a 48x48 cell, wearing a long vivid institutional "
    "green cloth coat (the coat itself is green, not black, not grey), "
    "(full-length coat reaching past the knee, never mid-thigh, never above "
    "the knee:1.3), concrete-grey head and skin tones, deep shadow values on "
    "the coat's own folds. Soviet brutalist interior aesthetic, muted "
    "desaturated palette for the environment only, the coat itself stays "
    "vivid green, hard value separation, dark darks and light lights, flat "
    "even lighting, no atmospheric haze, no depth of field, no scene "
    "composition, no background elements, solid flat black background only. "
    "Game asset reference sheet style, pixel art scale reference, figure "
    "silhouette study"
)

NEGATIVE_PROMPT = (
    "perspective, vanishing point, three-quarter view, isometric, receding "
    "walls, atmospheric haze, depth of field, sky, clouds, foliage, scene, "
    "composed illustration, photorealistic, 3d render, soft gradient lighting, "
    "ambient occlusion, painterly, cartoon, cheerful, "
    "text, watermark, signature, blurry, low quality, "
    "front view, facing the camera, symmetric front-facing pose, back view, "
    "rear view, both shoulders equally visible, both arms visible, both legs "
    "visible, "
    "neutral standing pose, arms at the sides, arms hanging down, legs "
    "together, static pose, both feet flat on the ground, "
    "city, skyscraper, buildings, urban background, architecture background, "
    "windows, cityscape, scenery, multiple figures, two figures, group of "
    "people, "
    "grey tactical costume, tan tactical costume, khaki uniform, army "
    "fatigues, muted olive costume, brownish coat, washed out colour, pale "
    "colour, desaturated coat, grayscale, black coat, grey coat, black "
    "armor, monochrome, colourless, "
    "short coat, cropped coat, coat above the knee, mid-thigh coat, mini "
    "coat, coat ending at the hip, coat stopping above the knee"
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
    """Plain txt2img + style LoRA -- no ControlNet, no IP-Adapter, no
    identity/pose LoRA. See module docstring for why the absence of those
    two nodes is this script's entire premise, exactly like T-0317's own
    generator, not an oversight."""
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
            "filename_prefix": "forward_limb_reference_T0355_main_1024",
            "images": [VAE_DECODE_NODE_ID, 0],
        },
    }
    return g


def measure_green_content(image: Image.Image) -> dict:
    """Whole-frame count plus a centred crop the same size as T-0272 round
    5's own front-panel calibration crop (187x200) -- identical measurement
    to T-0317's own `measure_green_content`, so the two references are
    directly comparable."""
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
    REPO_ROOT / "assets" / "src" / "concept" / "ARM_FORWARD_LIMB_REFERENCE_ATTEMPT_LOG_T0355.md"
)
FINAL_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_forward_limb_reference_T0355.png"
)
FINAL_PROVENANCE_PATH = (
    REPO_ROOT
    / "assets"
    / "src"
    / "concept"
    / "player_profile_forward_limb_reference_T0355.provenance.json"
)

ATTEMPT_LOG_HEADER = (
    "# Forward-limb green-costume side-profile reference attempt log (T-0355)\n\n"
    "Every attempt is recorded here whether promoted or not. Hard cap: 4 attempts "
    "(T-0355's own pre-registered alternative outcome -- stop and report past this, "
    "grinding further is out of scope). Same architecture as T-0317's own generator "
    "(plain txt2img + style LoRA, no ControlNet, no IP-Adapter) with the pose clause "
    "changed to near-arm/near-leg extended forward ~90 degrees and an explicit "
    "canonical coat-length constraint. `green_content` measures both the whole frame "
    "and a centred crop the same size as T-0272 round 5's own front-panel calibration "
    "crop (187x200), against that round's recorded 6,000-6,900 green-pixel band.\n\n"
    "| Attempt | Seed | Style LoRA weight | GPU seconds | Whole-frame green px | "
    "Centred-crop green px | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    green = provenance["green_content"]
    whole_frame = green.get("whole_frame_green_pixels", "n/a")
    centred_crop = green.get(
        "centred_crop_green_pixels", green.get("promoted_reference_green_pixels", "n/a")
    )
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['style_lora_weight']} | {provenance['gpu_seconds']} "
        f"| {whole_frame} | {centred_crop} "
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

    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_reference" / f"attempt_{attempt}"
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
            "identity/pose LoRA -- deliberately the same stack as T-0317's own "
            "player_profile_costume_reference_T0317.provenance.json, chosen because "
            "T-0351's own 21-attempt finding is that per-panel ControlNet/IP-Adapter "
            "conditioning has never once produced a compliant forward-limb panel."
        ),
        "generator": "assets/src/concept/gen_player_profile_forward_limb_reference_T0355.py",
        "card": "T-0355",
        "route": "generated",
        "spec": (
            "docs/design/13-asset-pipeline.md §6.9-§6.11, T-0351's own "
            "ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md attempts 19-21 (the missing-reference "
            "finding this card exists to fix)"
        ),
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "green_content": green_content,
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def promote_attempt(
    attempt: int,
    panel_box: tuple[int, int, int, int] | None = None,
    notes: str = "",
) -> None:
    """Unlike T-0317's own `promote_attempt` (which always crops a known
    3-panel turnaround down to a hardcoded panel box), this generator's
    prompt asks for a single reference panel -- so by default the whole
    1024x1024 frame is run through `extract_panel_reference` directly.
    `panel_box` (or the module-level `PROMOTED_PANEL_BOX`, set once the
    winning attempt's own layout is known by direct visual inspection) is
    only needed if a given attempt in fact renders a multi-panel sheet, the
    same failure mode T-0317's own attempts 1-2 hit."""
    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_reference" / f"attempt_{attempt}"
    provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
    main_img = Image.open(out_dir / "main_1024.png").convert("RGB")

    box = panel_box if panel_box is not None else PROMOTED_PANEL_BOX
    source_img = main_img.crop(box) if box is not None else main_img
    reference = extract_panel_reference(source_img, margin=PROMOTED_PANEL_MARGIN)
    reference.save(FINAL_PATH)
    reference_bytes = FINAL_PATH.read_bytes()

    promoted = dict(provenance)
    promoted["concept_hash"] = hashlib.sha256(reference_bytes).hexdigest()
    promoted["panel_source"] = {
        "source_attempt": attempt,
        "source_file": str((out_dir / "main_1024.png").relative_to(REPO_ROOT)),
        "panel_box": list(box) if box is not None else None,
        "panel_margin": PROMOTED_PANEL_MARGIN,
        "extraction_method": (
            "border-flood background detection + largest-connected-component selection "
            "(derive_profile_style_reference_T0272.extract_panel_reference, reused directly), "
            "crop to the figure's own bbox + margin"
        ),
    }
    promoted["green_content"] = {
        "promoted_reference_green_pixels": count_green_pixels(reference),
        "benchmark_green_band": [6000, 6900],
        "benchmark_noise_floor_fraction": [0.010, 0.017],
    }
    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")
    append_attempt_log(promoted, notes=notes)
    print(f"promoted attempt {attempt} -> {FINAL_PATH}")
    print(f"promoted reference green px: {promoted['green_content']['promoted_reference_green_pixels']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--style-lora-weight", type=float, default=STYLE_LORA_WEIGHT)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument("--promote-attempt", type=int)
    parser.add_argument(
        "--panel-box",
        type=int,
        nargs=4,
        metavar=("LEFT", "UPPER", "RIGHT", "LOWER"),
        default=None,
    )
    args = parser.parse_args()

    if args.promote_attempt is not None:
        panel_box = tuple(args.panel_box) if args.panel_box is not None else None
        promote_attempt(args.promote_attempt, panel_box=panel_box, notes=args.notes)
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --promote-attempt is passed")

    provenance = run_attempt(
        attempt=args.attempt, seed=args.seed, style_lora_weight=args.style_lora_weight
    )
    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_reference" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
