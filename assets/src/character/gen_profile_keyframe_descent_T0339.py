#!/usr/bin/env python3
"""SUPERSEDED (2026-09-11) -- see gen_profile_keyframe_side_neutral_T0339.py.

This script's own premise -- that `player_profile_costume_reference_T0317.png`
is a genuine square 1024 render needing only descent -- was wrong: that file
is a 175x891 CROP, not the square render its own sidecar claimed, and the
descended result was illegible (a pale olive column, no recoverable facing
information). Kept for the historical record (ASSET_PROVENANCE.md's own
"Superseded" note references it); do not run this script or treat its output
as current. `gen_profile_keyframe_side_neutral_T0339.py` is this card's
current generator.

Descend the committed T-0317 side-profile reference to a 48x48 keyframe (T-0339).

T-0272's own dual-IPAdapter + ControlNet stack (`gen_hybrid_profile_T0272.py`)
spent 84 attempts across 12 rounds and never produced a promotable frame at
`assets/final/character/player_profile_keyframe_hybrid_T0272.png` -- see
`ARM_PROFILE_ATTEMPT_LOG_T0272.md` for the full history. T-0317 separately
produced a genuine, unambiguous, vivid-green right-facing side profile
(`player_profile_costume_reference_T0317.png`, committed and provenanced) via
a completely different, ControlNet-free and IP-Adapter-free stack -- plain
txt2img + the style LoRA only -- then excluded it from promotion for the sole
reason that it didn't come from "the hybrid stack."

**This card removes that exclusion.** Per the card's own instruction ("Do
not route this through the dual-IPAdapter + ControlNet stack -- that stack
is exactly what failed 84 times" / "Do not regenerate the reference; it is
committed, provenanced and proven"), this script performs NO new diffusion
sampling at all: it descends the already-committed T-0317 reference straight
to 48x48 through the pipeline's existing, unmodified cutout + descent
primitives (`char_gen.cutout`), the same functions every other §24-e-family
keyframe in this repo already uses for that step.

Descent shape, since T-0317's own reference is a tight figure crop (175x891),
not a square canvas: the reference's own foreground is re-derived (border
flood + largest-component, no keypoints hint needed for a single figure),
cropped to its own bbox, resized so its height fills the same 40/48 fraction
of a 384px square canvas every other keyframe's 40px-tall-in-a-48px-cell
convention targets -- **and its width independently fills 15/48 of that same
canvas** (see FIGURE_WIDTH_FRAC's own comment: fitting width from height
alone via the source's own ~1:5.05 aspect produced an unreadable 3px-wide
column at 48x48, a reviewer FAIL against this card's first GREEN; a true
side profile has no shoulder width to show, so it is legitimately narrower
than a front-facing pose, but must still land in the same legible-width
footprint this pipeline's own promoted keyframes occupy) -- centred on that
canvas, then descended to 48x48 exactly as a fresh generation's own raw
frame would be (BOX-filter resize, nearest-Oklab palette quantization with
no dithering, per-pixel cutout, a 2px cell-margin clip, orphan-speck
cleanup).

Usage (from the repo root, no ComfyUI host required):
    python3 assets/src/character/gen_profile_keyframe_descent_T0339.py

Writes:
    assets/final/character/player_profile_keyframe_hybrid_T0272.png
    assets/final/character/player_profile_keyframe_hybrid_T0272.provenance.json
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from asset_gate import palette as asset_gate_palette  # noqa: E402
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
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

SOURCE_REFERENCE_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_costume_reference_T0317.png"
)
SOURCE_REFERENCE_PROVENANCE_PATH = (
    REPO_ROOT
    / "assets"
    / "src"
    / "concept"
    / "player_profile_costume_reference_T0317.provenance.json"
)
# sha256 of the committed T-0317 reference at the time this card ran -- guards
# against silently descending a different file than the one this card's own
# provenance chain was written against (the same pattern
# derive_profile_style_reference_T0272.py's own EXPECTED_CONCEPT_HASH uses).
EXPECTED_SOURCE_HASH = "603c00f2cc7a5da0462f05232176131d06678776de4876800e7b27af343d7f19"

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.provenance.json"

CELL_SIZE = 48
CANVAS_PX = 384  # same x8 intermediate canvas this pipeline's other keyframes descend from
FIGURE_HEIGHT_FRAC = 40 / 48  # matches every other keyframe's 40px-tall-in-a-48px-cell convention

# Reviewer FAIL round 1: fitting width from height alone via the source's own
# raw aspect ratio (T-0317's crop is 175x883, ~1:5.05 -- a true side profile,
# with no shoulder width to show, is legitimately far narrower than a
# front-facing pose) produced a 3px-wide olive column: faithful to the
# source's own proportions, but with no recoverable facing information at
# 40px tall. This pipeline's OTHER keyframes never hit this because they are
# front/three-quarter poses generated directly at roughly the target cell
# aspect; nothing here assumes a photographically faithful aspect is even
# desirable at this resolution -- every keyframe in this pipeline already
# widens its source to a canonical legible footprint, this is just the first
# one whose source aspect was extreme enough to make that explicit. Target
# width is fit independently of target height (a deliberate, bounded,
# uniform horizontal stretch -- never a shear) to the same footprint the
# pipeline's own already-promoted front-facing anchor measures at
# (`player_idle_sheet_hybrid_T0252.png`: every cell's foreground bbox is
# 14-16px wide at 44px tall -- midpoint 15 chosen here).
FIGURE_WIDTH_FRAC = 15 / 48


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resize_mask_to(mask: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Area-resample a boolean mask to `size` (w, h) and re-threshold at 50%
    coverage -- the same BOX-filter + re-threshold approach
    `char_gen.cutout.downscale_mask` already uses for its own square target,
    generalized here to an arbitrary width/height for this card's own
    intermediate resize-onto-canvas step."""
    mask_img = Image.fromarray((mask * 255).astype(np.uint8))
    resized = mask_img.resize(size, Image.Resampling.BOX)
    return np.array(resized) >= 128


def build_descended_cell(
    source: Image.Image, palette: asset_gate_palette.Palette
) -> tuple[Image.Image, dict]:
    """Descend `source` (the committed T-0317 reference -- already a tight
    figure crop on a forced-dark background) to a 48x48 indexed cell, reusing
    the pipeline's existing cutout + descent primitives unchanged: no new
    diffusion sampling, no ControlNet, no IP-Adapter."""
    corrected = force_border_background_to_fill(source, CUTOUT_OKLAB_TOLERANCE)
    native_mask = extract_foreground_mask(corrected, CUTOUT_OKLAB_TOLERANCE, keypoints_norm=None)

    ys, xs = np.where(native_mask)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    figure = corrected.crop((x0, y0, x1, y1))
    figure_mask = native_mask[y0:y1, x0:x1]

    target_h = round(CANVAS_PX * FIGURE_HEIGHT_FRAC)
    target_w = round(CANVAS_PX * FIGURE_WIDTH_FRAC)

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

    descent_info = {"source_bbox_on_reference": [x0, y0, x1, y1]}
    return indexed, descent_info


def descend() -> dict:
    actual_source_hash = sha256_of(SOURCE_REFERENCE_PATH)
    if actual_source_hash != EXPECTED_SOURCE_HASH:
        raise RuntimeError(
            f"T-0317 reference hash mismatch: got {actual_source_hash}, "
            f"expected {EXPECTED_SOURCE_HASH} -- refusing to descend an unexpected file"
        )
    source_provenance = json.loads(SOURCE_REFERENCE_PROVENANCE_PATH.read_text())

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    source_img = Image.open(SOURCE_REFERENCE_PATH).convert("RGB")
    indexed, descent_info = build_descended_cell(source_img, palette)

    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    save_sprite_sheet(indexed, FINAL_PATH)

    provenance = {
        "card": "T-0339",
        "route": "descended",
        "gpu_call_required": False,
        "generator": "assets/src/character/gen_profile_keyframe_descent_T0339.py",
        "model": source_provenance["model"],
        "model_hash": CHECKPOINT_HASH,
        "model_license": CHECKPOINT_LICENSE,
        "concept_hash": actual_source_hash,
        "source_reference": {
            "path": str(SOURCE_REFERENCE_PATH.relative_to(REPO_ROOT)),
            "provenance_path": str(SOURCE_REFERENCE_PROVENANCE_PATH.relative_to(REPO_ROOT)),
            "card": "T-0317",
            "sha256": actual_source_hash,
            "seed": source_provenance["seed"],
            "steps": source_provenance["steps"],
            "cfg": source_provenance["cfg"],
            "sampler": source_provenance["sampler"],
            "scheduler": source_provenance["scheduler"],
            "method": source_provenance["method"],
        },
        "cell_size": CELL_SIZE,
        "palette_path": str(PALETTE_PATH.relative_to(REPO_ROOT)),
        "dithering": False,
        "descent_method": (
            "Deterministic descent of an already-committed, already-provenanced 1024px "
            "diffusion sample (T-0317) -- no new ComfyUI call, no ControlNet, no IP-Adapter. "
            f"The reference's own background is re-forced dark (char_gen.cutout."
            f"force_border_background_to_fill, tolerance={CUTOUT_OKLAB_TOLERANCE}), its foreground "
            "is re-derived via the same border-connected Oklab flood every other keyframe in this "
            "pipeline uses (char_gen.cutout.extract_foreground_mask, no keypoints hint -- single-"
            "figure largest-component fallback), cropped to its own bbox, resized (LANCZOS) so "
            f"its height fills {FIGURE_HEIGHT_FRAC:.4f} and its width fills "
            f"{FIGURE_WIDTH_FRAC:.4f} of a {CANVAS_PX}px square canvas -- independently, a "
            "deliberate, bounded, uniform horizontal stretch (never a shear) because the source "
            "crop's own raw aspect (175x883, ~1:5.05 -- a true side profile has no shoulder width "
            "to show) produced an unreadable 3px-wide column when width was derived from height "
            "alone (reviewer FAIL, round 1); the width target instead matches the footprint this "
            "pipeline's own already-promoted "
            "front-facing anchor measures at (player_idle_sheet_hybrid_T0252.png: 14-16px wide at "
            "44px tall, midpoint 15/48 used here), centred, then descended to 48x48 via the same "
            "primitives a fresh generation's own raw frame would use (BOX-filter resize, "
            "char_gen.cutout.downscale_mask for the mask, asset_gate.palette-nearest-Oklab "
            "quantization with no dithering, char_gen.cutout.apply_cutout_masks, a 2px cell-margin "
            "clip, orphan-speck cleanup)."
        ),
        "background_cutout_applied": True,
        "cutout_method": CUTOUT_METHOD_DESCRIPTION,
        "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
        "cutout_bbox_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
        "canvas_px": CANVAS_PX,
        "figure_height_frac": FIGURE_HEIGHT_FRAC,
        "figure_width_frac": FIGURE_WIDTH_FRAC,
        "source_bbox_on_reference": descent_info["source_bbox_on_reference"],
    }
    FINAL_PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    provenance = descend()
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
