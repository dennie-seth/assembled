#!/usr/bin/env python3
"""Forward-limb green side reference via ControlNet/OpenPose img2img.

Originally authored for T-0380, which spent its 4-attempt cap without a
compliant image but found the cause: attempt 2 (seed 380002, denoise 0.87,
ControlNet strength/end 1.5/1.0) passed every check except one -- a second,
unrequested gloved hand at the hip, because the far arm's elbow/wrist
(reused verbatim from T-0351's `side_right_forward` rig) still projected
past the torso in a single strict-profile frame. T-0382 re-runs that exact
recipe verbatim -- this module's prompt text is deliberately still attempt
2's prompt, not T-0380's later (attempt 3/4) strengthened one -- against the
corrected skeleton in `pose_rig_forward_limb_controlnet_T0380`, which
collapses the far elbow/wrist onto the far shoulder (a zero-length limb) so
the ControlNet conditioning has no joint to hang a second hand on. See
`pose_rig_forward_limb_controlnet_T0380`'s own module docstring for why that
fix lives there and not here.

T-0355's stop-and-report (`ARM_FORWARD_LIMB_REFERENCE_ATTEMPT_LOG_T0355.md`)
originally falsified the prompt-only route for this exact pose (near arm +
near leg extended ~90 degrees, strict profile, canonical hooded-mask/glove/
boot identity): attempt 4 got costume and identity right, but the upper body
twisted to three-quarter (both eye lenses and the far fist visible) once the
pose clause had to compete with the identity clause for the same attention
budget. @DennieSeth's decisive follow-up: pose must come from a skeleton, not
the prompt.

This generator is therefore structurally different from T-0317's own
(`gen_player_profile_costume_reference_T0317.py`, plain txt2img + style LoRA,
no ControlNet, no img2img):

  - **img2img**, not txt2img: the T-0317 base image (a 175x891 green cutout on
    solid black, facing right) is composited onto a 1024x1024 black canvas
    (`compose_base_on_canvas`) and VAE-encoded into the starting latent
    (`denoise` < 1.0, so the base's own costume colour/identity survive the
    sampling pass rather than getting redrawn from noise).
  - **OpenPose ControlNet** on the authored forward-limb skeleton
    (`pose_rig_forward_limb_controlnet_T0380`, reused verbatim from the
    committed T-0351 rig's `side_right_forward`, with the far arm collapsed)
    supplies the pose structurally, the same lever T-0351's own evidence
    shows dominates a text prompt's camera-angle/pose request.
  - Style LoRA + identity LoRA chained (T-0336/T-0351's master-sheet recipe),
    **no IP-Adapter** -- the base image is already the identity/costume/
    colour reference via img2img, and IP-Adapter's own structural
    conditioning competing with ControlNet's is exactly the kind of
    attention-budget fight T-0351's evidence blames for prior pose defects.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/concept/gen_player_profile_forward_limb_controlnet_T0380.py \\
        --attempt 1 --seed 380002 --denoise 0.87 --controlnet-strength 1.5
    python3 assets/src/concept/gen_player_profile_forward_limb_controlnet_T0380.py \\
        --promote-attempt 1

Writes (always, so every attempt is logged whether it is promoted or not):
    assets/out/forward_limb_controlnet_T0382/attempt_<N>/main_1024.png
    assets/out/forward_limb_controlnet_T0382/attempt_<N>/provenance_candidate.json
    assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0382.md (appended)

Promotion writes the committed deliverable:
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
from PIL import Image

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
import pose_rig_forward_limb_controlnet_T0380 as pose_rig  # noqa: E402

BASE_IMAGE_PATH = REPO_ROOT / "assets" / "src" / "concept" / "player_profile_costume_reference_T0317.png"
BASE_IMAGE_CARD = "T-0317"

GEN_PX = 1024

STYLE_LORA_WEIGHT = 0.70
IDENTITY_LORA_WEIGHT = 0.5
DEFAULT_DENOISE = 0.87
DEFAULT_CONTROLNET_STRENGTH = 1.5
DEFAULT_CONTROLNET_END_PERCENT = 1.0

GREEN_MEASURE_CROP_SIZE = (187, 200)
BORDER_PX = 16

# Deliberately T-0380 attempt 2's prompt text verbatim -- not T-0380's later
# (attempt 3/4) strengthened wording -- per this card's own acceptance text
# ("same prompts" as attempt 2). The fix under test here is the skeleton's
# far-arm collapse (`pose_rig_forward_limb_controlnet_T0380`), not a prompt
# change.
POSITIVE_PROMPT = (
    f"{TRIGGER_TOKEN}, (a single full-body figure, exactly one pose, exactly one camera view, "
    "isolated portrait alone on a plain background:1.3), true 90-degree side profile view, not "
    "a three-quarter view, facing right, only the near arm and only the near leg extended "
    "forward at roughly a right angle clear of the torso, the far arm and far leg held back "
    "close to the body and hidden from view, one visible shoulder, a single visible arm "
    "silhouette, a single visible goggle lens, both hands empty, open palm, nothing held, "
    "(a single gloved hand reaching forward, pale light grey glove clearly lighter than the "
    "coat, fingers visible:1.2), wearing a long vivid institutional green cloth coat, coat "
    "reaching to mid-shin, well past the knee, "
    "(the raised near leg's own silhouette clearly visible pushing the coat fabric forward at "
    "the front of the stride, the coat hem swept up and forward by the forward motion of the "
    "raised knee, a visible boot beneath the lifted hem:1.3), the coat itself is green, not "
    "black, not grey, wearing a hooded mask with (a single dark round goggle lens on the near "
    "side of the hood:1.3), not a blank void, hood fully up and forward, face completely "
    "covered by the mask, no visible hair, no visible face, boots, never high heels, Soviet "
    "brutalist interior aesthetic, solid flat black background only, no scene elements, no "
    "wall, no floor, no environment, flat even lighting, no cast shadow, no atmospheric haze, "
    "no depth of field, hard value separation, dark darks and light lights, clean readable "
    "outline, game asset reference sheet style, figure silhouette study"
)

NEGATIVE_PROMPT = (
    "three-quarter view, three-quarter angle, front view, facing the camera, facing left, back "
    "view, rear view, isometric, both arms visible, second arm visible, far arm visible, both "
    "hands visible, two hands visible, both eyes visible, both eye lenses visible, two eye "
    "lenses, second lens, far eye visible, both shoulders visible, symmetric front-facing pose, "
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

# ── Graph node ids -- named, not raw string literals re-derived per call ────
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


def build_positive_prompt() -> str:
    return POSITIVE_PROMPT


def build_negative_prompt() -> str:
    return NEGATIVE_PROMPT


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
    """img2img (VAEEncode of the composited T-0317 base) + ControlNet(the
    authored forward-limb skeleton) + style/identity LoRA chain -> KSampler
    at partial denoise. No IP-Adapter -- see module docstring."""
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
            "filename_prefix": "forward_limb_controlnet_T0382_main_1024",
            "images": [VAE_DECODE_NODE_ID, 0],
        },
    }
    return g


# ── Base-image compositing (T-0317 cutout -> 1024 black canvas) ────────────


def compose_base_on_canvas(
    base_image: Image.Image, canvas_size: int = GEN_PX
) -> tuple[Image.Image, int, int]:
    """Centre `base_image` on a solid-black `canvas_size`x`canvas_size`
    canvas, returning the canvas and the exact (offset_x, offset_y) pasted --
    recorded in provenance so the compositing is reproducible, per this
    card's own acceptance criterion."""
    base_rgb = base_image.convert("RGB")
    canvas = Image.new("RGB", (canvas_size, canvas_size), (0, 0, 0))
    bw, bh = base_rgb.size
    offset_x = (canvas_size - bw) // 2
    offset_y = (canvas_size - bh) // 2
    canvas.paste(base_rgb, (offset_x, offset_y))
    return canvas, offset_x, offset_y


# ── Measurement: reuse T-0317's green predicate + a border-blackness check ──


def measure_green_content(image: Image.Image) -> dict:
    """Same centred-crop convention as T-0317's own `measure_green_content`
    (187x200, T-0272 round 5's own front-panel calibration crop size) --
    reused, not re-derived, per this card's own acceptance text."""
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
    / "ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0382.md"
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
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_forward_limb_skeleton_T0380.png"
)
SKELETON_KEYPOINTS_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_forward_limb_skeleton_T0380.json"
)

ATTEMPT_LOG_HEADER = (
    "# Forward-limb ControlNet img2img attempt log (T-0382)\n\n"
    "Re-run of T-0380 attempt 2's recipe (seed 380002, denoise 0.87, ControlNet strength/end "
    "1.5/1.0, attempt-2-era prompt) against the corrected (far-arm-collapsed) skeleton in "
    "`pose_rig_forward_limb_controlnet_T0380`. Hard cap of 3 attempts, pre-registered; see "
    "`docs/assets/evidence/T-0382/README.md` for the finding.\n\n"
    "| Attempt | Seed | Denoise | ControlNet strength/end | GPU seconds | Whole-frame green px | "
    "Centred-crop green px | Border max channel | Skeleton sha256 | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    green = provenance["green_content"]
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} | {provenance['denoise']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['gpu_seconds']} "
        f"| {green.get('whole_frame_green_pixels', 'n/a')} "
        f"| {green.get('centred_crop_green_pixels', 'n/a')} "
        f"| {provenance.get('border_max_channel', 'n/a')} "
        f"| {provenance.get('skeleton_sha256', 'n/a')} "
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
    """Render + commit the forward-limb skeleton once (keypoints JSON +
    rendered PNG) -- the "authored from committed pose-rig joints" half of
    this card's acceptance criteria. Returns (skeleton_sha256, keypoints_path
    as repo-relative str)."""
    skeleton_img = pose_rig.render_skeleton(GEN_PX)
    skeleton_img.save(SKELETON_PATH)
    SKELETON_KEYPOINTS_PATH.write_text(
        json.dumps(
            {
                "pose_key": pose_rig.POSE_KEY,
                "source_rig": "pose_rig_master_sheet_T0351.SIDE_RIGHT_FORWARD_KEYPOINTS_NORM",
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
    controlnet_strength: float = DEFAULT_CONTROLNET_STRENGTH,
    controlnet_end: float = DEFAULT_CONTROLNET_END_PERCENT,
    style_lora_weight: float = STYLE_LORA_WEIGHT,
    identity_lora_weight: float = IDENTITY_LORA_WEIGHT,
) -> dict:
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

    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_controlnet_T0382" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    base_img = Image.open(BASE_IMAGE_PATH)
    canvas, offset_x, offset_y = compose_base_on_canvas(base_img, canvas_size=GEN_PX)
    canvas_path = out_dir / "base_on_canvas_1024.png"
    canvas.save(canvas_path)

    t0 = time.monotonic()
    base_filename = upload_image(canvas_path)
    skeleton_filename = upload_image(SKELETON_PATH)
    graph = build_graph(
        seed=seed,
        base_image_filename=base_filename,
        skeleton_image_filename=skeleton_filename,
        denoise=denoise,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
    )
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id, timeout_s=300)
    gpu_seconds = time.monotonic() - t0

    main_bytes = fetch_save_image(info, SAVE_NODE_ID)
    main_path = out_dir / "main_1024.png"
    main_path.write_bytes(main_bytes)

    main_img = Image.open(main_path).convert("RGB")
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
        "comfyui_prompt_id": prompt_id,
        "method": (
            "img2img: T-0317 base image composited onto a 1024x1024 black canvas "
            "(compose_base_on_canvas) -> VAEEncode -> KSampler(denoise<1.0), conditioned by "
            "ControlNetApplyAdvanced on the authored forward-limb OpenPose skeleton "
            "(pose_rig_forward_limb_controlnet_T0380, reused from T-0351's side_right_forward "
            "rig, far arm collapsed) + LoraLoader(style) -> LoraLoader(identity), chained. No "
            "IP-Adapter."
        ),
        "generator": "assets/src/concept/gen_player_profile_forward_limb_controlnet_T0380.py",
        "card": "T-0382",
        "route": "generated",
        "spec": (
            "docs/design/13-asset-pipeline.md, T-0380's own evidence "
            "(docs/assets/evidence/T-0380/README.md) identifying the far-arm-visible defect "
            "and its fix"
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


def promote_attempt(attempt: int, notes: str = "") -> None:
    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_controlnet_T0382" / f"attempt_{attempt}"
    provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
    FINAL_PATH.write_bytes((out_dir / "main_1024.png").read_bytes())

    promoted = dict(provenance)
    promoted["concept_hash"] = hashlib.sha256(FINAL_PATH.read_bytes()).hexdigest()
    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")
    append_attempt_log(promoted, notes=notes)
    print(f"promoted attempt {attempt} -> {FINAL_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--denoise", type=float, default=DEFAULT_DENOISE)
    parser.add_argument("--controlnet-strength", type=float, default=DEFAULT_CONTROLNET_STRENGTH)
    parser.add_argument("--controlnet-end", type=float, default=DEFAULT_CONTROLNET_END_PERCENT)
    parser.add_argument("--style-lora-weight", type=float, default=STYLE_LORA_WEIGHT)
    parser.add_argument("--identity-lora-weight", type=float, default=IDENTITY_LORA_WEIGHT)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument("--promote-attempt", type=int)
    args = parser.parse_args()

    if args.promote_attempt is not None:
        promote_attempt(args.promote_attempt, notes=args.notes)
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --promote-attempt is passed")
    if not (1 <= args.attempt <= 3):
        raise SystemExit("attempt cap is 3 (this card's own pre-registered hard cap)")

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        denoise=args.denoise,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )
    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "forward_limb_controlnet_T0382" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
