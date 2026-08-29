#!/usr/bin/env python3
"""T-0248 round-2 Done-when: re-run Arm B generation against `player_identity_v2`.

HANDOFF §24-a's hypothesis is that `player_identity_v1` (trained on T-0209's
~20-panel costume-*exploration* sheet) learned a distribution of costumes
rather than one character, and that this explains both round-1 generative
failures (Arm A's cross-row drift/colour-shift, Arm B needing 7/8 attempts).
`player_identity_v2` (T-0248) retrains on a single-costume, 29-view dataset
to test that. This script re-runs Arm B's exact generation recipe -- same
graph, same seed/weights/ControlNet settings as T-0229 attempt 7 (the
promoted, passing attempt) -- swapping only the identity LoRA file, so any
change in the measured frame-delta range is attributable to the dataset
change alone, per round-2 rule "same pre-registered criteria... changing the
measure voids the round-1 comparison."

This does NOT touch T-0229's promoted sheet, attempt log, or provenance --
it reuses `gen_arm_b_idle_T0229.build_graph`/`run_attempt`/`append_attempt_log`
(all now accept an identity-LoRA override, T-0248) with a separate output
subdir (`assets/out/arm_b_v2/`) and its own attempt log
(`ARM_B_V2_ATTEMPT_LOG_T0248.md`). Nothing here is promoted to
`assets/final/character/` -- this is a diagnostic measurement, not a new
bake-off arm competing for adoption.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_v2.safetensors has been trained and is loadable by ComfyUI's
LoraLoader):
    python3 assets/src/character/gen_arm_b_idle_v2_T0248.py --attempt 1 --seed 31416

Writes:
    assets/out/arm_b_v2/attempt_<N>/{pose_grid_1008,main_1008,sheet_144_indexed}.png
    assets/out/arm_b_v2/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_B_V2_ATTEMPT_LOG_T0248.md   (appended, one row per attempt)
"""

from __future__ import annotations

import argparse
import json

from gen_arm_b_idle_T0229 import (  # noqa: E402
    REPO_ROOT,
    run_attempt,
)

IDENTITY_LORA_NAME = "player_identity_v2.safetensors"
IDENTITY_LORA_PATH = REPO_ROOT / "assets" / "final" / "lora" / IDENTITY_LORA_NAME
IDENTITY_LORA_PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v2.provenance.json"
)

OUT_DIR_NAME = "arm_b_v2"
ATTEMPT_LOG_PATH = REPO_ROOT / "assets" / "src" / "character" / "ARM_B_V2_ATTEMPT_LOG_T0248.md"

ATTEMPT_LOG_HEADER = (
    "# Arm B round-2 diagnostic attempt log (T-0248, HANDOFF §24-a Done-when)\n\n"
    "Re-runs T-0229's exact Arm B generation recipe against `player_identity_v2` instead of "
    "`player_identity_v1`, to measure whether the single-costume identity LoRA changes the "
    "adjacent-frame drift picture under the unchanged DL-21 criteria. Not a new bake-off arm -- "
    "no attempt here is promoted to `assets/final/character/`.\n\n"
    "| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | "
    "GPU seconds | Mechanical gate | Notes |\n"
    "|---|---|---|---|---|---|---|---|\n"
)


def append_v2_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['style_lora_weight']} | {provenance['identity_lora_weight']} "
        f"| {provenance['gpu_seconds']} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {notes} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--controlnet-strength", type=float, default=1.3)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.50)
    parser.add_argument("--notes", type=str, default="")
    args = parser.parse_args()

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
        identity_lora_name=IDENTITY_LORA_NAME,
        identity_lora_path=IDENTITY_LORA_PATH,
        identity_lora_provenance_path=IDENTITY_LORA_PROVENANCE_PATH,
        out_dir_name=OUT_DIR_NAME,
        card="T-0248",
        bake_off_arm="B, round-2 diagnostic re-run against player_identity_v2 (HANDOFF §24-a)",
    )

    out_dir = REPO_ROOT / "assets" / "out" / OUT_DIR_NAME / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_v2_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
