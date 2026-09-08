#!/usr/bin/env python3
"""Diagnostic-only probe (T-0259), not a production generation path.

Session 5's own two experiments so far bracket the problem from both ends:

- Fully unchained (`probe_unchained_pose_T0259.py`, and the real 8-frame
  `--attempt 6` run this session): frame 2's skeleton difference IS followed
  -- legs/arms visibly move -- but costume colour drifts badly frame to
  frame (some frames render mostly white/pale, matching the card's own
  "identity does not go pale" failure mode), and the frame-delta range
  (0.54-0.76) blows well past the 0.50 locomotion cap, confirming T-0266's
  original finding that independent sampling does not hold the character's
  own rendered costume consistent.
- The old chain at denoise 0.35 (attempt 5): costume stays solid and
  consistent, but pose motion is not legible (frame 2 barely differs from
  frame 0).

This probe sweeps denoise on the CHAINED path (`build_chained_graph`, still
intact as a primitive even though the production path no longer calls it)
between those two extremes, to see whether an intermediate value gets both:
visible pose motion AND costume consistency. Chains frame 2 from a real
frame 0 (an attempt's own `frame_0_main_384.png`, passed via --frame0).

Not a production change, not a numbered attempt, not part of the gate
suite. Output lands in
`assets/out/hybrid_walk/probe_chain_denoise_sweep_T0259/denoise_<d>/`
(gitignored).

Usage:
    python3 assets/src/character/probe_chain_denoise_sweep_T0259.py \
        --frame0 assets/out/hybrid_walk/attempt_6/frame_0_main_384.png \
        --denoise 0.6 0.75
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
    build_chained_graph,
    crop_identity_reference,
    fetch_save_image,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

SEED = 27182
CONTROLNET_STRENGTH = 1.0
CONTROLNET_END = 1.0
IPADAPTER_WEIGHT = 0.6
STYLE_LORA_WEIGHT = 0.70
IDENTITY_LORA_WEIGHT = 0.50
BACKGROUND_CORRECTION = "blend_0.5"
FRAME_INDEX = 2

OUT_ROOT = REPO_ROOT / "assets" / "out" / "hybrid_walk" / "probe_chain_denoise_sweep_T0259"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--frame0", type=Path, required=True, help="path to a frame 0 main_384 PNG to chain from"
    )
    parser.add_argument("--denoise", type=float, nargs="+", required=True)
    args = parser.parse_args()

    reference_path = OUT_ROOT / "identity_reference_crop.png"
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    crop_identity_reference(
        CONCEPT_SHEET_PATH, reference_path, background_correction=BACKGROUND_CORRECTION
    )
    concept_filename = upload_image(reference_path)

    points = pose_rig_walk_T0259.walk_keypoints_for_frame(FRAME_INDEX, FRAME_COUNT)
    skeleton_img = pose_rig_walk_T0259.render_pose_frame(points, GEN_PX)
    skeleton_path = OUT_ROOT / f"frame_{FRAME_INDEX}_pose_skeleton_384.png"
    skeleton_img.save(skeleton_path)
    skeleton_filename = upload_image(skeleton_path)

    init_image_filename = upload_image(args.frame0)

    for denoise in args.denoise:
        out_dir = OUT_ROOT / f"denoise_{denoise}"
        out_dir.mkdir(parents=True, exist_ok=True)

        graph = build_chained_graph(
            seed=SEED,
            concept_filename=concept_filename,
            pose_skeleton_filename=skeleton_filename,
            init_image_filename=init_image_filename,
            denoise=denoise,
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
        main_path = out_dir / f"frame_{FRAME_INDEX}_main_384_chained.png"
        main_path.write_bytes(main_bytes)

        (out_dir / "probe_meta.json").write_text(
            json.dumps(
                {
                    "frame_index": FRAME_INDEX,
                    "denoise": denoise,
                    "seed": SEED,
                    "frame0_source": str(args.frame0),
                    "comfyui_prompt_id": prompt_id,
                    "generation_seconds": generation_seconds,
                    "output": str(main_path.relative_to(REPO_ROOT)),
                },
                indent=2,
            )
            + "\n"
        )
        print(f"[denoise={denoise}] wrote {main_path} in {generation_seconds:.1f}s")


if __name__ == "__main__":
    main()
