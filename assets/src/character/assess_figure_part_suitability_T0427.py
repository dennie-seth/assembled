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

#: [T-0427] Visual findings for `torso` parts re-run by this card -- a
#: fresh, honest re-inspection of the NEW evidence PNGs this run produced,
#: following the exact same "no second joint to measure beyond, so judged
#: visually, cited by file" rule T-0423's own module docstring states.
#: `head` is untouched by this card (not re-run) -- T-0423's own
#: `_VISUAL_FINDINGS` entries for `head` still apply verbatim and are not
#: duplicated here.
_TORSO_VISUAL_FINDINGS: dict[str, str | None] = {
    "front_tpose": (
        "partial -- a narrow vertical strip down the coat's own center "
        "seam, not the full torso width; the empty-detection problem is "
        "fixed (present, mechanically isolated, no overlap) but this is "
        "not a complete torso silhouette "
        "(panel_front_tpose_part_torso_sam3_after.png)"
    ),
    "back_tpose": (
        "partial -- same narrow center-seam strip as front_tpose, same "
        "fix/limitation split: empty detection fixed, full torso width "
        "is not (panel_back_tpose_part_torso_sam3_after.png)"
    ),
    "side_right_forward": (
        "adequate -- a fuller profile torso/coat silhouette with visible "
        "fold lines, an improvement over T-0423's own 'strip of coat "
        "fold, not the complete torso/coat' finding for this panel "
        "(panel_side_right_forward_part_torso_sam3_after.png)"
    ),
    "side_left_forward": (
        "adequate -- a complete-looking triangular coat/cloak silhouette "
        "for this side view, tapering toward the hip; a minor concave "
        "notch on the near edge, not a missing region "
        "(panel_side_left_forward_part_torso_sam3_after.png)"
    ),
    "side_neutral": (
        "mechanically rejected -- visually a plausible, fairly complete "
        "torso blob on its own, but overlaps BOTH arm masks well past "
        "tolerance (see overlap table); the stray-fragment problem T-0423 "
        "recorded (68.4%) is fixed (1.3%), but overlap got WORSE, not "
        "better (panel_side_neutral_part_torso_sam3_after.png)"
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
