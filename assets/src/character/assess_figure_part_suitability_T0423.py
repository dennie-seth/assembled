#!/usr/bin/env python3
"""T-0423 FIX ROUND: per-part anatomical-suitability report.

Computes, from the already-committed `docs/assets/evidence/T-0417/
part_comparison.json` and mask PNGs, a mechanical-isolation vs.
anatomical-suitability table for every part on every figure panel -- no
SAM3, no ComfyUI, no GPU, nothing re-submitted or re-derived beyond reading
what T-0423's round-1 run already produced.

Two independent axes, kept distinct throughout (never conflated into one
pass/fail number -- the thing Chat's review of PR #426 found this card's
own README had been doing):

  - **mechanical** (`isolated` in `part_comparison.json`): a connected,
    non-stray, non-overlapping mask -- `char_gen.part_isolation`'s own
    question, unchanged by this script.
  - **suitability** (this script): does the mask, beyond being mechanically
    clean, actually contain the part it claims to and nothing else.
    - `upper_arm` parts: computed via `char_gen.part_suitability`'s
      `beyond_distal_joint_fraction` against the part's own committed mask
      -- "combined" when it exceeds `COMBINED_PART_BEYOND_JOINT_FRACTION_TOLERANCE`.
    - `lower_arm` parts: the metric does not apply (T-0338's own
      "lower arm+hand" naming means content past the wrist is the hand,
      not a neighbour) -- reported "n/a (hand-inclusive part)".
    - `head`/`torso` parts: no two-joint span to measure "beyond" (see
      `PartSpec.joint_b_pair`'s own docstring) -- the metric does not
      apply. Completeness here is a VISUAL judgement made by inspecting
      each part's own `*_sam3_after.png`/`*_mask.png` evidence file
      (`docs/assets/evidence/T-0417/panel_<panel>_part_<part>_*.png`), not
      something this script derives from pixels; the per-part findings
      below are hand-recorded from that inspection and cited by file.

Usage (from `assets/src/character/`, offline, no network):
    .venv/bin/python assess_figure_part_suitability_T0423.py
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

EVIDENCE_DIR = _CHARACTER_DIR.resolve().parents[2] / "docs" / "assets" / "evidence" / "T-0417"

_PANEL_KEYPOINTS = {
    "front_tpose": rig.FRONT_TPOSE_KEYPOINTS_NORM,
    "back_tpose": rig.BACK_TPOSE_KEYPOINTS_NORM,
    "side_right_forward": rig.SIDE_RIGHT_FORWARD_KEYPOINTS_NORM,
    "side_left_forward": rig.SIDE_LEFT_FORWARD_KEYPOINTS_NORM,
    "side_neutral": rig.SIDE_NEUTRAL_KEYPOINTS_NORM,
}

#: [T-0423] Visual findings for `head`/`torso` parts -- `beyond_distal_joint_fraction`
#: has no second joint to measure against for either (see module docstring),
#: so completeness here was judged by inspecting each part's own evidence
#: PNG directly, not computed. Recorded once here rather than re-typed
#: per-panel in the README. `None` reason = visually complete, no finding.
_VISUAL_FINDINGS: dict[tuple[str, str], str | None] = {
    ("front_tpose", "head"): (
        "incomplete -- face/goggles retained, surrounding hood omitted "
        "(panel_front_tpose_part_head_sam3_after.png)"
    ),
    ("back_tpose", "head"): None,
    ("side_right_forward", "head"): (
        "mechanically overlap-rejected AND visually poor -- fragmentary "
        "hood streamers, not a usable head shape "
        "(panel_side_right_forward_part_head_sam3_after.png)"
    ),
    ("side_left_forward", "head"): (
        "mechanically overlap-rejected AND visually poor -- fragmentary, "
        "not a usable head shape (panel_side_left_forward_part_head_mask.png)"
    ),
    ("side_neutral", "head"): None,
    ("side_right_forward", "torso"): (
        "partial -- a strip of coat fold, not the complete torso/coat "
        "(panel_side_right_forward_part_torso_sam3_after.png)"
    ),
    ("side_left_forward", "torso"): (
        "mechanically overlap-rejected -- coat mask extends into the "
        "swallowed left_upper_arm (panel_side_left_forward_part_torso_sam3_after.png)"
    ),
    ("side_neutral", "torso"): (
        "mechanically stray- and overlap-rejected (68.4% stray, the "
        "worst single result this card produced) -- a small disconnected "
        "fragment, not usable (panel_side_neutral_part_torso_sam3_after.png)"
    ),
}


def _joint_px(panel: str, joint_idx: int) -> tuple[int, int]:
    return compare_t0337._px(_PANEL_KEYPOINTS[panel][joint_idx], compare_t0337.PANEL_SIZE)


def compute_report() -> tuple[list[dict], dict]:
    """Returns `(per_part_rows, totals)` -- the structured data `main()`
    renders as markdown, pulled out so tests can assert on the data
    directly instead of parsing printed table text."""
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
                    # Same rule as the head/torso branch below: "combined"
                    # is only the headline label when mechanical isolation
                    # ALSO passed (the dangerous overclaim case -- reported
                    # as clean when it wasn't). A part already mechanically
                    # rejected stays labelled that, with the same beyond-
                    # elbow fact folded into its reason, not double-counted
                    # as a second rejection.
                    suitability = "combined" if isolated else "mechanically rejected"
                else:
                    reason = f"{frac * 100:.1f}% beyond its own elbow (within tolerance)"
            elif spec.label == "lower_arm_hand":
                reason = "beyond-wrist metric n/a -- wrist content is the hand this part names"
            else:  # head / torso_coat
                finding = _VISUAL_FINDINGS.get((panel, part))
                if finding is not None:
                    usable = False
                    reason = finding
                    # A short suitability label is only meaningful for a
                    # part that passed mechanical isolation and is still
                    # anatomically wrong (the overclaim cases this round
                    # corrects) -- a mechanically-rejected part just stays
                    # "mechanically rejected" below, with the full visual
                    # finding carried in `reason`, not relabelled.
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
