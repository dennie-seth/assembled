#!/usr/bin/env python3
"""Diagnostic-only probe (T-0259), not a production generation path.

The 2026-09-08 reviewer verdict on this card raised a decisive counter-
finding against the previous session's own "host-level incoherence"
conclusion: attempts 5-9 (pre-T-0319 identity-reference crop, i.e. the crop
WITHOUT `force_border_background_to_fill` applied to it) all came back as
recognisable figures, while attempts 3-4 (the same recipe, but with T-0319's
fix now applied to the identity-reference crop as well as the per-frame
cutout) came back as structurally incoherent barred/blocky abstraction with
no legible figure at all. A host-coherence explanation predicts failure
independent of which reference conditions IP-Adapter; a reference-regression
explanation predicts exactly the split actually observed.

Variant "bypass" (the reviewer's own suggested probe): identity reference
with NO background correction at all, i.e. exactly what attempts 5-9 used.
Result (see attempt log): coherent, matches attempt 5's figure quality --
confirms the regression is in the reference-side fix, not the host.

Variant "blend": a follow-up hypothesis this script also tests. T-0319's
`force_border_background_to_fill` does a HARD flat replace -- every
background pixel becomes the exact same `DARK_BACKGROUND_FILL` RGB triple,
producing a perfectly flat region with a sharp geometric edge around the
figure. That is a very unnatural signal for a CLIP vision encoder trained on
photographic references, and is a plausible reason IP-Adapter conditioning
destabilises on it specifically (as opposed to background colour per se).
"blend" tests whether a PARTIAL correction -- alpha-blending each background
pixel some fraction of the way toward the dark fill, preserving the
original gradient/texture rather than flattening it -- can move the
background hue away from the problematic light grey while staying close
enough to a "natural-looking" image that IP-Adapter stays coherent.

Neither variant is a production change by itself. This script does not go
through `check_attempt_cap` (DL-21's 8-slot budget is for candidate SHEETS
that might be promoted; a single diagnostic frame that will never be
promoted is not one of those slots), does not write into a numbered
`attempt_<N>/` directory, and is not part of the pytest-discovered gate
suite -- the same category as this card's own prior `tmp_probe/` and
T-0317's `profile_probe_T0259/` ad hoc host queries. Output lands in
`assets/out/hybrid_walk/probe_reference_bypass_T0259/<variant>/` (gitignored).

Usage:
    python3 assets/src/character/probe_reference_bypass_T0259.py bypass
    python3 assets/src/character/probe_reference_bypass_T0259.py blend 0.5
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pose_rig_walk_T0259  # noqa: E402
from gen_hybrid_walk_T0259 import (  # noqa: E402
    CONCEPT_SHEET_PATH,
    CUTOUT_OKLAB_TOLERANCE,
    FRAME_COUNT,
    GEN_PX,
    IDENTITY_REFERENCE_CROP_BOX,
    MAIN_SAVE_NODE_ID,
    REPO_ROOT,
    build_graph,
    fetch_save_image,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

from char_gen.cutout import DARK_BACKGROUND_FILL, border_flood_background_mask  # noqa: E402

# Attempt 3's own recipe, held fixed -- the only variable this probe changes
# is how (or whether) the identity-reference crop's background is corrected.
SEED = 27182
CONTROLNET_STRENGTH = 1.0
CONTROLNET_END = 1.0
IPADAPTER_WEIGHT = 0.6
STYLE_LORA_WEIGHT = 0.70
IDENTITY_LORA_WEIGHT = 0.50

OUT_ROOT = REPO_ROOT / "assets" / "out" / "hybrid_walk" / "probe_reference_bypass_T0259"


def blend_border_background(img: Image.Image, tolerance: float, alpha: float) -> Image.Image:
    """Alpha-blend each background pixel `alpha` of the way toward
    `DARK_BACKGROUND_FILL`, using the same border-flood mask
    `force_border_background_to_fill` trusts -- but never fully replacing a
    pixel, so the reference keeps its own gradient/texture instead of
    becoming a flat fill."""
    mask = border_flood_background_mask(img, tolerance)
    arr = np.array(img.convert("RGB"), dtype=np.float64)
    fill = np.array(DARK_BACKGROUND_FILL, dtype=np.float64)
    arr[mask] = arr[mask] * (1 - alpha) + fill * alpha
    return Image.fromarray(arr.astype(np.uint8), mode="RGB")


def main() -> None:
    variant = sys.argv[1] if len(sys.argv) > 1 else "bypass"
    alpha = float(sys.argv[2]) if len(sys.argv) > 2 else None
    if variant not in ("bypass", "blend"):
        raise SystemExit(f"unknown variant {variant!r} -- expected 'bypass' or 'blend'")
    if variant == "blend" and alpha is None:
        alpha = 0.5

    out_dir = OUT_ROOT / (variant if variant == "bypass" else f"blend_{alpha}")
    out_dir.mkdir(parents=True, exist_ok=True)

    crop = Image.open(CONCEPT_SHEET_PATH).convert("RGB").crop(IDENTITY_REFERENCE_CROP_BOX)
    if variant == "bypass":
        reference_img = crop
    else:
        reference_img = blend_border_background(crop, CUTOUT_OKLAB_TOLERANCE, alpha)

    reference_path = out_dir / "identity_reference_crop.png"
    reference_img.save(reference_path)
    concept_filename = upload_image(reference_path)

    points = pose_rig_walk_T0259.walk_keypoints_for_frame(0, FRAME_COUNT)
    skeleton_img = pose_rig_walk_T0259.render_pose_frame(points, GEN_PX)
    skeleton_path = out_dir / "frame_0_pose_skeleton_384.png"
    skeleton_img.save(skeleton_path)
    skeleton_filename = upload_image(skeleton_path)

    graph = build_graph(
        seed=SEED,
        concept_filename=concept_filename,
        pose_skeleton_filename=skeleton_filename,
        controlnet_strength=CONTROLNET_STRENGTH,
        controlnet_end=CONTROLNET_END,
        ipadapter_weight=IPADAPTER_WEIGHT,
        style_lora_weight=STYLE_LORA_WEIGHT,
        identity_lora_weight=IDENTITY_LORA_WEIGHT,
    )

    t0 = time.monotonic()
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id, timeout_s=300)
    generation_seconds = time.monotonic() - t0

    main_bytes = fetch_save_image(info, MAIN_SAVE_NODE_ID)
    main_path = out_dir / "frame_0_main_384.png"
    main_path.write_bytes(main_bytes)

    (out_dir / "probe_meta.json").write_text(
        json.dumps(
            {
                "variant": variant,
                "alpha": alpha,
                "seed": SEED,
                "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
                "comfyui_prompt_id": prompt_id,
                "generation_seconds": generation_seconds,
                "output": str(main_path.relative_to(REPO_ROOT)),
                "reference_crop": str(reference_path.relative_to(REPO_ROOT)),
            },
            indent=2,
        )
        + "\n"
    )
    print(f"[{variant}] wrote {main_path} in {generation_seconds:.1f}s (prompt_id={prompt_id})")


if __name__ == "__main__":
    main()
