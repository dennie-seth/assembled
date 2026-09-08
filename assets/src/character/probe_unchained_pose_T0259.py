#!/usr/bin/env python3
"""Diagnostic-only probe (T-0259), not a production generation path.

Session 4's own attempt log (2026-09-08) root-caused why attempt 5 -- the
first candidate ever to clear coherence, the background-fraction floor, and
identity colour simultaneously -- still fails the card's gait-legibility bar:
frame 0 is the only frame sampled fresh (`build_graph`, `EmptyLatentImage`,
denoise 1.0); frames 1-7 are img2img-chained from frame 0's own decoded
pixels (`build_chained_graph`, `VAEEncode`, denoise 0.35) via
`_generate_one_frame`. Frame 0's ControlNet skeleton is visibly, unambiguously
different from frame 2's (contact stance vs. narrow crossing stance), but the
img2img chain's low-denoise regime does not translate that skeleton
difference into the final pixels -- raising denoise (attempt 6) or lowering
IP-Adapter weight (attempt 7) each changed something else (background noise,
background cleanliness) without changing how much the character's own limbs
moved.

This probe tests the working hypothesis directly: generate frame 2 (a
passing/cross pose, `pose_rig_walk_T0259.walk_keypoints_for_frame(2, 8)`)
UNCHAINED -- via `build_graph`, not `build_chained_graph` -- at denoise 1.0,
with every other input held identical to attempt 5's own recipe (seed 27182,
blend_0.5 identity-reference background correction, controlnet 1.0/1.0,
ipadapter 0.6, style/identity LoRA 0.70/0.50). If the resulting frame visibly
adopts frame 2's crossed-leg pose (unlike attempt 5's own frame 2, chained
and pose-static), the img2img chain -- not the pose rig -- is confirmed as
the bottleneck, and the fix belongs in how frame-to-frame consistency is
achieved, not in another amplitude/denoise calibration sweep.

Like `probe_reference_bypass_T0259.py`, this script does not go through
`check_attempt_cap` (DL-21's 8-slot budget is for candidate SHEETS that might
be promoted; a single diagnostic frame that will never be promoted is not one
of those slots), does not write into a numbered `attempt_<N>/` directory, and
is not part of the pytest-discovered gate suite. Output lands in
`assets/out/hybrid_walk/probe_unchained_pose_T0259/` (gitignored).

Usage:
    python3 assets/src/character/probe_unchained_pose_T0259.py
    python3 assets/src/character/probe_unchained_pose_T0259.py --frame 2
"""

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pose_rig_walk_T0259  # noqa: E402
from gen_hybrid_walk_T0259 import (  # noqa: E402
    CONCEPT_SHEET_PATH,
    FRAME_COUNT,
    GEN_PX,
    MAIN_SAVE_NODE_ID,
    REPO_ROOT,
    build_graph,
    crop_identity_reference,
    fetch_save_image,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

# Attempt 5's own recipe, held fixed -- the only variable this probe changes
# is which frame's skeleton is conditioned on, and whether generation is
# chained (attempt 5) or fresh/unchained (this probe).
SEED = 27182
CONTROLNET_STRENGTH = 1.0
CONTROLNET_END = 1.0
IPADAPTER_WEIGHT = 0.6
STYLE_LORA_WEIGHT = 0.70
IDENTITY_LORA_WEIGHT = 0.50
BACKGROUND_CORRECTION = "blend_0.5"

OUT_ROOT = REPO_ROOT / "assets" / "out" / "hybrid_walk" / "probe_unchained_pose_T0259"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frame", type=int, default=2, help="frame index, 0..7 (default 2)")
    args = parser.parse_args()

    out_dir = OUT_ROOT
    out_dir.mkdir(parents=True, exist_ok=True)

    reference_path = out_dir / "identity_reference_crop.png"
    crop_identity_reference(
        CONCEPT_SHEET_PATH, reference_path, background_correction=BACKGROUND_CORRECTION
    )
    concept_filename = upload_image(reference_path)

    points = pose_rig_walk_T0259.walk_keypoints_for_frame(args.frame, FRAME_COUNT)
    skeleton_img = pose_rig_walk_T0259.render_pose_frame(points, GEN_PX)
    skeleton_path = out_dir / f"frame_{args.frame}_pose_skeleton_384.png"
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
    main_path = out_dir / f"frame_{args.frame}_main_384_unchained.png"
    main_path.write_bytes(main_bytes)

    (out_dir / f"frame_{args.frame}_probe_meta.json").write_text(
        json.dumps(
            {
                "frame_index": args.frame,
                "generation_mode": "fresh_unchained",
                "denoise": 1.0,
                "seed": SEED,
                "background_correction": BACKGROUND_CORRECTION,
                "comfyui_prompt_id": prompt_id,
                "generation_seconds": generation_seconds,
                "output": str(main_path.relative_to(REPO_ROOT)),
                "skeleton": str(skeleton_path.relative_to(REPO_ROOT)),
                "compare_against": "assets/out/hybrid_walk/attempt_5/frame_2_main_384.png "
                "(chained, denoise 0.35) and attempt_5/frame_0_main_384.png "
                "(fresh, denoise 1.0, contact pose) for the pose-fidelity comparison",
            },
            indent=2,
        )
        + "\n"
    )
    print(
        f"[frame {args.frame}, unchained] wrote {main_path} in "
        f"{generation_seconds:.1f}s (prompt_id={prompt_id})"
    )


if __name__ == "__main__":
    main()
