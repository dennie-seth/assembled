#!/usr/bin/env python3
"""T-0428: per-part anatomical-suitability report for this card's own
evidence directory (`docs/assets/evidence/T-0428/`), re-pointed from
T-0423's `assess_figure_part_suitability_T0423.py` (`docs/assets/evidence/
T-0417/`, which this card never touches -- see that script and
`gen_master_sheet_part_cutouts_T0417.EVIDENCE_DIR`'s own docstring).

Same two-axis approach T-0423 established, kept and never dropped (card's
own acceptance wording):

  - **mechanical** (`isolated` in `part_comparison.json`): a connected,
    non-stray, non-overlapping mask -- `char_gen.part_isolation`'s own
    question, unchanged by this script.
  - **suitability**: does the mask, beyond being mechanically clean,
    actually contain the part it claims to and nothing else.
    - `arm` parts ([T-0428] shoulder->wrist, replacing T-0423's
      `upper_arm`/`lower_arm` split): judged via
      `char_gen.part_suitability.beyond_distal_joint_fraction` against the
      WRIST as the distal joint -- not the elbow. An arm that runs past its
      own wrist into whatever comes next ("combined") is still caught and
      labelled, never silently counted as a win.
    - `head`/`torso` parts: no two-joint span to measure "beyond" (same as
      T-0423) -- completeness here is a VISUAL judgement made by
      inspecting each part's own `*_sam3_after.png`/`*_mask.png` evidence
      file, recorded in `_VISUAL_FINDINGS` below and cited by file.

Iterates over whatever panels/parts are actually PRESENT in this card's own
`part_comparison.json` -- this card's own live run is scoped to the two
side panels T-0338 needs (`side_left_forward`, `side_right_forward`; see
the card's own acceptance), not all five figure panels, so this script
does not assume all five are present.

Usage (from `assets/src/character/`, offline, no network):
    .venv/bin/python assess_figure_part_suitability_T0428.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parent
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))
sys.path.insert(0, str(_CHARACTER_DIR / "src"))

import gen_master_sheet_cutout_compare_T0337 as compare_t0337  # noqa: E402
import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

from char_gen.part_suitability import (  # noqa: E402
    beyond_distal_joint_fraction,
    is_combined_with_next_segment,
)

EVIDENCE_DIR = gen.EVIDENCE_DIR

_PANEL_KEYPOINTS = {
    "front_tpose": rig.FRONT_TPOSE_KEYPOINTS_NORM,
    "back_tpose": rig.BACK_TPOSE_KEYPOINTS_NORM,
    "side_right_forward": rig.SIDE_RIGHT_FORWARD_KEYPOINTS_NORM,
    "side_left_forward": rig.SIDE_LEFT_FORWARD_KEYPOINTS_NORM,
    "side_neutral": rig.SIDE_NEUTRAL_KEYPOINTS_NORM,
}

#: Visual findings for `head`/`torso` parts -- `beyond_distal_joint_fraction`
#: has no second joint to measure against for either (see module
#: docstring), so completeness is judged by inspecting each part's own
#: evidence PNG directly. `None` = visually complete, no finding. Filled in
#: from this card's own live run (see docs/assets/evidence/T-0428/README.md
#: for the inspection this records).
#:
#: [T-0428 live run] Both forward heads were already flagged by T-0423
#: as "visually poor -- fragmentary hood streamers" on these exact two
#: panels, BEFORE this card's ear-midpoint anchor change -- these entries
#: are this card's own fresh visual re-check under the new anchor, not a
#: carry-over assumption. The ear-midpoint anchor does clear the head x
#: arm overlap on both panels (see README's hypothesis-test table), but
#: neither resulting head mask is an anatomically legible head: the right
#: panel's is mechanically isolated hood/scarf cloth with no facial
#: features, and the left panel's is a mechanically-degenerate sliver of a
#: fabric highlight. Torso is unmodified by this card (same point prompt,
#: same panel) -- these entries record this run's own fresh visual check
#: of its own output, not a re-assertion of T-0423's.
_VISUAL_FINDINGS: dict[tuple[str, str], str | None] = {
    ("side_right_forward", "head"): (
        "visually not a head -- mechanically isolated hood/scarf cloth with no "
        "facial features, no eyes/nose/jaw visible anywhere in the mask "
        "(panel_side_right_forward_part_head_sam3_after.png)"
    ),
    ("side_left_forward", "head"): (
        "visually not a head -- a small bright fabric-fold highlight, not skin "
        "or a face (panel_side_left_forward_part_head_sam3_after.png)"
    ),
    ("side_right_forward", "torso"): (
        "partial -- an elongated coat-fold strip, not the complete torso/coat "
        "silhouette (panel_side_right_forward_part_torso_sam3_after.png)"
    ),
    ("side_left_forward", "torso"): None,
}


def _joint_px(panel: str, joint_idx: int) -> tuple[int, int]:
    return compare_t0337._px(_PANEL_KEYPOINTS[panel][joint_idx], compare_t0337.PANEL_SIZE)


def compute_report() -> tuple[list[dict], dict]:
    """Returns `(per_part_rows, totals)` -- the structured data `main()`
    renders as markdown, pulled out so tests can assert on the data
    directly instead of parsing printed table text.

    Iterates over panels/parts actually present in the committed
    `part_comparison.json`, intersected with `gen.PARTS_BY_PANEL` (never
    a part this card's own spec doesn't recognise) -- so a partial run
    (e.g. only the two side panels) is reported for exactly what it
    covers, never padded with parts that were never requested this run."""
    data = json.loads((EVIDENCE_DIR / "part_comparison.json").read_text())
    panels = data.get("panels", {})

    mechanical_isolated = 0
    anatomically_usable = 0
    total_requested = 0
    per_part: list[dict] = []

    for panel, panel_data in panels.items():
        allowed_parts = gen.PARTS_BY_PANEL.get(panel, ())
        parts_present = panel_data.get("parts", {})
        for part in allowed_parts:
            if part not in parts_present:
                continue
            total_requested += 1
            rec = parts_present[part]
            if not rec["present"]:
                per_part.append(
                    {
                        "panel": panel,
                        "part": part,
                        "present": False,
                        "isolated": None,
                        "suitability": "n/a",
                        "reason": "not present (empty detection)",
                    }
                )
                continue

            isolated = bool(rec["isolated"])
            mechanical_isolated += int(isolated)

            spec = gen._FIGURE_PART_SPECS_BY_KEY[part]
            usable = isolated
            suitability = "adequate"
            reason = ""

            if spec.label == "arm":
                mask_path = EVIDENCE_DIR / f"panel_{panel}_part_{part}_mask.png"
                mask = np.array(Image.open(mask_path)) > 0
                proximal_px = _joint_px(panel, spec.joint_a)
                distal_px = _joint_px(panel, spec.joint_b)
                frac = beyond_distal_joint_fraction(mask, proximal_px, distal_px)
                combined = is_combined_with_next_segment(frac)
                if combined:
                    usable = False
                    reason = (
                        f"{frac * 100:.1f}% of retained pixels lie past its own wrist -- "
                        "runs past the hand, not compositor-ready as arm"
                    )
                    # Same rule T-0423 used: "combined" is only the
                    # headline label when mechanical isolation ALSO
                    # passed. A part already mechanically rejected stays
                    # labelled that, with the beyond-wrist fact folded
                    # into its reason, not double-counted.
                    suitability = "combined" if isolated else "mechanically rejected"
                else:
                    reason = f"{frac * 100:.1f}% beyond its own wrist (within tolerance)"
            else:  # head / torso_coat
                finding = _VISUAL_FINDINGS.get((panel, part))
                if finding is not None:
                    usable = False
                    reason = finding
                    if isolated:
                        suitability = finding.split(" -- ")[0].split(" AND")[0]
                else:
                    reason = "visually complete, no finding"

            if not isolated and suitability == "adequate":
                suitability = "mechanically rejected"

            anatomically_usable += int(usable)
            per_part.append(
                {
                    "panel": panel,
                    "part": part,
                    "present": True,
                    "isolated": isolated,
                    "usable": usable,
                    "suitability": suitability,
                    "reason": reason,
                }
            )

    totals = {
        "requested": total_requested,
        "mechanically_isolated": mechanical_isolated,
        "anatomically_usable": anatomically_usable,
    }
    return per_part, totals


def main() -> None:
    per_part, totals = compute_report()

    rows = [
        "| panel | part | present | isolated | suitability | reason |",
        "|---|---|---|---|---|---|",
    ]
    for row in per_part:
        present = "yes" if row["present"] else "no"
        isolated = "n/a" if row["isolated"] is None else ("yes" if row["isolated"] else "no")
        rows.append(
            f"| {row['panel']} | {row['part']} | {present} | {isolated} | "
            f"{row['suitability']} | {row['reason']} |"
        )

    print("\n".join(rows))
    print()
    print(f"requested: {totals['requested']}")
    print(f"mechanically isolated: {totals['mechanically_isolated']}")
    print(f"anatomically usable by name: {totals['anatomically_usable']}")


if __name__ == "__main__":
    main()
