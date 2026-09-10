#!/usr/bin/env python3
"""Generate the `side_neutral` master-sheet panel, then descend it to a 48px
profile keyframe (T-0339 RE-SCOPE, 2026-09-11).

This card's first route (superseded -- see ASSET_PROVENANCE.md's
"Superseded" note) plainly descended the committed
`player_profile_costume_reference_T0317.png` with no new diffusion sampling
at all. That turned out to descend a 175x891 CROP, not the square 1024
render its own sidecar claimed, and produced an illegible result -- the card
was HELD.

T-0351's own finding, after 21 attempts building the Tier-2 master sheet, is
that exactly one panel converged reliably: `side_neutral` (a true 90-degree
standing side profile, arms hanging straight down) held clean across three
consecutive attempts (19, 20, 21) once each pose resolved its own IP-Adapter
reference (`reference_image_for`) instead of one shared crop -- side panels
condition on the committed T-0317 green side-profile reference, whole image,
square-padded before upload. T-0317's own reference pose (neutral, arms
straight down) matches `side_neutral`'s target pose exactly, which is why
this is the one T-0317-conditioned panel that never needed troubleshooting.

This script regenerates ONLY that one panel -- reusing
`gen_master_sheet_T0336`/`pose_rig_master_sheet_T0351`'s prompt builders,
`build_graph`, pose rig, and per-panel reference resolution completely
unchanged, no prompt tuning, no seed sweep -- then descends the accepted
1024 result through the same `char_gen` cutout primitives every other
keyframe in this pipeline already uses. Hard-capped at 3 generation
attempts per the card's own instruction; a human/agent judgment call opens
each attempt's raw panel directly (as every prior round in this pipeline
has) before deciding whether to descend it or spend another attempt.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/character/gen_profile_keyframe_side_neutral_T0339.py generate --attempt 1
    python3 assets/src/character/gen_profile_keyframe_side_neutral_T0339.py descend --attempt 1

Writes:
    assets/out/master_sheet_T0339/player/attempt_<N>/side_neutral_1024.png (gitignored)
    assets/out/master_sheet_T0339/player/attempt_<N>/provenance_candidate.json (gitignored)
    docs/assets/evidence/T-0339/side_neutral_attempt_<N>_1024.png (committed, as-you-go)
    assets/src/character/ARM_MASTER_SHEET_ATTEMPT_LOG_T0339.md (appended)
    assets/final/character/player_profile_keyframe_hybrid_T0272.png (on `descend`)
    assets/final/character/player_profile_keyframe_hybrid_T0272.provenance.json (on `descend`)
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

import gen_master_sheet_T0336 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as pose_rig  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402
from gen_arm_a_idle_T0228 import (  # noqa: E402
    cleanup_orphans,
    enforce_cell_margin,
    quantize_to_palette,
)

from char_gen.cutout import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_METHOD_DESCRIPTION,
    CUTOUT_OKLAB_TOLERANCE,
    DARK_BACKGROUND_FILL,
    apply_cutout_masks,
    downscale_mask,
    extract_foreground_mask,
    force_border_background_to_fill,
)
from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

CARD = "T-0339"
ENTITY_NAME = "player"
POSE_KEY = "side_neutral"
DEFAULT_PX = 1024

# T-0351's own proven attempt-19-21 recipe values, unchanged -- this card's
# own "Do not tune prompt weights" instruction means these are constants,
# not parameters.
STYLE_LORA_WEIGHT = 0.70
IPADAPTER_WEIGHT = 0.35

# T-0351's RE-SCOPE section (2026-09-10) authorised exactly three internal
# attempts (19, 20, 21) then a mandatory stop-and-report. This card's own
# instruction repeats that cap for its own three attempts: "If three
# attempts do not yield a clean neutral side profile, STOP AND REPORT."
ATTEMPT_CAP = 3

# side_neutral is POSE_SPECS index 4; run_five_pose_attempt seeds each pose
# `base_seed + index`. T-0351's logged base_seed for attempts 19/20/21 was
# 521365981 / 674839201 / 837462910 -- side_neutral's own seed each time was
# base_seed + 4. All three converged clean (see module docstring), so there
# is no single "correct" seed to reuse; ordered most-recent/most-robust
# first (attempt 21 includes the square-padding fix attempt 19 lacked).
KNOWN_GOOD_SEEDS: tuple[int, ...] = (837462914, 674839205, 521365985)

EVIDENCE_DIR = REPO_ROOT / "docs" / "assets" / "evidence" / "T-0339"

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.provenance.json"

CELL_SIZE = 48
CANVAS_PX = 384  # same x8 intermediate canvas this pipeline's other keyframes descend from
FIGURE_HEIGHT_FRAC = 40 / 48  # matches every other keyframe's 40px-tall-in-a-48px-cell convention

# Floor only -- unlike the superseded route's independent width stretch
# (needed because that route's source was an extreme 175x891 crop), a
# genuinely-generated 1024 standing profile should already clear this
# through ordinary aspect-preserving resize. Kept as a safety net: if a
# real generation's own bbox aspect is unexpectedly narrow, widen (bounded,
# never sheared) to this floor rather than ship an illegible sliver.
MIN_FIGURE_WIDTH_FRAC = 10 / 48


def seed_for_attempt(attempt: int) -> int:
    if not (1 <= attempt <= ATTEMPT_CAP):
        raise SystemExit(
            f"attempt cap is {ATTEMPT_CAP} for card {CARD!r} -- refusing to run further "
            "attempts (see conduct.md: a small job, not a sweep)"
        )
    return KNOWN_GOOD_SEEDS[attempt - 1]


def side_neutral_pose() -> gen.PoseSpec:
    return next(p for p in gen.POSE_SPECS if p.key == POSE_KEY)


def out_dir_for_attempt(attempt: int) -> Path:
    return gen.out_dir_for(CARD, ENTITY_NAME, attempt)


def evidence_panel_path(attempt: int) -> Path:
    return EVIDENCE_DIR / f"side_neutral_attempt_{attempt}_1024.png"


def candidate_provenance_path(attempt: int) -> Path:
    return out_dir_for_attempt(attempt) / "provenance_candidate.json"


def generated_panel_path(attempt: int) -> Path:
    return out_dir_for_attempt(attempt) / f"{POSE_KEY}_1024.png"


# ── Generation (live ComfyUI call) ──────────────────────────────────────────


def generate_side_neutral_panel(attempt: int) -> dict:
    """Runs ONE ComfyUI generation for the side_neutral panel only, reusing
    T-0351's proven attempt-19-21 recipe unchanged: build_single_pose_*
    prompts, pose_rig_master_sheet_T0351's OpenPose skeleton,
    reference_image_for's per-panel T-0317 reference conditioning
    (square-padded before upload), and build_graph. Writes the raw 1024
    panel and a provenance_candidate.json under this card's own out_dir/
    attempt-log namespace (never T-0351's -- that card's own 21-attempt cap
    is already spent) plus a committed evidence copy, and returns the
    generation record `build_generation_provenance` needs."""
    if gen.CHECKPOINT_LICENSE not in gen.CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {gen.CHECKPOINT_LICENSE!r} is not on the allowlist")

    seed = seed_for_attempt(attempt)
    entity = gen.ENTITIES[ENTITY_NAME]
    pose = side_neutral_pose()

    concept_hash = gen.sha256_of(entity.concept_sheet_path)
    if concept_hash != entity.concept_hash:
        raise RuntimeError(
            f"concept sheet hash mismatch for {ENTITY_NAME!r}: got {concept_hash}, "
            f"expected {entity.concept_hash}"
        )

    out_dir = out_dir_for_attempt(attempt)
    out_dir.mkdir(parents=True, exist_ok=True)

    positive_text = gen.build_single_pose_positive_prompt(entity, pose)
    negative_text = gen.build_single_pose_negative_prompt(pose)

    skeleton = pose_rig.render_pose_skeleton(pose.key, DEFAULT_PX)
    skeleton_path = out_dir / f"pose_{pose.key}_skeleton.png"
    skeleton.save(skeleton_path)
    skeleton_filename = gen.upload_image(skeleton_path)

    reference_path, reference_crop_box = gen.reference_image_for("T-0351", ENTITY_NAME, pose.key)
    reference_upload_path = gen.prepare_reference_for_upload(reference_path, out_dir)
    reference_square_padded = reference_upload_path != reference_path
    concept_filename = gen.upload_image(reference_upload_path)

    identity_lora_name = entity.identity_lora_name
    identity_lora_hash = None
    resolved_identity_weight = 0.0
    if identity_lora_name is not None:
        if not entity.identity_lora_path.exists():
            raise RuntimeError(f"trained identity LoRA not found: {entity.identity_lora_path}")
        identity_lora_hash = gen.sha256_of(entity.identity_lora_path)
        resolved_identity_weight = entity.identity_lora_weight

    style_lora_hash = gen.sha256_of(gen.LORA_PATH)

    graph = gen.build_graph(
        seed=seed,
        concept_filename=concept_filename,
        positive_text=positive_text,
        negative_text=negative_text,
        style_lora_weight=STYLE_LORA_WEIGHT,
        ipadapter_weight=IPADAPTER_WEIGHT,
        width=DEFAULT_PX,
        height=DEFAULT_PX,
        identity_lora_name=identity_lora_name,
        identity_lora_weight=resolved_identity_weight,
        concept_crop_box=reference_crop_box,
        pose_skeleton_filename=skeleton_filename,
        controlnet_strength=gen.CONTROLNET_STRENGTH,
        controlnet_end=gen.CONTROLNET_END_PERCENT,
        ipadapter_end_at=pose.ipadapter_end_at,
    )

    t0 = time.monotonic()
    prompt_id = gen.submit_prompt(graph)
    info = gen.wait_for_completion(prompt_id, timeout_s=300)
    gpu_seconds = time.monotonic() - t0

    panel_bytes = gen.fetch_save_image(info, gen.MAIN_SAVE_NODE_ID)
    panel_path = generated_panel_path(attempt)
    panel_path.write_bytes(panel_bytes)

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    evidence_panel_path(attempt).write_bytes(panel_bytes)

    record = {
        "attempt": attempt,
        "seed": seed,
        "comfyui_prompt_id": prompt_id,
        "gpu_seconds": round(gpu_seconds, 1),
        "positive_prompt": positive_text,
        "negative_prompt": negative_text,
        "reference_path": reference_path,
        "reference_hash": gen.sha256_of(reference_path),
        "reference_square_padded": reference_square_padded,
        "style_lora_hash": style_lora_hash,
        "identity_lora_hash": identity_lora_hash,
        "concept_hash": gen.sha256_of(reference_path),
    }

    provenance = build_generation_provenance(record)
    candidate_provenance_path(attempt).write_text(json.dumps(provenance, indent=2) + "\n")
    append_attempt_log(provenance)
    return record


def append_attempt_log(generation_provenance: dict) -> None:
    log_path = gen.attempt_log_path_for(CARD)
    if not log_path.exists():
        log_path.write_text(
            f"# side_neutral panel attempt log ({CARD}, RE-SCOPE 2026-09-11)\n\n"
            "Regenerates ONLY the side_neutral panel via T-0351's proven attempt-19-21 "
            "recipe, unchanged. Hard cap: 3 attempts.\n\n"
            "| Attempt | Seed | GPU seconds | Notes |\n|---|---|---|---|\n"
        )
    row = (
        f"| {generation_provenance['attempt']} | {generation_provenance['seed']} "
        f"| {generation_provenance['gpu_seconds']} | see "
        f"{evidence_panel_path(generation_provenance['attempt']).relative_to(REPO_ROOT)} |\n"
    )
    with log_path.open("a") as f:
        f.write(row)


# ── Pure provenance construction ────────────────────────────────────────────


def build_generation_provenance(record: dict) -> dict:
    """Pure: builds the generation-half of the provenance record from
    already-computed fields (no network). Mirrors
    `run_five_pose_attempt`'s own provenance shape where it overlaps, since
    this reuses the exact same recipe for one panel."""
    entity = gen.ENTITIES[ENTITY_NAME]
    identity_lora_name = entity.identity_lora_name if record.get("identity_lora_hash") else None
    model_summary = f"{gen.CHECKPOINT} + LoRA {gen.LORA_NAME} (style, weight {STYLE_LORA_WEIGHT})"
    if identity_lora_name is not None:
        model_summary += (
            f" + LoRA {identity_lora_name} (identity, chained, weight "
            f"{entity.identity_lora_weight})"
        )
    model_summary += (
        f" + IP-Adapter {gen.IPADAPTER_NAME} (weight {IPADAPTER_WEIGHT})"
        f" + ControlNet {gen.CONTROLNET_NAME} (pose conditioning only, strength "
        f"{gen.CONTROLNET_STRENGTH}/end {gen.CONTROLNET_END_PERCENT})"
    )
    return {
        "card": CARD,
        "attempt": record["attempt"],
        "attempt_cap": ATTEMPT_CAP,
        "seed": record["seed"],
        "comfyui_prompt_id": record.get("comfyui_prompt_id"),
        "gpu_seconds": record.get("gpu_seconds"),
        "pose_key": POSE_KEY,
        "pose_spec_source": (
            "assets/src/character/gen_master_sheet_T0336.py POSE_SPECS['side_neutral'], "
            "reused unchanged"
        ),
        "positive_prompt": record.get("positive_prompt"),
        "negative_prompt": record.get("negative_prompt"),
        "model": model_summary,
        "model_hash": gen.CHECKPOINT_HASH,
        "model_license": gen.CHECKPOINT_LICENSE,
        "style_lora_name": gen.LORA_NAME,
        "style_lora_hash": record.get("style_lora_hash"),
        "style_lora_weight": STYLE_LORA_WEIGHT,
        "style_lora_license": gen.LORA_LICENSE,
        "identity_lora_name": identity_lora_name,
        "identity_lora_hash": record.get("identity_lora_hash"),
        "identity_lora_weight": entity.identity_lora_weight if identity_lora_name else None,
        "ip_adapter": gen.IPADAPTER_NAME,
        "ip_adapter_weight": IPADAPTER_WEIGHT,
        "controlnet": gen.CONTROLNET_NAME,
        "controlnet_strength": gen.CONTROLNET_STRENGTH,
        "controlnet_end_percent": gen.CONTROLNET_END_PERCENT,
        "width": DEFAULT_PX,
        "height": DEFAULT_PX,
        "steps": 30,
        "cfg": 7.0,
        "entity": ENTITY_NAME,
        "concept_hash": record.get("concept_hash"),
        "reference_conditioning": {
            "path": str(record["reference_path"].relative_to(REPO_ROOT))
            if isinstance(record["reference_path"], Path)
            else record["reference_path"],
            "card": "T-0317",
            "sha256": record.get("reference_hash"),
            "square_padded_for_upload": record.get("reference_square_padded", False),
            "recipe_source": (
                "T-0351 attempts 19-21 (docs/assets/evidence/T-0351/README.md), reused "
                "unchanged -- no prompt tuning, no seed sweep"
            ),
        },
        "method": (
            "Single 1024x1024 txt2img generation of ONLY the side_neutral panel: "
            "LoraLoader(soviet_brutalism_style_v1) -> LoraLoader(identity, chained) -> "
            "CLIPTextEncode(positive/negative) -> ControlNetLoader + ControlNetApplyAdvanced "
            "(pose_rig_master_sheet_T0351's side_neutral skeleton) -> IPAdapterUnifiedLoader + "
            "IPAdapterAdvanced (T-0317 reference, square-padded, whole image) -> KSampler -> "
            "VAEDecode -> SaveImage. Reuses gen_master_sheet_T0336.build_graph and prompt "
            "builders unchanged -- this card's own generator wraps them for a single named "
            "pose instead of running all six POSE_SPECS panels."
        ),
    }


def build_final_provenance(generation_provenance: dict, descent_info: dict) -> dict:
    """Pure: merges the generation provenance with the descent step's own
    fields into the final sidecar shape the gate test checks."""
    final = dict(generation_provenance)
    final.update(
        {
            "route": "generated_and_descended",
            "gpu_call_required": True,
            "generator": "assets/src/character/gen_profile_keyframe_side_neutral_T0339.py",
            "cell_size": CELL_SIZE,
            "palette_path": str(PALETTE_PATH.relative_to(REPO_ROOT)),
            "dithering": False,
            "descent_method": (
                "The accepted side_neutral 1024 panel's own background is forced dark "
                f"(char_gen.cutout.force_border_background_to_fill, tolerance="
                f"{CUTOUT_OKLAB_TOLERANCE}), its foreground derived via the same "
                "border-connected Oklab flood every other keyframe in this pipeline uses "
                "(char_gen.cutout.extract_foreground_mask, no keypoints hint -- single-figure "
                "largest-component fallback), cropped to its own bbox, resized (LANCZOS) so "
                f"its height fills {FIGURE_HEIGHT_FRAC:.4f} of a {CANVAS_PX}px square canvas "
                "with width scaled to preserve the panel's own aspect ratio (widened only if "
                f"below a {MIN_FIGURE_WIDTH_FRAC:.4f} floor, bounded, never sheared), centred, "
                "then descended to 48x48 via BOX-filter resize, char_gen.cutout.downscale_mask "
                "for the mask, asset_gate.palette nearest-Oklab quantization with no dithering, "
                "char_gen.cutout.apply_cutout_masks, a 2px cell-margin clip, orphan-speck "
                "cleanup -- the same primitives every other keyframe in this pipeline already "
                "uses for this step."
            ),
            "background_cutout_applied": True,
            "cutout_method": CUTOUT_METHOD_DESCRIPTION,
            "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
            "cutout_bbox_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
            "canvas_px": CANVAS_PX,
            "figure_height_frac": FIGURE_HEIGHT_FRAC,
            "min_figure_width_frac": MIN_FIGURE_WIDTH_FRAC,
        }
    )
    final.update(descent_info)
    return final


# ── Descent (no network) ────────────────────────────────────────────────────


def resize_mask_to(mask: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    mask_img = Image.fromarray((mask * 255).astype(np.uint8))
    resized = mask_img.resize(size, Image.Resampling.BOX)
    return np.array(resized) >= 128


def build_descended_cell(
    source: Image.Image, palette: asset_gate_palette.Palette
) -> tuple[Image.Image, dict]:
    """Descends `source` (the accepted, freshly-generated side_neutral 1024
    panel) to a 48x48 indexed cell, reusing the pipeline's existing cutout +
    descent primitives unchanged. Unlike the superseded route (which forced
    an independent width stretch because its source was an extreme 175x891
    crop), this preserves the panel's own natural aspect ratio -- a real
    generation should already sit near this pipeline's legible-width
    footprint -- and only widens (bounded, never sheared) if it falls below
    the minimum legible floor."""
    corrected = force_border_background_to_fill(source, CUTOUT_OKLAB_TOLERANCE)
    native_mask = extract_foreground_mask(corrected, CUTOUT_OKLAB_TOLERANCE, keypoints_norm=None)

    ys, xs = np.where(native_mask)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    figure = corrected.crop((x0, y0, x1, y1))
    figure_mask = native_mask[y0:y1, x0:x1]

    target_h = round(CANVAS_PX * FIGURE_HEIGHT_FRAC)
    natural_w = round(target_h * (figure.width / figure.height))
    min_w = round(CANVAS_PX * MIN_FIGURE_WIDTH_FRAC)
    target_w = max(natural_w, min_w)

    figure_resized = figure.resize((target_w, target_h), Image.Resampling.LANCZOS)
    mask_resized = resize_mask_to(figure_mask, (target_w, target_h))

    canvas = Image.new("RGB", (CANVAS_PX, CANVAS_PX), DARK_BACKGROUND_FILL)
    paste_x = (CANVAS_PX - target_w) // 2
    paste_y = (CANVAS_PX - target_h) // 2
    canvas.paste(figure_resized, (paste_x, paste_y))

    canvas_mask = np.zeros((CANVAS_PX, CANVAS_PX), dtype=bool)
    canvas_mask[paste_y : paste_y + target_h, paste_x : paste_x + target_w] = mask_resized

    raw_cell = canvas.resize((CELL_SIZE, CELL_SIZE), Image.Resampling.BOX)
    fg_mask_48 = downscale_mask(canvas_mask, CELL_SIZE)

    indexed = quantize_to_palette(raw_cell, palette)
    indexed = apply_cutout_masks(
        indexed, {(0, 0): fg_mask_48}, cell_size=CELL_SIZE, background_index=0
    )
    indexed = enforce_cell_margin(indexed, cell_size=CELL_SIZE, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)

    descent_info = {"source_bbox_on_panel": [x0, y0, x1, y1]}
    return indexed, descent_info


def descend_accepted_panel(attempt: int) -> dict:
    """Reads the already-generated side_neutral panel + its candidate
    provenance for `attempt`, descends it, and writes the final 48x48
    keyframe + sidecar."""
    panel_path = generated_panel_path(attempt)
    if not panel_path.exists():
        raise RuntimeError(f"no generated panel for attempt {attempt}: {panel_path}")
    generation_provenance = json.loads(candidate_provenance_path(attempt).read_text())

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    source_img = Image.open(panel_path).convert("RGB")
    indexed, descent_info = build_descended_cell(source_img, palette)

    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    save_sprite_sheet(indexed, FINAL_PATH)

    provenance = build_final_provenance(generation_provenance, descent_info)
    FINAL_PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["generate", "descend"])
    parser.add_argument("--attempt", type=int, required=True)
    args = parser.parse_args()

    if args.action == "generate":
        record = generate_side_neutral_panel(args.attempt)
        print(json.dumps({k: v for k, v in record.items() if k != "reference_path"}, indent=2))
    else:
        provenance = descend_accepted_panel(args.attempt)
        print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
