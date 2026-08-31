#!/usr/bin/env python3
"""Hybrid walk-cycle generation (T-0259, HANDOFF §24-e, DL-25's winning arm).

Successor to `player_move_sheet_v2` (predates the hybrid pipeline entirely --
mode 'P', no alpha, no Arm-C comparison). Ships under a new filename,
`player_walk_sheet_hybrid.png` -- the old sheet stays committed and
untouched; the atlas switch to the new sheet is a separate card.

**Why this is its own script, not a generalisation of
`gen_hybrid_idle_T0252.py`.** The idle hybrid recipe generates exactly ONE
SDXL frame and derives every other frame by translating that one frame's own
pixel bands (Arm C's `_player_pose_offsets`, reused unchanged) -- a
band-translate can shift a costume block sideways, but it cannot bend a knee
or swing an arm through a different angle, which a walk gait needs every
frame. That is a different pipeline mechanism, not a parameter of the same
one, so generalising `gen_hybrid_idle_T0252.py` would distort it rather than
extend it. Instead this script follows the same precedent every other
round-2 arm already set (Arm A, Arm B, pose-authority, hybrid-source: each
owns its own `build_graph` + prompt constants, reusing the checkpoint/LoRA/
ControlNet identifiers and HTTP client helpers via import, never a shared
parametrised generator) -- structurally closest to
`gen_pose_authority_idle_T0249.py` (real per-frame generation, one KSampler
call per frame, script-authored skeleton), extended with the identity LoRA +
IP-Adapter + per-frame cutout `gen_hybrid_source_idle_T0252.py` already
proved out for this same character.

Per frame: LoraLoader(style) -> LoraLoader(identity, chained) ->
IPAdapterAdvanced(concept sheet) -> ControlNet(this frame's script-authored
walk skeleton, `pose_rig_walk_T0259.py`) -> KSampler at 384x384 -> area
descent to 48x48 -> per-frame background cutout (this frame's own keypoints'
bounding box) -> assembled into a 4x2 sheet (192x96) -> Oklab-nearest
palette quantization (dithering off, §3.1) -> orphan cleanup -> true-RGBA
sprite write (`char_gen.sprite_io.save_sprite_sheet`, P-6).

**Identity anchoring (two committed references).** The approved concept
sheet (`assets/src/concept/player_character_concept_sheet_v1.png`, T-0209)
is fed through IP-Adapter exactly as the idle recipe does -- same node,
same weight convention. The canonical idle keyframe DL-25 promoted
(`assets/final/character/player_idle_sheet_hybrid_T0252.png`, T-0252) is
NOT a second IP-Adapter input -- stacking a second reference image through
the same IPAdapterAdvanced node is untested on this ComfyUI host and would
spend one of the 8 attempts on a wiring gamble instead of the actual gait.
It is recorded as `identity_anchor` (path + hash) so "the new motion must
read as the same character as this sheet" is a checkable claim, and is the
sheet a human (or this script's own curation pass, via the Read tool) holds
the generated walk frames against before promoting an attempt.

**Chunked and resumable (T-0266).** Measured per-frame cost from real
ComfyUI history is ~100s/frame (95.2s, 100.4s, 118.0s), so an 8-frame sheet
is ~14 minutes -- longer than a single foreground shell call's 10-minute
cap. This script generates at most `--max-frames` frames per invocation
(default `char_gen.chunked_frames.DEFAULT_MAX_FRAMES`, derived from that
measured cost) and skips any frame already complete on disk, via the
shared `char_gen.chunked_frames` module every §24-e per-frame generator
uses. **Drive a sheet to completion with sequential foreground calls of
the identical command, inside one implementer session** -- never
`run_in_background: true` followed by ending the turn; the background
child is torn down with the session and orphans the run mid-sheet with no
resume logic reachable from outside that session (this is exactly how
T-0259 got stuck at signature `3f1568f9...` twice). Each call prints
whether the sheet is complete yet; re-run the same command until it is.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_v2.safetensors -- T-0248 -- is loadable by ComfyUI's
LoraLoader):
    python3 assets/src/character/gen_hybrid_walk_T0259.py --attempt 1 --seed 31416
    python3 assets/src/character/gen_hybrid_walk_T0259.py --attempt 1 --seed 31416  # resume
    python3 assets/src/character/gen_hybrid_walk_T0259.py --attempt 1 --promote-attempt 1

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/hybrid_walk/attempt_<N>/frame_<i>_pose_skeleton_384.png  (x8)
    assets/out/hybrid_walk/attempt_<N>/frame_<i>_keypoints.json         (x8)
    assets/out/hybrid_walk/attempt_<N>/frame_<i>_main_384.png           (x8)
    assets/out/hybrid_walk/attempt_<N>/frame_<i>_meta.json              (x8, resume bookkeeping)
    assets/out/hybrid_walk/attempt_<N>/sheet_192x96_indexed.png
    assets/out/hybrid_walk/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md (appended, once complete)

Promotion to assets/final/character/ (only for an attempt whose mechanical
gate passes) is a separate, explicit step -- a discarded attempt's bytes
never land in assets/final/, even transiently. Promotion also re-homes the
promoted attempt's per-frame ControlNet conditioning inputs from the
gitignored assets/out/ into a committed evidence directory under
assets/src/, since the promoted provenance's file references must resolve
on a fresh clone.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
# comfy-client is not a declared dependency of this package's pyproject.toml
# (char-gen only lists pillow/numpy) -- same informal sys.path convention
# already used for asset-gate above. CHR-1's shared apply_arm_c_benchmark_fields
# helper (T-0258) lives in comfy_client.provenance_sidecar.
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pose_rig_walk_T0259  # noqa: E402
from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402
from comfy_client.provenance_sidecar import apply_arm_c_benchmark_fields  # noqa: E402

# Reused directly from Arm A (T-0228) -- checkpoint/ControlNet identifiers,
# HTTP client helpers, and the §3.1 descent/cleanup chain are unchanged.
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONCEPT_SHEET_PATH,
    CONTROLNET_NAME,
    EXPECTED_CONCEPT_HASH,
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

# Reused directly from T-0250's own fix for the identical background-clutter
# defect (see gen_hybrid_source_idle_T0252.py, which applies these same
# functions to its own single source frame): a border-connected Oklab-tolerant
# flood over each frame's own 384x384 sampled image, unioned with "outside
# this frame's own keypoint bounding box + margin".
from gen_chained_idle_T0250 import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_METHOD_DESCRIPTION,
    CUTOUT_OKLAB_TOLERANCE,
    apply_background_hold,
    apply_cutout_masks,
    background_hold_mask,
    cutout_foreground_mask,
    downscale_mask,
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

from char_gen import chunked_frames  # noqa: E402
from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

FINAL_CELL_PX = 48  # native cell size -- DL-21 output spec, unchanged
GEN_PX = FINAL_CELL_PX * 8  # 384 -- same x8 descent ratio as every round-2 per-frame path

FRAME_COUNT = pose_rig_walk_T0259.FRAME_COUNT  # 8
COLS = 4
ROWS = 2
SHEET_W = FINAL_CELL_PX * COLS  # 192
SHEET_H = FINAL_CELL_PX * ROWS  # 96
# Row-major reading order, one frame per cell, no unused cell (4x2 is an
# exact fit for 8 frames -- see this card's own note on layout choice).
FRAME_CELLS: list[tuple[int, int]] = [(r, c) for r in range(ROWS) for c in range(COLS)]

# IP-Adapter identity reference crop (T-0266 recipe finding). The full
# concept sheet (assets/src/concept/player_character_concept_sheet_v1.png,
# T-0209) is a ~24-panel costume/turnaround grid, not a single clean
# identity image. Attempts 1-2 fed that WHOLE grid into IPAdapterAdvanced;
# visual inspection of the raw frames showed each independently-sampled
# frame partially reproducing the grid's own panel/gutter structure (a
# duplicated prop-like shape recurring per quadrant) -- IP-Adapter's
# image-level conditioning leaking the sheet's own layout, which text
# negative prompting cannot reach. This box crops out one clean front-on
# panel (green coat, front view -- row 3, column 1 of the sheet) so
# IP-Adapter conditions on the character alone.
IDENTITY_REFERENCE_CROP_BOX = (8, 298, 195, 498)  # left, upper, right, lower

MAX_FRAME_DELTA_RATIO = 0.30  # same cap every round-2 arm uses (DL-21 criterion 2)
# The Arm-C benchmark pair itself is derived by apply_arm_c_benchmark_fields
# (comfy_client.provenance_sidecar, CHR-1's single shared home, T-0258).

# The two *output* files that make a frame complete, per char_gen.chunked_frames'
# contract -- deliberately excludes frame_{i}_keypoints.json/frame_{i}_pose_skeleton_384.png
# (that frame's *inputs*, written before generation) so a frame killed after its inputs
# landed but before ComfyUI returned is always regenerated, never skipped (T-0259's defect).
REQUIRED_OUTPUT_NAMES = ("frame_{i}_main_384.png", "frame_{i}_cell_48_raw.png")

WALK_PROMPT = (
    f"{TRIGGER_TOKEN}, pixel art walk cycle animation frame, single figure mid-stride walking, "
    "flat front-on orthographic view, exactly one figure matching the pose skeleton exactly, "
    "same uniform and same equipment loadout, one leg forward and one leg back, weight-bearing "
    "stance on the planted leg, natural arm swing opposite the forward leg, "
    "value-separated pixel art silhouette, clean readable pixel outline, solid flat black "
    "background, no perspective, no vanishing point, no text, no UI"
)
WALK_NEGATIVE = IDLE_MAIN_NEGATIVE

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
# img2img chain nodes (T-0266) -- only present on frames 1+'s submitted
# graph, in place of LATENT_NODE_ID. Same ids gen_chained_idle_T0250 uses
# for the analogous nodes on its own graph.
INIT_IMAGE_NODE_ID = "30"
VAE_ENCODE_NODE_ID = "31"

# Default denoise for the img2img chain (T-0266, iter 3). Idle's own chained
# arm (T-0250) settled on 0.15-0.30 for a near-static breathing pose; a walk
# gait swings limbs through a much larger structural change frame to frame,
# so a higher value is chosen here to leave the sampler enough of the
# schedule to actually relocate limbs against the ControlNet skeleton rather
# than being biased toward frame 0's own pose. Not yet swept -- first real
# attempt at this value, adjust per its own attempt-log result.
DEFAULT_DENOISE = 0.45


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
    """One frame, one figure, the full §24-e stack: LoraLoader(style) ->
    LoraLoader(identity, chained) -> IPAdapterAdvanced(concept) ->
    ControlNet(this frame's own walk-skeleton image) -> KSampler at
    384x384 -> area descent to 48x48. Mirrors
    gen_hybrid_source_idle_T0252.build_graph's wiring exactly (same four
    conditioning mechanisms, same node shapes) -- this script's own
    contribution is calling it once per walk-gait frame instead of once
    for a single idle keyframe, with a walk-specific prompt.
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
        "inputs": {"text": WALK_PROMPT, "clip": [IDENTITY_LORA_NODE_ID, 1]},
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": WALK_NEGATIVE, "clip": [IDENTITY_LORA_NODE_ID, 1]},
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
        "inputs": {
            "filename_prefix": "hybrid_walk_T0259_main_384",
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
        "inputs": {"filename_prefix": "hybrid_walk_T0259_cell_48", "images": [DESCENT_NODE_ID, 0]},
    }
    return g


def build_chained_graph(
    seed: int,
    concept_filename: str,
    pose_skeleton_filename: str,
    init_image_filename: str,
    denoise: float,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
) -> dict:
    """Frame 1+ of the img2img chain (T-0266): reuses `build_graph` unchanged
    for every node except the latent source -- `EmptyLatentImage` swapped for
    `VAEEncode` of frame 0's own decoded output, denoise lowered from 1.0.
    Same pattern as `gen_chained_idle_T0250.build_chained_graph`, applied to
    this module's own graph (which additionally carries IP-Adapter/identity
    LoRA, absent from pose_authority's)."""
    g = build_graph(
        seed=seed,
        concept_filename=concept_filename,
        pose_skeleton_filename=pose_skeleton_filename,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        ipadapter_weight=ipadapter_weight,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
        identity_lora_name=identity_lora_name,
    )
    del g[LATENT_NODE_ID]
    g[INIT_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": init_image_filename},
    }
    g[VAE_ENCODE_NODE_ID] = {
        "class_type": "VAEEncode",
        "inputs": {
            "pixels": [INIT_IMAGE_NODE_ID, 0],
            "vae": [CHECKPOINT_NODE_ID, 2],
        },
    }
    g[SAMPLER_NODE_ID]["inputs"]["latent_image"] = [VAE_ENCODE_NODE_ID, 0]
    g[SAMPLER_NODE_ID]["inputs"]["denoise"] = denoise
    return g


def crop_identity_reference(concept_sheet_path: Path, dest_path: Path) -> Path:
    """Crop the full concept-sheet turnaround grid down to one clean
    front-on panel (`IDENTITY_REFERENCE_CROP_BOX`) and write it to
    `dest_path` -- this crop, not the full sheet, is what gets uploaded to
    ComfyUI and fed to IPAdapterAdvanced. See the T-0266 recipe finding
    above `IDENTITY_REFERENCE_CROP_BOX` for why."""
    Image.open(concept_sheet_path).convert("RGB").crop(IDENTITY_REFERENCE_CROP_BOX).save(dest_path)
    return dest_path


def check_attempt_cap(attempt: int) -> None:
    if not (1 <= attempt <= 8):
        raise SystemExit("attempt cap is 8 per round (DL-21) -- refusing to run a 9th attempt")


ATTEMPT_LOG_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md"
)
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_walk_sheet_hybrid.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_walk_sheet_hybrid.provenance.json"
IDLE_KEYFRAME_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png"
WALK_FRAME_EVIDENCE_DIR = (
    REPO_ROOT / "assets" / "src" / "character" / "pose_rig_walk_frame_evidence_T0259"
)

ATTEMPT_LOG_HEADER = (
    "# Hybrid walk-cycle attempt log (T-0259, HANDOFF §24-e)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not. Every frame "
    "is its own full-stack generation (style LoRA + player_identity_v2 + IP-Adapter + OpenPose "
    "ControlNet on a script-authored walk skeleton, `pose_rig_walk_T0259.py`) -- there is no "
    "single-generation-plus-derived-frames shortcut here, a walk gait needs real per-frame limb "
    "articulation. `mechanical_gate` is the frame-silhouette delta check (0.30 cap) across all "
    "8 adjacent transitions INCLUDING the loop seam (frame 7 -> frame 0).\n\n"
    "| Attempt | Seed | Frame-delta range | Mechanical gate | Beats Arm C (0.072-0.112) | "
    "GPU seconds | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    lo, hi = provenance["frame_delta_range"]
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {lo:.4f}-{hi:.4f} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'yes' if provenance['beats_arm_c_benchmark'] else 'no'} "
        f"| {provenance['gpu_seconds']} "
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
    """Copy this attempt's indexed sheet + provenance into
    assets/final/character/, and re-home its 8 per-frame ControlNet
    conditioning inputs from the gitignored assets/out/ into a committed
    evidence directory under assets/src/ -- otherwise the promoted
    provenance's file references dangle on a fresh clone."""
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes((out_dir / "sheet_192x96_indexed.png").read_bytes())

    WALK_FRAME_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    promoted = dict(provenance)
    promoted_frames = []
    for frame in provenance["frame_generation"]:
        i = frame["frame_index"]
        keypoints_dst = WALK_FRAME_EVIDENCE_DIR / f"frame_{i}_keypoints.json"
        skeleton_dst = WALK_FRAME_EVIDENCE_DIR / f"frame_{i}_pose_skeleton_384.png"
        keypoints_dst.write_bytes((out_dir / f"frame_{i}_keypoints.json").read_bytes())
        skeleton_dst.write_bytes((out_dir / f"frame_{i}_pose_skeleton_384.png").read_bytes())
        promoted_frame = dict(frame)
        promoted_frame["pose_keypoints_file"] = str(keypoints_dst.relative_to(REPO_ROOT))
        promoted_frame["pose_skeleton_file"] = str(skeleton_dst.relative_to(REPO_ROOT))
        promoted_frames.append(promoted_frame)
    promoted["frame_generation"] = promoted_frames

    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")


def _generate_one_frame(
    *,
    out_dir: Path,
    frame_index: int,
    seed: int,
    concept_filename: str,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    denoise: float,
) -> None:
    """The `generate_frame(i)` callback `char_gen.chunked_frames.run_chunk`
    calls for one frame: writes this frame's inputs (skeleton PNG,
    keypoints JSON), submits the full §24-e stack to ComfyUI, and writes
    its two required outputs plus a small `_meta.json` sidecar carrying the
    one piece of per-frame state that cannot be re-derived from disk on a
    later, separate invocation (the ComfyUI prompt id + generation time).

    Frame 0 is a fresh independent sample (`build_graph`, `EmptyLatentImage`,
    denoise fixed at 1.0). Frames 1+ (T-0266 img2img chain) are an img2img
    pass anchored to frame 0's own decoded output (`build_chained_graph`,
    `VAEEncode`, this `denoise`), with the decoded result background-held
    against frame 0 so noise/clutter cannot compound or vary across frames
    -- see `gen_chained_idle_T0250.apply_background_hold`, the same
    mechanism used unchanged here.
    """
    points = pose_rig_walk_T0259.walk_keypoints_for_frame(frame_index, FRAME_COUNT)
    skeleton_img = pose_rig_walk_T0259.render_pose_frame(points, GEN_PX)
    skeleton_path = out_dir / f"frame_{frame_index}_pose_skeleton_384.png"
    skeleton_img.save(skeleton_path)

    keypoints_path = out_dir / f"frame_{frame_index}_keypoints.json"
    keypoints_path.write_text(
        json.dumps(pose_rig_walk_T0259.keypoints_to_coco_list(points), indent=2) + "\n"
    )

    skeleton_filename = upload_image(skeleton_path)

    if frame_index == 0:
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
    else:
        frame0_main_path = out_dir / "frame_0_main_384.png"
        init_image_filename = upload_image(frame0_main_path)
        graph = build_chained_graph(
            seed=seed,
            concept_filename=concept_filename,
            pose_skeleton_filename=skeleton_filename,
            init_image_filename=init_image_filename,
            denoise=denoise,
            controlnet_strength=controlnet_strength,
            controlnet_end=controlnet_end,
            ipadapter_weight=ipadapter_weight,
            style_lora_weight=style_lora_weight,
            identity_lora_weight=identity_lora_weight,
        )

    frame_t0 = time.monotonic()
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id, timeout_s=300)
    generation_seconds = time.monotonic() - frame_t0

    main_bytes = fetch_save_image(info, MAIN_SAVE_NODE_ID)

    if frame_index == 0:
        cell_bytes = fetch_save_image(info, CELL_SAVE_NODE_ID)
        (out_dir / f"frame_{frame_index}_main_384.png").write_bytes(main_bytes)
        (out_dir / f"frame_{frame_index}_cell_48_raw.png").write_bytes(cell_bytes)
    else:
        # Background hold happens in pixel space, after decode -- see
        # apply_background_hold's docstring for why. ComfyUI's own
        # CELL_SAVE_NODE_ID descent ran on the pre-hold sampled image, so it
        # would silently reintroduce the noise the hold removes; the cell is
        # instead locally area-descended from the held image below.
        raw_sampled_path = out_dir / f"frame_{frame_index}_main_384_raw_sampled.png"
        raw_sampled_path.write_bytes(main_bytes)
        sampled_img = Image.open(io.BytesIO(main_bytes)).convert("RGB")
        frame0_main_img = Image.open(out_dir / "frame_0_main_384.png").convert("RGB")
        mask = background_hold_mask(points, GEN_PX)
        mask.save(out_dir / f"frame_{frame_index}_background_hold_mask.png")
        held_img = apply_background_hold(sampled_img, frame0_main_img, mask)
        held_img.save(out_dir / f"frame_{frame_index}_main_384.png")
        cell_img = held_img.resize((FINAL_CELL_PX, FINAL_CELL_PX), Image.Resampling.BOX)
        cell_img.save(out_dir / f"frame_{frame_index}_cell_48_raw.png")

    generation_mode = "fresh" if frame_index == 0 else "img2img_chained"
    chained_from_frame = None if frame_index == 0 else 0
    frame_denoise = 1.0 if frame_index == 0 else denoise
    (out_dir / f"frame_{frame_index}_meta.json").write_text(
        json.dumps(
            {
                "comfyui_prompt_id": prompt_id,
                "generation_seconds": generation_seconds,
                "generation_mode": generation_mode,
                "chained_from_frame": chained_from_frame,
                "denoise": frame_denoise,
            },
            indent=2,
        )
        + "\n"
    )


def run_attempt(
    attempt: int,
    seed: int,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    max_frames: int = chunked_frames.DEFAULT_MAX_FRAMES,
    denoise: float = DEFAULT_DENOISE,
) -> dict | None:
    """Generate up to `max_frames` still-incomplete frames of this attempt,
    then, only once every frame is complete, assemble the sheet and return
    its provenance candidate. Returns None when the sheet is not yet
    complete -- callers (this module's own `main`, or a script driving
    sequential foreground chunks) re-invoke with identical arguments until
    a dict comes back. See `char_gen.chunked_frames` for the resume/chunk
    contract this relies on.
    """
    if not (0.0 < denoise < 1.0):
        raise ValueError(f"denoise must be in (0, 1) -- got {denoise}")
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
    if not IDLE_KEYFRAME_PATH.exists():
        raise RuntimeError(
            f"identity anchor (idle keyframe) not found: {IDLE_KEYFRAME_PATH} -- this is the "
            "canonical reference the walk sheet's identity is checked against"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)

    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_walk" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    identity_reference_path = out_dir / "identity_reference_crop.png"
    crop_identity_reference(CONCEPT_SHEET_PATH, identity_reference_path)
    concept_filename = upload_image(identity_reference_path)

    def generate_frame(frame_index: int) -> None:
        _generate_one_frame(
            out_dir=out_dir,
            frame_index=frame_index,
            seed=seed,
            concept_filename=concept_filename,
            controlnet_strength=controlnet_strength,
            controlnet_end=controlnet_end,
            ipadapter_weight=ipadapter_weight,
            style_lora_weight=style_lora_weight,
            identity_lora_weight=identity_lora_weight,
            denoise=denoise,
        )

    chunk_result = chunked_frames.run_chunk(
        out_dir=out_dir,
        frame_indices=range(FRAME_COUNT),
        required_names=REQUIRED_OUTPUT_NAMES,
        max_frames=max_frames,
        generate_frame=generate_frame,
    )
    print(
        f"attempt {attempt}: generated {chunk_result.generated}, "
        f"skipped (already complete) {chunk_result.skipped}, "
        f"remaining {chunk_result.remaining}"
    )
    if not chunk_result.complete:
        return None

    # Every frame is complete on disk -- assemble by READING every frame's
    # outputs back, never from this invocation's own in-memory state, since
    # most frames were very likely generated by an earlier, separate
    # foreground invocation.
    gpu_seconds = 0.0
    frame_records = []
    prompt_ids = []
    raw_cells: dict[tuple[int, int], Image.Image] = {}
    fg_masks: dict[tuple[int, int], object] = {}

    for i, cell in enumerate(FRAME_CELLS):
        keypoints_path = out_dir / f"frame_{i}_keypoints.json"
        skeleton_path = out_dir / f"frame_{i}_pose_skeleton_384.png"
        main_path = out_dir / f"frame_{i}_main_384.png"
        cell_raw_path = out_dir / f"frame_{i}_cell_48_raw.png"
        meta = json.loads((out_dir / f"frame_{i}_meta.json").read_text())
        points = pose_rig_walk_T0259.walk_keypoints_for_frame(i, FRAME_COUNT)

        prompt_ids.append(meta["comfyui_prompt_id"])
        gpu_seconds += meta["generation_seconds"]

        raw_cells[cell] = Image.open(cell_raw_path).convert("RGB")
        main_img = Image.open(main_path).convert("RGB")
        fg_masks[cell] = downscale_mask(
            cutout_foreground_mask(
                main_img, points, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
            ),
            FINAL_CELL_PX,
        )

        frame_records.append(
            {
                "frame_index": i,
                "cell": list(cell),
                "comfyui_prompt_id": meta["comfyui_prompt_id"],
                "pose_keypoints_file": str(keypoints_path.relative_to(REPO_ROOT)),
                "pose_skeleton_file": str(skeleton_path.relative_to(REPO_ROOT)),
                "background_cutout_applied": True,
                "cutout_method": CUTOUT_METHOD_DESCRIPTION,
                "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
                "cutout_bbox_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
                "generation_mode": meta["generation_mode"],
                "chained_from_frame": meta["chained_from_frame"],
                "denoise": meta["denoise"],
            }
        )

    raw_sheet = Image.new("RGB", (SHEET_W, SHEET_H))
    for (r, c), cell_img in raw_cells.items():
        raw_sheet.paste(cell_img, (c * FINAL_CELL_PX, r * FINAL_CELL_PX))
    raw_sheet.save(out_dir / "sheet_192x96_raw.png")

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    indexed = quantize_to_palette(raw_sheet, palette)
    indexed = apply_cutout_masks(
        indexed, fg_masks, cell_size=FINAL_CELL_PX, background_index=0
    )
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    save_sprite_sheet(indexed, out_dir / "sheet_192x96_indexed.png")

    cells = {
        (r, c): indexed.crop(
            (c * FINAL_CELL_PX, r * FINAL_CELL_PX, c * FINAL_CELL_PX + FINAL_CELL_PX,
             r * FINAL_CELL_PX + FINAL_CELL_PX)
        )
        for r, c in FRAME_CELLS
    }
    # Interior adjacent pairs PLUS the explicit loop seam (last frame -> frame
    # 0) -- the motion spec calls this out by name, not just the 7 interior
    # pairs.
    adjacent_pairs = [
        (FRAME_CELLS[i], FRAME_CELLS[i + 1]) for i in range(len(FRAME_CELLS) - 1)
    ] + [(FRAME_CELLS[-1], FRAME_CELLS[0])]

    frame_deltas = []
    for a, b in adjacent_pairs:
        result = asset_gate_art.check_frame_consistency(
            cells[a], cells[b], background_index=0, max_delta_ratio=MAX_FRAME_DELTA_RATIO
        )
        frame_deltas.append(
            {
                "pair": [list(a), list(b)],
                "ratio": float(result.details["ratio"]),
                "passed": bool(result.passed),
            }
        )
    mechanical_gate_passed = all(d["passed"] for d in frame_deltas)
    ratios = [d["ratio"] for d in frame_deltas]
    beats_030_cap = max(ratios) <= MAX_FRAME_DELTA_RATIO
    arm_c_fields = apply_arm_c_benchmark_fields({}, ratios)

    identity_anchor = {
        "path": str(IDLE_KEYFRAME_PATH.relative_to(REPO_ROOT)),
        "hash": sha256_of(IDLE_KEYFRAME_PATH),
        "note": (
            "the canonical idle keyframe DL-25 promoted (T-0252) -- the walk sheet's identity "
            "is checked against this sheet (same costume, same equipment loadout), not fed as "
            "a second IP-Adapter input alongside the concept sheet"
        ),
    }

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) "
        f"+ LoRA {IDENTITY_LORA_NAME} (player identity, weight {identity_lora_weight}) "
        f"+ IP-Adapter {IPADAPTER_NAME} (weight {ipadapter_weight}) + ControlNet {CONTROLNET_NAME} "
        f"+ img2img chain (frames 1-7 anchored to frame 0's own output via VAEEncode, "
        f"denoise {denoise}, background held out of the feedback path)"
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
        "prompt": WALK_PROMPT,
        "negative_prompt": WALK_NEGATIVE,
        "pose_source": (
            "script (assets/src/character/pose_rig_walk_T0259.py) -- deterministic per-frame "
            "OpenPose-format 18-keypoint COCO walk-gait skeleton, emitted directly by the "
            "script (opposed leg swing, per-leg knee lift, opposite-phase arm swing, hip bob), "
            "with no derivation step in between -- the model is given no say in the pose"
        ),
        "identity_anchor": identity_anchor,
        "seed": seed,
        "denoise": denoise,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "ip_adapter_reference_crop_box": list(IDENTITY_REFERENCE_CROP_BOX),
        "ip_adapter_reference_note": (
            "IP-Adapter is fed a crop of the concept sheet (IDENTITY_REFERENCE_CROP_BOX, one "
            "clean front-on panel), not the full ~24-panel turnaround grid -- T-0266 recipe "
            "finding: the full grid's own panel/gutter structure leaked into independently-"
            "sampled frames via IP-Adapter's image-level conditioning, driving attempts 1-2's "
            "frame deltas past the 0.30 cap"
        ),
        "frame_generation": frame_records,
        "method": (
            "pose_rig_walk_T0259 derives 18-keypoint COCO walk-gait frame keypoints "
            "deterministically -> gen_arm_a_idle_T0228.draw_pose_skeleton_cell renders each "
            "frame's skeleton (384x384, reused renderer) -> ControlNetApplyAdvanced (xinsir "
            "OpenPose) + LoraLoader(soviet_brutalism_style_v1) -> LoraLoader(player_identity_v2, "
            "chained) -> IPAdapterAdvanced (PLUS, T-0209 concept) -> KSampler -- frame 0 samples "
            "fresh from EmptyLatentImage (denoise 1.0); frames 1-7 (T-0266) img2img-chain from "
            "frame 0's own decoded output via VAEEncode at the recorded denoise, with the "
            "decoded result background-held against frame 0 (apply_background_hold) so only the "
            "figure region -- not the background -- is allowed to vary per frame -> per-frame "
            "area descent to 48x48 (frame 0 from ComfyUI, frames 1-7 locally from the held "
            "image) -> per-frame background cutout (this frame's own keypoint bbox) -> frames "
            "assembled into a 192x96 sheet -> Oklab-nearest palette quantization (dithering off, "
            "§3.1) -> orphan cleanup -> true-RGBA sprite write."
        ),
        "generator": "assets/src/character/gen_hybrid_walk_T0259.py",
        "card": "T-0259",
        "mechanism": (
            "§24-e hybrid (DL-25's winning arm) applied to a walk gait -- every frame is its "
            "own full-stack generation (unlike the idle hybrid recipe's single-generation-plus-"
            "derived-frames, which cannot represent limb articulation)"
        ),
        "spec": (
            "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5 + HANDOFF §24.4"
        ),
        "comfyui_prompt_ids": prompt_ids,
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "frame_delta_range": arm_c_fields["frame_delta_range"],
        "beats_030_cap": beats_030_cap,
        "beats_arm_c_benchmark": arm_c_fields["beats_arm_c_benchmark"],
        "arm_c_benchmark": arm_c_fields["arm_c_benchmark"],
        "layout": {
            "sheet_px": [SHEET_W, SHEET_H],
            "cell_px": FINAL_CELL_PX,
            "cols": COLS,
            "rows": ROWS,
            "frame_cells": [list(k) for k in FRAME_CELLS],
            "loop": True,
        },
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
    parser.add_argument(
        "--denoise",
        type=float,
        default=DEFAULT_DENOISE,
        help=(
            f"img2img denoise for frames 1-7's chain to frame 0's own output (default "
            f"{DEFAULT_DENOISE} -- T-0266). Frame 0 always samples fresh at denoise 1.0, "
            "unaffected by this flag."
        ),
    )
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument(
        "--max-frames",
        type=int,
        default=chunked_frames.DEFAULT_MAX_FRAMES,
        help=(
            "generate at most this many still-incomplete frames this invocation, then stop "
            f"(default {chunked_frames.DEFAULT_MAX_FRAMES}, derived from the measured "
            "~100s/frame cost against the 10-minute shell timeout -- T-0266). Re-run the "
            "identical command to resume; already-complete frames are skipped."
        ),
    )
    parser.add_argument(
        "--promote-attempt",
        type=int,
        help="promote an existing attempt's sheet to assets/final/character/ and exit",
    )
    args = parser.parse_args()

    if args.promote_attempt is not None:
        out_dir = REPO_ROOT / "assets" / "out" / "hybrid_walk" / f"attempt_{args.promote_attempt}"
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        if not provenance["mechanical_gate_passed"]:
            raise SystemExit(
                f"attempt {args.promote_attempt} did not pass the mechanical gate -- refusing "
                "to promote"
            )
        promote_attempt(out_dir, provenance)
        promoted_record = json.loads(FINAL_PROVENANCE_PATH.read_text())
        append_attempt_log(promoted_record, notes=args.notes)
        print(f"promoted attempt {args.promote_attempt} -> {FINAL_SHEET_PATH}")
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
        max_frames=args.max_frames,
        denoise=args.denoise,
    )
    if provenance is None:
        print(
            "chunk complete, frames remain -- re-run the identical command to continue "
            "(sequential foreground chunks, never --background)"
        )
        return

    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_walk" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
