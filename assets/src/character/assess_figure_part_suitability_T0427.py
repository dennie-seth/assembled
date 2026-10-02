#!/usr/bin/env python3
"""T-0427: per-part anatomical-suitability report, after retuning the
torso's own SAM3 request (see `gen_master_sheet_part_cutouts_T0417.py`'s
`_TORSO_POSITIVE_RUN_FRACTIONS`/`_TORSO_EXTRA_NEGATIVE_JOINTS`).

Sibling of `assess_figure_part_suitability_T0423.py`, not a replacement for
it: that script and its own `_VISUAL_FINDINGS` table stay exactly as T-0423
committed them, a historical record of what T-0423's own run found. This
module reuses the identical computation
(`char_gen.part_suitability.beyond_distal_joint_fraction`/
`is_combined_with_next_segment` for `upper_arm`; a fresh visual judgement
for `head`/`torso`, since neither has a second joint to measure "beyond"
against) against the CURRENT `docs/assets/evidence/T-0417/
part_comparison.json` -- which this card's own torso re-runs have updated
in place for `torso` only, exactly as the T-0417/T-0423 machinery's own
`--panel X --part torso` re-run path is designed to do.

Usage (from `assets/src/character/`, offline, no network):
    .venv/bin/python assess_figure_part_suitability_T0427.py
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

import assess_figure_part_suitability_T0423 as t0423_report  # noqa: E402
import gen_master_sheet_cutout_compare_T0337 as compare_t0337  # noqa: E402
import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

from char_gen.part_suitability import (  # noqa: E402
    beyond_distal_joint_fraction,
    is_combined_with_next_segment,
)

#: [T-0427] `head` is untouched by this card -- not re-run, no new mask.
#: Reused verbatim from T-0423's own module rather than re-derived, so a
#: head finding (e.g. `front_tpose/head`'s own recorded "incomplete --
#: hood omitted") can never silently read as "adequate" here just because
#: this module's own rule for an unlisted part defaults optimistically.
_HEAD_VISUAL_FINDINGS = t0423_report._VISUAL_FINDINGS

EVIDENCE_DIR = _CHARACTER_DIR.resolve().parents[2] / "docs" / "assets" / "evidence" / "T-0417"

_PANEL_KEYPOINTS = {
    "front_tpose": rig.FRONT_TPOSE_KEYPOINTS_NORM,
    "back_tpose": rig.BACK_TPOSE_KEYPOINTS_NORM,
    "side_right_forward": rig.SIDE_RIGHT_FORWARD_KEYPOINTS_NORM,
    "side_left_forward": rig.SIDE_LEFT_FORWARD_KEYPOINTS_NORM,
    "side_neutral": rig.SIDE_NEUTRAL_KEYPOINTS_NORM,
}

#: [T-0427 ROUND 2] Visual findings for `torso`, re-measured after adding
#: the lateral shoulder/hip positive points (`_TORSO_LATERAL_POSITIVE_JOINT_PAIRS`)
#: on top of round 1's centerline run. **Round 1's own findings for
#: `side_right_forward` and `side_left_forward` here were WRONG** -- the
#: reviewer's second FAIL on this card measured `side_left_forward`'s
#: actual committed mask (20,111px, 4.8% of the whole-figure mask) against
#: the source panel and found it covers part of the brown tunic only,
#: missing the entire green cloak -- the opposite of "a complete-looking
#: triangular coat/cloak silhouette." That finding is retracted below, not
#: repeated. Every percentage cited here is pixel count divided by the
#: whole-figure foreground pixel count from
#: `docs/assets/evidence/T-0337/panel_<panel>_oklab_after.png` (the same
#: method the reviewer used), not a subjective impression -- the subjective
#: "looks complete" language is exactly what produced round 1's false
#: positives, so this round's labels are anchored to that measurement
#: first and a visual description second.
_TORSO_VISUAL_FINDINGS: dict[str, str | None] = {
    "front_tpose": (
        "partial -- 19,983px, 5.1% of the whole-figure mask, a narrow "
        "~70px-wide vertical strip down the coat's own center seam; the "
        "lateral positive points landed within ~15px of the centerline "
        "run on this pose (front/back T-poses do spread the shoulder/hip "
        "joints apart, but this pose's own geometry still didn't pull the "
        "mask wider) -- empty-detection problem fixed, full torso width "
        "is not (panel_front_tpose_part_torso_sam3_after.png)"
    ),
    "back_tpose": (
        "partial -- genuinely larger this round (99,640px, 24.3% of the "
        "whole figure, up from round 1's 5,955px/1.5%) and visually spans "
        "most of the upper-to-mid back coat width; overlaid on the source "
        "panel it has extensive internal holes (the kept component is not "
        "a clean fill) and still falls short of the garment's left/right "
        "edges by a visible margin -- real progress, not yet a complete "
        "silhouette (panel_back_tpose_part_torso_sam3_after.png)"
    ),
    "side_right_forward": (
        "partial -- 107,293px, 35.8% of the whole figure, a single "
        "vertical coat-fold panel with visible fold lines -- same "
        "conclusion T-0423's original run reached ('a strip of coat fold, "
        "not the complete torso/coat'); the opposite panel of this "
        "open coat (the far-side flap, roughly the other half of the "
        "garment's visible width) is not captured "
        "(panel_side_right_forward_part_torso_sam3_after.png)"
    ),
    "side_left_forward": (
        "partial -- CORRECTS round 1's wrong 'adequate' label. 20,722px, "
        "5.0% of the whole figure, a ~90px-wide vertical strip down the "
        "center seam only. The torso/left_upper_arm overlap that rejected "
        "this panel under T-0423 is genuinely resolved (0.392 -> 0.013, "
        "confirmed again this round), which is why the mask now isolates "
        "mechanically -- but resolving an overlap only clears the "
        "mechanical-isolation axis, it does not make the mask anatomically "
        "complete: overlaid on the source panel this strip covers part of "
        "the brown tunic and excludes the entire green cloak "
        "(panel_side_left_forward_part_torso_sam3_after.png)"
    ),
    "side_neutral": (
        "mechanically rejected -- 44,092px, 33.8% of the whole figure, a "
        "visually clean vertical panel on its own, but overlaps "
        "right_upper_arm (0.577, over the 0.25 tolerance) and "
        "right_lower_arm (0.897, over the 0.0 non-adjacent tolerance); "
        "both worse than T-0423's original 0.369/0.194 for this same pair "
        "-- the stray-fragment problem T-0423 recorded (68.4%) stays fixed "
        "(1.1%), but overlap is still the blocker, not improved by the "
        "lateral points (panel_side_neutral_part_torso_sam3_after.png)"
    ),
}


def _joint_px(panel: str, joint_idx: int) -> tuple[int, int]:
    return compare_t0337._px(_PANEL_KEYPOINTS[panel][joint_idx], compare_t0337.PANEL_SIZE)


def compute_report() -> tuple[list[dict], dict]:
    """Returns `(per_part_rows, totals)` for the torso + upper_arm/
    lower_arm/head rows on every figure panel, reusing
    `part_comparison.json` and the committed mask PNGs exactly as
    `assess_figure_part_suitability_T0423.compute_report` does -- this
    function exists separately only because `_VISUAL_FINDINGS` for `torso`
    changed (new masks), not because the computation itself did."""
    data = json.loads((EVIDENCE_DIR / "part_comparison.json").read_text())
    panels = data["panels"]

    mechanical_isolated = 0
    anatomically_usable = 0
    total_requested = 0
    per_part: list[dict] = []

    for panel in gen._FIGURE_PANEL_KEYS:
        for part in gen.PARTS_BY_PANEL[panel]:
            total_requested += 1
            rec = panels[panel]["parts"][part]
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

            if spec.label == "upper_arm":
                mask_path = EVIDENCE_DIR / f"panel_{panel}_part_{part}_mask.png"
                mask = np.array(Image.open(mask_path)) > 0
                proximal_px = _joint_px(panel, spec.joint_a)
                distal_px = _joint_px(panel, spec.joint_b)
                frac = beyond_distal_joint_fraction(mask, proximal_px, distal_px)
                combined = is_combined_with_next_segment(frac)
                if combined:
                    usable = False
                    reason = (
                        f"{frac * 100:.1f}% of retained pixels lie past its own elbow "
                        "-- includes the forearm, not compositor-ready as upper_arm"
                    )
                    suitability = "combined" if isolated else "mechanically rejected"
                else:
                    reason = f"{frac * 100:.1f}% beyond its own elbow (within tolerance)"
                    if not isolated:
                        suitability = "mechanically rejected"
            elif spec.label == "lower_arm_hand":
                reason = "beyond-wrist metric n/a -- wrist content is the hand this part names"
                if not isolated:
                    suitability = "mechanically rejected"
            elif part == "torso":
                finding = _TORSO_VISUAL_FINDINGS.get(panel)
                if finding is not None:
                    reason = finding
                    suitability = finding.split(" -- ")[0]
                    if suitability not in ("adequate",):
                        usable = False
                else:
                    reason = "visually complete, no finding"
            else:  # head, untouched by this card -- T-0423's own findings apply verbatim
                finding = _HEAD_VISUAL_FINDINGS.get((panel, part))
                if finding is not None:
                    usable = False
                    reason = f"unchanged by T-0427 -- {finding}"
                    if isolated:
                        suitability = finding.split(" -- ")[0].split(" AND")[0]
                else:
                    reason = "unchanged by T-0427 -- visually complete, no finding"
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
