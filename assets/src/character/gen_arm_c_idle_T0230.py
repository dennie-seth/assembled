#!/usr/bin/env python3
"""Arm C of the T-0227 character-pipeline bake-off (T-0230, HANDOFF §23-f).

**No diffusion model anywhere in the generation path.** A seeded script
(`char_gen.synth_entities.generate_player_idle_sheet_arm_c`) renders the
144x144 idle sheet directly, with palette indices assigned by construction
rather than quantised after the fact -- see that module's "Player --
articulated idle figure" section for the drawing code and DL-21
(`docs/decision-log.md`) for the output spec every bake-off arm shares.

Because there is no model, no HTTP call, and no sampling step, "attempts"
here are not exploratory the way Arm A/B's ComfyUI runs were: the figure's
geometry and pose-offset bounds are correct or not by inspection of the
committed drawing code, not by re-rolling a seed and hoping. This script
still respects DL-21's attempt-cap bookkeeping (every attempt logged, cap
of 8) so attempts-to-first-pass is a real, comparable number against Arm A
and Arm B's rows in the same cost table -- it is expected, not guaranteed,
to pass on attempt 1.

Usage (from the repo root, no ComfyUI/GPU required):
    python3 assets/src/character/gen_arm_c_idle_T0230.py --attempt 1 --seed 23230
    python3 assets/src/character/gen_arm_c_idle_T0230.py --attempt 1 --seed 23230 --promote

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/arm_c/attempt_<N>/sheet_144_indexed.png
    assets/out/arm_c/attempt_<N>/sheet_144_indexed_rerun.png  (second render, determinism proof)
    assets/out/arm_c/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_C_ATTEMPT_LOG_T0230.md   (appended, one row per attempt)

--promote copies the attempt's sheet + provenance into assets/final/character/
(only for the attempt that passes DL-21's mechanical criterion-2 gate).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402

from char_gen.synth_entities import (  # noqa: E402
    PALETTE_PATH,
    _load_palette,
    generate_player_idle_sheet_arm_c,
)

SYNTH_ENTITIES_SRC = Path(__file__).resolve().parent / "src" / "char_gen" / "synth_entities.py"

# Shared reference every bake-off arm cites (docs/decision-log.md DL-21).
# Arm C has no live conditioning step, so this is a provenance-resolution
# record, not an input to generation -- the figure's proportions/palette
# were designed by inspection of T-0209's sheet, not read by this script.
CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"
CONCEPT_SOURCE = "assets/src/concept/player_character_concept_sheet_v1.png"
CONCEPT_CARD = "T-0209"

FINAL_PX = 144
CELL_PX = 48

ATTEMPT_LOG_PATH = REPO_ROOT / "assets" / "src" / "character" / "ARM_C_ATTEMPT_LOG_T0230.md"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_arm_c_T0230.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_arm_c_T0230.provenance.json"

ATTEMPT_LOG_HEADER = (
    "# Arm C attempt log (T-0230, HANDOFF §23-f, DL-21)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not, so "
    "attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the "
    "frame-silhouette delta check (DL-21 criterion 2's mechanical half); the human "
    "silhouette-read (criterion 1) and human drift verdict (criterion 2's other half) "
    "are judged later, in §23-g, against the promoted sheet. `determinism` re-renders "
    "the same seed a second time and compares bytes -- this arm's own defining claim.\n\n"
    "| Attempt | Seed | Mechanical gate | Determinism | Promoted | Notes |\n"
    "|---|---|---|---|---|---|\n"
)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'PASS' if provenance['determinism']['passed'] else 'FAIL'} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


def promote_attempt(out_dir: Path, provenance: dict) -> None:
    """Copy this attempt's indexed sheet + provenance into assets/final/character/.

    Only called for the first attempt whose mechanical gate (and determinism
    proof) passes -- a discarded attempt's bytes never land in assets/final/,
    even transiently (module docstring).
    """
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes((out_dir / "sheet_144_indexed.png").read_bytes())
    FINAL_PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")


def run_attempt(attempt: int, seed: int) -> dict:
    out_dir = REPO_ROOT / "assets" / "out" / "arm_c" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    palette_rgb = _load_palette(PALETTE_PATH)

    sheet_path = out_dir / "sheet_144_indexed.png"
    generate_player_idle_sheet_arm_c(seed, palette_rgb, sheet_path)
    sheet_bytes_1 = sheet_path.read_bytes()

    # Determinism proof: re-render the same seed to a second path and compare
    # bytes -- the acceptance criterion this arm exists to demonstrate.
    rerun_path = out_dir / "sheet_144_indexed_rerun.png"
    generate_player_idle_sheet_arm_c(seed, palette_rgb, rerun_path)
    sheet_bytes_2 = rerun_path.read_bytes()
    determinism_passed = sheet_bytes_1 == sheet_bytes_2

    from PIL import Image

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
            cells[a], cells[b], background_index=0, max_delta_ratio=0.30
        )
        frame_deltas.append(
            {
                "pair": [list(a), list(b)],
                "ratio": float(result.details["ratio"]),
                "passed": bool(result.passed),
            }
        )
    frame_consistency_passed = all(d["passed"] for d in frame_deltas)

    mechanical_gate_passed = (
        membership.passed
        and semantics.passed
        and cell_fit_passed
        and orphan_passed
        and frame_consistency_passed
    )

    provenance = {
        "model": (
            "N/A -- deterministic script, no diffusion model anywhere in the generation "
            "path (DL-21 §23-f). model_hash pins the exact committed generator source "
            "(char_gen/synth_entities.py) that produced this sheet."
        ),
        "model_license": "N/A",
        "model_hash": sha256_of(SYNTH_ENTITIES_SRC),
        "prompt": None,
        "negative_prompt": None,
        "seed": seed,
        "concept_hash": CONCEPT_HASH,
        "concept_source": CONCEPT_SOURCE,
        "concept_card": CONCEPT_CARD,
        "palette_assignment": "by_construction",
        "quantization": "none",
        "method": (
            "char_gen.synth_entities.generate_player_idle_sheet_arm_c: an articulated "
            "player figure (head, neck, torso, two-segment arms, two-segment legs) is "
            "drawn directly into a 3x3 grid of 48x48 numpy index arrays using the home "
            "palette's own indices -- BG_IDX/HEAD_IDX/BODY_IDX/LEG_IDX -- as literal "
            "constants in the drawing code, then saved as mode-P PNG with the home "
            "palette embedded. No image is ever rendered to RGB and quantised down; "
            "the indices are correct from the first assignment. Per-frame pose "
            "(head-bob, arm-swing, leg weight-shift) is chosen from six hand-verified, "
            "adjacent-step<=1 patterns via random.Random(seed), so the same seed always "
            "selects the same three patterns and produces byte-identical pixels."
        ),
        "generator": "assets/src/character/gen_arm_c_idle_T0230.py",
        "card": "T-0230",
        "bake_off_arm": "C (§23-f)",
        "spec": "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5",
        "attempt": attempt,
        "gpu_seconds": 0.0,
        "gpu_minutes_note": "CPU-only PIL/numpy rendering -- no GPU involved at any step",
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "determinism": {
            "passed": determinism_passed,
            "sheet_sha256": sha256_bytes(sheet_bytes_1),
            "rerun_sha256": sha256_bytes(sheet_bytes_2),
            "runs": 2,
        },
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
        raise SystemExit("attempt cap is 8 per arm (DL-21) -- refusing to run a 9th attempt")

    out_dir = REPO_ROOT / "assets" / "out" / "arm_c" / f"attempt_{args.attempt}"
    provenance = run_attempt(attempt=args.attempt, seed=args.seed)

    promoted = False
    if args.promote:
        if not provenance["mechanical_gate_passed"]:
            raise SystemExit(
                f"attempt {args.attempt} did not pass the mechanical gate -- refusing to promote"
            )
        if not provenance["determinism"]["passed"]:
            raise SystemExit(
                f"attempt {args.attempt} was not reproducible across two renders -- refusing "
                "to promote a non-deterministic result from an arm whose entire premise is "
                "determinism"
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
