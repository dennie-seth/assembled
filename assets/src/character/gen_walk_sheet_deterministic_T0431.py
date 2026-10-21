#!/usr/bin/env python3
"""T-0431: render the deterministic side-view walk sheet from the committed
parts + rig (`char_gen.walk_sheet`), measure it against the character gate,
and promote it into `assets/final/character/` ONLY if it clears every check
on its own merit.

Not a GPU generator -- there is no ComfyUI call anywhere in this script or in
`char_gen.walk_sheet`. The "generation" is a deterministic composite of the
ten already-committed `assets/src/character/parts/side_view/*.png` parts
driven by `char_gen.walk_cycle`'s gait curves.

Promote-or-stop, not promote-or-crash
--------------------------------------
docs/decision-log.md DL-31 already measured the placeholder
`player_walk_sheet_hybrid.png` against this exact gate (T-0340) and found it
reads with "motion barely visible" -- failing the same pose-fidelity floor
this script checks. A declared `motion_class: locomotion` on a NEW sheet
turns that gate on for the first time on a real candidate, so this script
measures BEFORE writing anything into `assets/final/`:

  1. Render + quantize the sheet (zero GPU calls -- asserted by
     `char_gen.walk_sheet`'s own test suite, not re-asserted here).
  2. Write per-frame rig-keypoint JSON evidence (what the rig actually
     commanded) under `pose_rig_walk_deterministic_frame_evidence_T0431/`.
  3. Build a provenance record with `motion_class: locomotion` from the
     start -- never promoted first and classified after, which is exactly
     how a sheet could pass by omission (`asset_gate.character`'s own
     T-0357 motivation).
  4. Run `asset_gate.character.build_character_gate_report` -- the SAME
     function the reviewer's `checkDeliverable.js` route and
     `ci-asset-gate.yml` call -- twice: once to discover the real
     pose-fidelity/identity-stability recompute, then again after recording
     that recompute's own `motion_score_binding` into the provenance (T-0360
     needs the binding to already be present to check it; it cannot be
     present before the first recompute has run once).
  5. Promote into `assets/final/character/` ONLY if every check in that
     report passed. Otherwise: write the full report plus the rendered
     evidence (sheet, frames, gif) to `docs/assets/evidence/T-0431/` and
     stop -- no file lands under `assets/final/`, no threshold is touched.

The existing placeholder `player_walk_sheet_hybrid.*` is never read, written,
or deleted by this script.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _CHARACTER_DIR.parents[2]
for _extra in (
    _REPO_ROOT / "tools" / "asset-gate" / "src",
    _REPO_ROOT / "tools" / "comfy-client" / "src",
    _CHARACTER_DIR / "src",
):
    if str(_extra) not in sys.path:
        sys.path.insert(0, str(_extra))

from asset_gate import character as chargate  # noqa: E402
from asset_gate.character import compute_file_sha256, compute_image_content_sha256  # noqa: E402
from comfy_client.provenance_sidecar import ARM_C_BENCHMARK  # noqa: E402
from PIL import Image  # noqa: E402

from char_gen import walk_sheet  # noqa: E402

GENERATOR_PATH = "assets/src/character/gen_walk_sheet_deterministic_T0431.py"
CARD = "T-0431"

#: CHR-1's own shared benchmark (docs/board-invariants.md, T-0258) -- imported
#: above from `comfy_client.provenance_sidecar.ARM_C_BENCHMARK`, the single
#: shared home, the same way `gen_pose_authority_idle_T0249.py` does; never
#: restated here as a literal.

KEYPOINTS_EVIDENCE_DIR = _CHARACTER_DIR / "pose_rig_walk_deterministic_frame_evidence_T0431"
EVIDENCE_DIR = _REPO_ROOT / "docs" / "assets" / "evidence" / "T-0431"
FINAL_DIR = _REPO_ROOT / "assets" / "final" / "character"
PALETTE_PATH = _REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

SHEET_NAME = "player_walk_sheet_deterministic_T0431"


def _load_palette(path: Path) -> list[tuple[int, int, int]]:
    data = json.loads(path.read_text())
    by_index = {int(s["index"]): s["hex"] for s in data["slots"]}
    out = []
    for i in range(len(by_index)):
        h = by_index[i].lstrip("#")
        out.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    return out


def _write_keypoint_evidence(result: walk_sheet.WalkSheetResult) -> list[str]:
    KEYPOINTS_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    rel_paths = []
    for i, points in enumerate(result.keypoints):
        path = KEYPOINTS_EVIDENCE_DIR / f"frame_{i}_keypoints.json"
        path.write_text(json.dumps(walk_sheet.keypoints_to_coco_list(points), indent=2) + "\n")
        rel_paths.append(str(path.relative_to(_REPO_ROOT)))
    return rel_paths


def _frame_delta_fields(frames: list[Image.Image]) -> dict:
    from asset_gate import art

    pairs = [(i, i + 1) for i in range(len(frames) - 1)] + [(len(frames) - 1, 0)]
    ratios = [
        float(
            art.check_frame_consistency(
                frames[a], frames[b], background_index=0, max_delta_ratio=1.0
            ).details["ratio"]
        )
        for a, b in pairs
    ]
    return {
        "frame_delta_range": [min(ratios), max(ratios)],
        "arm_c_benchmark": list(ARM_C_BENCHMARK),
        "beats_arm_c_benchmark": bool(max(ratios) <= ARM_C_BENCHMARK[1]),
    }


def build_provenance(result: walk_sheet.WalkSheetResult, frames: list[Image.Image],
                      keypoint_rel_paths: list[str]) -> dict:
    run_id = os.environ.get("BOARD_RUN_ID") or None

    frame_generation = [
        {
            "frame_index": i,
            "cell": [i // walk_sheet.COLS, i % walk_sheet.COLS],
            "pose_keypoints_file": keypoint_rel_paths[i],
            "generation_mode": "deterministic_composite",
            "chained_from_frame": None,
            "denoise": None,
        }
        for i in range(len(frames))
    ]

    provenance = {
        "model": "none -- deterministic composite, zero GPU/network calls",
        "method": (
            "char_gen.walk_sheet.render_frames: char_gen.walk_cycle's keyframed hip/knee/"
            "shoulder/elbow curves drive char_gen.rig_compositor.build_placements (called "
            "twice per frame -- near-side angles, then far-side -- keeping only the far "
            "call's shoulder_L/forearm_L; both legs already get correct per-side angles via "
            "LegStance) over the ten committed assets/src/character/parts/side_view/*.png "
            "parts and side_view_rig.json, root bob applied via LegStance.hip using the "
            "rig's own recorded root_bob_px, descended to the shared 48px cell at "
            "char_gen.character_scale.CHARACTER_SCALE, then quantized to the home palette "
            "(Oklab-nearest, no dithering, background forced by alpha threshold)."
        ),
        "parts_source": "assets/src/character/parts/side_view/ (ten committed parts, unmodified)",
        "rig_source": "assets/src/character/parts/side_view/side_view_rig.json (unmodified)",
        "animation_module": "assets/src/character/src/char_gen/walk_cycle.py (unmodified)",
        "generator": GENERATOR_PATH,
        "card": CARD,
        "run_id": run_id,
        "motion_class": "locomotion",
        "gpu_seconds": 0.0,
        "mechanical_gate_passed": None,  # filled in once measured, below
        "layout": {"cols": walk_sheet.COLS, "rows": walk_sheet.ROWS, "cell_px": 48},
        "frame_generation": frame_generation,
        "palette_source": "assets/final/palette/home_palette.json",
        "root_bob_amplitude_native_px": result.root_bob_amplitude_px,
        "ground_plane_y_native_px": result.ground_plane_y,
    }
    provenance.update(_frame_delta_fields(frames))
    return provenance


def main() -> None:
    palette = _load_palette(PALETTE_PATH)
    result = walk_sheet.render_frames()
    frames = walk_sheet.quantize_to_indexed(result.cell_frames, palette, background_index=0)
    keypoint_rel_paths = _write_keypoint_evidence(result)

    provenance = build_provenance(result, frames, keypoint_rel_paths)

    sheet = Image.new("P", (48 * walk_sheet.COLS, 48 * walk_sheet.ROWS))
    sheet.putpalette(frames[0].getpalette())
    for i, frame in enumerate(frames):
        row, col = divmod(i, walk_sheet.COLS)
        sheet.paste(frame, (col * 48, row * 48))
    sheet.info["transparency"] = 0

    # Pass 1: discover the real pose-fidelity/identity-stability recompute
    # (needed to populate motion_score_binding before the real report runs).
    motion_result = chargate.determine_character_motion_fidelity(
        provenance, frames=frames, cell_px=48, repo_root=_REPO_ROOT,
        sheet_name=f"{SHEET_NAME}.png",
    )
    if motion_result.details.get("recomputed_from_pixels"):
        provenance["pose_fidelity_range"] = list(motion_result.details["pose_fidelity_range"])
        provenance["identity_stability_range"] = list(
            motion_result.details["identity_stability_range"]
        )
        provenance["motion_score_binding"] = {
            "sheet_sha256": compute_image_content_sha256(sheet),
            "rig_config_version": chargate.RIG_CONFIG_VERSION,
            "palette_sha256": compute_file_sha256(PALETTE_PATH),
            "evaluator_version": chargate.EVALUATOR_VERSION,
        }

    # Pass 2: the real, authoritative report -- now with the binding present.
    report = chargate.build_character_gate_report(
        sheet, provenance, cols=walk_sheet.COLS, rows=walk_sheet.ROWS, cell_px=48,
        background_index=0, sheet_name=f"{SHEET_NAME}.png", repo_root=_REPO_ROOT,
    )
    all_passed = all(c["passed"] for c in report["checks"].values())
    provenance["mechanical_gate_passed"] = all_passed

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    sheet.save(EVIDENCE_DIR / f"{SHEET_NAME}.png", transparency=0)
    (EVIDENCE_DIR / f"{SHEET_NAME}.provenance_candidate.json").write_text(
        json.dumps(provenance, indent=2) + "\n"
    )
    (EVIDENCE_DIR / f"{SHEET_NAME}.gate_report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    walk_sheet.save_sheet(frames, EVIDENCE_DIR / f"{SHEET_NAME}_frames_check.png")

    print(json.dumps({"promoted": all_passed, "checks": {
        name: c["passed"] for name, c in report["checks"].items()
    }}, indent=2))

    if not all_passed:
        print("NOT PROMOTED -- see docs/assets/evidence/T-0431/ for the full gate report.")
        return

    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    sheet.save(FINAL_DIR / f"{SHEET_NAME}.png", transparency=0)
    (FINAL_DIR / f"{SHEET_NAME}.provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n"
    )
    (FINAL_DIR / f"{SHEET_NAME}.gate_report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(f"PROMOTED -- {FINAL_DIR / f'{SHEET_NAME}.png'}")


if __name__ == "__main__":
    main()
