#!/usr/bin/env python3
"""Arm B of the T-0227 character-pipeline bake-off (T-0229, HANDOFF §23-e).

`docs/design/13-asset-pipeline.md` §6.14 stage 2: instead of conditioning a
general model per generation (Arm A's IP-Adapter on T-0209's concept sheet),
train the identity into weights and stack that LoRA with the T-0072 style
LoRA. This script's graph is Arm A's (gen_arm_a_idle_T0228.py) with the
IP-Adapter nodes removed and a second, chained LoraLoader (the trained
player-identity LoRA, T-0229) added in their place -- everything else
(checkpoint, ControlNet model, the deterministic procedural OpenPose
skeleton, descent chain) is unchanged, reused directly by import, so any
difference in outcome between the two arms is attributable to the
conditioning-vs-weights distinction DL-21 exists to measure, not to an
incidental pipeline difference.

DL-21 (`docs/decision-log.md`) pins the output spec (3x3 grid, 48x48 cells,
144x144 native, indexed to the locked 16-slot home palette) and the shared
concept-sheet reference (T-0209) identically across all three bake-off arms.
Arm B traces that shared reference through its curation manifest and the
trained LoRA's own provenance (identity_lora_provenance, resolvable) rather
than a live IP-Adapter node -- see test_no_ip_adapter_conditioning in
test_player_idle_arm_b_gate.py, which asserts this arm does not silently
fall back to Arm A's mechanism.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after a
real lora_train.train run has produced and deployed
assets/final/lora/player_identity_v1.safetensors):
    python3 assets/src/character/gen_arm_b_idle_T0229.py --attempt 1 --seed 31415

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/arm_b/attempt_<N>/pose_grid_1008.png
    assets/out/arm_b/attempt_<N>/main_1008.png
    assets/out/arm_b/attempt_<N>/sheet_144_indexed.png
    assets/out/arm_b/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_B_ATTEMPT_LOG_T0229.md   (appended, one row per attempt)

Promotion to assets/final/character/ (only for the attempt that passes the
mechanical gate, or the best-effort candidate at the 8-attempt cap) is a
separate, explicit step -- see promote_arm_b_attempt.py.
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

from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402

# Reused directly from Arm A (T-0228) -- checkpoint/ControlNet identifiers,
# the deterministic procedural OpenPose skeleton, HTTP client helpers, and
# the §3.1 descent chain are unchanged between arms; only the graph
# (IP-Adapter -> a second LoraLoader) and the prompt differ.
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CELL_PX,
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    FINAL_PX,
    GEN_PX,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    build_pose_grid_image,
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

IDENTITY_LORA_NAME = "player_identity_v1.safetensors"
IDENTITY_LORA_PATH = REPO_ROOT / "assets" / "final" / "lora" / IDENTITY_LORA_NAME
IDENTITY_LORA_PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v1.provenance.json"
)

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"
CURATION_MANIFEST_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "identity_curation_manifest_T0229.json"
)

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

TRIGGER_TOKEN = "sbrutalistplayer"

# Arm A's winning grid/composition prompt (attempts 5-8), the trigger token
# prepended and the free-text identity description trimmed -- the whole
# point of Arm B is that the identity LoRA, not the prompt, carries identity.
MAIN_PROMPT = (
    f"{TRIGGER_TOKEN}, pixel art idle animation contact sheet, 3 by 3 grid of nine separate "
    "equal square photographs, thin white gutter lines separating each square, exactly "
    "three rows and three columns and nothing outside the grid, standing idle, flat "
    "front-on orthographic view, one single unchanging figure repeated in every panel, "
    "same uniform and same equipment loadout in every panel, exactly one single figure "
    "centered in each cell matching the pose skeleton exactly, never two figures in one "
    "cell, no duplicate figure per cell, identical character identity and camera angle "
    "across all cells, same identical texture, shading and colours in every cell, no "
    "per-cell variation in equipment or uniform colour, subtle idle motion between "
    "frames, slight weight shift and natural breathing pose variation, both feet on "
    "ground, arms relaxed at sides, upright standing posture, solid flat black "
    "background in every cell, value-separated pixel art silhouette, clean readable "
    "pixel outline, no perspective, no vanishing point"
)
MAIN_NEGATIVE = (
    "perspective, three-quarter view, vanishing point, diagonal, depth of "
    "field, blurry, low quality, text, watermark, multiple different "
    "characters per panel, more than nine panels, extra panels, small thumbnails, "
    "two figures per cell, duplicate figure, twins, doubled character, couple, "
    "side by side figures, group of people, "
    "action pose, background clutter, background texture, background detail, "
    "concrete background, grey background, patterned background, bright colours, "
    "photorealistic, character sheet, multi-angle turnaround, different "
    "viewing angles, costume variants, different uniform, different "
    "equipment, costume change between panels, inconsistent identity, "
    "different shading between panels, different texture between panels, "
    "different colour between panels, "
    "skeleton, wireframe"
)


def build_graph(
    seed: int,
    pose_grid_filename: str,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
) -> dict:
    """LoraLoader(style) -> LoraLoader(identity, chained) -> ControlNet(pose
    grid) main generation -> area descent to 144x144. No IP-Adapter -- the
    concept sheet conditions the trained identity LoRA's weights (see
    curate_identity_panels_T0229.py), not this graph.

    `identity_lora_name` defaults to the T-0229/v1 identity LoRA; T-0248's
    round-2 re-run passes `player_identity_v2.safetensors` instead to measure
    whether the single-costume LoRA changes the drift picture under the
    otherwise-unchanged DL-21 recipe -- see gen_arm_b_idle_v2_T0248.py.
    """
    g: dict = {}

    g["1"] = {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CHECKPOINT}}
    g["10"] = {"class_type": "LoadImage", "inputs": {"image": pose_grid_filename}}

    g["11"] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["1", 0],
            "clip": ["1", 1],
            "lora_name": LORA_NAME,
            "strength_model": style_lora_weight,
            "strength_clip": style_lora_weight,
        },
    }
    g["12"] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["11", 0],
            "clip": ["11", 1],
            "lora_name": identity_lora_name,
            "strength_model": identity_lora_weight,
            "strength_clip": identity_lora_weight,
        },
    }
    g["13"] = {"class_type": "CLIPTextEncode", "inputs": {"text": MAIN_PROMPT, "clip": ["12", 1]}}
    g["14"] = {"class_type": "CLIPTextEncode", "inputs": {"text": MAIN_NEGATIVE, "clip": ["12", 1]}}
    g["15"] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": CONTROLNET_NAME}}
    g["16"] = {
        "class_type": "ControlNetApplyAdvanced",
        "inputs": {
            "positive": ["13", 0],
            "negative": ["14", 0],
            "control_net": ["15", 0],
            "image": ["10", 0],
            "strength": controlnet_strength,
            "start_percent": 0.0,
            "end_percent": controlnet_end,
        },
    }
    g["20"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": GEN_PX, "height": GEN_PX, "batch_size": 1},
    }
    g["21"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["12", 0],
            "positive": ["16", 0],
            "negative": ["16", 1],
            "latent_image": ["20", 0],
            "seed": seed,
            "steps": 30,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    g["22"] = {"class_type": "VAEDecode", "inputs": {"samples": ["21", 0], "vae": ["1", 2]}}
    g["23"] = {
        "class_type": "ImageScale",
        "inputs": {
            "image": ["22", 0],
            "upscale_method": "area",
            "width": FINAL_PX,
            "height": FINAL_PX,
            "crop": "disabled",
        },
    }
    g["24"] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "arm_b_T0229_sheet_144", "images": ["23", 0]},
    }
    g["25"] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "arm_b_T0229_main_1008", "images": ["22", 0]},
    }
    return g


ATTEMPT_LOG_PATH = REPO_ROOT / "assets" / "src" / "character" / "ARM_B_ATTEMPT_LOG_T0229.md"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_arm_b_T0229.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_arm_b_T0229.provenance.json"

ATTEMPT_LOG_HEADER = (
    "# Arm B attempt log (T-0229, HANDOFF §23-e, DL-21)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not, so "
    "attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the "
    "frame-silhouette delta check (DL-21 criterion 2's mechanical half); the human "
    "silhouette-read (criterion 1) and human drift verdict (criterion 2's other half) "
    "are judged later, in §23-g, against the promoted sheet.\n\n"
    "| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | "
    "GPU seconds | Mechanical gate | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(
    provenance: dict, notes: str = "", *, log_path: Path = ATTEMPT_LOG_PATH
) -> None:
    if not log_path.exists():
        log_path.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['style_lora_weight']} | {provenance['identity_lora_weight']} "
        f"| {provenance['gpu_seconds']} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    with log_path.open("a") as f:
        f.write(row)


def run_attempt(
    attempt: int,
    seed: int,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
    identity_lora_path: Path = IDENTITY_LORA_PATH,
    identity_lora_provenance_path: Path = IDENTITY_LORA_PROVENANCE_PATH,
    out_dir_name: str = "arm_b",
    card: str = "T-0229",
    bake_off_arm: str = "B (§23-e)",
) -> dict:
    """`identity_lora_name`/`identity_lora_path`/`identity_lora_provenance_path`
    default to the T-0229/v1 identity LoRA; `out_dir_name`/`card`/`bake_off_arm`
    default to Arm A's own T-0229 identifiers. T-0248's round-2 re-run
    (gen_arm_b_idle_v2_T0248.py) overrides all six to point at
    `player_identity_v2` and a separate out dir/attempt log, so it never
    touches T-0229's own promoted sheet or attempt history."""
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH} "
            "-- the curated identity training set traces back to this exact sheet; refusing to "
            "record provenance against a sheet that is not T-0209's approved sheet"
        )
    if not identity_lora_path.exists():
        raise RuntimeError(
            f"trained identity LoRA not found: {identity_lora_path} -- run lora_train.train first"
        )
    if not identity_lora_provenance_path.exists():
        raise RuntimeError(
            f"identity LoRA provenance sidecar not found: {identity_lora_provenance_path}"
        )
    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(identity_lora_path)

    out_dir = REPO_ROOT / "assets" / "out" / out_dir_name / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    pose_grid_image = build_pose_grid_image(CELL_PX)
    pose_grid_image.save(out_dir / "pose_grid_1008.png")

    t0 = time.monotonic()
    pose_grid_filename = upload_image(out_dir / "pose_grid_1008.png")
    graph = build_graph(
        seed=seed,
        pose_grid_filename=pose_grid_filename,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
        identity_lora_name=identity_lora_name,
    )
    prompt_id = submit_prompt(graph)
    # Arm A's attempts ran up to 294s against its 300s default timeout (close
    # enough to be a real risk) -- Arm B's graph swaps IP-Adapter for a second
    # LoraLoader, comparable cost, so the same margin applies here.
    info = wait_for_completion(prompt_id, timeout_s=600)
    gpu_seconds = time.monotonic() - t0

    main_1008_bytes = fetch_save_image(info, "25")
    sheet_144_bytes = fetch_save_image(info, "24")

    (out_dir / "main_1008.png").write_bytes(main_1008_bytes)
    (out_dir / "sheet_144_raw.png").write_bytes(sheet_144_bytes)

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    raw = Image.open(out_dir / "sheet_144_raw.png")
    indexed = quantize_to_palette(raw, palette)
    indexed = force_cell_corner_background(indexed, cell_size=48, background_index=0)
    indexed = enforce_cell_margin(indexed, cell_size=48, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    indexed.save(out_dir / "sheet_144_indexed.png")

    cells = {}
    for r in range(3):
        for c in range(3):
            cells[(r, c)] = indexed.crop((c * 48, r * 48, c * 48 + 48, r * 48 + 48))
    order = [(r, c) for r in range(3) for c in range(3)]
    frame_deltas = []
    for a, b in zip(order, order[1:]):
        result = asset_gate_art.check_frame_consistency(
            cells[a], cells[b], background_index=0, max_delta_ratio=0.30
        )
        frame_deltas.append(
            {
                "pair": [list(a), list(b)],
                "ratio": float(result.details["ratio"]),
                "passed": bool(result.passed),
            }
        )
    mechanical_gate_passed = all(d["passed"] for d in frame_deltas)

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) "
        f"+ LoRA {identity_lora_name} (player identity, weight {identity_lora_weight}) "
        f"+ ControlNet {CONTROLNET_NAME}"
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
        "identity_lora_provenance": str(identity_lora_provenance_path.relative_to(REPO_ROOT)),
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": MAIN_PROMPT,
        "negative_prompt": MAIN_NEGATIVE,
        "pose_source": (
            "procedural (gen_arm_a_idle_T0228.draw_pose_skeleton_cell) -- no SDXL sampling"
        ),
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "curation_manifest": "assets/src/character/identity_curation_manifest_T0229.json",
        "method": (
            "Procedurally drawn OpenPose-format skeleton (single 336x336 cell, PIL, "
            "18-keypoint COCO layout) tiled bit-for-bit identical into a 1008x1008 pose grid "
            "-> ControlNetApplyAdvanced (xinsir OpenPose) "
            f"+ LoraLoader(soviet_brutalism_style_v1) -> LoraLoader({identity_lora_name}, chained) "
            "-> KSampler 1008x1008 -> area downscale to 144x144 -> Oklab-nearest palette "
            "quantization (dithering off, §3.1) -> orphan cleanup. No IP-Adapter node -- "
            "identity comes from the trained LoRA (§6.14 stage 2)."
        ),
        "generator": "assets/src/character/gen_arm_b_idle_T0229.py",
        "card": card,
        "bake_off_arm": bake_off_arm,
        "spec": "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §6.14 stage 2",
        "comfyui_prompt_id": prompt_id,
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "layout": {
            "sheet_px": [FINAL_PX, FINAL_PX],
            "cell_px": 48,
            "cols": 3,
            "rows": 3,
            "frame_cells": [list(k) for k in order],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--attempt", type=int, required=True, help="attempt number, 1..8 (DL-21 cap)"
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--controlnet-strength", type=float, default=1.0)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.80)
    args = parser.parse_args()

    if not (1 <= args.attempt <= 8):
        raise SystemExit("attempt cap is 8 per arm (DL-21) -- refusing to run a 9th attempt")

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )

    provenance["promoted"] = False
    out_dir = REPO_ROOT / "assets" / "out" / "arm_b" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
