"""T-0231 (HANDOFF §23-g) — bake-off comparison: side-by-side artefact,
frame-silhouette delta gate re-run, and cost-table assembly for the three
T-0227 character-pipeline bake-off arms (docs/decision-log.md DL-21).

This module only re-verifies and assembles outputs the three arms already
produced (docs/decisions/T-0227-bakeoff-cost-record-template.md rows, each
arm's own provenance sidecar and committed sheet) -- it generates no new
character pixels of its own and invents no judgement. Criterion 1
(silhouette read) and criterion 2's human drift verdict stay human calls
per DL-21; see BAKEOFF_DECISION_T0231.md for how this card records that.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple

CHAR_DIR = Path(__file__).resolve().parents[2]  # assets/src/character
REPO_ROOT = CHAR_DIR.parents[2]  # repo root
FINAL_DIR = REPO_ROOT / "assets" / "final" / "character"

CELL_SIZE = 48
COLS = 3
ROWS = 3
BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.30  # DL-21 criterion 2's mechanical cap

FRAME_CELLS: list[tuple[int, int]] = [(r, c) for r in range(ROWS) for c in range(COLS)]
ADJACENT_PAIRS: list[tuple[tuple[int, int], tuple[int, int]]] = [
    (FRAME_CELLS[i], FRAME_CELLS[i + 1]) for i in range(len(FRAME_CELLS) - 1)
]


class Arm(NamedTuple):
    key: str
    label: str
    card: str
    sheet: Path
    provenance: Path
    report: Path
    preview_gif: Path


ARMS: list[Arm] = [
    Arm(
        key="arm_a",
        label="Arm A (§23-d)",
        card="T-0228",
        sheet=FINAL_DIR / "player_idle_sheet_arm_a_T0228.png",
        provenance=FINAL_DIR / "player_idle_sheet_arm_a_T0228.provenance.json",
        report=CHAR_DIR / "ARM_A_BAKEOFF_REPORT_T0228.md",
        preview_gif=FINAL_DIR / "arm_a_judging_preview_T0228.gif",
    ),
    Arm(
        key="arm_b",
        label="Arm B (§23-e)",
        card="T-0229",
        sheet=FINAL_DIR / "player_idle_sheet_arm_b_T0229.png",
        provenance=FINAL_DIR / "player_idle_sheet_arm_b_T0229.provenance.json",
        report=CHAR_DIR / "ARM_B_BAKEOFF_REPORT_T0229.md",
        preview_gif=FINAL_DIR / "arm_b_judging_preview_T0229.gif",
    ),
    Arm(
        key="arm_c",
        label="Arm C (§23-f, the script)",
        card="T-0230",
        sheet=FINAL_DIR / "player_idle_sheet_arm_c_T0230.png",
        provenance=FINAL_DIR / "player_idle_sheet_arm_c_T0230.provenance.json",
        report=CHAR_DIR / "ARM_C_BAKEOFF_REPORT_T0230.md",
        preview_gif=FINAL_DIR / "arm_c_judging_preview_T0230.gif",
    ),
]


def compute_frame_deltas(sheet_path: Path) -> list[dict]:
    """Re-run DL-21 criterion 2's mechanical gate
    (asset_gate.art.check_frame_consistency) over a committed sheet's 8
    adjacent-cell transitions. Caller must have tools/asset-gate/src on
    sys.path (conftest.py does this for pytest; the CLI wrapper does it for
    direct invocation)."""
    from asset_gate import art as asset_gate_art
    from PIL import Image

    sheet = Image.open(sheet_path)
    cells: dict[tuple[int, int], Image.Image] = {}
    for sr, sc in FRAME_CELLS:
        x0, y0 = sc * CELL_SIZE, sr * CELL_SIZE
        cells[(sr, sc)] = sheet.crop((x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE))

    deltas = []
    for cell_a, cell_b in ADJACENT_PAIRS:
        result = asset_gate_art.check_frame_consistency(
            cells[cell_a],
            cells[cell_b],
            background_index=BACKGROUND_INDEX,
            max_delta_ratio=MAX_FRAME_DELTA_RATIO,
        )
        deltas.append(
            {
                "pair": [list(cell_a), list(cell_b)],
                "ratio": result.details["ratio"],
                "passed": result.passed,
            }
        )
    return deltas


def build_frame_delta_report() -> dict:
    """Consolidate a fresh gate run across all three arms into one report --
    acceptance bullet 2: 'the numbers are reported per arm'."""
    report: dict = {
        "card": "T-0231",
        "spec": "docs/decision-log.md DL-21 criterion 2 (mechanical half)",
        "max_delta_ratio": MAX_FRAME_DELTA_RATIO,
        "arms": {},
    }
    for arm in ARMS:
        deltas = compute_frame_deltas(arm.sheet)
        failed = [d for d in deltas if not d["passed"]]
        report["arms"][arm.key] = {
            "label": arm.label,
            "card": arm.card,
            "sheet": str(arm.sheet.relative_to(REPO_ROOT)),
            "deltas": deltas,
            "num_failed": len(failed),
            "all_passed": len(failed) == 0,
        }
    return report


def extract_cost_row(report_path: Path) -> str:
    """Pull the single '| Arm X (...) | ... |' data row out of an arm's own
    filled §23-c cost template -- verbatim, not retyped (DL-21 recording
    rule: 'same template, same columns, same units')."""
    for line in report_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("| Arm ") and "§23-" in stripped and stripped.endswith("|"):
            return stripped
    raise ValueError(f"no cost-table row found in {report_path}")


COST_TABLE_HEADER = (
    "| Arm | Criterion 1 (silhouette @ 40px in motion) "
    "| Criterion 2 (identity stable) | Attempts-to-first-pass "
    "| GPU minutes | Wall-clock | $ | Sheet | Provenance sidecar | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|"
)


def build_cost_table() -> str:
    """§23-c's shared template, concatenated unchanged across all three arms
    -- acceptance bullet 3, and the template's own 'How to use this' rule:
    '§23-g concatenates the three rows unchanged.'"""
    rows = [extract_cost_row(arm.report) for arm in ARMS]
    return COST_TABLE_HEADER + "\n" + "\n".join(rows)


SVG_PANEL_W = 384  # DL-18 committed blockout-room pixel width
SVG_PANEL_H = 216  # DL-18 committed blockout-room pixel height
SVG_GAP = 16
SVG_LABEL_H = 24
SVG_TITLE_H = 32
SVG_MARGIN = 12


def build_comparison_svg() -> str:
    """One side-by-side artefact referencing all three arms' already-rendered
    judging previews (each already at 40px, in motion, inside the T-0192
    blockout-room mockup -- render_judging_preview*.py, DL-18 dimensions).
    Text/vector only: no new pixels are generated, nothing is fabricated."""
    n = len(ARMS)
    width = SVG_MARGIN * 2 + n * SVG_PANEL_W + (n - 1) * SVG_GAP
    height = SVG_MARGIN * 2 + SVG_TITLE_H + SVG_LABEL_H + SVG_PANEL_H

    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        f'<rect x="0" y="0" width="{width}" height="{height}" fill="#1b1b1b"/>',
        f'<text x="{width / 2}" y="{SVG_MARGIN + 18}" fill="#e8e4d8" '
        'font-family="monospace" font-size="16" text-anchor="middle">'
        "T-0231 bake-off comparison -- DL-21 judging conditions: 40px, in "
        "motion, T-0192 blockout room</text>",
    ]
    y_label = SVG_MARGIN + SVG_TITLE_H
    y_panel = y_label + SVG_LABEL_H
    for i, arm in enumerate(ARMS):
        x = SVG_MARGIN + i * (SVG_PANEL_W + SVG_GAP)
        href = arm.preview_gif.name
        parts.append(
            f'<text x="{x + SVG_PANEL_W / 2}" y="{y_label + 18}" fill="#e8e4d8" '
            f'font-family="monospace" font-size="14" text-anchor="middle">'
            f"{arm.label} ({arm.card})</text>"
        )
        parts.append(
            f'<image x="{x}" y="{y_panel}" width="{SVG_PANEL_W}" height="{SVG_PANEL_H}" '
            f'href="{href}" xlink:href="{href}"/>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def main() -> None:
    delta_report = build_frame_delta_report()
    (FINAL_DIR / "bakeoff_frame_delta_report_T0231.json").write_text(
        json.dumps(delta_report, indent=2) + "\n"
    )
    (CHAR_DIR / "BAKEOFF_COST_TABLE_T0231.md").write_text(build_cost_table() + "\n")
    (FINAL_DIR / "bakeoff_comparison_T0231.svg").write_text(build_comparison_svg() + "\n")
    print("wrote bakeoff_frame_delta_report_T0231.json, BAKEOFF_COST_TABLE_T0231.md, "
          "bakeoff_comparison_T0231.svg")


if __name__ == "__main__":
    main()
