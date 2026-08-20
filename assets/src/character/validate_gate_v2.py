#!/usr/bin/env python3
"""Standalone T-0212 gate validation — no pytest required.

Runs all checks from test_player_idle_v2_gate.py against the produced PNG,
using asset_gate from its source directory (no pip install needed).
Exits 0 on all-pass, 1 on any failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[3]
ASSET_GATE_SRC = WORKTREE / "tools/asset-gate/src"
sys.path.insert(0, str(ASSET_GATE_SRC))

from PIL import Image  # noqa: E402

import asset_gate.art as art  # noqa: E402
import asset_gate.palette as pal  # noqa: E402

SHEET_PATH = WORKTREE / "assets/final/character/player_idle_sheet_v2.png"
PROVENANCE_PATH = WORKTREE / "assets/final/character/player_idle_sheet_v2.provenance.json"
PALETTE_PATH = WORKTREE / "assets/final/palette/home_palette.json"
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CELL_SIZE = 48
COLS = 3
ROWS = 3
FRAME_CELLS: list[tuple[int, int]] = [(0, 0), (0, 1), (0, 2), (1, 0)]
ADJACENT_PAIRS = [((0, 0), (0, 1)), ((0, 1), (0, 2)), ((0, 2), (1, 0))]
BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.30
ORPHAN_SIZE_THRESHOLD = 4

failures: list[str] = []


def check(name: str, passed: bool, reason: str = "") -> None:
    if passed:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}: {reason}")
        failures.append(name)


print("\n=== T-0212 gate validation ===\n")

# -- basic file checks --
if not SHEET_PATH.exists():
    print(f"FATAL: sheet not found: {SHEET_PATH}")
    sys.exit(1)

sheet = Image.open(SHEET_PATH)
check("mode_P", sheet.mode == "P", f"mode={sheet.mode!r}")
check("size_144x144", sheet.size == (144, 144), f"size={sheet.size}")

# -- provenance / concept_hash --
if not PROVENANCE_PATH.exists():
    print(f"FATAL: provenance not found: {PROVENANCE_PATH}")
    sys.exit(1)
prov = json.loads(PROVENANCE_PATH.read_text())
check("provenance_has_concept_hash", "concept_hash" in prov, "key missing")
if "concept_hash" in prov:
    check(
        "concept_hash_value",
        prov["concept_hash"] == EXPECTED_CONCEPT_HASH,
        f"got {prov.get('concept_hash')}",
    )

# -- load palette --
palette = pal.load_palette(PALETTE_PATH)

# -- whole-sheet palette checks --
r = pal.check_palette_membership(sheet, palette)
check("palette_membership", r.passed, r.reason)

r = pal.check_index_semantics(sheet, palette)
check("index_semantics", r.passed, r.reason)

# -- cell-fit --
results = art.check_cell_fit(
    sheet,
    cell_width=CELL_SIZE,
    cell_height=CELL_SIZE,
    cols=COLS,
    rows=ROWS,
    background_index=BACKGROUND_INDEX,
)
cell_failures = [r for r in results if not r.passed]
check("cell_fit", not cell_failures, "; ".join(f"cell {r.details['cell']}: {r.reason}" for r in cell_failures))

# -- per-frame checks --
frame_images: dict[tuple[int, int], Image.Image] = {}
for sr, sc in FRAME_CELLS:
    x0, y0 = sc * CELL_SIZE, sr * CELL_SIZE
    frame_images[(sr, sc)] = sheet.crop((x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE))

for cell in FRAME_CELLS:
    r = art.check_orphan_pixels(
        frame_images[cell],
        background_index=BACKGROUND_INDEX,
        size_threshold=ORPHAN_SIZE_THRESHOLD,
    )
    check(f"orphan_pixels_{cell}", r.passed, r.reason)

# -- frame consistency --
for cell_a, cell_b in ADJACENT_PAIRS:
    r = art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    check(f"frame_consistency_{cell_a}->{cell_b}", r.passed, r.reason)

print()
if failures:
    print(f"RESULT: FAIL ({len(failures)} failures: {', '.join(failures)})")
    sys.exit(1)
else:
    print("RESULT: PASS — all T-0212 gate checks passed")
    sys.exit(0)
