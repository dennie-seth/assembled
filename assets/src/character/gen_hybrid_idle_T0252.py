#!/usr/bin/env python3
"""Hybrid round-2 idle-sheet assembly (T-0252, HANDOFF §24-e).

Assembles the 3x3, 48x48-cell, 144x144-native idle sheet DL-21 specifies
from the single SDXL frame `gen_hybrid_source_idle_T0252.py` promotes
(`assets/final/character/player_idle_frame_hybrid_source_T0252.png`), by
calling `char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252` --
Arm C's own committed `_player_pose_offsets` (T-0230), reused unchanged, now
translating the generated frame's own pixels instead of redrawing a
hardcoded shape.

There is no second SDXL generation anywhere in this script -- every "attempt"
here is a script-only, zero-GPU-cost run (like Arm C's own attempts), so
tuning the transform's band boundaries against the actual generated art is
free, unlike a real SDXL re-roll.

Usage (from the repo root, after gen_hybrid_source_idle_T0252.py --promote-attempt
has produced assets/final/character/player_idle_frame_hybrid_source_T0252.png):
    python3 assets/src/character/gen_hybrid_idle_T0252.py --attempt 1 --seed 31416
    python3 assets/src/character/gen_hybrid_idle_T0252.py --attempt 1 --seed 31416 --promote

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/hybrid/attempt_<N>/sheet_144_indexed.png
    assets/out/hybrid/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0252.md (appended)

--promote copies the attempt's sheet + provenance into
assets/final/character/ (only for the attempt that passes DL-21's mechanical
criterion-2 gate).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
# comfy-client is not a declared dependency of this package's pyproject.toml
# (char-gen only lists pillow/numpy) -- same informal sys.path convention
# already used for asset-gate above, not a formal pip dependency, per
# gen_idle_v2_diffusers.py's existing precedent. CHR-1's shared
# apply_arm_c_benchmark_fields helper (T-0258) lives in
# comfy_client.provenance_sidecar, the established home for this pipeline's
# other shared provenance surface.
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import character as asset_gate_character  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402
from comfy_client.provenance_sidecar import apply_arm_c_benchmark_fields  # noqa: E402
from PIL import Image  # noqa: E402

from char_gen.synth_entities import (  # noqa: E402
    PALETTE_PATH,
    _load_palette,
    generate_player_idle_sheet_hybrid_T0252,
)
from char_gen.synth_entities import (  # noqa: E402
    _player_pose_offsets as player_pose_offsets,
)

SYNTH_ENTITIES_SRC = Path(__file__).resolve().parent / "src" / "char_gen" / "synth_entities.py"

FINAL_PX = 144
CELL_PX = 48

# T-0271/DL-26: this sheet is idle -- DL-21's 0.30 stays the cap, unchanged,
# derived via the shared motion-class predicate so this script and the
# enforcement sweep cannot drift apart.
MOTION_CLASS = "idle"
MAX_FRAME_DELTA_RATIO = asset_gate_character.frame_delta_cap_for_motion_class(MOTION_CLASS)
# The Arm-C benchmark pair itself (the real bar to beat, not the pass/fail
# floor) is not defined here -- apply_arm_c_benchmark_fields (imported above
# from comfy_client.provenance_sidecar, CHR-1's single shared home, T-0258)
# derives frame_delta_range/arm_c_benchmark/beats_arm_c_benchmark from it.

ATTEMPT_LOG_PATH = REPO_ROOT / "assets" / "src" / "character" / "ARM_HYBRID_ATTEMPT_LOG_T0252.md"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
SOURCE_FRAME_PATH = FINAL_CHARACTER_DIR / "player_idle_frame_hybrid_source_T0252.png"
SOURCE_FRAME_PROVENANCE_PATH = (
    FINAL_CHARACTER_DIR / "player_idle_frame_hybrid_source_T0252.provenance.json"
)
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.provenance.json"

ATTEMPT_LOG_HEADER = (
    "# Hybrid assembly attempt log (T-0252, HANDOFF §24-e, round 2)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not. Assembly "
    "is a deterministic, zero-GPU-cost script run against the one promoted SDXL source frame "
    "(see ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md for that frame's own attempt history) -- "
    "`mechanical_gate` is the frame-silhouette delta check (DL-21 criterion 2's mechanical "
    "half); the human silhouette-read and drift verdict are judged separately against the "
    "promoted sheet's judging preview.\n\n"
    "| Attempt | Seed | Frame-delta range | Mechanical gate | Beats Arm C (0.072-0.112) | "
    "Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    """Record `attempt`'s row, replacing any row already logged for that same
    attempt number (a run re-invoked with --promote after an earlier
    non-promoting run of the same attempt must not leave two rows for one
    attempt -- see this file's own history: attempt 2 was logged twice, once
    without --promote and once with, before this dedup was added)."""
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    lo, hi = provenance["frame_delta_range"]
    row = (
        f"| {provenance['attempt']} | {provenance['derived_frames']['seed']} "
        f"| {lo:.4f}-{hi:.4f} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'yes' if provenance['beats_arm_c_benchmark'] else 'no'} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    lines = ATTEMPT_LOG_PATH.read_text().splitlines(keepends=True)
    attempt_str = str(provenance["attempt"])
    kept = [
        line
        for line in lines
        if not (line.startswith("|") and line.split("|")[1].strip() == attempt_str)
    ]
    kept.append(row)
    ATTEMPT_LOG_PATH.write_text("".join(kept))


def promote_attempt(out_dir: Path, provenance: dict) -> None:
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes((out_dir / "sheet_144_indexed.png").read_bytes())
    FINAL_PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")


def run_attempt(attempt: int, seed: int) -> dict:
    if not SOURCE_FRAME_PATH.exists():
        raise RuntimeError(
            f"generated source frame not found: {SOURCE_FRAME_PATH} -- run "
            "gen_hybrid_source_idle_T0252.py --promote-attempt first"
        )
    if not SOURCE_FRAME_PROVENANCE_PATH.exists():
        raise RuntimeError(f"source frame provenance not found: {SOURCE_FRAME_PROVENANCE_PATH}")

    source_provenance = json.loads(SOURCE_FRAME_PROVENANCE_PATH.read_text())

    out_dir = REPO_ROOT / "assets" / "out" / "hybrid" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    palette_rgb = _load_palette(PALETTE_PATH)
    sheet_path = out_dir / "sheet_144_indexed.png"
    generate_player_idle_sheet_hybrid_T0252(seed, SOURCE_FRAME_PATH, palette_rgb, sheet_path)

    indexed = Image.open(sheet_path)
    palette = asset_gate_palette.load_palette(PALETTE_PATH)

    membership = asset_gate_palette.check_palette_membership(indexed, palette)
    semantics = asset_gate_palette.check_index_semantics(indexed, palette)
    cell_fit_results = asset_gate_art.check_cell_fit(
        indexed, cell_width=CELL_PX, cell_height=CELL_PX, cols=3, rows=3, background_index=0
    )
    cell_fit_passed = all(r.passed for r in cell_fit_results)

    order = [(r, c) for r in range(3) for c in range(3)]
    cells = {
        (r, c): indexed.crop(
            (c * CELL_PX, r * CELL_PX, c * CELL_PX + CELL_PX, r * CELL_PX + CELL_PX)
        )
        for r, c in order
    }
    orphan_results = [
        asset_gate_art.check_orphan_pixels(cells[cell], background_index=0, size_threshold=4)
        for cell in order
    ]
    orphan_passed = all(r.passed for r in orphan_results)

    frame_deltas = []
    for a, b in zip(order, order[1:], strict=False):
        result = asset_gate_art.check_frame_consistency(
            cells[a], cells[b], background_index=0, max_delta_ratio=MAX_FRAME_DELTA_RATIO
        )
        frame_deltas.append(
            {
                "pair": [list(a), list(b)],
                "ratio": float(result.details["ratio"]),
                "passed": bool(result.passed),
            }
        )
    frame_consistency_passed = all(d["passed"] for d in frame_deltas)
    ratios = [d["ratio"] for d in frame_deltas]
    beats_030_cap = max(ratios) <= MAX_FRAME_DELTA_RATIO
    arm_c_fields = apply_arm_c_benchmark_fields({}, ratios, motion_class=MOTION_CLASS)
    frame_delta_range = arm_c_fields["frame_delta_range"]
    beats_arm_c_benchmark = arm_c_fields["beats_arm_c_benchmark"]

    mechanical_gate_passed = (
        membership.passed
        and semantics.passed
        and cell_fit_passed
        and orphan_passed
        and frame_consistency_passed
    )

    offsets = player_pose_offsets(seed, n_frames=len(order))

    provenance = {
        "source_frame": source_provenance,
        "derived_frames": {
            "generator": (
                "assets/src/character/src/char_gen/synth_entities.py:"
                "generate_player_idle_sheet_hybrid_T0252"
            ),
            "seed": seed,
            "offsets": [list(o) for o in offsets],
            "palette_assignment": "transform_of_generated_source",
            "quantization": (
                "none at assembly time -- the source frame was already quantized once "
                "(gen_hybrid_source_idle_T0252.py); every derived frame only translates "
                "its already-quantized indices, it never re-quantizes"
            ),
            "method": (
                "char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252: the single "
                "promoted source frame's head/arm/leg pixel bands (HYBRID_HEAD_BAND / "
                "HYBRID_LEFT_ARM_BAND / HYBRID_RIGHT_ARM_BAND / HYBRID_LEFT_LEG_BAND / "
                "HYBRID_RIGHT_LEG_BAND) are translated per-frame by the same (head, arm, leg) "
                "offsets Arm C's _player_pose_offsets(seed) already selects (T-0230, reused "
                "unchanged) -- everything outside those bands (torso, equipment, background) "
                "stays byte-identical to the source. Frame 0 is the untouched source frame "
                "(every _PLAYER_POSE_PATTERNS entry starts at offset 0)."
            ),
        },
        "seed": seed,
        "concept_hash": source_provenance.get("concept_hash"),
        "model_hash": source_provenance.get("model_hash"),
        "total_comfyui_generations": 1,
        "generator": "assets/src/character/gen_hybrid_idle_T0252.py",
        "card": "T-0252",
        "bake_off_arm": (
            "round 2, hybrid (HANDOFF §24-e) -- not a new bake-off arm competing on DL-21's "
            "original criteria, a mechanism change layered on top of the round-1 result"
        ),
        "spec": "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5",
        "attempt": attempt,
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "frame_delta_range": frame_delta_range,
        "beats_030_cap": beats_030_cap,
        "beats_arm_c_benchmark": beats_arm_c_benchmark,
        "arm_c_benchmark": arm_c_fields["arm_c_benchmark"],
        "gate_results": {
            "palette_membership": membership.passed,
            "index_semantics": semantics.passed,
            "cell_fit": cell_fit_passed,
            "orphan_pixels": orphan_passed,
            "frame_consistency": frame_consistency_passed,
        },
        "layout": {
            "sheet_px": [FINAL_PX, FINAL_PX],
            "cell_px": CELL_PX,
            "cols": 3,
            "rows": 3,
            "frame_cells": [list(k) for k in order],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--attempt", type=int, required=True, help="attempt number, 1..8 (DL-21 cap)"
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument(
        "--promote",
        action="store_true",
        help="copy this attempt into assets/final/character/ (only if the gate passed)",
    )
    args = parser.parse_args()

    if not (1 <= args.attempt <= 8):
        raise SystemExit("attempt cap is 8 per round (DL-21) -- refusing to run a 9th attempt")

    out_dir = REPO_ROOT / "assets" / "out" / "hybrid" / f"attempt_{args.attempt}"
    provenance = run_attempt(attempt=args.attempt, seed=args.seed)

    promoted = False
    if args.promote:
        if not provenance["mechanical_gate_passed"]:
            raise SystemExit(
                f"attempt {args.attempt} did not pass the mechanical gate -- refusing to promote"
            )
        promoted = True
        promote_attempt(out_dir, provenance)

    provenance["promoted"] = promoted
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    if promoted:
        FINAL_PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
