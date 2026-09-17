#!/usr/bin/env python3
"""Promote one Arm B attempt to assets/final/character/ (T-0229, HANDOFF §23-e).

Mirrors promote_arm_a_attempt.py (T-0228): a separate, explicit step from
gen_arm_b_idle_T0229.py, since the mechanical frame-consistency gate that
script computes per attempt is only half of DL-21 criterion 2 and says
nothing about criterion 1 (silhouette readable, single idle character, no
drift), which takes strict precedence and needs a human/visual pass first.

Usage (from the repo root):
    python3 assets/src/character/promote_arm_b_attempt.py --attempt 3

Copies:
    assets/out/arm_b/attempt_<N>/sheet_144_indexed.png
        -> assets/final/character/player_idle_sheet_arm_b_T0229.png
    assets/out/arm_b/attempt_<N>/provenance_candidate.json (with "promoted": true)
        -> assets/final/character/player_idle_sheet_arm_b_T0229.provenance.json

Refuses to run if the attempt's own mechanical gate did not pass, unless
--as-best-effort-candidate is given (DL-21's 8-attempt cap is itself a
result -- see promote_arm_a_attempt.py's module docstring for the full
rationale, identical here), or if a sheet is already promoted.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_arm_b_idle_T0229 import (  # noqa: E402
    ATTEMPT_LOG_PATH,
    FINAL_CHARACTER_DIR,
    FINAL_PROVENANCE_PATH,
    FINAL_SHEET_PATH,
)


def promote(attempt: int, as_best_effort_candidate: bool = False) -> dict:
    out_dir = REPO_ROOT / "assets" / "out" / "arm_b" / f"attempt_{attempt}"
    provenance_path = out_dir / "provenance_candidate.json"
    sheet_path = out_dir / "sheet_144_indexed.png"

    if not provenance_path.exists():
        raise SystemExit(f"no such attempt: {provenance_path} does not exist")
    provenance = json.loads(provenance_path.read_text())

    if not provenance.get("mechanical_gate_passed") and not as_best_effort_candidate:
        raise SystemExit(
            f"attempt {attempt} did not pass the mechanical gate -- refusing to promote "
            "(pass --as-best-effort-candidate if this is DL-21's 8-attempt-cap criterion-3 "
            "failure and you are delivering the best candidate for §23-g's inspection)"
        )
    if FINAL_SHEET_PATH.exists():
        raise SystemExit(
            f"{FINAL_SHEET_PATH} already exists -- one promoted sheet per arm, "
            "remove it first if this promotion is meant to replace it"
        )

    provenance["promoted"] = True
    if as_best_effort_candidate:
        provenance["bake_off_result"] = (
            "criterion-3 failure -- DL-21 8-attempt cap exhausted without a mechanical "
            "criterion-2 pass; delivered as the best-effort candidate for §23-g's criterion-1 "
            "inspection, not as a passing sheet"
        )
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes(sheet_path.read_bytes())
    FINAL_PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")

    if ATTEMPT_LOG_PATH.exists():
        with ATTEMPT_LOG_PATH.open("a") as f:
            if as_best_effort_candidate:
                f.write(
                    f"\nAttempt {attempt} promoted to "
                    f"`{FINAL_SHEET_PATH.relative_to(REPO_ROOT)}` as the best-effort candidate "
                    "after the DL-21 8-attempt cap was exhausted without a mechanical "
                    "criterion-2 pass -- a criterion-3 failure, delivered for §23-g's "
                    "criterion-1 inspection, not as a passing sheet.\n"
                )
            else:
                f.write(
                    f"\nAttempt {attempt} promoted to "
                    f"`{FINAL_SHEET_PATH.relative_to(REPO_ROOT)}` after passing DL-21 "
                    "criterion 1 (visual review) and the mechanical half of criterion 2.\n"
                )

    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--as-best-effort-candidate", action="store_true")
    args = parser.parse_args()
    provenance = promote(args.attempt, as_best_effort_candidate=args.as_best_effort_candidate)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
