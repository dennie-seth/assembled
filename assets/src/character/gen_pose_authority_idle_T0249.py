#!/usr/bin/env python3
"""Pose-authority idle sheet generation (T-0249, HANDOFF §24-b, reframed by
§24.4 "the script becomes the pose authority").

Round 2 of the T-0227 character-pipeline bake-off continues the generative
path (Arm A/B) per @DennieSeth's authorship override (see
BAKEOFF_DECISION_T0231.md). This card is not a new bake-off arm competing on
DL-21's original criteria -- it is a mechanism change layered on top of
§24-a's `player_identity_v2` (T-0248): instead of tiling one bit-for-bit
identical skeleton across a 3x3 contact-sheet grid and asking a single
KSampler call to hold nine cells' worth of identity at once (Arm A/B), the
script authors nine *distinct* skeletons -- one per animation frame, each
encoding real breathing/weight-shift motion -- and each frame is generated
as its own 384x384 image, one KSampler call at a time, conditioned only on
that frame's skeleton. Motion is authored (`pose_rig_T0249.py` +
`pose_rig_T0249.json`); appearance is generated.

Division of labour (HANDOFF §24.4):
    the script owns: keypoints, frame count, timing, the animation curve
    the model owns:  silhouette, costume, shading, texture

Two honest limits, recorded (not papered over):
  1. A pose skeleton is strong conditioning, not absolute control -- Arm B
     needed ControlNet strength ~1.3 to suppress idle swing on an IDENTICAL
     skeleton; this script defaults to the same 1.3, and the frame-delta
     gate (not the mechanism's principle) is still the arbiter of whether
     that's enough here, where the skeleton itself legitimately varies.
  2. This does not address costume drift -- that's §24-a's job. Running
     against `player_identity_v2` (not v1) is what keeps this card's result
     from masking whether §24-a's single-costume retrain actually worked.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_v2.safetensors -- T-0248 -- is loadable by ComfyUI's
LoraLoader):
    python3 assets/src/character/gen_pose_authority_idle_T0249.py --attempt 1 --seed 31416
    python3 assets/src/character/gen_pose_authority_idle_T0249.py --emit-rig-evidence
    python3 assets/src/character/gen_pose_authority_idle_T0249.py --promote-attempt 1

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/pose_authority/attempt_<N>/frame_<i>_pose_skeleton_384.png  (x9)
    assets/out/pose_authority/attempt_<N>/frame_<i>_keypoints.json         (x9)
    assets/out/pose_authority/attempt_<N>/frame_<i>_main_384.png           (x9)
    assets/out/pose_authority/attempt_<N>/sheet_144_indexed.png
    assets/out/pose_authority/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_POSE_AUTHORITY_ATTEMPT_LOG_T0249.md (appended)

Promotion to assets/final/character/ (only for the first attempt that passes
the mechanical gate, or the best-effort candidate at the 8-attempt cap) is a
separate, explicit step (--promote-attempt) -- a discarded attempt's bytes
never land in assets/final/, even transiently. Promotion also re-homes that
attempt's 9 per-frame keypoints/skeleton files (the ControlNet conditioning
inputs) from assets/out/ into the committed
assets/src/character/pose_rig_idle_frame_evidence_T0249/ directory, since
assets/out/ is gitignored and the promoted provenance's frame_generation
references must resolve on a fresh clone, not just on the machine that ran
the attempt.
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
# comfy-client is not a declared dependency of this package's pyproject.toml
# (char-gen only lists pillow/numpy) -- same informal sys.path convention
# already used for asset-gate above, not a formal pip dependency, per
# gen_idle_v2_diffusers.py's existing precedent. See CHR-1 (T-0258): the
# shared ARM_C_BENCHMARK constant + apply_arm_c_benchmark_fields helper live
# in comfy_client.provenance_sidecar, the established home for this pipeline's
# other shared provenance surface.
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pose_rig_T0249  # noqa: E402
from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402
from char_gen.sprite_io import save_sprite_sheet  # noqa: E402
from comfy_client.provenance_sidecar import (  # noqa: E402
    # Not referenced directly below -- gen_chained_idle_T0250.py re-exports this
    # as `pose_authority.ARM_C_BENCHMARK` (any module-level name is an attribute
    # of the module, import or assignment alike).
    ARM_C_BENCHMARK,  # noqa: F401
    apply_arm_c_benchmark_fields,
)

# Reused directly from Arm A (T-0228) -- checkpoint/ControlNet identifiers,
# HTTP client helpers, and the §3.1 descent chain are unchanged; only the
# graph (per-frame single-figure generation instead of a shared 3x3 grid)
# and the pose source (pose_rig_T0249, not a static tiled skeleton) differ.
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    cleanup_orphans,
    enforce_cell_margin,
    fetch_save_image,
    force_cell_corner_background,
    quantize_to_palette,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

IDENTITY_LORA_NAME = "player_identity_v2.safetensors"
IDENTITY_LORA_PATH = REPO_ROOT / "assets" / "final" / "lora" / IDENTITY_LORA_NAME
IDENTITY_LORA_PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v2.provenance.json"
)

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
RIG_PATH = pose_rig_T0249.RIG_PATH

# player_identity_v2's own trained trigger token (see its provenance JSON,
# assets/final/lora/player_identity_v2.provenance.json).
TRIGGER_TOKEN = "sbrutalistplayer"

FINAL_CELL_PX = 48  # native cell size -- DL-21 output spec, unchanged from round 1
GEN_PX = FINAL_CELL_PX * 8  # 384 -- per-frame generation canvas (same x8 ratio as the grid path)
SHEET_PX = FINAL_CELL_PX * 3  # 144 -- assembled sheet, 3x3 of 48px cells

FRAME_COUNT = 9
FRAME_ORDER: list[tuple[int, int]] = [(r, c) for r in range(3) for c in range(3)]  # row-major

MAX_FRAME_DELTA_RATIO = 0.30  # round-2 rule: same 0.30 cap as round 1 (DL-21 criterion 2)
# ARM_C_BENCHMARK: the real bar to beat, not the pass/fail floor -- imported
# above from comfy_client.provenance_sidecar (CHR-1's single shared home,
# T-0258), not redefined here.

RIG_GENERALIZATION_EVIDENCE_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "pose_rig_move_evidence_T0249.json"
)
# Where a promoted attempt's per-frame ControlNet conditioning inputs land --
# assets/out/ is gitignored (see assets.md), so a passing attempt's own
# skeleton/keypoints must be re-homed under assets/src/ at promotion time or
# the provenance's frame_generation references dangle on a fresh clone
# (P-3/P-7: an arm that wins on an uncommitted skeleton has not won).
IDLE_FRAME_EVIDENCE_DIR = (
    REPO_ROOT / "assets" / "src" / "character" / "pose_rig_idle_frame_evidence_T0249"
)

# Single-figure prompt -- each generation is its own image now, not a cell of
# a 3x3 contact sheet, so the grid/panel language Arm A/B needed is gone.
MAIN_PROMPT = (
    f"{TRIGGER_TOKEN}, pixel art idle animation frame, single standing figure, flat "
    "front-on orthographic view, exactly one figure matching the pose skeleton exactly, "
    "same uniform and same equipment loadout, both feet on ground, arms relaxed at sides, "
    "upright standing posture, solid flat black background, value-separated pixel art "
    "silhouette, clean readable pixel outline, no perspective, no vanishing point, "
    "no text, no UI"
)
MAIN_NEGATIVE = (
    "perspective, three-quarter view, vanishing point, diagonal, depth of field, blurry, "
    "low quality, text, watermark, multiple different characters, two figures, duplicate "
    "figure, twins, doubled character, group of people, action pose, background clutter, "
    "background texture, background detail, concrete background, grey background, "
    "patterned background, bright colours, photorealistic, character sheet, multi-angle "
    "turnaround, different viewing angles, costume variants, different uniform, different "
    "equipment, inconsistent identity, grid, panels, contact sheet, multiple frames, "
    "skeleton, wireframe"
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
LATENT_NODE_ID = "20"
SAMPLER_NODE_ID = "21"
VAE_DECODE_NODE_ID = "22"
MAIN_SAVE_NODE_ID = "23"
DESCENT_NODE_ID = "24"
CELL_SAVE_NODE_ID = "25"


def build_graph(
    seed: int,
    pose_skeleton_filename: str,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
) -> dict:
    """One frame, one figure: LoraLoader(style) -> LoraLoader(identity) ->
    ControlNet(this frame's emitted skeleton) -> KSampler at 384x384 -> area
    descent to 48x48. `seed`, MAIN_PROMPT/MAIN_NEGATIVE, and the 384x384
    EmptyLatentImage size are identical across every frame's call by
    construction (module-level constants / the same `seed` argument value);
    `pose_skeleton_filename` -- loaded into POSE_IMAGE_NODE_ID and nothing
    else -- is the only per-frame input.
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
    g[LATENT_NODE_ID] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": GEN_PX, "height": GEN_PX, "batch_size": 1},
    }
    g[SAMPLER_NODE_ID] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [IDENTITY_LORA_NODE_ID, 0],
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
            "filename_prefix": "pose_authority_T0249_main_384",
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
            "filename_prefix": "pose_authority_T0249_cell_48",
            "images": [DESCENT_NODE_ID, 0],
        },
    }
    return g


def check_attempt_cap(attempt: int) -> None:
    if not (1 <= attempt <= 8):
        raise SystemExit("attempt cap is 8 per round (DL-21) -- refusing to run a 9th attempt")


ATTEMPT_LOG_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "ARM_POSE_AUTHORITY_ATTEMPT_LOG_T0249.md"
)
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_pose_authority_T0249.png"
FINAL_PROVENANCE_PATH = (
    FINAL_CHARACTER_DIR / "player_idle_sheet_pose_authority_T0249.provenance.json"
)

ATTEMPT_LOG_HEADER = (
    "# Pose-authority attempt log (T-0249, HANDOFF §24-b/§24.4, round 2)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not, so "
    "attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the "
    "frame-silhouette delta check (DL-21 criterion 2's mechanical half) across all 8 "
    "adjacent-cell transitions of the assembled sheet. Runs against `player_identity_v2` "
    "(T-0248) -- §24-a's contribution, not masked by reverting to v1.\n\n"
    "| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | "
    "Frame-delta range | GPU seconds | Mechanical gate | Beats Arm C (0.072-0.112) | "
    "Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    lo, hi = provenance["frame_delta_range"]
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['style_lora_weight']} | {provenance['identity_lora_weight']} "
        f"| {lo:.4f}-{hi:.4f} "
        f"| {provenance['gpu_seconds']} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'yes' if provenance['beats_arm_c_benchmark'] else 'no'} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


def promote_attempt(out_dir: Path, provenance: dict) -> None:
    """Copy this attempt's indexed sheet + provenance into
    assets/final/character/. Only called for an attempt whose mechanical
    gate passes (or the best-effort candidate at the 8-attempt cap) -- a
    discarded attempt's bytes never land in assets/final/, even transiently.

    Also re-homes this attempt's 9 per-frame ControlNet conditioning inputs
    (the emitted keypoints + rendered skeleton each frame was generated
    against) from the gitignored assets/out/ into a committed evidence
    directory under assets/src/, and rewrites the promoted provenance's
    frame_generation entries to point there -- otherwise those references
    resolve only on the machine that ran the attempt and dangle on a fresh
    clone.
    """
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes((out_dir / "sheet_144_indexed.png").read_bytes())

    IDLE_FRAME_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    promoted = dict(provenance)
    promoted_frames = []
    for frame in provenance["frame_generation"]:
        i = frame["frame_index"]
        keypoints_dst = IDLE_FRAME_EVIDENCE_DIR / f"frame_{i}_keypoints.json"
        skeleton_dst = IDLE_FRAME_EVIDENCE_DIR / f"frame_{i}_pose_skeleton_384.png"
        keypoints_dst.write_bytes((out_dir / f"frame_{i}_keypoints.json").read_bytes())
        skeleton_dst.write_bytes((out_dir / f"frame_{i}_pose_skeleton_384.png").read_bytes())
        promoted_frame = dict(frame)
        promoted_frame["pose_keypoints_file"] = str(keypoints_dst.relative_to(REPO_ROOT))
        promoted_frame["pose_skeleton_file"] = str(skeleton_dst.relative_to(REPO_ROOT))
        promoted_frames.append(promoted_frame)
    promoted["frame_generation"] = promoted_frames

    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")


def write_rig_generalization_evidence(state_name: str = "move") -> Path:
    """Cheap (no SDXL sampling) evidence that the same rig generator drives
    a second state: renders every frame's keypoints/skeleton for
    `state_name` from pose_rig_T0249.json's own committed numbers -- no code
    change -- and commits both the keypoints and the rendered skeletons.
    Satisfies the acceptance criterion "the rig generalises ... with
    evidence (emitted skeletons for at least one other state)."
    """
    rig = pose_rig_T0249.load_rig()
    state = rig["states"][state_name]
    frame_count = state["frame_count"]

    evidence_dir = (
        REPO_ROOT / "assets" / "src" / "character" / f"pose_rig_{state_name}_evidence_T0249"
    )
    evidence_dir.mkdir(parents=True, exist_ok=True)

    frames = []
    for i in range(frame_count):
        points = pose_rig_T0249.keypoints_for_frame(state, i, frame_count)
        # Evidence only -- not a generation input, so a small render suffices.
        img = pose_rig_T0249.render_pose_frame(points, 192)
        img_path = evidence_dir / f"frame_{i}_skeleton.png"
        img.save(img_path)
        frames.append(
            {
                "frame_index": i,
                "keypoints": pose_rig_T0249.keypoints_to_coco_list(points),
                "skeleton_image": str(img_path.relative_to(REPO_ROOT)),
            }
        )

    evidence = {
        "state": state_name,
        "rig_params": state,
        "frame_count": frame_count,
        "frames": frames,
        "note": (
            "Proves keypoints_for_frame/render_pose_frame (pose_rig_T0249.py) drives a "
            "second state (stride_extent_norm > 0, distinct from idle's 0.0) purely from "
            "different committed numbers in pose_rig_T0249.json -- no code change. This is "
            "procedural evidence only (no SDXL sampling, no ComfyUI call). What it does NOT "
            "prove: a shippable move sheet would still need a walking BASE pose authored -- "
            "this rig only offsets Arm A's standing-idle base pose (_POSE_KEYPOINTS_NORM), "
            "so today it can drive an idle-with-stride variant, not a true mid-stride gait, "
            "without also authoring a new base pose for that state."
        ),
    }
    RIG_GENERALIZATION_EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2) + "\n")
    return RIG_GENERALIZATION_EVIDENCE_PATH


def run_attempt(
    attempt: int,
    seed: int,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
    state_name: str = "idle",
) -> dict:
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH}"
        )
    if not IDENTITY_LORA_PATH.exists():
        raise RuntimeError(
            f"trained identity LoRA not found: {IDENTITY_LORA_PATH} -- run T-0248's training first"
        )
    if not IDENTITY_LORA_PROVENANCE_PATH.exists():
        raise RuntimeError(
            f"identity LoRA provenance sidecar not found: {IDENTITY_LORA_PROVENANCE_PATH}"
        )
    if not RIG_GENERALIZATION_EVIDENCE_PATH.exists():
        raise RuntimeError(
            f"{RIG_GENERALIZATION_EVIDENCE_PATH} missing -- run --emit-rig-evidence first"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)

    out_dir = REPO_ROOT / "assets" / "out" / "pose_authority" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    rig = pose_rig_T0249.load_rig()
    state = rig["states"][state_name]

    t0 = time.monotonic()
    frame_records = []
    cell_images: dict[tuple[int, int], Image.Image] = {}
    prompt_ids = []

    for i, cell in enumerate(FRAME_ORDER):
        points = pose_rig_T0249.keypoints_for_frame(state, i, FRAME_COUNT)
        skeleton_img = pose_rig_T0249.render_pose_frame(points, GEN_PX)
        skeleton_path = out_dir / f"frame_{i}_pose_skeleton_384.png"
        skeleton_img.save(skeleton_path)

        keypoints_path = out_dir / f"frame_{i}_keypoints.json"
        keypoints_path.write_text(
            json.dumps(pose_rig_T0249.keypoints_to_coco_list(points), indent=2) + "\n"
        )

        skeleton_filename = upload_image(skeleton_path)
        graph = build_graph(
            seed=seed,
            pose_skeleton_filename=skeleton_filename,
            controlnet_strength=controlnet_strength,
            controlnet_end=controlnet_end,
            style_lora_weight=style_lora_weight,
            identity_lora_weight=identity_lora_weight,
            identity_lora_name=identity_lora_name,
        )
        prompt_id = submit_prompt(graph)
        info = wait_for_completion(prompt_id, timeout_s=300)
        prompt_ids.append(prompt_id)

        main_bytes = fetch_save_image(info, MAIN_SAVE_NODE_ID)
        cell_bytes = fetch_save_image(info, CELL_SAVE_NODE_ID)
        (out_dir / f"frame_{i}_main_384.png").write_bytes(main_bytes)
        cell_raw_path = out_dir / f"frame_{i}_cell_48_raw.png"
        cell_raw_path.write_bytes(cell_bytes)
        cell_images[cell] = Image.open(cell_raw_path).convert("RGB")

        frame_records.append(
            {
                "frame_index": i,
                "cell": list(cell),
                "seed": seed,
                "width": GEN_PX,
                "height": GEN_PX,
                "prompt": MAIN_PROMPT,
                "negative_prompt": MAIN_NEGATIVE,
                "pose_keypoints_file": str(keypoints_path.relative_to(REPO_ROOT)),
                "pose_skeleton_file": str(skeleton_path.relative_to(REPO_ROOT)),
                "comfyui_prompt_id": prompt_id,
            }
        )

    gpu_seconds = time.monotonic() - t0

    raw_sheet = Image.new("RGB", (SHEET_PX, SHEET_PX))
    for (r, c), cell_img in cell_images.items():
        raw_sheet.paste(cell_img, (c * FINAL_CELL_PX, r * FINAL_CELL_PX))
    raw_sheet.save(out_dir / "sheet_144_raw.png")

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    indexed = quantize_to_palette(raw_sheet, palette)
    indexed = force_cell_corner_background(indexed, cell_size=FINAL_CELL_PX, background_index=0)
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    save_sprite_sheet(indexed, out_dir / "sheet_144_indexed.png")

    cells = {}
    for r in range(3):
        for c in range(3):
            cells[(r, c)] = indexed.crop(
                (c * FINAL_CELL_PX, r * FINAL_CELL_PX, c * FINAL_CELL_PX + FINAL_CELL_PX,
                 r * FINAL_CELL_PX + FINAL_CELL_PX)
            )
    frame_deltas = []
    for a, b in zip(FRAME_ORDER, FRAME_ORDER[1:]):
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
    frame_delta_range = arm_c_fields["frame_delta_range"]
    beats_arm_c_benchmark = arm_c_fields["beats_arm_c_benchmark"]

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) "
        f"+ LoRA {identity_lora_name} (player identity, weight {identity_lora_weight}) "
        f"+ ControlNet {CONTROLNET_NAME} (per-frame script-authored pose skeleton)"
    )
    provenance = {
        "model": model_summary,
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "style_lora_license": LORA_LICENSE,
        "identity_lora_name": identity_lora_name,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": identity_lora_weight,
        "identity_lora_license": "CreativeML OpenRAIL++-M",
        "identity_lora_provenance": str(IDENTITY_LORA_PROVENANCE_PATH.relative_to(REPO_ROOT)),
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": MAIN_PROMPT,
        "negative_prompt": MAIN_NEGATIVE,
        "pose_source": (
            "script (assets/src/character/pose_rig_T0249.py) -- deterministic per-frame "
            "OpenPose-format 18-keypoint COCO skeleton, emitted directly by the script, with "
            "no derivation step in between (this ComfyUI host has no DWPose/OpenPose node "
            "that could have derived it from an image)"
        ),
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "animation_params": str(RIG_PATH.relative_to(REPO_ROOT)),
        "animation_state": state_name,
        "rig_generalization_evidence": str(
            RIG_GENERALIZATION_EVIDENCE_PATH.relative_to(REPO_ROOT)
        ),
        "frame_generation": frame_records,
        "method": (
            "pose_rig_T0249 derives 18-keypoint COCO frame keypoints from committed animation "
            "parameters (pose_rig_T0249.json) -> gen_arm_a_idle_T0228.draw_pose_skeleton_cell "
            "renders each frame's skeleton (384x384, reused renderer, not re-authored) -> "
            "ControlNetApplyAdvanced (xinsir OpenPose) conditions a single-figure KSampler "
            "generation at 384x384 -- identical seed/prompt/negative/latent-size across all 9 "
            "frames, only the skeleton varies -> per-frame area descent to 48x48 (same x8 ratio "
            "as the grid path) -> frames assembled into a 144x144 sheet -> Oklab-nearest palette "
            "quantization (dithering off, §3.1) -> orphan cleanup."
        ),
        "generator": "assets/src/character/gen_pose_authority_idle_T0249.py",
        "card": "T-0249",
        "bake_off_arm": (
            "round 2, pose authority (HANDOFF §24-b/§24.4), stacked on top of §24-a's "
            "player_identity_v2 -- not a new bake-off arm competing on DL-21's original criteria"
        ),
        "spec": (
            "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5 + HANDOFF §24.4"
        ),
        "comfyui_prompt_ids": prompt_ids,
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "frame_delta_range": frame_delta_range,
        "beats_030_cap": beats_030_cap,
        "beats_arm_c_benchmark": beats_arm_c_benchmark,
        "arm_c_benchmark": arm_c_fields["arm_c_benchmark"],
        "layout": {
            "sheet_px": [SHEET_PX, SHEET_PX],
            "cell_px": FINAL_CELL_PX,
            "cols": 3,
            "rows": 3,
            "frame_cells": [list(k) for k in FRAME_ORDER],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int, help="attempt number, 1..8 (DL-21 cap)")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--controlnet-strength", type=float, default=1.3)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.50)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument(
        "--emit-rig-evidence",
        action="store_true",
        help="write generalisation evidence for the 'move' state and exit (no ComfyUI call)",
    )
    parser.add_argument(
        "--promote-attempt",
        type=int,
        help="promote an existing attempt's output to assets/final/character/ and exit",
    )
    args = parser.parse_args()

    if args.emit_rig_evidence:
        path = write_rig_generalization_evidence("move")
        print(f"wrote {path}")
        return

    if args.promote_attempt is not None:
        out_dir = (
            REPO_ROOT / "assets" / "out" / "pose_authority" / f"attempt_{args.promote_attempt}"
        )
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        promote_attempt(out_dir, provenance)
        print(f"promoted attempt {args.promote_attempt} -> {FINAL_SHEET_PATH}")
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --emit-rig-evidence is passed")

    check_attempt_cap(args.attempt)

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )
    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "pose_authority" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
