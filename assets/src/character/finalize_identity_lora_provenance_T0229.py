#!/usr/bin/env python3
"""Write the P-7 provenance sidecar for the trained player-identity LoRA
(T-0229, HANDOFF §23-e, Arm B of the T-0227 bake-off).

Separate, explicit step from `lora_train.train` (which only produces the
weights file) -- mirrors gen_arm_a_idle_T0228.py's promote_arm_a_attempt.py
being a distinct step from generation. Satisfies the acceptance criterion
that the trained LoRA is itself covered by provenance (weights hash +
training config + curation set resolvable), independent of the idle-sheet
generation step.

Usage (from the repo root, after a real lora_train.train run has produced
assets/final/lora/player_identity_v1.safetensors):
    python3 assets/src/character/finalize_identity_lora_provenance_T0229.py --gpu-seconds 1234.5

Writes:
    assets/final/lora/player_identity_v1.provenance.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "assets" / "src" / "lora" / "src"))

from lora_train.config import load_config  # noqa: E402

WEIGHTS_PATH = REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v1.safetensors"
PROVENANCE_PATH = REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v1.provenance.json"
TRAINING_CONFIG_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "training_config_player_identity_T0229.toml"
)
CURATION_MANIFEST_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "identity_curation_manifest_T0229.json"
)

CHECKPOINT_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
CHECKPOINT_LICENSE = "CreativeML Open RAIL++-M"


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_provenance(gpu_seconds: float) -> dict:
    if not WEIGHTS_PATH.exists():
        raise RuntimeError(
            f"trained weights not found: {WEIGHTS_PATH} -- run lora_train.train first"
        )

    config = load_config(TRAINING_CONFIG_PATH)
    manifest = json.loads(CURATION_MANIFEST_PATH.read_text())
    ref_count = len(manifest["refs"])
    steps = config.num_epochs * ref_count

    return {
        "model": (
            f"{config.base_checkpoint} + LoRA training (kohya sd-scripts sdxl_train_network.py, "
            f"rank={config.network_rank}, alpha={config.network_alpha})"
        ),
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "weights_hash": sha256_of(WEIGHTS_PATH),
        "weights_license": "CreativeML OpenRAIL++-M",
        "base_checkpoint": config.base_checkpoint,
        "network_rank": config.network_rank,
        "network_alpha": config.network_alpha,
        "learning_rate": config.learning_rate,
        "optimizer": config.optimizer,
        "num_epochs": config.num_epochs,
        "dataset_ref_count": ref_count,
        "steps": steps,
        "concept_hash": manifest["concept_hash"],
        "concept_card": manifest["concept_card"],
        "trigger_token": manifest["trigger_token"],
        "training_config": "assets/src/character/training_config_player_identity_T0229.toml",
        "curation_manifest": "assets/src/character/identity_curation_manifest_T0229.json",
        "generator": "assets/src/lora/src/lora_train/train.py",
        "card": "T-0229",
        "bake_off_arm": "B (§23-e)",
        "spec": "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §6.14 stage 2",
        "gpu_seconds": round(gpu_seconds, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gpu-seconds",
        type=float,
        required=True,
        help="measured wall-clock of the training subprocess",
    )
    args = parser.parse_args()

    provenance = build_provenance(args.gpu_seconds)
    PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
