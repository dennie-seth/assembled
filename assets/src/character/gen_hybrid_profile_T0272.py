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
from PIL import Image, ImageOps

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

# T-0272 round 4: the per-pixel background-cutout family (same functions
# gen_hybrid_source_idle_T0252.py and gen_hybrid_walk_T0259.py apply to their
# own frames) now lives in the shared char_gen package, imported directly
# rather than reached by importing gen_chained_idle_T0250 -- and
# `extract_foreground_mask` replaces the old hard keypoint-bbox clip with
# content-aware connected-component selection (see that module's own
# docstring): a rendered figure that deviates from this card's profile
# skeleton, exactly what round 3's Test D produced, is no longer zeroed or
# clipped just for landing outside the skeleton's own footprint.
from char_gen.cutout import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_METHOD_DESCRIPTION,
    CUTOUT_OKLAB_TOLERANCE,
    apply_cutout_masks,
    downscale_mask,
    extract_foreground_mask,
)
from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

FINAL_CELL_PX = 48  # native cell size -- DL-21 output spec, unchanged
GEN_PX = FINAL_CELL_PX * 8  # 384 -- same x8 descent ratio as every §24-e per-frame path

FACING = pose_rig_profile_T0272.FACING

# T-0274's pose-only identity LoRA -- trained on anonymous side-on gait
# reference (T-0273's approved set), explicitly NOT a costume match ("this
# trigger token is distinct from player_identity_v2's sbrutalistplayer and is
# meant to be stacked with it at generation time", its own provenance/
# training-config notes). T-0274's own smoke check only ever swapped this in
# for player_identity_v2 (isolation, against the unchanged FRONT rig) -- this
# card stacks it, chained after the costume identity LoRA, on the
# profile-topology rig, which neither T-0272's first 4 attempts nor T-0274's
# smoke check ever tried together.
POSE_LORA_NAME = "player_identity_profile_v1.safetensors"
POSE_LORA_PATH = REPO_ROOT / "assets" / "final" / "lora" / POSE_LORA_NAME
POSE_LORA_PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "lora" / "player_identity_profile_v1.provenance.json"
)
POSE_LORA_TRIGGER_TOKEN = "sbrutalistprofilepose"

# Single-figure, side-profile prompt. Names the canonical costume explicitly
# ("institutional green coat, hooded, white gloves" -- CANONICAL_COSTUME_SELECTION_T0248.md)
# and forbids desaturation, since T-0259's attempt 8 found low denoise can wash
# the costume colour out even when the pose reads correctly. Carries both
# LoRAs' trigger tokens -- costume (TRIGGER_TOKEN) and pose (POSE_LORA_TRIGGER_TOKEN).


def build_positive_prompt(
    include_pose_trigger_token: bool = True, emphasize_green: bool = False
) -> str:
    """Round 3, Test A's isolation: round 2 could not separate the pose
    LoRA's own learned weights from the fact that its trigger token was
    always injected into the prompt whenever the LoRA was stacked at all,
    independent of weight (`ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s own
    follow-up #1). `include_pose_trigger_token=False` controls for that.

    Round 5 Lever 2 (`emphasize_green`): attempts 24-28 all converged on a
    muted olive/khaki costume rather than the vivid institutional green
    `player_idle_sheet_hybrid_T0252.png` itself carries -- a ComfyUI
    attention-weighted repeat of the costume-colour phrase, on top of the
    plain unweighted phrase every prior attempt used, is the cheapest lever
    to try before reaching for a post-hoc palette snap (Lever 3)."""
    pose_token = f"{POSE_LORA_TRIGGER_TOKEN}, " if include_pose_trigger_token else ""
    green_emphasis = (
        "(vivid saturated institutional green costume colour:1.4), " if emphasize_green else ""
    )
    # Round 7 (T-0317): the "no grey background, no multi-tone background" fix is
    # appended at the very END, not spliced into the middle -- CLIP truncates at 77
    # BPE tokens and this prompt is already close to that budget (see PROFILE_NEGATIVE's
    # own comment on attempt 45's regression), so inserting new terms earlier pushes
    # existing, load-bearing terms ("no perspective, no vanishing point, no text, no UI")
    # further toward the truncation boundary instead of the new, less-tested ones.
    return (
        f"{TRIGGER_TOKEN}, {pose_token}pixel art side-profile base pose, "
        f"single standing figure seen from the side, facing {FACING}, flat side-on "
        "orthographic view, exactly one figure matching the pose skeleton exactly, "
        f"{green_emphasis}institutional green coat, hooded, white gloves, same uniform and "
        "same equipment loadout, upright standing posture, solid flat black background, "
        "value-separated pixel art silhouette, clean readable pixel outline, vivid saturated "
        "green costume colour, no perspective, no vanishing point, no text, no UI, "
        "no grey background, no multi-tone background"
    )


PROFILE_PROMPT = build_positive_prompt(include_pose_trigger_token=True)


def invert_reference_for_conditioning(src_path: Path, dest_path: Path) -> None:
    """Round 3 Test D: T-0273's approved side-profile references are a dark
    silhouette on an off-white/cream studio background -- the opposite tone
    of this card's own "solid flat black background" target. Fed to
    IP-Adapter as-is, that off-white background bleeds into the generation's
    own background (attempt 12: only 76 foreground pixels survived cutout,
    because the light background threw off `cutout_foreground_mask`'s
    border-connected region growing). A pure RGB channel invert (dark
    silhouette -> light figure on a near-black field) aligns the reference's
    tone with the desired output composition without altering the pose or
    silhouette it encodes -- a deterministic transform of the committed
    source, not a new reference."""
    inverted = ImageOps.invert(Image.open(src_path).convert("RGB"))
    inverted.save(dest_path)


def prepare_secondary_reference(src_path: Path, dest_path: Path, needs_invert: bool) -> None:
    """Round 4 defect-fix: `invert_reference_for_conditioning` was applied
    unconditionally to every secondary reference, which is correct for
    T-0273's dark-silhouette-on-light-background photographs but wrong for
    `derive_profile_style_reference_T0272.py`'s own output, whose background
    is already forced to solid black -- inverting it a second time would flip
    that correct tone back to near-white and reintroduce the exact bleed
    round 3's Test D fixed (round-3 attempt 12: only 76 fg px survived
    cutout). `needs_invert` makes that choice explicit per secondary source
    instead of assuming every reference needs the same fix T-0273's did."""
    if needs_invert:
        invert_reference_for_conditioning(src_path, dest_path)
    else:
        dest_path.write_bytes(src_path.read_bytes())


PROFILE_NEGATIVE = (
    IDLE_MAIN_NEGATIVE + ", front view, facing the camera, symmetric front-facing pose, "
    "back view, both shoulders equally visible, washed out colour, pale colour, desaturated, "
    "faded costume, grayscale, multi-toned background"
)
# Round 7 (T-0317): IDLE_MAIN_NEGATIVE is already 67 words on its own, shared verbatim
# across T-0228/T-0249/T-0252/T-0259 (out of this card's scope to trim), and CLIP's
# text encoder truncates at 77 BPE tokens -- attempt 45 (this round) reused attempt
# 39's exact seed/graph but regressed from a coherent visual to an incoherent
# outline-and-glow render purely from a longer negative prompt, the signature of a
# truncation-order shift, not a deliberate style change. This addition therefore
# drops the two terms it used to duplicate from IDLE_MAIN_NEGATIVE outright
# ("three-quarter view", "grey background") rather than adding new synonyms
# ("gray background", "mottled/patchy/textured background") on top of them.


def build_negative_prompt(emphasize_green: bool = False) -> str:
    """Round 5 Lever 2 companion to `build_positive_prompt`'s `emphasize_green`:
    the plain `PROFILE_NEGATIVE` already names generic desaturation, but
    attempts 24-28's failure mode was a specific, nameable colour drift (a
    muted olive/khaki coat, not grayscale) -- naming it directly gives the
    sampler something concrete to steer away from."""
    if not emphasize_green:
        return PROFILE_NEGATIVE
    return (
        PROFILE_NEGATIVE
        + ", olive coat, khaki coat, brownish coat, muted green, grey-green"
        + ", heavy black outline, thick black border, neon rim light, glowing outline, vignette"
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
POSE_LORA_NODE_ID = "26"
SECONDARY_CONCEPT_IMAGE_NODE_ID = "27"
SECONDARY_IPADAPTER_NODE_ID = "28"


def build_graph(
    seed: int,
    concept_filename: str,
    pose_skeleton_filename: str,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    pose_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
    pose_lora_name: str = POSE_LORA_NAME,
    include_pose_trigger_token: bool = True,
    enable_ipadapter: bool = True,
    secondary_concept_filename: str | None = None,
    secondary_ipadapter_weight: float = 0.6,
    emphasize_green: bool = False,
) -> dict:
    """The full §24-e stack, extended with T-0274's pose LoRA chained on the
    end: LoraLoader(style) -> LoraLoader(identity, costume) ->
    LoraLoader(pose, chained) -> IPAdapterAdvanced(concept) -> KSampler, with
    ControlNet (this card's profile-topology skeleton) conditioning the
    positive/negative prompt pair. One 384x384 generation, batch size 1.

    Round 3 isolation knobs (`ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s own
    follow-ups): `include_pose_trigger_token=False` (Test A) strips the pose
    LoRA's trigger token from the encoded prompt independent of its weight;
    `enable_ipadapter=False` (Test B) removes IP-Adapter and its concept-image
    input from the graph entirely (not merely a zero weight) and wires the
    sampler's model straight off the end of the LoRA chain;
    `secondary_concept_filename` (Test D) chains a second IPAdapterAdvanced
    node after the first, conditioning on a genuine side-profile reference in
    addition to the front concept sheet -- untested before this card.
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
    g[POSE_LORA_NODE_ID] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": [IDENTITY_LORA_NODE_ID, 0],
            "clip": [IDENTITY_LORA_NODE_ID, 1],
            "lora_name": pose_lora_name,
            "strength_model": pose_lora_weight,
            "strength_clip": pose_lora_weight,
        },
    }
    g[POSITIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {
            "text": build_positive_prompt(include_pose_trigger_token, emphasize_green),
            "clip": [POSE_LORA_NODE_ID, 1],
        },
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": build_negative_prompt(emphasize_green), "clip": [POSE_LORA_NODE_ID, 1]},
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

    model_source = [POSE_LORA_NODE_ID, 0]
    if enable_ipadapter:
        g[CONCEPT_IMAGE_NODE_ID] = {
            "class_type": "LoadImage",
            "inputs": {"image": concept_filename},
        }
        g[IPADAPTER_LOADER_NODE_ID] = {
            "class_type": "IPAdapterUnifiedLoader",
            "inputs": {"model": model_source, "preset": IPADAPTER_PRESET},
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
        model_source = [IPADAPTER_NODE_ID, 0]

        if secondary_concept_filename is not None:
            g[SECONDARY_CONCEPT_IMAGE_NODE_ID] = {
                "class_type": "LoadImage",
                "inputs": {"image": secondary_concept_filename},
            }
            g[SECONDARY_IPADAPTER_NODE_ID] = {
                "class_type": "IPAdapterAdvanced",
                "inputs": {
                    "model": model_source,
                    "ipadapter": [IPADAPTER_LOADER_NODE_ID, 1],
                    "image": [SECONDARY_CONCEPT_IMAGE_NODE_ID, 0],
                    "weight": secondary_ipadapter_weight,
                    "weight_type": "linear",
                    "combine_embeds": "concat",
                    "start_at": 0.0,
                    "end_at": 1.0,
                    "embeds_scaling": "V only",
                },
            }
            model_source = [SECONDARY_IPADAPTER_NODE_ID, 0]

    g[LATENT_NODE_ID] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": GEN_PX, "height": GEN_PX, "batch_size": 1},
    }
    g[SAMPLER_NODE_ID] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_source,
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
    """DL-21's cap is 8 attempts per round. Round 1 (attempts 1-4) and round 2
    (attempts 5-8) spent the first budget; round 3 (isolation + promote)
    spent a second 8-attempt budget, attempts 9-16. Round 4 (generalized
    cutout + costume-bearing reference + promote, see the card's own
    "ROUND 4" section) spent a third 8-attempt budget, attempts 17-24.

    The round-4 reviewer FAIL (defect 2) found that budget never actually
    tested a costume-bearing secondary reference -- attempts 25-28 are a
    small, explicitly-scoped continuation to fix that specific defect (test
    `player_profile_style_reference_T0272.png`, derived after the FAIL), not
    a fresh 8-attempt round of its own.

    Round 5 ("vivid green on the profile") spends a fourth fresh 8-attempt
    budget, attempts 29-36, on top of rounds 1-4's 1-24 and the round-4
    defect-fix continuation's 25-28.

    Round 6 (T-0317: the generated green-costume side reference wired into
    the secondary IP-Adapter slot) spends a fifth fresh 8-attempt budget,
    attempts 37-44, on top of rounds 1-5's spent 1-36. This is new
    conditioning input -- a reference that finally carries both the side pose
    and the green coat, unlike the pose-only T-0273 photograph (round 3) and
    the colour-thin derived crop (round 4-5) -- not a re-run of the same
    §24-e parameter sweep.

    Round 7 (T-0317 continuation, per round 6's own reviewer FAIL and its
    "what a follow-up would need to try" note) spends a sixth fresh
    8-attempt budget, attempts 45-52, on top of rounds 1-6's spent 1-44: two
    specific, previously-untried levers on round 6's own two failure
    modes -- fine-stepping the secondary IP-Adapter weight between attempt
    39's 0.1 (coherent, gate-fails) and attempt 41's 0.15-0.3 (gate-passes,
    incoherent) while holding attempt 39's own seed (31416) fixed, and the
    strengthened "no grey background, no multi-tone background" prompt term
    to address the multi-toned-background render that starved attempt 39's
    cutout -- not a re-run of round 6's own seed+weight sweep."""
    if not (1 <= attempt <= 52):
        raise SystemExit(
            "attempt cap is 8 per round (DL-21); round 7 adds attempts 45..52 on top of "
            "rounds 1-6's spent 1..44 -- refusing to run a 53rd attempt"
        )


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
    "fraction) and a non-erased silhouette (round 4: the content-aware cutout no longer clips "
    "to the pose rig's own keypoint bbox, so a legitimately shifted figure is no longer "
    "penalised for landing outside it). Whether the result genuinely reads as side-facing with "
    "intact identity is a human visual call, recorded in Notes, not a mechanical one.\n\n"
    "| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | "
    "Pose LoRA weight | IP-Adapter weight | GPU seconds | Mechanical gate | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['style_lora_weight']} | {provenance['identity_lora_weight']} "
        f"| {provenance.get('pose_lora_weight')} "
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
    (`char_gen.cutout.extract_foreground_mask`, T-0250's original fix,
    generalized round 4). THIS card's profile rig keypoints are passed as a
    HINT, not a hard frame -- a figure that lands outside them (a stacked
    profile reference pulling the pose off-rig, round 3's Test D) is still
    recovered in full, provided it is the single largest surviving blob."""
    indexed = quantize_to_palette(raw_cell, palette)
    fg_mask = downscale_mask(
        extract_foreground_mask(
            main_384, CUTOUT_OKLAB_TOLERANCE, points_norm, BACKGROUND_MASK_MARGIN_FRAC
        ),
        FINAL_CELL_PX,
    )
    indexed = apply_cutout_masks(
        indexed, {(0, 0): fg_mask}, cell_size=FINAL_CELL_PX, background_index=0
    )
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    return indexed


def compute_mechanical_gate(indexed: Image.Image) -> dict:
    """The only checks that make sense against a single static frame: is the
    background actually clean, and is the silhouette not erased? There is no
    adjacent frame to compute a delta against.

    Round 4 drops the old "no foreground pixel survives outside this pose's
    own keypoint bbox" check: `build_indexed_cell` no longer clips to that
    bbox at all (`extract_foreground_mask` selects a single connected
    component regardless of where it sits), so every surviving foreground
    pixel already belongs to the one blob the cutout chose -- re-deriving a
    bbox here and flagging pixels outside it would only re-introduce the
    same hard-clip assumption this round removed, penalising a genuinely
    shifted but legitimate figure instead of catching a real defect."""
    arr = np.array(indexed)
    bg_fraction = float((arr == 0).mean())
    fg_count = int((arr != 0).sum())

    passed = bg_fraction >= 0.65 and fg_count >= 50
    return {
        "background_fraction": bg_fraction,
        "foreground_pixels": fg_count,
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
    pose_lora_weight: float,
    *,
    include_pose_trigger_token: bool = True,
    enable_ipadapter: bool = True,
    secondary_concept_path: Path | None = None,
    secondary_ipadapter_weight: float = 0.6,
    secondary_needs_invert: bool = True,
    emphasize_green: bool = False,
    secondary_reference_note: str | None = None,
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
    if not POSE_LORA_PATH.exists():
        raise RuntimeError(f"trained pose LoRA not found: {POSE_LORA_PATH} (T-0274)")
    if not POSE_LORA_PROVENANCE_PATH.exists():
        raise RuntimeError(f"pose LoRA provenance sidecar not found: {POSE_LORA_PROVENANCE_PATH}")
    if not IDLE_ANCHOR_PATH.exists():
        raise RuntimeError(
            f"identity anchor (T-0252 front idle keyframe) not found: {IDLE_ANCHOR_PATH}"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)
    pose_lora_hash = sha256_of(POSE_LORA_PATH)

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

    secondary_hash = None
    secondary_filename = None
    if secondary_concept_path is not None:
        if not secondary_concept_path.exists():
            raise RuntimeError(
                f"secondary IP-Adapter reference not found: {secondary_concept_path}"
            )
        secondary_hash = sha256_of(secondary_concept_path)
        secondary_prepared_path = out_dir / "secondary_reference_prepared.png"
        prepare_secondary_reference(
            secondary_concept_path, secondary_prepared_path, secondary_needs_invert
        )

    t0 = time.monotonic()
    skeleton_filename = upload_image(skeleton_path)
    concept_filename = upload_image(identity_reference_path)
    if secondary_concept_path is not None:
        secondary_filename = upload_image(secondary_prepared_path)
    graph = build_graph(
        seed=seed,
        concept_filename=concept_filename,
        pose_skeleton_filename=skeleton_filename,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        ipadapter_weight=ipadapter_weight,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
        pose_lora_weight=pose_lora_weight,
        include_pose_trigger_token=include_pose_trigger_token,
        enable_ipadapter=enable_ipadapter,
        secondary_concept_filename=secondary_filename,
        secondary_ipadapter_weight=secondary_ipadapter_weight,
        emphasize_green=emphasize_green,
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

    mechanical_gate = compute_mechanical_gate(indexed)

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
        f"+ LoRA {IDENTITY_LORA_NAME} (player identity/costume, weight {identity_lora_weight}) "
        f"+ LoRA {POSE_LORA_NAME} (T-0274 profile pose, chained, weight {pose_lora_weight}) "
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
        "pose_lora_name": POSE_LORA_NAME,
        "pose_lora_hash": pose_lora_hash,
        "pose_lora_weight": pose_lora_weight,
        "pose_lora_license": "CreativeML OpenRAIL++-M",
        "pose_lora_provenance": str(POSE_LORA_PROVENANCE_PATH.relative_to(REPO_ROOT)),
        "pose_lora_trigger_token": POSE_LORA_TRIGGER_TOKEN,
        "pose_lora_trigger_token_in_prompt": include_pose_trigger_token,
        "ipadapter_enabled": enable_ipadapter,
        "ip_adapter": IPADAPTER_NAME if enable_ipadapter else None,
        "ip_adapter_weight": ipadapter_weight if enable_ipadapter else None,
        "ip_adapter_reference_crop_box": list(IDENTITY_REFERENCE_CROP_BOX),
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": build_positive_prompt(include_pose_trigger_token, emphasize_green),
        "negative_prompt": build_negative_prompt(emphasize_green),
        "green_emphasis": emphasize_green,
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
            "-> LoraLoader(player_identity_v2, costume, chained) "
            "-> LoraLoader(player_identity_profile_v1, T-0274 pose, chained) "
            "-> IPAdapterAdvanced (PLUS, cropped T-0209 "
            "concept panel) -> KSampler -> area descent to 48x48 -> Oklab-nearest palette "
            "quantization (dithering off, §3.1) -> content-aware per-pixel background cutout "
            "(char_gen.cutout.extract_foreground_mask, this pose's own keypoints as a hint, not "
            "a hard clip) -> orphan cleanup -> true-RGBA sprite write. This is a "
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
    if secondary_concept_path is not None:
        if secondary_needs_invert:
            transform_note = (
                "RGB channel invert (PIL.ImageOps.invert, invert_reference_for_conditioning) "
                "applied to the committed source before conditioning -- an off-white/light "
                "background is the opposite tone of this card's black-background target; "
                "uninverted, a light background bled into the generation and defeated cutout "
                "(round-3 attempt 12: 76 fg px survived)"
            )
        else:
            transform_note = (
                "none -- the source's own background is already dark-toned, matching this "
                "card's black-background target; inverting it would flip that correct tone "
                "back toward light and reintroduce round-3 Test D's own bleed defect"
            )
        # Round-5 fix: the two branches above used to hardcode prose naming a specific
        # source script (T-0273's photographs / derive_profile_style_reference_T0272.py) --
        # accurate only for the attempts that first used them, and already caught going
        # stale twice (round-4 review, attempts 23/24 vs 25-28). Deriving the reference
        # note from the actual path passed in keeps it correct for any future source
        # (e.g. round 5 bootstrapping from a prior attempt's own output) without the
        # caller having to remember to update prose here.
        try:
            secondary_display_path = secondary_concept_path.relative_to(REPO_ROOT)
        except ValueError:
            secondary_display_path = secondary_concept_path
        reference_note = secondary_reference_note or (
            f"secondary IP-Adapter reference sourced from {secondary_display_path}, stacked "
            "via a second IPAdapterAdvanced node chained after the front concept sheet's"
        )
        provenance["secondary_ip_adapter_reference"] = {
            "path": str(secondary_concept_path.relative_to(REPO_ROOT)),
            "hash": secondary_hash,
            "weight": secondary_ipadapter_weight,
            "needs_invert": secondary_needs_invert,
            "transform": transform_note,
            "note": reference_note,
        }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--attempt", type=int, help="attempt number, 1..16 (DL-21 cap, round 1-2 spent 1..8)"
    )
    parser.add_argument("--seed", type=int)
    parser.add_argument("--controlnet-strength", type=float, default=1.0)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--ipadapter-weight", type=float, default=0.6)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.50)
    parser.add_argument("--pose-lora-weight", type=float, default=0.60)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument(
        "--no-pose-trigger-token",
        action="store_false",
        dest="include_pose_trigger_token",
        default=True,
        help="round 3 Test A: strip the pose LoRA's trigger token from the prompt, "
        "independent of --pose-lora-weight",
    )
    parser.add_argument(
        "--disable-ipadapter",
        action="store_true",
        default=False,
        help="round 3 Test B: remove IP-Adapter and its concept image from the graph entirely",
    )
    parser.add_argument(
        "--secondary-concept",
        type=str,
        default=None,
        help="round 3 Test D: path to a committed T-0273 side-profile reference "
        "(assets/src/concept/player_profile_reference_*.jpg), colour-inverted automatically "
        "before conditioning and stacked via a second IPAdapterAdvanced node chained after "
        "the front concept sheet's",
    )
    parser.add_argument("--secondary-ipadapter-weight", type=float, default=0.6)
    parser.add_argument(
        "--secondary-no-invert",
        action="store_false",
        dest="secondary_needs_invert",
        default=True,
        help="round-4 defect-fix continuation: the secondary reference (e.g. "
        "player_profile_style_reference_T0272.png) already has the correct tone -- skip "
        "invert_reference_for_conditioning rather than flipping it a second time",
    )
    parser.add_argument(
        "--green-emphasis",
        action="store_true",
        default=False,
        help="round 5 Lever 2: attention-weight the costume-colour phrase and add explicit "
        "anti-olive/khaki negative terms, to counter the muted-colour drift attempts 24-28 "
        "converged on",
    )
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

    secondary_concept_path = (
        Path(args.secondary_concept).resolve() if args.secondary_concept else None
    )
    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        ipadapter_weight=args.ipadapter_weight,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
        pose_lora_weight=args.pose_lora_weight,
        include_pose_trigger_token=args.include_pose_trigger_token,
        enable_ipadapter=not args.disable_ipadapter,
        secondary_concept_path=secondary_concept_path,
        secondary_ipadapter_weight=args.secondary_ipadapter_weight,
        secondary_needs_invert=args.secondary_needs_invert,
        emphasize_green=args.green_emphasis,
    )
    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "hybrid_profile" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
