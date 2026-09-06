#!/usr/bin/env python3
"""T-0274 acceptance smoke check: does `player_identity_profile_v1` place a profile?

Reuses the exact §24-e hybrid stack graph (`gen_hybrid_source_idle_T0252.build_graph`)
unchanged -- style LoRA + identity LoRA (chained) + IP-Adapter (T-0209 concept) +
OpenPose ControlNet -- with exactly one variable swapped: the identity LoRA is
`player_identity_profile_v1.safetensors` (this card) instead of `player_identity_v2`.

The pose skeleton is deliberately still the existing FRONT-FACING topology
(`gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM`, via `draw_pose_skeleton_cell`) --
authoring a profile-topology skeleton is T-0272's own scope, not this card's, and
T-0272 is blocked on this card's LoRA existing first. This smoke check isolates
one question: is the profile LoRA *alone* (still under front-facing ControlNet
conditioning) enough to place a profile, or is the rig also required (T-0272)?

Same recipe T-0272's 4 attempts and T-0248's winning arm used (DL-25): seed 31416,
ControlNet strength/end 1.3/1.0, style weight 0.7, identity weight 0.5.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_profile_v1.safetensors is deployed and loadable by ComfyUI's
LoraLoader):
    python3 assets/src/character/smoke_check_profile_lora_T0274.py

Writes:
    assets/out/smoke_profile_T0274/main_384.png                  (gitignored scratch)
    assets/out/smoke_profile_T0274/provenance_candidate.json     (gitignored scratch)
    assets/src/character/smoke_check_profile_T0274/main_384.png  (committed evidence)
    assets/src/character/smoke_check_profile_T0274/provenance.json (committed evidence)
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    IPADAPTER_NAME,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    draw_pose_skeleton_cell,
    fetch_save_image,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)
from gen_hybrid_source_idle_T0252 import (  # noqa: E402
    CONCEPT_SHEET_PATH,
    EXPECTED_CONCEPT_HASH,
    GEN_PX,
    MAIN_SAVE_NODE_ID,
    build_graph,
)
from gen_pose_authority_idle_T0249 import MAIN_NEGATIVE, MAIN_PROMPT  # noqa: E402

PROFILE_LORA_NAME = "player_identity_profile_v1.safetensors"
PROFILE_LORA_PATH = REPO_ROOT / "assets" / "final" / "lora" / PROFILE_LORA_NAME
PROFILE_LORA_PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "lora" / "player_identity_profile_v1.provenance.json"
)

SEED = 31416
CONTROLNET_STRENGTH = 1.3
CONTROLNET_END = 1.0
STYLE_LORA_WEIGHT = 0.70
IDENTITY_LORA_WEIGHT = 0.50
IPADAPTER_WEIGHT = 0.60

SCRATCH_DIR = REPO_ROOT / "assets" / "out" / "smoke_profile_T0274"
EVIDENCE_DIR = REPO_ROOT / "assets" / "src" / "character" / "smoke_check_profile_T0274"


def run_smoke_check() -> dict:
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH}"
        )
    if not PROFILE_LORA_PATH.exists():
        raise RuntimeError(f"trained profile identity LoRA not found: {PROFILE_LORA_PATH}")

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(PROFILE_LORA_PATH)

    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    skeleton_img = draw_pose_skeleton_cell(GEN_PX)
    skeleton_path = SCRATCH_DIR / "pose_skeleton_384.png"
    skeleton_img.save(skeleton_path)

    t0 = time.monotonic()
    skeleton_filename = upload_image(skeleton_path)
    concept_filename = upload_image(CONCEPT_SHEET_PATH)
    graph = build_graph(
        seed=SEED,
        concept_filename=concept_filename,
        pose_skeleton_filename=skeleton_filename,
        controlnet_strength=CONTROLNET_STRENGTH,
        controlnet_end=CONTROLNET_END,
        ipadapter_weight=IPADAPTER_WEIGHT,
        style_lora_weight=STYLE_LORA_WEIGHT,
        identity_lora_weight=IDENTITY_LORA_WEIGHT,
        identity_lora_name=PROFILE_LORA_NAME,
    )
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id, timeout_s=300)
    gpu_seconds = time.monotonic() - t0

    main_bytes = fetch_save_image(info, MAIN_SAVE_NODE_ID)
    main_path = SCRATCH_DIR / "main_384.png"
    main_path.write_bytes(main_bytes)

    provenance = {
        "model": (
            f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {STYLE_LORA_WEIGHT}) "
            f"+ LoRA {PROFILE_LORA_NAME} (player identity profile, weight {IDENTITY_LORA_WEIGHT}) "
            f"+ IP-Adapter {IPADAPTER_NAME} (weight {IPADAPTER_WEIGHT}) "
            f"+ ControlNet {CONTROLNET_NAME}"
        ),
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": STYLE_LORA_WEIGHT,
        "style_lora_license": LORA_LICENSE,
        "identity_lora_name": PROFILE_LORA_NAME,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": IDENTITY_LORA_WEIGHT,
        "identity_lora_license": "CreativeML OpenRAIL++-M",
        "identity_lora_provenance": str(PROFILE_LORA_PROVENANCE_PATH.relative_to(REPO_ROOT)),
        "ip_adapter": IPADAPTER_NAME,
        "ip_adapter_weight": IPADAPTER_WEIGHT,
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": CONTROLNET_STRENGTH,
        "controlnet_end_percent": CONTROLNET_END,
        "pose_topology": (
            "front-facing (gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM, unchanged) -- "
            "deliberately NOT a profile-topology rig; authoring one is T-0272's scope, "
            "which is blocked on this card. This smoke check isolates whether the LoRA "
            "alone (still under front-facing ControlNet conditioning) can place a profile."
        ),
        "prompt": MAIN_PROMPT,
        "negative_prompt": MAIN_NEGATIVE,
        "seed": SEED,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "comfyui_prompt_id": prompt_id,
        "gpu_seconds": round(gpu_seconds, 1),
        "generator": "assets/src/character/smoke_check_profile_lora_T0274.py",
        "card": "T-0274",
        "purpose": (
            "Acceptance smoke check: generate one frame through the §24-e stack with "
            "player_identity_profile_v1 loaded and record whether the result is "
            "genuinely side-facing (identity intact) or still front-facing."
        ),
    }
    (SCRATCH_DIR / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def promote_evidence(provenance: dict, result: str, notes: str) -> None:
    """Copy the smoke-check frame + provenance out of gitignored assets/out/ into a
    committed location so the acceptance evidence resolves on a fresh clone (same
    reasoning as T-0249's pose_rig_idle_frame_evidence_T0249/ re-homing)."""
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SCRATCH_DIR / "main_384.png", EVIDENCE_DIR / "main_384.png")
    recorded = dict(provenance)
    recorded["result"] = result
    recorded["notes"] = notes
    (EVIDENCE_DIR / "provenance.json").write_text(json.dumps(recorded, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--record-result",
        choices=["side_facing", "front_facing"],
        help="After visually inspecting main_384.png, record the verdict and promote evidence",
    )
    parser.add_argument("--notes", type=str, default="")
    args = parser.parse_args()

    if args.record_result is not None:
        provenance = json.loads((SCRATCH_DIR / "provenance_candidate.json").read_text())
        promote_evidence(provenance, args.record_result, args.notes)
        print(f"recorded result={args.record_result!r}, evidence -> {EVIDENCE_DIR}")
        return

    provenance = run_smoke_check()
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
