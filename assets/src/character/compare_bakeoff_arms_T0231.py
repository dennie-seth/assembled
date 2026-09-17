#!/usr/bin/env python3
"""T-0231 CLI (HANDOFF §23-g) -- assembles the bake-off comparison artefact,
the consolidated frame-silhouette delta report, and the assembled cost
table from the three already-committed T-0227 arms (docs/decision-log.md
DL-21).

Usage (from the repo root, no ComfyUI/GPU required):
    python3 assets/src/character/compare_bakeoff_arms_T0231.py

Writes:
    assets/final/character/bakeoff_comparison_T0231.webp
    assets/final/character/bakeoff_frame_delta_report_T0231.json
    assets/src/character/BAKEOFF_COST_TABLE_T0231.md

Reads only already-committed arm outputs (sheets, provenance sidecars,
§23-c cost rows, judging-preview gifs) -- no new generation, no ComfyUI
call. See assets/src/character/BAKEOFF_DECISION_T0231.md for what this
card does and does not decide: criterion 1 (silhouette read) and criterion
2's human drift verdict are DL-21 human calls, recorded there as PENDING,
not invented by this script or this card.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from char_gen.bakeoff_compare import main  # noqa: E402

if __name__ == "__main__":
    main()
