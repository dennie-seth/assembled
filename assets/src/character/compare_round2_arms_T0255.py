#!/usr/bin/env python3
"""T-0255 CLI (HANDOFF §24, handle §24-f) -- assembles the round-2 comparison
artefact and the consolidated frame-silhouette delta report from the
already-committed round-2 arms (pose authority T-0249, chained img2img
T-0250, hybrid T-0252) plus Arm C (T-0230) as the benchmark
(docs/decision-log.md DL-21/DL-23).

Usage (from the repo root, no ComfyUI/GPU required):
    python3 assets/src/character/compare_round2_arms_T0255.py

Writes:
    assets/final/character/round2_comparison_T0255.webp
    assets/final/character/round2_frame_delta_report_T0255.json

Reads only already-committed arm outputs (sheets, provenance sidecars,
judging-preview gifs) -- no new generation, no ComfyUI call. See
assets/src/character/ROUND2_DECISION_T0255.md for what this card does and
does not decide.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from char_gen.round2_compare import main  # noqa: E402

if __name__ == "__main__":
    main()
