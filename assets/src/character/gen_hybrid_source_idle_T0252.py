#!/usr/bin/env python3
"""Hybrid round-2 source-frame generation (T-0252, HANDOFF §24-e).

"SDXL for the look, Arm C's deterministic script for the motion". This
script generates the *only* SDXL frame the hybrid pipeline ever produces:
one 384x384 idle pose, front-facing, descended to the native 48x48 cell
size, through the **full generative stack** -- style LoRA (T-0072) +
identity LoRA (`player_identity_v2`, T-0248, chained) + IP-Adapter
(concept-conditioned, T-0209) + ControlNet (single-cell OpenPose skeleton,
reused from Arm A). Every other frame of the assembled idle sheet is derived
from this one frame by `char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252`
(gen_hybrid_idle_T0252.py) -- there is no second SDXL call anywhere in the
pipeline, so identity drift between frames is structurally impossible.

Reused directly, unchanged: checkpoint/ControlNet identifiers, the
procedural OpenPose skeleton renderer, HTTP client helpers, and the §3.1
descent chain (gen_arm_a_idle_T0228.py); the identity LoRA identifiers and
single-figure prompt (gen_pose_authority_idle_T0249.py, itself already a
single-frame, no-grid-language prompt); the IP-Adapter node shape (Arm A).
This script's own contribution is the graph that stacks all four
conditioning mechanisms in one generation -- no prior round-2 card combined
IP-Adapter with the identity LoRA.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_v2.safetensors -- T-0248 -- is loadable by ComfyUI's
LoraLoader):
    python3 assets/src/character/gen_hybrid_source_idle_T0252.py --attempt 1 --seed 31416
    python3 assets/src/character/gen_hybrid_source_idle_T0252.py --promote-attempt 1

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/hybrid_source/attempt_<N>/pose_skeleton_384.png
    assets/out/hybrid_source/attempt_<N>/main_384.png
    assets/out/hybrid_source/attempt_<N>/cell_48_indexed.png
    assets/out/hybrid_source/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md (appended)

Promotion to assets/final/character/player_idle_frame_hybrid_source_T0252.png
(+ .provenance.json) is a separate, explicit step (--promote-attempt) -- a
discarded attempt's bytes never land in assets/final/, even transiently.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from asset_gate import palette as asset_gate_palette  # noqa: E402

# Reused directly from Arm A (T-0228) -- checkpoint/ControlNet identifiers,
# the procedural OpenPose skeleton renderer, HTTP client helpers, and the
# §3.1 descent chain are unchanged.
from gen_arm_a_idle_T0228 import (  # noqa: E402
    _POSE_KEYPOINTS_NORM,
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    IPADAPTER_NAME,
    IPADAPTER_PRESET,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    cleanup_orphans,
    draw_pose_skeleton_cell,
    enforce_cell_margin,
    fetch_save_image,
    quantize_to_palette,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

# Reused directly from the T-0250 second human review's own fix for the
# identical defect: a same-index, corner-connected flood
# (force_cell_corner_background, now superseded here) leaves a near-black
# halo around the figure -- a different quantized palette index from
# background_index but visually indistinguishable -- as "foreground",
# inflating check_frame_consistency's union denominator. cutout_foreground_mask
# does a real per-pixel, content-aware segmentation instead: a border-connected
# Oklab-tolerant flood over the frame's own 384x384 sampled image, unioned with
# "outside this frame's own keypoint bounding box + margin".
from gen_chained_idle_T0250 import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_METHOD_DESCRIPTION,
    CUTOUT_OKLAB_TOLERANCE,
    apply_cutout_masks,
    cutout_foreground_mask,
    downscale_mask,
)

# Reused directly from the pose-authority round (T-0249) -- the already
# battle-tested single-figure ("not a cell of a grid") prompt and the
# player_identity_v2 identifiers round 2 has standardised on since §24-a.
from gen_pose_authority_idle_T0249 import (  # noqa: E402
    IDENTITY_LORA_NAME,
    IDENTITY_LORA_PATH,
    IDENTITY_LORA_PROVENANCE_PATH,
    MAIN_NEGATIVE,
    MAIN_PROMPT,
)

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

FINAL_CELL_PX = 48  # native cell size -- DL-21 output spec, unchanged
GEN_PX = FINAL_CELL_PX * 8  # 384 -- same x8 descent ratio as every round-2 per-frame path

# ── Graph node ids -- named, not raw string literals re-derived per call ────
CHECKPOINT_NODE_ID = "1"
POSE_IMAGE_NODE_ID = "10"
STYLE_LORA_NODE_ID = "11"
IDENTITY_LORA_NODE_ID = "12"
POSITIVE_PROMPT_NODE_ID = "13"
NEGATIVE_PROMPT_NODE_ID = "14"
CONTROLNET_LOADER_NODE_ID = "15"
CONTROLNET_NODE_ID = "16"
CONCEPT_IMAGE_NODE_ID = "17"
IPADAPTER_LOADER_NODE_ID = "18"
IPADAPTER_NODE_ID = "19"
LATENT_NODE_ID = "20"
SAMPLER_NODE_ID = "21"
VAE_DECODE_NODE_ID = "22"
MAIN_SAVE_NODE_ID = "23"
DESCENT_NODE_ID = "24"
CELL_SAVE_NODE_ID = "25"


def build_graph(
    seed: int,
    concept_filename: str,
    pose_skeleton_filename: str,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
) -> dict:
    """The full stack in one graph: LoraLoader(style) -> LoraLoader(identity,
    chained) -> IPAdapterAdvanced(concept) -> KSampler, with ControlNet
    (single-cell pose skeleton) conditioning the positive/negative prompt
    pair the sampler consumes. One 384x384 generation, batch size 1 -- no
    grid, no per-cell tiling.
    """
    g: dict = {}
    g[CHECKPOINT_NODE_ID] = {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": CHECKPOINT},
    }
    g[POSE_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": pose_skeleton_filename},
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
    g[IDENTITY_LORA_NODE_ID] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": [STYLE_LORA_NODE_ID, 0],
            "clip": [STYLE_LORA_NODE_ID, 1],
            "lora_name": identity_lora_name,
            "strength_model": identity_lora_weight,
            "strength_clip": identity_lora_weight,
        },
    }
    g[POSITIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": MAIN_PROMPT, "clip": [IDENTITY_LORA_NODE_ID, 1]},
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": MAIN_NEGATIVE, "clip": [IDENTITY_LORA_NODE_ID, 1]},
    }
    g[CONTROLNET_LOADER_NODE_ID] = {
        "class_type": "ControlNetLoader",
        "inputs": {"control_net_name": CONTROLNET_NAME},
    }
    g[CONTROLNET_NODE_ID] = {
        "class_type": "ControlNetApplyAdvanced",
        "inputs": {
            "positive": [POSITIVE_PROMPT_NODE_ID, 0],
            "negative": [NEGATIVE_PROMPT_NODE_ID, 0],
            "control_net": [CONTROLNET_LOADER_NODE_ID, 0],
            "image": [POSE_IMAGE_NODE_ID, 0],
            "strength": controlnet_strength,
            "start_percent": 0.0,
            "end_percent": controlnet_end,
        },
    }
    g[CONCEPT_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": concept_filename},
    }
    g[IPADAPTER_LOADER_NODE_ID] = {
        "class_type": "IPAdapterUnifiedLoader",
        "inputs": {"model": [IDENTITY_LORA_NODE_ID, 0], "preset": IPADAPTER_PRESET},
    }
    g[IPADAPTER_NODE_ID] = {
        "class_type": "IPAdapterAdvanced",
        "inputs": {
            "model": [IPADAPTER_LOADER_NODE_ID, 0],
            "ipadapter": [IPADAPTER_LOADER_NODE_ID, 1],
            "image": [CONCEPT_IMAGE_NODE_ID, 0],
            "weight": ipadapter_weight,
            "weight_type": "linear",
            "combine_embeds": "concat",
            "start_at": 0.0,
            "end_at": 1.0,
            "embeds_scaling": "V only",
        },
    }
    g[LATENT_NODE_ID] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": GEN_PX, "height": GEN_PX, "batch_size": 1},
    }
    g[SAMPLER_NODE_ID] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [IPADAPTER_NODE_ID, 0],
            "positive": [CONTROLNET_NODE_ID, 0],
            "negative": [CONTROLNET_NODE_ID, 1],
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
    g[MAIN_SAVE_NODE_ID] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "hybrid_T0252_main_384", "images": [VAE_DECODE_NODE_ID, 0]},
    }
    g[DESCENT_NODE_ID] = {
        "class_type": "ImageScale",
        "inputs": {
            "image": [VAE_DECODE_NODE_ID, 0],
            "upscale_method": "area",
            "width": FINAL_CELL_PX,
            "height": FINAL_CELL_PX,
            "crop": "disabled",
        },
    }
    g[CELL_SAVE_NODE_ID] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "hybrid_T0252_cell_48", "images": [DESCENT_NODE_ID, 0]},
    }
    return g


def check_attempt_cap(attempt: int) -> None:
    if not (1 <= attempt <= 8):
        raise SystemExit("attempt cap is 8 per round (DL-21) -- refusing to run a 9th attempt")


ATTEMPT_LOG_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md"
)
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_FRAME_PATH = FINAL_CHARACTER_DIR / "player_idle_frame_hybrid_source_T0252.png"
FINAL_FRAME_PROVENANCE_PATH = (
    FINAL_CHARACTER_DIR / "player_idle_frame_hybrid_source_T0252.provenance.json"
)

ATTEMPT_LOG_HEADER = (
    "# Hybrid source-frame attempt log (T-0252, HANDOFF §24-e, round 2)\n\n"
    "Every attempt is recorded here whether it passes or not. There is exactly one SDXL "
    "generation per attempt -- this is the *only* diffusion-model call in the entire hybrid "
    "pipeline; the assembled sheet's frame-consistency is measured separately, downstream, "
    "in ARM_HYBRID_ATTEMPT_LOG_T0252.md once gen_hybrid_idle_T0252.py derives the other 8 "
    "frames from whichever attempt here is promoted.\n\n"
    "| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | "
    "IP-Adapter weight | GPU seconds | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['style_lora_weight']} | {provenance['identity_lora_weight']} "
        f"| {provenance['ip_adapter_weight']} "
        f"| {provenance['gpu_seconds']} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


def promote_attempt(out_dir: Path, provenance: dict) -> None:
    """Copy this attempt's indexed 48x48 frame + provenance into
    assets/final/character/ -- only called for the attempt chosen to feed
    gen_hybrid_idle_T0252.py's assembly step."""
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_FRAME_PATH.write_bytes((out_dir / "cell_48_indexed.png").read_bytes())
    promoted = dict(provenance)
    promoted["promoted"] = True
    FINAL_FRAME_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")


def build_indexed_cell(
    raw_cell: Image.Image, main_384: Image.Image, palette: list[tuple[int, int, int]]
) -> Image.Image:
    """Quantize the descended 48x48 raw cell to the home palette, then cut the
    character out of its background with a real per-pixel segmentation
    (`cutout_foreground_mask`, T-0250's own committed fix for the identical
    defect, reused unchanged): a border-connected Oklab-tolerant flood over
    `main_384` (this frame's own 384x384 sampled image, before descent),
    unioned with "outside the fixed standing-idle pose's own keypoint
    bounding box + margin" (`_POSE_KEYPOINTS_NORM`, the same skeleton
    `draw_pose_skeleton_cell` rendered for this generation). Supersedes
    `force_cell_corner_background`, which only flooded pixels at the exact
    background quantized index from the corner and left a near-black halo
    (a *different* index, visually indistinguishable from background) as
    foreground -- inflating check_frame_consistency's union denominator."""
    indexed = quantize_to_palette(raw_cell, palette)
    fg_mask = downscale_mask(
        cutout_foreground_mask(
            main_384, _POSE_KEYPOINTS_NORM, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
        ),
        FINAL_CELL_PX,
    )
    indexed = apply_cutout_masks(
        indexed, {(0, 0): fg_mask}, cell_size=FINAL_CELL_PX, background_index=0
    )
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    return indexed


def run_attempt(
    attempt: int,
    seed: int,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    style_lora_weight: float,
    identity_lora_weight: float,
) -> dict:
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH}"
        )
    if not IDENTITY_LORA_PATH.exists():
        raise RuntimeError(f"trained identity LoRA not found: {IDENTITY_LORA_PATH}")
    if not IDENTITY_LORA_PROVENANCE_PATH.exists():
        raise RuntimeError(
            f"identity LoRA provenance sidecar not found: {IDENTITY_LORA_PROVENANCE_PATH}"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)

    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_source" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    skeleton_img = draw_pose_skeleton_cell(GEN_PX)
    skeleton_path = out_dir / "pose_skeleton_384.png"
    skeleton_img.save(skeleton_path)

    t0 = time.monotonic()
    skeleton_filename = upload_image(skeleton_path)
    concept_filename = upload_image(CONCEPT_SHEET_PATH)
    graph = build_graph(
        seed=seed,
        concept_filename=concept_filename,
        pose_skeleton_filename=skeleton_filename,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        ipadapter_weight=ipadapter_weight,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
    )
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id, timeout_s=300)
    gpu_seconds = time.monotonic() - t0

    main_bytes = fetch_save_image(info, MAIN_SAVE_NODE_ID)
    cell_bytes = fetch_save_image(info, CELL_SAVE_NODE_ID)
    (out_dir / "main_384.png").write_bytes(main_bytes)
    cell_raw_path = out_dir / "cell_48_raw.png"
    cell_raw_path.write_bytes(cell_bytes)

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    raw = Image.open(cell_raw_path).convert("RGB")
    main_img = Image.open(out_dir / "main_384.png").convert("RGB")
    indexed = build_indexed_cell(raw, main_img, palette)
    indexed.save(out_dir / "cell_48_indexed.png")

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) "
        f"+ LoRA {IDENTITY_LORA_NAME} (player identity, weight {identity_lora_weight}) "
        f"+ IP-Adapter {IPADAPTER_NAME} (weight {ipadapter_weight}) + ControlNet {CONTROLNET_NAME}"
    )
    provenance = {
        "model": model_summary,
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "style_lora_license": LORA_LICENSE,
        "identity_lora_name": IDENTITY_LORA_NAME,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": identity_lora_weight,
        "identity_lora_license": "CreativeML OpenRAIL++-M",
        "identity_lora_provenance": str(IDENTITY_LORA_PROVENANCE_PATH.relative_to(REPO_ROOT)),
        "ip_adapter": IPADAPTER_NAME,
        "ip_adapter_weight": ipadapter_weight,
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": MAIN_PROMPT,
        "negative_prompt": MAIN_NEGATIVE,
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "comfyui_prompt_id": prompt_id,
        "method": (
            "Single 384x384 generation: procedurally drawn OpenPose-format skeleton "
            "(gen_arm_a_idle_T0228.draw_pose_skeleton_cell) -> ControlNetApplyAdvanced (xinsir "
            "OpenPose) + LoraLoader(soviet_brutalism_style_v1) -> LoraLoader(player_identity_v2, "
            "chained) -> IPAdapterAdvanced (PLUS, T-0209 concept, applied after both LoRAs) -> "
            "KSampler -> area descent to 48x48 -> Oklab-nearest palette quantization (dithering "
            "off, §3.1) -> per-pixel background cutout (see cutout_method) -> orphan cleanup. "
            "This is the only diffusion-model call in the entire hybrid pipeline (T-0252) -- "
            "every other animation frame is derived from this one frame's own pixels by "
            "char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252."
        ),
        "generator": "assets/src/character/gen_hybrid_source_idle_T0252.py",
        "card": "T-0252",
        "bake_off_arm": "round 2, hybrid (HANDOFF §24-e)",
        "spec": "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5",
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "background_cutout_applied": True,
        "cutout_method": CUTOUT_METHOD_DESCRIPTION,
        "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
        "cutout_bbox_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
        "layout": {"cell_px": FINAL_CELL_PX},
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def reprocess_attempt_cutout(attempt: int) -> dict:
    """Re-derive `attempt`'s indexed cell with the background-cutout fix from
    that attempt's ALREADY SAMPLED pixels on disk -- no new ComfyUI call, no
    seed change, no re-sweep. Reads back `main_384.png` (the frame's own
    sampled image, for the cutout mask) and `cell_48_raw.png` (the exact
    pre-quantization pixels the previous run descended) from `attempt`'s own
    out_dir, rebuilds the indexed cell through `build_indexed_cell`, and
    overwrites both `cell_48_indexed.png` and `provenance_candidate.json` in
    place. `--promote-attempt` then promotes the result exactly as for a
    fresh run."""
    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_source" / f"attempt_{attempt}"
    candidate_path = out_dir / "provenance_candidate.json"
    provenance = json.loads(candidate_path.read_text())

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    raw = Image.open(out_dir / "cell_48_raw.png").convert("RGB")
    main_img = Image.open(out_dir / "main_384.png").convert("RGB")
    indexed = build_indexed_cell(raw, main_img, palette)
    indexed.save(out_dir / "cell_48_indexed.png")

    provenance["background_cutout_applied"] = True
    provenance["cutout_method"] = CUTOUT_METHOD_DESCRIPTION
    provenance["cutout_oklab_tolerance"] = CUTOUT_OKLAB_TOLERANCE
    provenance["cutout_bbox_margin_frac"] = BACKGROUND_MASK_MARGIN_FRAC
    provenance["method"] = (
        "Single 384x384 generation: procedurally drawn OpenPose-format skeleton "
        "(gen_arm_a_idle_T0228.draw_pose_skeleton_cell) -> ControlNetApplyAdvanced (xinsir "
        "OpenPose) + LoraLoader(soviet_brutalism_style_v1) -> LoraLoader(player_identity_v2, "
        "chained) -> IPAdapterAdvanced (PLUS, T-0209 concept, applied after both LoRAs) -> "
        "KSampler -> area descent to 48x48 -> Oklab-nearest palette quantization (dithering "
        "off, §3.1) -> per-pixel background cutout (see cutout_method) -> orphan cleanup. "
        "This is the only diffusion-model call in the entire hybrid pipeline (T-0252) -- "
        "every other animation frame is derived from this one frame's own pixels by "
        "char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252."
    )
    candidate_path.write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int, help="attempt number, 1..8 (DL-21 cap)")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--controlnet-strength", type=float, default=1.0)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--ipadapter-weight", type=float, default=0.6)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.50)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument(
        "--promote-attempt",
        type=int,
        help="promote an existing attempt's cell to assets/final/character/ and exit",
    )
    parser.add_argument(
        "--reprocess-cutout",
        type=int,
        help=(
            "re-derive an existing attempt's indexed cell with the background-cutout fix "
            "from its already-sampled pixels on disk, no new ComfyUI call, and exit"
        ),
    )
    args = parser.parse_args()

    if args.reprocess_cutout is not None:
        provenance = reprocess_attempt_cutout(args.reprocess_cutout)
        print(json.dumps(provenance, indent=2))
        return

    if args.promote_attempt is not None:
        out_dir = REPO_ROOT / "assets" / "out" / "hybrid_source" / f"attempt_{args.promote_attempt}"
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        promote_attempt(out_dir, provenance)
        print(f"promoted attempt {args.promote_attempt} -> {FINAL_FRAME_PATH}")
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --promote-attempt is passed")

    check_attempt_cap(args.attempt)

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        ipadapter_weight=args.ipadapter_weight,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )
    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_source" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
