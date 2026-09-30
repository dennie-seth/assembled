#!/usr/bin/env python
"""T-0419: materialise char_gen.rig_recovery_T0419's recovered keypoints as
committed per-frame JSON files, wire them into player_crouch_hide_sheet_v1/
player_die_sheet_v1/player_move_sheet_v1's own .provenance.json sidecars as
`frame_generation`, then recompute (never invent) the real
character_motion_fidelity/character_part_identity/character_motion_score_binding
values those sidecars must carry, using the SAME asset_gate.character
recompute functions the CI gate itself runs.

This is a one-shot recovery script (like the repo's other gen_*.py/
compare_*.py one-off tools), not a reusable CLI -- see
docs/assets/evidence/T-0419/README.md for the run this produced.

Run: .venv/bin/python recover_rig_evidence_T0419.py (from assets/src/character/)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
ASSET_GATE_SRC = REPO_ROOT / "tools" / "asset-gate" / "src"
sys.path.insert(0, str(ASSET_GATE_SRC))

from asset_gate import character  # noqa: E402
from PIL import Image  # noqa: E402

from char_gen.rig_recovery_T0419 import (  # noqa: E402
    crouch_hide_frame_keypoints,
    die_frame_keypoints,
    move_frame_keypoints,
    move_sheet_frame_count,
)

CHAR_FINAL = REPO_ROOT / "assets" / "final" / "character"
RECOVERED_DIR = REPO_ROOT / "assets" / "src" / "character" / "pose_rig_recovered_T0419"

SHEETS = {
    "player_crouch_hide_sheet_v1": {
        "frame_count": 9,
        "keypoints_fn": crouch_hide_frame_keypoints,
        "recovered_from": (
            "char_gen.synth_states._draw_crouch_frame (via char_gen.rig_recovery_T0419."
            "crouch_hide_frame_keypoints) -- this sheet's own body/head/leg pixel ranges, "
            "transcribed exactly, not invented"
        ),
    },
    "player_die_sheet_v1": {
        "frame_count": 9,
        "keypoints_fn": die_frame_keypoints,
        "recovered_from": (
            "char_gen.synth_states._draw_die_frame (via char_gen.rig_recovery_T0419."
            "die_frame_keypoints) -- this sheet's own body/head/leg pixel ranges, "
            "transcribed exactly, not invented"
        ),
    },
    "player_move_sheet_v1": {
        "frame_count": move_sheet_frame_count(),
        "keypoints_fn": move_frame_keypoints,
        "recovered_from": (
            "char_gen.synth_states._draw_walk_frame + _WALK_OFFSETS (via char_gen."
            "rig_recovery_T0419.move_frame_keypoints) -- this sheet's own body/head/arm/leg "
            "pixel ranges, transcribed exactly, not invented; frames 10-11 are the sheet's own "
            "documented spare/blank cells, recorded as such, not as an invented pose"
        ),
    },
}


def write_keypoints_files(sheet_name: str, frame_count: int, keypoints_fn) -> list[dict]:
    out_dir = RECOVERED_DIR / sheet_name
    out_dir.mkdir(parents=True, exist_ok=True)
    frame_generation = []
    for i in range(frame_count):
        keypoints = keypoints_fn(i)
        out_path = out_dir / f"frame_{i}_keypoints.json"
        out_path.write_text(json.dumps(keypoints, indent=2) + "\n")
        rel_path = out_path.relative_to(REPO_ROOT).as_posix()
        frame_generation.append(
            {
                "frame_index": i,
                "pose_keypoints_file": rel_path,
                "generation_mode": "recovered_from_synthetic_generator",
            }
        )
    return frame_generation


def update_provenance(sheet_name: str, frame_generation: list[dict], recovered_from: str) -> dict:
    prov_path = CHAR_FINAL / f"{sheet_name}.provenance.json"
    provenance = json.loads(prov_path.read_text())
    provenance["frame_generation"] = frame_generation
    provenance["rig_evidence_basis"] = (
        f"T-0419: recovered, not regenerated -- {recovered_from}. This sheet was never "
        "diffusion-generated or rig-conditioned; its pixels are drawn directly by the named "
        "function from literal pixel-range constants. These keypoints are a faithful "
        "transcription of those same constants into the asset-gate's frame_generation schema."
    )
    prov_path.write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def recompute_and_bind(sheet_name: str, provenance: dict) -> dict:
    sheet_path = CHAR_FINAL / f"{sheet_name}.png"
    sheet = Image.open(sheet_path)

    motion_result = character.determine_character_motion_fidelity(
        provenance,
        sheet=sheet,
        repo_root=REPO_ROOT,
        sheet_name=sheet_name,
    )
    part_result = character.determine_character_part_identity(
        provenance,
        sheet=sheet,
        repo_root=REPO_ROOT,
        sheet_name=sheet_name,
    )

    report = {
        "sheet": sheet_name,
        "motion_fidelity": {"passed": motion_result.passed, "reason": motion_result.reason},
        "part_identity": {"passed": part_result.passed, "reason": part_result.reason},
    }

    if motion_result.details.get("recomputed_from_pixels"):
        pose_range = motion_result.details["pose_fidelity_range"]
        identity_range = motion_result.details["identity_stability_range"]

        palette_path = REPO_ROOT / provenance["palette_source"]
        binding = {
            "sheet_sha256": character.compute_image_content_sha256(sheet),
            "rig_config_version": character.RIG_CONFIG_VERSION,
            "palette_sha256": character.compute_file_sha256(palette_path),
            "evaluator_version": character.EVALUATOR_VERSION,
        }

        prov_path = CHAR_FINAL / f"{sheet_name}.provenance.json"
        provenance = json.loads(prov_path.read_text())
        provenance["pose_fidelity_range"] = pose_range
        provenance["identity_stability_range"] = identity_range
        provenance["motion_score_binding"] = binding
        prov_path.write_text(json.dumps(provenance, indent=2) + "\n")

        binding_result = character.check_motion_score_binding(
            provenance,
            recomputed_pose_fidelity_range=pose_range,
            recomputed_identity_stability_range=identity_range,
            sheet=sheet,
            repo_root=REPO_ROOT,
            sheet_name=sheet_name,
        )
        report["motion_score_binding"] = {
            "passed": binding_result.passed,
            "reason": binding_result.reason,
        }

    return report


def main() -> None:
    reports = []
    for sheet_name, cfg in SHEETS.items():
        frame_generation = write_keypoints_files(
            sheet_name, cfg["frame_count"], cfg["keypoints_fn"]
        )
        provenance = update_provenance(sheet_name, frame_generation, cfg["recovered_from"])
        reports.append(recompute_and_bind(sheet_name, provenance))

    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
