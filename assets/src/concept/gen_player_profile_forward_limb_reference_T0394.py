#!/usr/bin/env python3
"""Forward-limb green side reference via ControlNet/OpenPose img2img + a
head-masked detail pass -- T-0394.

@DennieSeth, after T-0387's stop-and-report (`docs/assets/evidence/T-0387/README.md`):
the raised near leg is out of scope -- "we already have a clean single leg
in profile from earlier work, so the leg counts as solved." T-0387's own
evidence also names the lens as "a texture problem, not a pose problem":
across 6 attempts (T-0382 + T-0387) at denoise 0.87, moving skeleton eye
joints never produced a legible lens. This card's two structural changes
follow directly from that evidence:

1. **Resting near leg.** `pose_rig_forward_limb_controlnet_T0394` keeps
   T-0380/T-0382's far-arm collapse (the fix that actually worked) verbatim
   and replaces the near knee/ankle with `pose_rig_master_sheet_T0351`'s own
   committed `SIDE_NEUTRAL_KEYPOINTS_NORM` resting-leg joints -- no hip-flex
   excursion, no hand-typed numbers.

2. **A second, head-masked detail pass for the lens**, not another skeleton
   or prompt move on the full-frame pass. `run_attempt` below runs two
   ComfyUI jobs per attempt:
     a. The full-frame pose pass -- structurally identical to
        T-0380/T-0382/T-0387's own graph (img2img from the T-0317 base
        composited on a 1024 black canvas, OpenPose ControlNet on this
        card's resting-leg skeleton, style+identity LoRA chain, no
        IP-Adapter), held at this card's own floor, `DEFAULT_DENOISE = 0.87`
        -- never lowered, per this card's "Do not" list.
     b. A detail pass scoped to the head bounding box only
        (`compute_head_bbox`, computed from this card's own skeleton
        keypoints): the pose-pass output's head region is cropped, upscaled,
        re-sampled through the same checkpoint+LoRA stack (no ControlNet --
        this pass only needs the head's existing shape plus a lens-focused
        prompt) at its own denoise, `DETAIL_DENOISE`, a distinct constant
        from the pose pass's 0.87 floor. The result is composited back onto
        the pose-pass frame through `build_head_mask` -- a feathered ellipse
        that reaches zero well inside the bbox rectangle's own edges, so
        `composite_head_detail` provably leaves every pixel outside the mask
        -- arm, torso, leg, background -- byte-identical to the pose pass's
        own output. The mask itself is committed per attempt
        (`mask_path_for_attempt`) as this card's own acceptance evidence.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/concept/gen_player_profile_forward_limb_reference_T0394.py \\
        --attempt 1 --seed 380002
    python3 assets/src/concept/gen_player_profile_forward_limb_reference_T0394.py \\
        --promote-attempt 1

Writes (always, so every attempt is logged whether it is promoted or not):
    assets/out/forward_limb_reference_T0394/attempt_<N>/pose_pass_1024.png
    assets/out/forward_limb_reference_T0394/attempt_<N>/head_crop_upscaled.png
    assets/out/forward_limb_reference_T0394/attempt_<N>/head_detail_upscaled.png
    assets/out/forward_limb_reference_T0394/attempt_<N>/main_1024.png
    assets/out/forward_limb_reference_T0394/attempt_<N>/provenance_candidate.json
    assets/src/concept/player_profile_forward_limb_head_mask_T0394_attempt_<N>.png (committed)
    assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0394.md (appended)

Promotion writes the committed deliverable (same target filename T-0382 and
T-0387's own acceptance text named, never reached since both stopped and
reported):
    assets/src/concept/player_profile_forward_limb_reference_controlnet.png
    assets/src/concept/player_profile_forward_limb_reference_controlnet.provenance.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "assets" / "src" / "character"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    fetch_save_image,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)
from gen_pose_authority_idle_T0249 import (  # noqa: E402
    IDENTITY_LORA_NAME,
    IDENTITY_LORA_PATH,
    TRIGGER_TOKEN,
)
from green_content import count_green_pixels  # noqa: E402
import pose_rig_forward_limb_controlnet_T0394 as pose_rig  # noqa: E402

BASE_IMAGE_PATH = REPO_ROOT / "assets" / "src" / "concept" / "player_profile_costume_reference_T0317.png"
BASE_IMAGE_CARD = "T-0317"

GEN_PX = 1024

STYLE_LORA_WEIGHT = 0.70
IDENTITY_LORA_WEIGHT = 0.5
# Fixed recipe -- T-0394's own "Do not lower the full-frame pose pass below
# denoise 0.87": every prior card already measured that trade.
DEFAULT_DENOISE = 0.87
DEFAULT_CONTROLNET_STRENGTH = 1.5
DEFAULT_CONTROLNET_END_PERCENT = 1.0
MAX_ATTEMPTS = 3

# Detail pass -- its own recorded strength, distinct from the pose pass's
# held floor. "That is not 'lowering denoise'; lowering the full-frame pass
# is" (this card's own acceptance text).
DETAIL_DENOISE = 0.55
DETAIL_WORK_PX = 512

GREEN_MEASURE_CROP_SIZE = (187, 200)
BORDER_PX = 16

# ── Head bounding-box geometry (normalised, as a fraction of GEN_PX) ───────
HEAD_BBOX_HALF_WIDTH_FRAC = 0.11
HEAD_BBOX_MARGIN_ABOVE_FRAC = 0.09
HEAD_BBOX_MARGIN_BELOW_FRAC = 0.03

_NOSE, _NECK = 0, 1
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17
_HEAD_JOINTS = (_NOSE, _NECK, _R_EYE, _L_EYE, _R_EAR, _L_EAR)

# T-0382's attempt-2-era prompt (also T-0387's own baseline before its own
# lens/leg rewrites), with exactly one clause replaced: the leg. Per this
# card's own "isolate one lever" discipline (T-0387's own precedent), the
# arm clause -- the working single-arm fix -- is reused verbatim, unchanged
# from every prior card in this line.
POSITIVE_PROMPT = (
    f"{TRIGGER_TOKEN}, (a single full-body figure, exactly one pose, exactly one camera view, "
    "isolated portrait alone on a plain background:1.3), true 90-degree side profile view, not "
    "a three-quarter view, facing right, only the near arm extended forward at roughly a right "
    "angle clear of the torso, the far arm held back close to the body and hidden from view, "
    "the near leg resting flat in a relaxed standing stance, straight and close to vertical in "
    "profile, the far leg held back close to the body and hidden from view, one visible "
    "shoulder, a single visible arm silhouette, a single visible goggle lens, both hands empty, "
    "open palm, nothing held, "
    "(a single gloved hand reaching forward, pale light grey glove clearly lighter than the "
    "coat, fingers visible:1.2), wearing a long vivid institutional green cloth coat, coat "
    "reaching to mid-shin, well past the knee, "
    "(the near leg resting naturally at ease, weight settled straight down through the leg, no "
    "forward kick, no lifted hem, the coat hanging straight and even past the leg, a visible "
    "boot beneath the hem:1.3), the coat itself is green, not black, not grey, wearing a hooded "
    "mask with (a single dark round goggle lens on the near side of the hood:1.3), not a blank "
    "void, hood fully up and forward, face completely covered by the mask, no visible hair, no "
    "visible face, boots, never high heels, Soviet brutalist interior aesthetic, solid flat "
    "black background only, no scene elements, no wall, no floor, no environment, flat even "
    "lighting, no cast shadow, no atmospheric haze, no depth of field, hard value separation, "
    "dark darks and light lights, clean readable outline, game asset reference sheet style, "
    "figure silhouette study"
)

NEGATIVE_PROMPT = (
    "three-quarter view, three-quarter angle, front view, facing the camera, facing left, back "
    "view, rear view, isometric, both arms visible, second arm visible, far arm visible, both "
    "hands visible, two hands visible, both eyes visible, both eye lenses visible, two eye "
    "lenses, second lens, far eye visible, both shoulders visible, symmetric front-facing pose, "
    "raised leg, lifted leg, kicking pose, high kick, striding leg, leg mid-stride, hem swept "
    "up, hem lifted, "
    "mid-hip coat, cropped coat, short coat, coat above the knee, bare thigh, no coat, blank "
    "head, faceless, featureless mannequin head, missing face, no face, headless, weapon, "
    "holding an object, tool in hand, high heels, stiletto heels, pumps, "
    "grey tactical costume, tan tactical costume, khaki uniform, army fatigues, muted olive "
    "costume, brownish coat, washed out colour, pale colour, desaturated coat, grayscale, black "
    "coat, grey coat, black armor, monochrome, colourless, "
    "perspective, vanishing point, receding walls, atmospheric haze, depth of field, sky, "
    "clouds, foliage, scene, composed illustration, photorealistic, 3d render, soft gradient "
    "lighting, ambient occlusion, painterly, cartoon, cheerful, grey background, concrete "
    "background, wall, floor, environment, scenery, "
    "multiple figures, two figures, group of people, "
    "text, watermark, signature, blurry, low quality"
)

# Detail pass -- a focused, head-only prompt. No pose language, no identity
# elements beyond the hood/mask/lens themselves.
DETAIL_POSITIVE_PROMPT = (
    f"{TRIGGER_TOKEN}, close-up detail of a hooded mask in strict side profile, (a single dark "
    "round convex circular goggle lens set into the near side of the hood, clearly visible, "
    "glossy glass highlight, thin metal rim:1.4), not a strap, not a blindfold, not a flat void, "
    "hood fabric texture, Soviet brutalist aesthetic, solid flat black background only, hard "
    "value separation, dark darks and light lights, clean readable outline, game asset "
    "reference sheet style"
)

DETAIL_NEGATIVE_PROMPT = (
    "two lenses, both lenses visible, second lens, symmetric lenses, strap across the face, "
    "blindfold, fabric band over the eyes, blank head, featureless mannequin head, missing "
    "face, no face, headless, front view, three-quarter view, "
    "perspective, vanishing point, photorealistic, 3d render, soft gradient lighting, painterly, "
    "cartoon, text, watermark, signature, blurry, low quality"
)

# ── Graph node ids (pose pass) -- named, not raw string literals re-derived ─
CHECKPOINT_NODE_ID = "1"
STYLE_LORA_NODE_ID = "2"
IDENTITY_LORA_NODE_ID = "3"
POSITIVE_PROMPT_NODE_ID = "4"
NEGATIVE_PROMPT_NODE_ID = "5"
BASE_IMAGE_NODE_ID = "6"
VAE_ENCODE_NODE_ID = "7"
SKELETON_IMAGE_NODE_ID = "8"
CONTROLNET_LOADER_NODE_ID = "9"
CONTROLNET_APPLY_NODE_ID = "10"
SAMPLER_NODE_ID = "11"
VAE_DECODE_NODE_ID = "12"
SAVE_NODE_ID = "13"

# ── Graph node ids (detail pass) -- a separate, smaller graph, no ControlNet ─
DETAIL_CHECKPOINT_NODE_ID = "1"
DETAIL_STYLE_LORA_NODE_ID = "2"
DETAIL_IDENTITY_LORA_NODE_ID = "3"
DETAIL_POSITIVE_PROMPT_NODE_ID = "4"
DETAIL_NEGATIVE_PROMPT_NODE_ID = "5"
DETAIL_IMAGE_NODE_ID = "6"
DETAIL_VAE_ENCODE_NODE_ID = "7"
DETAIL_SAMPLER_NODE_ID = "8"
DETAIL_VAE_DECODE_NODE_ID = "9"
DETAIL_SAVE_NODE_ID = "10"


def build_positive_prompt() -> str:
    return POSITIVE_PROMPT


def build_negative_prompt() -> str:
    return NEGATIVE_PROMPT


def build_detail_positive_prompt() -> str:
    return DETAIL_POSITIVE_PROMPT


def build_detail_negative_prompt() -> str:
    return DETAIL_NEGATIVE_PROMPT


def build_graph(
    seed: int,
    base_image_filename: str,
    skeleton_image_filename: str,
    denoise: float,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float = STYLE_LORA_WEIGHT,
    identity_lora_weight: float = IDENTITY_LORA_WEIGHT,
) -> dict:
    """img2img (VAEEncode of the composited T-0317 base) + ControlNet(this
    card's resting-leg skeleton) + style/identity LoRA chain -> KSampler at
    partial denoise. Structurally identical to T-0380/T-0382/T-0387's own
    graph; only the pose/prompt inputs differ per card."""
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
    g[IDENTITY_LORA_NODE_ID] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": [STYLE_LORA_NODE_ID, 0],
            "clip": [STYLE_LORA_NODE_ID, 1],
            "lora_name": IDENTITY_LORA_NAME,
            "strength_model": identity_lora_weight,
            "strength_clip": identity_lora_weight,
        },
    }
    g[POSITIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": build_positive_prompt(), "clip": [IDENTITY_LORA_NODE_ID, 1]},
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": build_negative_prompt(), "clip": [IDENTITY_LORA_NODE_ID, 1]},
    }
    g[BASE_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": base_image_filename},
    }
    g[VAE_ENCODE_NODE_ID] = {
        "class_type": "VAEEncode",
        "inputs": {"pixels": [BASE_IMAGE_NODE_ID, 0], "vae": [CHECKPOINT_NODE_ID, 2]},
    }
    g[SKELETON_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": skeleton_image_filename},
    }
    g[CONTROLNET_LOADER_NODE_ID] = {
        "class_type": "ControlNetLoader",
        "inputs": {"control_net_name": CONTROLNET_NAME},
    }
    g[CONTROLNET_APPLY_NODE_ID] = {
        "class_type": "ControlNetApplyAdvanced",
        "inputs": {
            "positive": [POSITIVE_PROMPT_NODE_ID, 0],
            "negative": [NEGATIVE_PROMPT_NODE_ID, 0],
            "control_net": [CONTROLNET_LOADER_NODE_ID, 0],
            "image": [SKELETON_IMAGE_NODE_ID, 0],
            "strength": controlnet_strength,
            "start_percent": 0.0,
            "end_percent": controlnet_end,
        },
    }
    g[SAMPLER_NODE_ID] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [IDENTITY_LORA_NODE_ID, 0],
            "positive": [CONTROLNET_APPLY_NODE_ID, 0],
            "negative": [CONTROLNET_APPLY_NODE_ID, 1],
            "latent_image": [VAE_ENCODE_NODE_ID, 0],
            "seed": seed,
            "steps": 30,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": denoise,
        },
    }
    g[VAE_DECODE_NODE_ID] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": [SAMPLER_NODE_ID, 0], "vae": [CHECKPOINT_NODE_ID, 2]},
    }
    g[SAVE_NODE_ID] = {
        "class_type": "SaveImage",
        "inputs": {
            "filename_prefix": "forward_limb_reference_T0394_pose_pass_1024",
            "images": [VAE_DECODE_NODE_ID, 0],
        },
    }
    return g


def build_detail_graph(
    seed: int,
    crop_image_filename: str,
    denoise: float,
    style_lora_weight: float = STYLE_LORA_WEIGHT,
    identity_lora_weight: float = IDENTITY_LORA_WEIGHT,
) -> dict:
    """img2img on the pose pass's own head crop -- same checkpoint/LoRA
    stack, no ControlNet. This pass only adds a texture-level feature (the
    goggle lens) on top of a head shape the pose pass already got right; it
    does not need pose conditioning."""
    g: dict = {}
    g[DETAIL_CHECKPOINT_NODE_ID] = {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": CHECKPOINT},
    }
    g[DETAIL_STYLE_LORA_NODE_ID] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": [DETAIL_CHECKPOINT_NODE_ID, 0],
            "clip": [DETAIL_CHECKPOINT_NODE_ID, 1],
            "lora_name": LORA_NAME,
            "strength_model": style_lora_weight,
            "strength_clip": style_lora_weight,
        },
    }
    g[DETAIL_IDENTITY_LORA_NODE_ID] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": [DETAIL_STYLE_LORA_NODE_ID, 0],
            "clip": [DETAIL_STYLE_LORA_NODE_ID, 1],
            "lora_name": IDENTITY_LORA_NAME,
            "strength_model": identity_lora_weight,
            "strength_clip": identity_lora_weight,
        },
    }
    g[DETAIL_POSITIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": build_detail_positive_prompt(), "clip": [DETAIL_IDENTITY_LORA_NODE_ID, 1]},
    }
    g[DETAIL_NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": build_detail_negative_prompt(), "clip": [DETAIL_IDENTITY_LORA_NODE_ID, 1]},
    }
    g[DETAIL_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": crop_image_filename},
    }
    g[DETAIL_VAE_ENCODE_NODE_ID] = {
        "class_type": "VAEEncode",
        "inputs": {"pixels": [DETAIL_IMAGE_NODE_ID, 0], "vae": [DETAIL_CHECKPOINT_NODE_ID, 2]},
    }
    g[DETAIL_SAMPLER_NODE_ID] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [DETAIL_IDENTITY_LORA_NODE_ID, 0],
            "positive": [DETAIL_POSITIVE_PROMPT_NODE_ID, 0],
            "negative": [DETAIL_NEGATIVE_PROMPT_NODE_ID, 0],
            "latent_image": [DETAIL_VAE_ENCODE_NODE_ID, 0],
            "seed": seed,
            "steps": 24,
            "cfg": 6.5,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": denoise,
        },
    }
    g[DETAIL_VAE_DECODE_NODE_ID] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": [DETAIL_SAMPLER_NODE_ID, 0], "vae": [DETAIL_CHECKPOINT_NODE_ID, 2]},
    }
    g[DETAIL_SAVE_NODE_ID] = {
        "class_type": "SaveImage",
        "inputs": {
            "filename_prefix": "forward_limb_reference_T0394_head_detail",
            "images": [DETAIL_VAE_DECODE_NODE_ID, 0],
        },
    }
    return g


# ── Base-image compositing (T-0317 cutout -> 1024 black canvas) ────────────


def compose_base_on_canvas(
    base_image: Image.Image, canvas_size: int = GEN_PX
) -> tuple[Image.Image, int, int]:
    """Centre `base_image` on a solid-black `canvas_size`x`canvas_size`
    canvas, returning the canvas and the exact (offset_x, offset_y) pasted --
    recorded in provenance so the compositing is reproducible."""
    base_rgb = base_image.convert("RGB")
    canvas = Image.new("RGB", (canvas_size, canvas_size), (0, 0, 0))
    bw, bh = base_rgb.size
    offset_x = (canvas_size - bw) // 2
    offset_y = (canvas_size - bh) // 2
    canvas.paste(base_rgb, (offset_x, offset_y))
    return canvas, offset_x, offset_y


# ── Head-masked detail pass geometry (pure, GPU-free) ───────────────────────


def compute_head_bbox(
    keypoints_norm: dict[int, tuple[float, float]],
    canvas_size: int,
    half_width_frac: float = HEAD_BBOX_HALF_WIDTH_FRAC,
    margin_above_frac: float = HEAD_BBOX_MARGIN_ABOVE_FRAC,
    margin_below_frac: float = HEAD_BBOX_MARGIN_BELOW_FRAC,
) -> tuple[int, int, int, int]:
    """A bounding box around the head cluster (nose/neck/eyes/ears),
    generously margined so it covers the rendered hood -- which extends
    well beyond the facial landmark keypoints themselves -- not just the
    keypoints' own tight bounds. Returns (left, top, right, bottom) in
    pixel space, clamped to the canvas."""
    xs = [keypoints_norm[j][0] for j in _HEAD_JOINTS]
    ys = [keypoints_norm[j][1] for j in _HEAD_JOINTS]
    cx = sum(xs) / len(xs)
    top_y = min(ys)
    neck_y = keypoints_norm[_NECK][1]

    left = (cx - half_width_frac) * canvas_size
    right = (cx + half_width_frac) * canvas_size
    top = (top_y - margin_above_frac) * canvas_size
    bottom = (neck_y + margin_below_frac) * canvas_size

    left = max(0, int(round(left)))
    top = max(0, int(round(top)))
    right = min(canvas_size, int(round(right)))
    bottom = min(canvas_size, int(round(bottom)))
    return left, top, right, bottom


def build_head_mask(
    size: tuple[int, int], inset_frac: float = 0.18, feather_radius: int = 10
) -> Image.Image:
    """A feathered ellipse mask ("L" mode, 0-255) inscribed well inside
    `size`'s own rectangle -- the inset guarantees the mask reaches zero
    before the rectangle's own edges, so compositing through it leaves
    everything outside the mask (including the bbox rectangle's own
    corners) untouched. This is what makes 'must not touch the arm, torso
    or leg outside its mask' a structural guarantee, not a hope."""
    w, h = size
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    inset_x = int(w * inset_frac)
    inset_y = int(h * inset_frac)
    draw.ellipse([inset_x, inset_y, w - inset_x, h - inset_y], fill=255)
    return mask.filter(ImageFilter.GaussianBlur(feather_radius))


def composite_head_detail(
    base: Image.Image,
    detail_crop: Image.Image,
    bbox: tuple[int, int, int, int],
    mask: Image.Image,
) -> Image.Image:
    """Paste `detail_crop` onto `base` at `bbox`, blended through `mask`.
    Pixels outside `bbox` are `base`'s own, untouched; pixels inside `bbox`
    but where `mask` is zero are also `base`'s own, unchanged -- only the
    mask's non-zero interior actually blends in the detail pass's output."""
    left, top, right, bottom = bbox
    region_size = (right - left, bottom - top)
    if detail_crop.size != region_size:
        detail_crop = detail_crop.resize(region_size, Image.LANCZOS)
    if mask.size != region_size:
        mask = mask.resize(region_size, Image.LANCZOS)

    result = base.copy()
    region = result.crop(bbox)
    blended = Image.composite(detail_crop, region, mask)
    result.paste(blended, (left, top))
    return result


# ── Measurement: reuse T-0317/T-0382's green predicate + border check ──────


def measure_green_content(image: Image.Image) -> dict:
    """Same centred-crop convention as T-0317/T-0382/T-0387's own
    `measure_green_content` (187x200) -- reused, not re-derived."""
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
    }


def measure_border_max_channel(image: Image.Image, border: int = BORDER_PX) -> int:
    """Max RGB channel value within the outer `border`-px band -- the
    acceptance check's own measurement for 'solid black background'."""
    arr = np.array(image.convert("RGB"))
    band = np.concatenate(
        [
            arr[:border, :, :].reshape(-1, 3),
            arr[-border:, :, :].reshape(-1, 3),
            arr[:, :border, :].reshape(-1, 3),
            arr[:, -border:, :].reshape(-1, 3),
        ]
    )
    return int(band.max())


# ── Attempt log + promotion ──────────────────────────────────────────────────

ATTEMPT_LOG_PATH = (
    REPO_ROOT
    / "assets"
    / "src"
    / "concept"
    / "ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0394.md"
)
FINAL_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_forward_limb_reference_controlnet.png"
)
FINAL_PROVENANCE_PATH = (
    REPO_ROOT
    / "assets"
    / "src"
    / "concept"
    / "player_profile_forward_limb_reference_controlnet.provenance.json"
)
SKELETON_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_forward_limb_skeleton_T0394.png"
)
SKELETON_KEYPOINTS_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_forward_limb_skeleton_T0394.json"
)


def mask_path_for_attempt(attempt: int) -> Path:
    return (
        REPO_ROOT
        / "assets"
        / "src"
        / "concept"
        / f"player_profile_forward_limb_head_mask_T0394_attempt_{attempt}.png"
    )


ATTEMPT_LOG_HEADER = (
    "# Forward-limb reference attempt log (T-0394)\n\n"
    "Continues T-0387's stop-and-report (`docs/assets/evidence/T-0387/README.md`): the "
    "full-frame pose pass stays at denoise 0.87 (never lowered), ControlNet strength/end "
    "1.5/1.0, T-0382's style/identity LoRA stack (0.70/0.50, no IP-Adapter), 1024, on "
    "T-0380/T-0382's far-arm-collapsed skeleton. Two structural changes: the near leg is reset "
    "to `pose_rig_master_sheet_T0351`'s own committed resting stance (no hip-flex excursion -- "
    "the raised leg is out of scope per @DennieSeth's design change), and the goggle lens is "
    "produced by a second pass masked to the head bounding box only "
    "(`compute_head_bbox`/`build_head_mask`/`composite_head_detail`), not another skeleton or "
    "prompt move on the full-frame pass. Hard cap of 3 attempts, pre-registered.\n\n"
    "| Attempt | Seed | Pose denoise | Detail denoise | ControlNet strength/end | GPU seconds "
    "(pose+detail) | Whole-frame green px | Centred-crop green px | Border max channel | "
    "Skeleton sha256 | Mask path | What changed | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, change: str = "", notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    green = provenance["green_content"]
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} | {provenance['denoise']} "
        f"| {provenance['detail_pass_denoise']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['gpu_seconds']} "
        f"| {green.get('whole_frame_green_pixels', 'n/a')} "
        f"| {green.get('centred_crop_green_pixels', 'n/a')} "
        f"| {provenance.get('border_max_channel', 'n/a')} "
        f"| {provenance.get('skeleton_sha256', 'n/a')} "
        f"| {provenance.get('detail_pass_mask_path', 'n/a')} "
        f"| {change} "
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


def author_skeleton() -> tuple[str, str]:
    """Render + commit the resting-leg forward-limb skeleton once
    (keypoints JSON + rendered PNG). Returns (skeleton_sha256, keypoints_path
    as repo-relative str)."""
    skeleton_img = pose_rig.render_skeleton(GEN_PX)
    skeleton_img.save(SKELETON_PATH)
    SKELETON_KEYPOINTS_PATH.write_text(
        json.dumps(
            {
                "pose_key": pose_rig.POSE_KEY,
                "source_rig": (
                    "pose_rig_forward_limb_controlnet_T0380.FORWARD_LIMB_KEYPOINTS_NORM, near "
                    "knee/ankle overridden to pose_rig_master_sheet_T0351."
                    "SIDE_NEUTRAL_KEYPOINTS_NORM (resting leg, no hip-flex excursion)"
                ),
                "thigh_angle_degrees_from_horizontal": pose_rig.thigh_angle_degrees_from_horizontal(),
                "keypoints": pose_rig.keypoints_to_coco_list(),
            },
            indent=2,
        )
        + "\n"
    )
    return sha256_of(SKELETON_PATH), str(SKELETON_KEYPOINTS_PATH.relative_to(REPO_ROOT))


def run_attempt(
    attempt: int,
    seed: int,
    denoise: float = DEFAULT_DENOISE,
    detail_denoise: float = DETAIL_DENOISE,
    controlnet_strength: float = DEFAULT_CONTROLNET_STRENGTH,
    controlnet_end: float = DEFAULT_CONTROLNET_END_PERCENT,
    style_lora_weight: float = STYLE_LORA_WEIGHT,
    identity_lora_weight: float = IDENTITY_LORA_WEIGHT,
) -> dict:
    if denoise < 0.87:
        raise SystemExit(
            f"pose-pass denoise {denoise} is below this card's own held floor of 0.87 -- "
            "'Do not lower the full-frame pose pass below denoise 0.87' is non-negotiable "
            "for T-0394"
        )
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")
    if not BASE_IMAGE_PATH.exists():
        raise RuntimeError(f"T-0317 base image not found: {BASE_IMAGE_PATH}")
    if not IDENTITY_LORA_PATH.exists():
        raise RuntimeError(f"identity LoRA not found: {IDENTITY_LORA_PATH}")

    base_sha256 = sha256_of(BASE_IMAGE_PATH)
    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)
    skeleton_sha256, keypoints_relpath = author_skeleton()

    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_reference_T0394" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    base_img = Image.open(BASE_IMAGE_PATH)
    canvas, offset_x, offset_y = compose_base_on_canvas(base_img, canvas_size=GEN_PX)
    canvas_path = out_dir / "base_on_canvas_1024.png"
    canvas.save(canvas_path)

    t0 = time.monotonic()

    # ── Stage A: full-frame pose pass ───────────────────────────────────
    base_filename = upload_image(canvas_path)
    skeleton_filename = upload_image(SKELETON_PATH)
    pose_graph = build_graph(
        seed=seed,
        base_image_filename=base_filename,
        skeleton_image_filename=skeleton_filename,
        denoise=denoise,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
    )
    pose_prompt_id = submit_prompt(pose_graph)
    pose_info = wait_for_completion(pose_prompt_id, timeout_s=300)
    pose_pass_gpu_seconds = time.monotonic() - t0

    pose_bytes = fetch_save_image(pose_info, SAVE_NODE_ID)
    pose_pass_path = out_dir / "pose_pass_1024.png"
    pose_pass_path.write_bytes(pose_bytes)
    pose_pass_img = Image.open(pose_pass_path).convert("RGB")

    # ── Stage B: head-masked detail pass ────────────────────────────────
    t1 = time.monotonic()
    bbox = compute_head_bbox(pose_rig.keypoints(), canvas_size=GEN_PX)
    head_crop = pose_pass_img.crop(bbox)
    head_crop_upscaled = head_crop.resize((DETAIL_WORK_PX, DETAIL_WORK_PX), Image.LANCZOS)
    head_crop_path = out_dir / "head_crop_upscaled.png"
    head_crop_upscaled.save(head_crop_path)

    crop_filename = upload_image(head_crop_path)
    detail_graph = build_detail_graph(
        seed=seed,
        crop_image_filename=crop_filename,
        denoise=detail_denoise,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
    )
    detail_prompt_id = submit_prompt(detail_graph)
    detail_info = wait_for_completion(detail_prompt_id, timeout_s=300)
    detail_pass_gpu_seconds = time.monotonic() - t1

    detail_bytes = fetch_save_image(detail_info, DETAIL_SAVE_NODE_ID)
    detail_upscaled_path = out_dir / "head_detail_upscaled.png"
    detail_upscaled_path.write_bytes(detail_bytes)
    detail_upscaled_img = Image.open(detail_upscaled_path).convert("RGB")

    # ── Composite: detail pass blended back through the head mask only ──
    left, top, right, bottom = bbox
    region_size = (right - left, bottom - top)
    detail_resized = detail_upscaled_img.resize(region_size, Image.LANCZOS)
    mask = build_head_mask(region_size)
    mask_path = mask_path_for_attempt(attempt)
    mask.save(mask_path)

    main_img = composite_head_detail(pose_pass_img, detail_resized, bbox, mask)
    main_path = out_dir / "main_1024.png"
    main_img.save(main_path)

    gpu_seconds = pose_pass_gpu_seconds + detail_pass_gpu_seconds

    green_content = measure_green_content(main_img)
    border_max_channel = measure_border_max_channel(main_img)

    provenance = {
        "model": (
            f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) + LoRA "
            f"{IDENTITY_LORA_NAME} (identity, chained, weight {identity_lora_weight}) + "
            f"ControlNet {CONTROLNET_NAME}"
        ),
        "model_license": (
            f"{CHECKPOINT_LICENSE} (base) / {LORA_LICENSE} (style + identity LoRA)"
        ),
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "identity_lora_name": IDENTITY_LORA_NAME,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": identity_lora_weight,
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": build_positive_prompt(),
        "negative_prompt": build_negative_prompt(),
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "denoise": denoise,
        "width": GEN_PX,
        "height": GEN_PX,
        "sampler": "euler",
        "scheduler": "normal",
        "comfyui_prompt_id": pose_prompt_id,
        "detail_pass_mechanism": (
            "masked img2img detailer pass scoped to the head bounding box (feathered ellipse "
            "mask, zero at the bbox rectangle's own edges), same checkpoint+LoRA stack, no "
            "ControlNet -- composited back through the mask so every pixel outside it is "
            "byte-identical to the pose pass's own output"
        ),
        "detail_pass_prompt": build_detail_positive_prompt(),
        "detail_pass_negative_prompt": build_detail_negative_prompt(),
        "detail_pass_denoise": detail_denoise,
        "detail_pass_seed": seed,
        "detail_pass_bbox": [left, top, right, bottom],
        "detail_pass_mask_path": str(mask_path.relative_to(REPO_ROOT)),
        "detail_pass_work_px": DETAIL_WORK_PX,
        "detail_pass_comfyui_prompt_id": detail_prompt_id,
        "detail_pass_gpu_seconds": round(detail_pass_gpu_seconds, 1),
        "pose_pass_gpu_seconds": round(pose_pass_gpu_seconds, 1),
        "method": (
            "Two ComfyUI passes: (1) img2img: T-0317 base image composited onto a 1024x1024 "
            "black canvas (compose_base_on_canvas) -> VAEEncode -> KSampler(denoise=0.87), "
            "conditioned by ControlNetApplyAdvanced on the resting-leg forward-limb OpenPose "
            "skeleton (pose_rig_forward_limb_controlnet_T0394) + LoraLoader(style) -> "
            "LoraLoader(identity), chained, no IP-Adapter. (2) A head-only detail pass: crop "
            "the pose pass's own head bounding box (compute_head_bbox), upscale, re-sample "
            "through the same checkpoint+LoRA stack at its own denoise (no ControlNet), "
            "composite back through a feathered ellipse mask (build_head_mask, "
            "composite_head_detail) so only the mask's interior changes."
        ),
        "generator": "assets/src/concept/gen_player_profile_forward_limb_reference_T0394.py",
        "card": "T-0394",
        "route": "generated",
        "spec": (
            "docs/design/13-asset-pipeline.md, T-0387's own stop-and-report "
            "(docs/assets/evidence/T-0387/README.md) identifying the goggle-lens as a texture "
            "problem and the raised leg as out of scope; this card's fix"
        ),
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "green_content": green_content,
        "border_max_channel": border_max_channel,
        "base_image_path": str(BASE_IMAGE_PATH.relative_to(REPO_ROOT)),
        "base_image_sha256": base_sha256,
        "base_image_card": BASE_IMAGE_CARD,
        "base_composite_offset": {"x": offset_x, "y": offset_y, "canvas_size": GEN_PX},
        "skeleton_path": str(SKELETON_PATH.relative_to(REPO_ROOT)),
        "skeleton_sha256": skeleton_sha256,
        "skeleton_keypoints_path": keypoints_relpath,
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def promote_attempt(attempt: int, notes: str = "", change: str = "") -> None:
    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_reference_T0394" / f"attempt_{attempt}"
    provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
    FINAL_PATH.write_bytes((out_dir / "main_1024.png").read_bytes())

    promoted = dict(provenance)
    promoted["concept_hash"] = hashlib.sha256(FINAL_PATH.read_bytes()).hexdigest()
    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")
    append_attempt_log(promoted, change=change, notes=notes)
    print(f"promoted attempt {attempt} -> {FINAL_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--denoise", type=float, default=DEFAULT_DENOISE)
    parser.add_argument("--detail-denoise", type=float, default=DETAIL_DENOISE)
    parser.add_argument("--controlnet-strength", type=float, default=DEFAULT_CONTROLNET_STRENGTH)
    parser.add_argument("--controlnet-end", type=float, default=DEFAULT_CONTROLNET_END_PERCENT)
    parser.add_argument("--style-lora-weight", type=float, default=STYLE_LORA_WEIGHT)
    parser.add_argument("--identity-lora-weight", type=float, default=IDENTITY_LORA_WEIGHT)
    parser.add_argument("--change", type=str, default="")
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument("--promote-attempt", type=int)
    args = parser.parse_args()

    if args.promote_attempt is not None:
        promote_attempt(args.promote_attempt, notes=args.notes, change=args.change)
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --promote-attempt is passed")
    if not (1 <= args.attempt <= MAX_ATTEMPTS):
        raise SystemExit(f"attempt cap is {MAX_ATTEMPTS} (this card's own pre-registered hard cap)")

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        denoise=args.denoise,
        detail_denoise=args.detail_denoise,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )
    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_reference_T0394" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, change=args.change, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
