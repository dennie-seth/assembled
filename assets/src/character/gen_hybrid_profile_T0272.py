#!/usr/bin/env python3
"""Side-profile base-pose keyframe generation (T-0272, HANDOFF §24-e).

**This delivers ONE still keyframe, not a sheet and not an animation.** There
is no frame count, no loop, no Arm-C frame-delta comparison anywhere in this
script -- CHR-1's multi-frame provenance fields (`frame_delta_range`,
`beats_arm_c_benchmark`, `loop`, ...) do not apply to a single pose and must
never be invented here (see the sibling gate test's own guard,
`test_no_animation_gate_fields_present`).

Per-script convention this pipeline has kept since Arm A/B/pose-authority/
hybrid-source/hybrid-walk (`gen_hybrid_walk_T0259.py`'s own module docstring:
"each [arm] owns its own build_graph + prompt constants, reusing the
checkpoint/LoRA/ControlNet identifiers and HTTP client helpers via import,
never a shared parametrised generator") -- this script owns its own
`build_graph` and profile-specific prompt, wired identically to
`gen_hybrid_source_idle_T0252.build_graph` (style LoRA -> identity LoRA,
chained -> IPAdapterAdvanced(concept) -> ControlNet(this card's profile
skeleton) -> KSampler -> area descent to 48x48 -> per-pixel cutout), but
conditioned on `pose_rig_profile_T0272.py`'s profile-topology skeleton
instead of the front rig's `_POSE_KEYPOINTS_NORM`.

**Why a new skeleton, not a reframed one.** T-0259's own feasibility probe
already showed a prompt-only reframe of the front skeleton cannot work --
ControlNet's structural conditioning dominates the text prompt's camera-angle
request (see `pose_rig_profile_T0272.py`'s module docstring for the full
finding). This script's ControlNet input is `pose_rig_profile_T0272`'s
genuinely different keypoint layout, not `_POSE_KEYPOINTS_NORM` reframed.

**Identity anchoring.** IP-Adapter is fed the same cropped concept-sheet
panel `gen_hybrid_walk_T0259.py` established (`IDENTITY_REFERENCE_CROP_BOX`,
reused directly, not re-derived -- T-0266's own recipe finding: the full
~24-panel turnaround grid leaks its own layout into independently-sampled
generations via IP-Adapter's image-level conditioning). The committed T-0252
front idle keyframe is recorded as `identity_anchor` (path + hash), exactly
as the walk sheet records it -- "the new pose must read as the same
character as this sheet" is a checkable claim, not a second IP-Adapter input
(stacking a second reference image through the same node is untested on this
ComfyUI host, per T-0259's own reasoning for the identical choice).

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_v2.safetensors -- T-0248 -- is loadable by ComfyUI's
LoraLoader, and after player_idle_sheet_hybrid_T0252.png -- the identity
anchor -- is committed):
    python3 assets/src/character/gen_hybrid_profile_T0272.py --attempt 1 --seed 31416
    python3 assets/src/character/gen_hybrid_profile_T0272.py --promote-attempt 1

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/hybrid_profile/attempt_<N>/pose_skeleton_384.png
    assets/out/hybrid_profile/attempt_<N>/keypoints.json
    assets/out/hybrid_profile/attempt_<N>/main_384.png
    assets/out/hybrid_profile/attempt_<N>/cell_48_indexed.png
    assets/out/hybrid_profile/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_PROFILE_ATTEMPT_LOG_T0272.md (appended)

Promotion to assets/final/character/player_profile_keyframe_hybrid_T0272.png
(+ .provenance.json) is a separate, explicit step (--promote-attempt) -- a
discarded attempt's bytes never land in assets/final/, even transiently. It
also re-homes the promoted attempt's skeleton/keypoints (the ControlNet
conditioning input) from the gitignored assets/out/ into a committed evidence
directory under assets/src/, since the promoted provenance's file references
must resolve on a fresh clone.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pose_rig_profile_T0272  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402

# Reused directly from Arm A (T-0228) -- checkpoint/ControlNet identifiers,
# HTTP client helpers, and the §3.1 descent chain are unchanged.
from gen_arm_a_idle_T0228 import (  # noqa: E402
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
    enforce_cell_margin,
    fetch_save_image,
    quantize_to_palette,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

# Reused directly from T-0250's own per-pixel background-cutout fix (same
# functions gen_hybrid_source_idle_T0252.py and gen_hybrid_walk_T0259.py
# already apply to their own frames).
from gen_chained_idle_T0250 import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_METHOD_DESCRIPTION,
    CUTOUT_OKLAB_TOLERANCE,
    apply_cutout_masks,
    cutout_foreground_mask,
    downscale_mask,
)

# Reused directly from T-0259 (T-0266's own recipe finding: the full concept
# sheet's ~24-panel grid leaks its own layout into IP-Adapter conditioning).
from gen_hybrid_walk_T0259 import (  # noqa: E402
    IDENTITY_REFERENCE_CROP_BOX,
    crop_identity_reference,
)

# Reused directly from the pose-authority round (T-0249) -- the trained
# identity LoRA's identifiers and trigger token, unchanged.
from gen_pose_authority_idle_T0249 import (  # noqa: E402
    IDENTITY_LORA_NAME,
    IDENTITY_LORA_PATH,
    IDENTITY_LORA_PROVENANCE_PATH,
    TRIGGER_TOKEN,
)
from gen_pose_authority_idle_T0249 import MAIN_NEGATIVE as IDLE_MAIN_NEGATIVE  # noqa: E402

from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

FINAL_CELL_PX = 48  # native cell size -- DL-21 output spec, unchanged
GEN_PX = FINAL_CELL_PX * 8  # 384 -- same x8 descent ratio as every §24-e per-frame path

FACING = pose_rig_profile_T0272.FACING

# Single-figure, side-profile prompt. Names the canonical costume explicitly
# ("institutional green coat, hooded, white gloves" -- CANONICAL_COSTUME_SELECTION_T0248.md)
# and forbids desaturation, since T-0259's attempt 8 found low denoise can wash
# the costume colour out even when the pose reads correctly.
PROFILE_PROMPT = (
    f"{TRIGGER_TOKEN}, pixel art side-profile base pose, single standing figure seen "
    f"from the side, facing {FACING}, flat side-on orthographic view, exactly one figure "
    "matching the pose skeleton exactly, institutional green coat, hooded, white gloves, "
    "same uniform and same equipment loadout, upright standing posture, solid flat black "
    "background, value-separated pixel art silhouette, clean readable pixel outline, "
    "vivid saturated green costume colour, no perspective, no vanishing point, no text, no UI"
)
PROFILE_NEGATIVE = (
    IDLE_MAIN_NEGATIVE + ", front view, facing the camera, symmetric front-facing pose, "
    "three-quarter view, back view, both shoulders equally visible, washed out colour, "
    "pale colour, desaturated, faded costume, grayscale"
)

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
    """The full §24-e stack in one graph, wired identically to
    `gen_hybrid_source_idle_T0252.build_graph`: LoraLoader(style) ->
    LoraLoader(identity, chained) -> IPAdapterAdvanced(concept) -> KSampler,
    with ControlNet (this card's profile-topology skeleton) conditioning the
    positive/negative prompt pair. One 384x384 generation, batch size 1.
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
        "inputs": {"text": PROFILE_PROMPT, "clip": [IDENTITY_LORA_NODE_ID, 1]},
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": PROFILE_NEGATIVE, "clip": [IDENTITY_LORA_NODE_ID, 1]},
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
    g[VAE_DECODE_NODE_ID] = {"class_type": "VAEDecode", "inputs": {
        "samples": [SAMPLER_NODE_ID, 0], "vae": [CHECKPOINT_NODE_ID, 2]
    }}
    g[MAIN_SAVE_NODE_ID] = {
        "class_type": "SaveImage",
        "inputs": {
            "filename_prefix": "hybrid_profile_T0272_main_384",
            "images": [VAE_DECODE_NODE_ID, 0],
        },
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
        "inputs": {
            "filename_prefix": "hybrid_profile_T0272_cell_48",
            "images": [DESCENT_NODE_ID, 0],
        },
    }
    return g


def check_attempt_cap(attempt: int) -> None:
    if not (1 <= attempt <= 8):
        raise SystemExit("attempt cap is 8 per round (DL-21) -- refusing to run a 9th attempt")


ATTEMPT_LOG_PATH = REPO_ROOT / "assets" / "src" / "character" / "ARM_PROFILE_ATTEMPT_LOG_T0272.md"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_KEYFRAME_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.png"
FINAL_PROVENANCE_PATH = (
    FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.provenance.json"
)
IDLE_ANCHOR_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png"
PROFILE_FRAME_EVIDENCE_DIR = (
    REPO_ROOT / "assets" / "src" / "character" / "pose_rig_profile_frame_evidence_T0272"
)

ATTEMPT_LOG_HEADER = (
    "# Side-profile keyframe attempt log (T-0272, HANDOFF §24-e)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not. This is a "
    "STATIC POSE, not an animation -- there is no frame-delta/0.30 cap, no loop seam, no "
    "Arm-C comparison here (a single keyframe has nothing adjacent to compare against). "
    "`mechanical_gate` covers only what a single frame can: cutout cleanliness (background "
    "fraction, no stray foreground outside the profile rig's own keypoint bbox) and a "
    "non-erased silhouette. Whether the result genuinely reads as side-facing with intact "
    "identity is a human visual call, recorded in Notes, not a mechanical one.\n\n"
    "| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | "
    "IP-Adapter weight | GPU seconds | Mechanical gate | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|\n"
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
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
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


def promote_attempt(out_dir: Path, provenance: dict) -> None:
    """Copy this attempt's indexed keyframe + provenance into
    assets/final/character/, and re-home its ControlNet conditioning input
    (skeleton PNG + keypoints JSON) from the gitignored assets/out/ into a
    committed evidence directory under assets/src/ -- otherwise the promoted
    provenance's file references dangle on a fresh clone."""
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_KEYFRAME_PATH.write_bytes((out_dir / "cell_48_indexed.png").read_bytes())

    PROFILE_FRAME_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    keypoints_dst = PROFILE_FRAME_EVIDENCE_DIR / "keypoints.json"
    skeleton_dst = PROFILE_FRAME_EVIDENCE_DIR / "pose_skeleton_384.png"
    keypoints_dst.write_bytes((out_dir / "keypoints.json").read_bytes())
    skeleton_dst.write_bytes((out_dir / "pose_skeleton_384.png").read_bytes())

    promoted = dict(provenance)
    promoted["pose_keypoints_file"] = str(keypoints_dst.relative_to(REPO_ROOT))
    promoted["pose_skeleton_file"] = str(skeleton_dst.relative_to(REPO_ROOT))
    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")


def build_indexed_cell(
    raw_cell: Image.Image,
    main_384: Image.Image,
    palette: list[tuple[int, int, int]],
    points_norm: dict[int, tuple[float, float]],
) -> Image.Image:
    """Quantize the descended 48x48 raw cell to the home palette, then cut
    the character out of its background with a real per-pixel segmentation
    (`cutout_foreground_mask`, T-0250's own fix, reused unchanged) against
    THIS card's profile rig keypoint bounding box, not the front rig's."""
    indexed = quantize_to_palette(raw_cell, palette)
    fg_mask = downscale_mask(
        cutout_foreground_mask(
            main_384, points_norm, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
        ),
        FINAL_CELL_PX,
    )
    indexed = apply_cutout_masks(
        indexed, {(0, 0): fg_mask}, cell_size=FINAL_CELL_PX, background_index=0
    )
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    return indexed


def compute_mechanical_gate(
    indexed: Image.Image, points_norm: dict[int, tuple[float, float]]
) -> dict:
    """The only checks that make sense against a single static frame: is the
    background actually clean, is the silhouette not erased, and did no
    foreground clutter survive outside this pose's own keypoint bbox? There
    is no adjacent frame to compute a delta against."""
    arr = np.array(indexed)
    bg_fraction = float((arr == 0).mean())
    fg_count = int((arr != 0).sum())

    margin = BACKGROUND_MASK_MARGIN_FRAC
    xs = [x for x, _ in points_norm.values()]
    ys = [y for _, y in points_norm.values()]
    x0n, x1n = min(xs), max(xs)
    y0n, y1n = min(ys), max(ys)
    wn, hn = x1n - x0n, y1n - y0n
    x0n = max(0.0, x0n - wn * margin)
    x1n = min(1.0, x1n + wn * margin)
    y0n = max(0.0, y0n - hn * margin)
    y1n = min(1.0, y1n + hn * margin)
    size = arr.shape[0]
    px0, px1 = int(x0n * size), int(x1n * size)
    py0, py1 = int(y0n * size), int(y1n * size)
    outside = arr != 0
    outside = outside.copy()
    outside[py0:py1, px0:px1] = False
    stray_px = int(outside.sum())

    passed = bg_fraction >= 0.65 and fg_count >= 50 and stray_px == 0
    return {
        "background_fraction": bg_fraction,
        "foreground_pixels": fg_count,
        "stray_foreground_pixels": stray_px,
        "passed": passed,
    }


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
    if not IDLE_ANCHOR_PATH.exists():
        raise RuntimeError(
            f"identity anchor (T-0252 front idle keyframe) not found: {IDLE_ANCHOR_PATH}"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)

    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_profile" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    points = pose_rig_profile_T0272.profile_keypoints()
    skeleton_img = pose_rig_profile_T0272.render_pose_frame(points, GEN_PX)
    skeleton_path = out_dir / "pose_skeleton_384.png"
    skeleton_img.save(skeleton_path)
    keypoints_path = out_dir / "keypoints.json"
    keypoints_path.write_text(
        json.dumps(pose_rig_profile_T0272.keypoints_to_coco_list(points), indent=2) + "\n"
    )

    identity_reference_path = out_dir / "identity_reference_crop.png"
    crop_identity_reference(CONCEPT_SHEET_PATH, identity_reference_path)

    t0 = time.monotonic()
    skeleton_filename = upload_image(skeleton_path)
    concept_filename = upload_image(identity_reference_path)
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
    indexed = build_indexed_cell(raw, main_img, palette, points)
    save_sprite_sheet(indexed, out_dir / "cell_48_indexed.png")

    mechanical_gate = compute_mechanical_gate(indexed, points)

    identity_anchor = {
        "path": str(IDLE_ANCHOR_PATH.relative_to(REPO_ROOT)),
        "hash": sha256_of(IDLE_ANCHOR_PATH),
        "note": (
            "the committed T-0252 front idle keyframe -- this keyframe's identity is checked "
            "against it (same costume, same equipment loadout), not fed as a second "
            "IP-Adapter input alongside the concept sheet"
        ),
    }

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
        "ip_adapter_reference_crop_box": list(IDENTITY_REFERENCE_CROP_BOX),
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": PROFILE_PROMPT,
        "negative_prompt": PROFILE_NEGATIVE,
        "pose_source": (
            "script (assets/src/character/pose_rig_profile_T0272.py) -- a newly authored "
            "profile-topology 18-keypoint COCO skeleton (legs collapsed to a single fore-aft "
            "line, shoulders in line with the view axis, one arm forward/one back, head "
            "turned), not a reframed or mirrored copy of the front rig"
        ),
        "facing": FACING,
        "identity_anchor": identity_anchor,
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
            "Single 384x384 generation: pose_rig_profile_T0272 authors a profile-topology "
            "18-keypoint COCO skeleton -> gen_arm_a_idle_T0228.draw_pose_skeleton_cell renders "
            "it -> ControlNetApplyAdvanced (xinsir OpenPose) "
            "+ LoraLoader(soviet_brutalism_style_v1) "
            "-> LoraLoader(player_identity_v2, chained) -> IPAdapterAdvanced (PLUS, cropped T-0209 "
            "concept panel) -> KSampler -> area descent to 48x48 -> Oklab-nearest palette "
            "quantization (dithering off, §3.1) -> per-pixel background cutout against this "
            "pose's own keypoint bbox -> orphan cleanup -> true-RGBA sprite write. This is a "
            "single static keyframe -- no sheet assembly, no second generation, no animation."
        ),
        "generator": "assets/src/character/gen_hybrid_profile_T0272.py",
        "card": "T-0272",
        "spec": "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5",
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "background_cutout_applied": True,
        "cutout_method": CUTOUT_METHOD_DESCRIPTION,
        "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
        "cutout_bbox_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
        "mechanical_gate_passed": mechanical_gate["passed"],
        "mechanical_gate": mechanical_gate,
        "layout": {"cell_px": FINAL_CELL_PX},
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
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
        help="promote an existing attempt's keyframe to assets/final/character/ and exit",
    )
    args = parser.parse_args()

    if args.promote_attempt is not None:
        out_dir = (
            REPO_ROOT / "assets" / "out" / "hybrid_profile" / f"attempt_{args.promote_attempt}"
        )
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        if not provenance["mechanical_gate_passed"]:
            raise SystemExit(
                f"attempt {args.promote_attempt} did not pass the mechanical gate -- refusing "
                "to promote"
            )
        promote_attempt(out_dir, provenance)
        promoted_record = json.loads(FINAL_PROVENANCE_PATH.read_text())
        append_attempt_log(promoted_record, notes=args.notes)
        print(f"promoted attempt {args.promote_attempt} -> {FINAL_KEYFRAME_PATH}")
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
    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_profile" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
