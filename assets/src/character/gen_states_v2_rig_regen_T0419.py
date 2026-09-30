#!/usr/bin/env python3
"""T-0419: regenerate `player_{crouch_hide,die,move}_sheet_v2` through a
rig-driven ComfyUI path, so each carries genuine per-frame `frame_generation`
rig evidence the character gate can recompute pose-fidelity/identity-
stability from.

**Why regenerate rather than recover.** T-0213's `gen_states_v2_tiled.py`
sampled every cell of a sheet from ONE tiled img2img prompt -- no
ControlNet, no per-frame skeleton, no rig of any kind ever produced those
pixels (confirmed: `grep -n "ControlNet\\|controlnet\\|pose\\|keypoint" \
gen_states_v2_tiled.py` matches only prompt-text substrings like "no action
poses other than falling", never an actual conditioning node). There is
nothing to recover. This card's own edge case is explicit: "a sheet whose
original generation truly had no per-frame rig -- regeneration is then the
only honest route". This script is that route.

**The pose source is not invented for this card.** Each frame's ControlNet
skeleton comes from `char_gen.rig_recovery_T0419.{crouch_hide,die,move}_frame_keypoints`
-- the SAME literal pixel-range transcription already used (and already
reviewed) to recover `player_{crouch_hide,die,move}_sheet_v1`'s own genuine
rig evidence. Reusing it here means v2's pose is a real, already-verified-
non-fabricated skeleton, not a new pose authored from scratch for this
script.

Per frame: LoraLoader(style) -> LoraLoader(identity, chained) ->
IPAdapterAdvanced(concept) -> ControlNet(this frame's own v1-recovered-rig
skeleton) -> KSampler at 384x384, denoise 1.0 -- every frame is its own
independent full-stack generation, no img2img chain. Unlike the walk
(T-0259/T-0266), none of these three sheets is a repeating gait that needs
frame-to-frame chaining to hold a loop seam together; crouch-hide and die
are one-directional transitions, and move's own rig (a march-in-place
cycle distinct from the walk's own rig) does not share the walk's chaining
requirement either. Independent per-frame sampling is the simpler, honest
choice here -- consistent with `gen_pose_authority_idle_T0249.py`'s own
"real per-frame generation, one KSampler call per frame" precedent, which
`gen_hybrid_walk_T0259.py`'s own docstring names as what this script is
"structurally closest to" before that script's own chaining requirement.

This script owns its own `build_graph` (parametrised on prompt/negative,
since none of the existing per-frame generators is), per this repo's own
established precedent: "each owns its own build_graph ... reusing
checkpoint/LoRA/ControlNet identifiers ... via import, never a shared
parametrised generator" (`gen_hybrid_walk_T0259.py`'s own module docstring).

`player_move_sheet_v2`'s own two documented spare/blank cells ((3,1),(3,2),
mirroring T-0199's v1 convention) are left as pure background -- no
ComfyUI call for those two indices, consistent with
`move_frame_keypoints`'s own "no pose to report" treatment of them.

**Chunked and resumable** (T-0266's `char_gen.chunked_frames`, the same
module `gen_hybrid_walk_T0259.py` uses): generates at most `--max-frames`
still-incomplete frames per invocation and skips any frame already
complete on disk. Drive a sheet to completion with sequential foreground
calls of the identical command, inside one implementer session -- never
`run_in_background: true` followed by ending the turn (T-0259's own
lesson).

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/character/gen_states_v2_rig_regen_T0419.py --sheet crouch_hide
    python3 assets/src/character/gen_states_v2_rig_regen_T0419.py --sheet crouch_hide  # resume
    python3 assets/src/character/gen_states_v2_rig_regen_T0419.py --sheet die
    python3 assets/src/character/gen_states_v2_rig_regen_T0419.py --sheet move

Writes, per sheet (always, whether the recomputed metrics pass or not --
this card's own acceptance criteria treat a real, on-merit failure as a
legitimate, reportable result, never something to chase with edits):
    assets/out/rig_regen_v2/<sheet>/frame_<i>_pose_skeleton_384.png
    assets/out/rig_regen_v2/<sheet>/frame_<i>_keypoints.json
    assets/out/rig_regen_v2/<sheet>/frame_<i>_main_384.png
    assets/out/rig_regen_v2/<sheet>/frame_<i>_cell_48_raw.png
    assets/out/rig_regen_v2/<sheet>/frame_<i>_meta.json
    assets/out/rig_regen_v2/<sheet>/sheet_indexed.png
    assets/out/rig_regen_v2/<sheet>/provenance_candidate.json

Once every frame is complete, this same invocation assembles the sheet,
recomputes `character_motion_fidelity`/`character_part_identity`/
`character_motion_score_binding` (the SAME `asset_gate.character` functions
the CI gate itself runs, never a local re-derivation), and promotes
straight to `assets/final/character/player_<sheet>_sheet_v2.png` +
`.provenance.json` -- there is no separate `--promote` step, and no
multi-attempt tuning loop: one genuine attempt, honestly reported. This
overwrites the old tiled-diffusion pixels, which this card's own acceptance
criteria require (no rig ever produced them, so there is no honest way to
keep them AND carry genuine `frame_generation`). Per-frame ControlNet
conditioning inputs are re-homed from the gitignored `assets/out/` into a
committed evidence directory under `assets/src/character/`, since the
promoted provenance's file references must resolve on a fresh clone.
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
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from asset_gate import character as asset_gate_character  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402
from comfy_client.provenance_sidecar import resolve_run_id  # noqa: E402
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
    draw_pose_skeleton_cell,
    enforce_cell_margin,
    fetch_save_image,
    quantize_to_palette,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)
from gen_hybrid_walk_T0259 import IDENTITY_REFERENCE_CROP_BOX, crop_identity_reference  # noqa: E402
from gen_pose_authority_idle_T0249 import (  # noqa: E402
    IDENTITY_LORA_NAME,
    IDENTITY_LORA_PATH,
    IDENTITY_LORA_PROVENANCE_PATH,
    MAIN_NEGATIVE,  # noqa: E402
    TRIGGER_TOKEN,
)

from char_gen import chunked_frames  # noqa: E402
from char_gen.cutout import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_METHOD_DESCRIPTION,
    CUTOUT_OKLAB_TOLERANCE,
    apply_cutout_masks,
    cutout_foreground_mask,
    downscale_mask,
)
from char_gen.rig_recovery_T0419 import (  # noqa: E402
    crouch_hide_frame_keypoints,
    die_frame_keypoints,
    move_frame_keypoints,
)
from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FRAME_EVIDENCE_ROOT = (
    REPO_ROOT / "assets" / "src" / "character" / "pose_rig_v2_regen_frame_evidence_T0419"
)

FINAL_CELL_PX = 48
GEN_PX = FINAL_CELL_PX * 8  # 384, same x8 descent ratio as every round-2 per-frame path

CROUCH_PROMPT = (
    f"{TRIGGER_TOKEN}, pixel art crouch and hide animation frame, single figure matching the "
    "pose skeleton exactly, Soviet brutalist soldier in standard military uniform, flat side-on "
    "orthographic view, same uniform and same equipment loadout in every frame, "
    "value-separated pixel art silhouette, clean readable pixel outline, solid flat black "
    "background, no perspective, no vanishing point, no text, no UI"
)
DIE_PROMPT = (
    f"{TRIGGER_TOKEN}, pixel art death-fall animation frame, single figure matching the pose "
    "skeleton exactly, Soviet brutalist soldier in standard military uniform, flat side-on "
    "orthographic view, same uniform and same equipment loadout in every frame, "
    "value-separated pixel art silhouette, clean readable pixel outline, solid flat black "
    "background, no perspective, no vanishing point, no text, no UI"
)
MOVE_PROMPT = (
    f"{TRIGGER_TOKEN}, pixel art march-in-place animation frame, single figure matching the "
    "pose skeleton exactly, Soviet brutalist soldier in standard military uniform, flat side-on "
    "orthographic view, same uniform and same equipment loadout in every frame, "
    "value-separated pixel art silhouette, clean readable pixel outline, solid flat black "
    "background, no perspective, no vanishing point, no text, no UI"
)
NEGATIVE_PROMPT = MAIN_NEGATIVE


class SheetConfig:
    def __init__(self, key, state_name, motion_class, cols, rows, frame_count, real_frame_count,
                 keypoints_fn, prompt, seed):
        self.key = key
        self.state_name = state_name
        self.motion_class = motion_class
        self.cols = cols
        self.rows = rows
        self.frame_count = frame_count
        self.real_frame_count = real_frame_count
        self.keypoints_fn = keypoints_fn
        self.prompt = prompt
        self.seed = seed

    def is_real_frame(self, i: int) -> bool:
        return i < self.real_frame_count

    @property
    def final_name(self) -> str:
        return f"player_{self.state_name}_sheet_v2"

    @property
    def frame_cells(self) -> list[tuple[int, int]]:
        return [(r, c) for r in range(self.rows) for c in range(self.cols)][: self.frame_count]


SHEET_CONFIGS: dict[str, SheetConfig] = {
    "crouch_hide": SheetConfig(
        "crouch_hide", "crouch_hide", "transition", cols=3, rows=3, frame_count=9,
        real_frame_count=9, keypoints_fn=crouch_hide_frame_keypoints, prompt=CROUCH_PROMPT,
        seed=31420,
    ),
    "die": SheetConfig(
        "die", "die", "transition", cols=3, rows=3, frame_count=9, real_frame_count=9,
        keypoints_fn=die_frame_keypoints, prompt=DIE_PROMPT, seed=31421,
    ),
    "move": SheetConfig(
        "move", "move", "locomotion", cols=3, rows=4, frame_count=12, real_frame_count=10,
        keypoints_fn=move_frame_keypoints, prompt=MOVE_PROMPT, seed=31422,
    ),
}

REQUIRED_OUTPUT_NAMES = ("frame_{i}_main_384.png", "frame_{i}_cell_48_raw.png")

# Node ids, named -- mirrors gen_hybrid_walk_T0259.py's own convention.
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
    prompt: str,
    negative: str,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
) -> dict:
    """One frame, one figure, the same §24-e stack every other round-2 arm
    uses, parametrised on this sheet's own prompt/negative -- see module
    docstring for why this script owns its own copy rather than importing
    `gen_hybrid_walk_T0259.build_graph` (which hardcodes the walk's own
    prompt)."""
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
        "inputs": {"text": prompt, "clip": [IDENTITY_LORA_NODE_ID, 1]},
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": negative, "clip": [IDENTITY_LORA_NODE_ID, 1]},
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
            "filename_prefix": "rig_regen_v2_T0419_main_384",
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
        "inputs": {"filename_prefix": "rig_regen_v2_T0419_cell_48", "images": [DESCENT_NODE_ID, 0]},
    }
    return g


def _points_dict(points_list: list[dict]) -> dict[int, tuple[float, float]]:
    return {p["joint"]: (p["x"], p["y"]) for p in points_list}


def _generate_one_frame(*, out_dir: Path, frame_index: int, cfg: SheetConfig, seed: int,
                         concept_filename: str, controlnet_strength: float, controlnet_end: float,
                         ipadapter_weight: float, style_lora_weight: float,
                         identity_lora_weight: float) -> None:
    points_list = cfg.keypoints_fn(frame_index)
    keypoints_path = out_dir / f"frame_{frame_index}_keypoints.json"
    keypoints_path.write_text(json.dumps(points_list, indent=2) + "\n")

    skeleton_img = draw_pose_skeleton_cell(GEN_PX, points_norm=_points_dict(points_list))
    skeleton_path = out_dir / f"frame_{frame_index}_pose_skeleton_384.png"
    skeleton_img.save(skeleton_path)

    if not cfg.is_real_frame(frame_index):
        # Documented spare/blank cell (move's own (3,1)/(3,2), mirroring v1)
        # -- no ComfyUI call, pure background, honestly recorded as such.
        blank = Image.new("RGB", (GEN_PX, GEN_PX), (0, 0, 0))
        blank.save(out_dir / f"frame_{frame_index}_main_384.png")
        blank_cell = blank.resize((FINAL_CELL_PX, FINAL_CELL_PX))
        blank_cell.save(out_dir / f"frame_{frame_index}_cell_48_raw.png")
        (out_dir / f"frame_{frame_index}_meta.json").write_text(
            json.dumps(
                {
                    "comfyui_prompt_id": None,
                    "generation_seconds": 0.0,
                    "generation_mode": "spare_cell",
                },
                indent=2,
            )
            + "\n"
        )
        return

    skeleton_filename = upload_image(skeleton_path)
    graph = build_graph(
        seed=seed,
        concept_filename=concept_filename,
        pose_skeleton_filename=skeleton_filename,
        prompt=cfg.prompt,
        negative=NEGATIVE_PROMPT,
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
    cell_bytes = fetch_save_image(info, CELL_SAVE_NODE_ID)
    (out_dir / f"frame_{frame_index}_main_384.png").write_bytes(main_bytes)
    (out_dir / f"frame_{frame_index}_cell_48_raw.png").write_bytes(cell_bytes)
    (out_dir / f"frame_{frame_index}_meta.json").write_text(
        json.dumps(
            {
                "comfyui_prompt_id": prompt_id,
                "generation_seconds": generation_seconds,
                "generation_mode": "fresh",
            },
            indent=2,
        )
        + "\n"
    )


def promote(out_dir: Path, cfg: SheetConfig, provenance: dict) -> None:
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    final_sheet_path = FINAL_CHARACTER_DIR / f"{cfg.final_name}.png"
    final_sheet_path.write_bytes((out_dir / "sheet_indexed.png").read_bytes())

    evidence_dir = FRAME_EVIDENCE_ROOT / cfg.key
    evidence_dir.mkdir(parents=True, exist_ok=True)
    promoted_frames = []
    for frame in provenance["frame_generation"]:
        i = frame["frame_index"]
        keypoints_dst = evidence_dir / f"frame_{i}_keypoints.json"
        skeleton_dst = evidence_dir / f"frame_{i}_pose_skeleton_384.png"
        keypoints_dst.write_bytes((out_dir / f"frame_{i}_keypoints.json").read_bytes())
        skeleton_dst.write_bytes((out_dir / f"frame_{i}_pose_skeleton_384.png").read_bytes())
        promoted_frame = dict(frame)
        promoted_frame["pose_keypoints_file"] = str(keypoints_dst.relative_to(REPO_ROOT))
        promoted_frame["pose_skeleton_file"] = str(skeleton_dst.relative_to(REPO_ROOT))
        promoted_frames.append(promoted_frame)
    provenance = dict(provenance)
    provenance["frame_generation"] = promoted_frames
    provenance["promoted"] = True

    final_prov_path = FINAL_CHARACTER_DIR / f"{cfg.final_name}.provenance.json"
    final_prov_path.write_text(json.dumps(provenance, indent=2) + "\n")

    provenance = json.loads(final_prov_path.read_text())
    sheet_img = Image.open(final_sheet_path)
    motion_result = asset_gate_character.determine_character_motion_fidelity(
        provenance, sheet=sheet_img, repo_root=REPO_ROOT, sheet_name=f"{cfg.final_name}.png"
    )
    part_result = asset_gate_character.determine_character_part_identity(
        provenance, sheet=sheet_img, repo_root=REPO_ROOT, sheet_name=f"{cfg.final_name}.png"
    )
    print(
        f"{cfg.final_name}: motion_fidelity passed={motion_result.passed} -- {motion_result.reason}"
    )
    print(
        f"{cfg.final_name}: part_identity passed={part_result.passed} -- {part_result.reason}"
    )

    if motion_result.details.get("recomputed_from_pixels"):
        pose_range = motion_result.details["pose_fidelity_range"]
        identity_range = motion_result.details["identity_stability_range"]
        palette_path = REPO_ROOT / provenance["palette_source"]
        provenance["pose_fidelity_range"] = pose_range
        provenance["identity_stability_range"] = identity_range
        provenance["motion_score_binding"] = {
            "sheet_sha256": asset_gate_character.compute_image_content_sha256(sheet_img),
            "rig_config_version": asset_gate_character.RIG_CONFIG_VERSION,
            "palette_sha256": asset_gate_character.compute_file_sha256(palette_path),
            "evaluator_version": asset_gate_character.EVALUATOR_VERSION,
        }
        final_prov_path.write_text(json.dumps(provenance, indent=2) + "\n")
        binding_result = asset_gate_character.check_motion_score_binding(
            provenance,
            recomputed_pose_fidelity_range=pose_range,
            recomputed_identity_stability_range=identity_range,
            sheet=sheet_img,
            repo_root=REPO_ROOT,
            sheet_name=f"{cfg.final_name}.png",
        )
        print(
            f"{cfg.final_name}: motion_score_binding passed={binding_result.passed} "
            f"-- {binding_result.reason}"
        )


def run_sheet(sheet_key: str, *, max_frames: int, controlnet_strength: float = 1.0,
              controlnet_end: float = 1.0, ipadapter_weight: float = 0.6,
              style_lora_weight: float = 0.70, identity_lora_weight: float = 0.50) -> dict | None:
    cfg = SHEET_CONFIGS[sheet_key]

    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")
    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(f"concept sheet hash mismatch: got {concept_hash}")
    if not IDENTITY_LORA_PATH.exists():
        raise RuntimeError(f"trained identity LoRA not found: {IDENTITY_LORA_PATH}")
    if not IDENTITY_LORA_PROVENANCE_PATH.exists():
        raise RuntimeError(
            f"identity LoRA provenance sidecar not found: {IDENTITY_LORA_PROVENANCE_PATH}"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)

    out_dir = REPO_ROOT / "assets" / "out" / "rig_regen_v2" / cfg.key
    out_dir.mkdir(parents=True, exist_ok=True)

    identity_reference_path = out_dir / "identity_reference_crop.png"
    crop_identity_reference(CONCEPT_SHEET_PATH, identity_reference_path)
    concept_filename = upload_image(identity_reference_path)

    def generate_frame(frame_index: int) -> None:
        _generate_one_frame(
            out_dir=out_dir,
            frame_index=frame_index,
            cfg=cfg,
            seed=cfg.seed + frame_index,
            concept_filename=concept_filename,
            controlnet_strength=controlnet_strength,
            controlnet_end=controlnet_end,
            ipadapter_weight=ipadapter_weight,
            style_lora_weight=style_lora_weight,
            identity_lora_weight=identity_lora_weight,
        )

    chunk_result = chunked_frames.run_chunk(
        out_dir=out_dir,
        frame_indices=range(cfg.frame_count),
        required_names=REQUIRED_OUTPUT_NAMES,
        max_frames=max_frames,
        generate_frame=generate_frame,
    )
    print(
        f"{cfg.key}: generated {chunk_result.generated}, "
        f"skipped (already complete) {chunk_result.skipped}, remaining {chunk_result.remaining}"
    )
    if not chunk_result.complete:
        return None

    gpu_seconds = 0.0
    frame_records = []
    prompt_ids = []
    raw_cells: dict[tuple[int, int], Image.Image] = {}
    fg_masks: dict[tuple[int, int], object] = {}

    for i, cell in zip(range(cfg.frame_count), cfg.frame_cells):
        keypoints_path = out_dir / f"frame_{i}_keypoints.json"
        skeleton_path = out_dir / f"frame_{i}_pose_skeleton_384.png"
        cell_raw_path = out_dir / f"frame_{i}_cell_48_raw.png"
        main_path = out_dir / f"frame_{i}_main_384.png"
        meta = json.loads((out_dir / f"frame_{i}_meta.json").read_text())
        points = _points_dict(json.loads(keypoints_path.read_text()))

        prompt_ids.append(meta["comfyui_prompt_id"])
        gpu_seconds += meta["generation_seconds"]

        raw_cells[cell] = Image.open(cell_raw_path).convert("RGB")
        if cfg.is_real_frame(i):
            main_img = Image.open(main_path).convert("RGB")
            fg_masks[cell] = downscale_mask(
                cutout_foreground_mask(
                    main_img, points, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
                ),
                FINAL_CELL_PX,
            )
            background_cutout_applied = True
            generation_mode = "fresh"
        else:
            fg_masks[cell] = np.zeros((FINAL_CELL_PX, FINAL_CELL_PX), dtype=bool)
            background_cutout_applied = False
            generation_mode = "spare_cell_no_generation"

        frame_records.append(
            {
                "frame_index": i,
                "cell": list(cell),
                "comfyui_prompt_id": meta["comfyui_prompt_id"],
                "pose_keypoints_file": str(keypoints_path.relative_to(REPO_ROOT)),
                "pose_skeleton_file": str(skeleton_path.relative_to(REPO_ROOT)),
                "background_cutout_applied": background_cutout_applied,
                "cutout_method": CUTOUT_METHOD_DESCRIPTION,
                "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
                "cutout_bbox_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
                "generation_mode": generation_mode,
                "chained_from_frame": None,
                "denoise": 1.0 if cfg.is_real_frame(i) else None,
            }
        )

    sheet_w, sheet_h = cfg.cols * FINAL_CELL_PX, cfg.rows * FINAL_CELL_PX
    raw_sheet = Image.new("RGB", (sheet_w, sheet_h))
    for (r, c), cell_img in raw_cells.items():
        raw_sheet.paste(cell_img, (c * FINAL_CELL_PX, r * FINAL_CELL_PX))

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    indexed = quantize_to_palette(raw_sheet, palette)
    indexed = apply_cutout_masks(indexed, fg_masks, cell_size=FINAL_CELL_PX, background_index=0)
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    save_sprite_sheet(indexed, out_dir / "sheet_indexed.png")

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) "
        f"+ LoRA {IDENTITY_LORA_NAME} (player identity, weight {identity_lora_weight}) "
        f"+ IP-Adapter {IPADAPTER_NAME} (weight {ipadapter_weight}) + ControlNet {CONTROLNET_NAME} "
        "-- each frame independently sampled (denoise 1.0), no img2img chain"
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
        "prompt": cfg.prompt,
        "negative_prompt": NEGATIVE_PROMPT,
        "pose_source": (
            "char_gen.rig_recovery_T0419."
            f"{cfg.keypoints_fn.__name__} -- the SAME per-frame COCO-18 keypoints already "
            f"recovered (T-0419) from player_{cfg.state_name}_sheet_v1's own procedural drawing "
            "formula, reused here as this sheet's ControlNet pose source. Not a newly-authored "
            "pose: this is v1's own already-verified-genuine rig, driving a fresh SDXL "
            "generation for v2."
        ),
        "rig_evidence_basis": (
            "T-0419: v2's original generator (gen_states_v2_tiled.py, T-0213) used a single "
            "tiled img2img prompt with no ControlNet/pose conditioning of any kind -- no rig "
            "ever produced its pixels, so there was nothing to recover. This provenance replaces "
            "those pixels via a genuine rig-driven regeneration (per this card's own edge case), "
            "conditioned on v1's own already-recovered, already-verified rig keypoints -- never "
            "an invented pose."
        ),
        "seed": cfg.seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "ip_adapter_reference_crop_box": list(IDENTITY_REFERENCE_CROP_BOX),
        "frame_generation": frame_records,
        "method": (
            f"char_gen.rig_recovery_T0419.{cfg.keypoints_fn.__name__} supplies this sheet's "
            "per-frame COCO-18 keypoints -> gen_arm_a_idle_T0228.draw_pose_skeleton_cell renders "
            "each frame's skeleton (384x384) -> ControlNetApplyAdvanced (xinsir OpenPose) + "
            "LoraLoader(soviet_brutalism_style_v1) -> LoraLoader(player_identity_v2, chained) -> "
            "IPAdapterAdvanced (PLUS, T-0209 concept) -> KSampler (denoise 1.0, independent per "
            "frame) -> per-frame area descent to 48x48 -> per-frame background cutout (this "
            "frame's own keypoint bbox) -> frames assembled into the sheet -> Oklab-nearest "
            "palette quantization -> orphan cleanup -> true-RGBA sprite write. Documented spare/"
            "blank cells (move only) get no ComfyUI call -- pure background, per "
            "move_frame_keypoints' own convention."
        ),
        "generator": "assets/src/character/gen_states_v2_rig_regen_T0419.py",
        "card": "T-0419",
        "run_id": resolve_run_id(),
        "motion_class": cfg.motion_class,
        "spec": "docs/design/13-asset-pipeline.md §3.5 (Characters -- the hard class) + §6",
        "comfyui_prompt_ids": prompt_ids,
        "gpu_seconds": round(gpu_seconds, 1),
        "layout": {
            "sheet_px": [sheet_w, sheet_h],
            "cell_px": FINAL_CELL_PX,
            "cols": cfg.cols,
            "rows": cfg.rows,
            "frame_cells": [list(k) for k in cfg.frame_cells],
            "spare_cells": [
                list(cfg.frame_cells[i])
                for i in range(cfg.frame_count)
                if not cfg.is_real_frame(i)
            ],
            "loop": False,
        },
        "palette_source": "assets/final/palette/home_palette.json",
        "promoted": False,
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    promote(out_dir, cfg, provenance)
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sheet", required=True, choices=sorted(SHEET_CONFIGS))
    parser.add_argument("--controlnet-strength", type=float, default=1.0)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--ipadapter-weight", type=float, default=0.6)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.50)
    parser.add_argument("--max-frames", type=int, default=chunked_frames.DEFAULT_MAX_FRAMES)
    args = parser.parse_args()

    provenance = run_sheet(
        args.sheet,
        max_frames=args.max_frames,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        ipadapter_weight=args.ipadapter_weight,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )
    if provenance is None:
        print("chunk complete, frames remain -- re-run the identical command to continue")
        return
    final_name = SHEET_CONFIGS[args.sheet].final_name
    print(f"{args.sheet}: promoted -> assets/final/character/{final_name}.png")


if __name__ == "__main__":
    main()
