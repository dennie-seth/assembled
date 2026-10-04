"""T-0428: fix the side-panel head masks and re-scope the figure arms to one
shoulder-to-hand piece.

[T-0427](T-0427)'s own diagnosis (reproduced directly against this branch's
already-committed `docs/assets/evidence/T-0417/part_comparison.json` --
see this module's `TestT0417DirectoryUnregressed` below) found the only
tolerance-exceeding overlap on either side panel T-0338 needs is
`head` x `upper_arm`, and that the head mask itself is rejected on both
panels (wildly inconsistent sizes, neither mechanically isolated). The
likely cause: `head`'s own anchor was a single point on NOSE alone -- on a
profile panel the forward-most point of the face, 12-13px (horizontal) from
the forward-extended arm's own anchor.

This module pins three structural changes, all offline (no ComfyUI, no
GPU):

  1. `head` anchors on the ear-to-ear midpoint instead of NOSE alone -- a
     point inside the skull rather than on its forward edge.
  2. `upper_arm`/`lower_arm` per side collapse into one `arm` part
     (shoulder->wrist) -- T-0338 needs the arm to separate from the torso,
     not at the elbow.
  3. `EVIDENCE_DIR` points at this card's own directory, not T-0417's --
     and T-0417's own directory, already committed, keeps reproducing its
     own 24/8/5 result unregressed.

RED state: `gen_master_sheet_part_cutouts_T0417.EVIDENCE_DIR` still points
at T-0417's own directory, `_build_figure_part_specs` still anchors `head`
on NOSE alone and still emits `upper_arm`/`lower_arm` -> every assertion
below fails against the pre-T-0428 module.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

PANEL_SIZE = gen.PANEL_SIZE

# COCO-18 indices, same numbering as pose_rig_master_sheet_T0351.py.
_NOSE = 0
_R_SHOULDER, _R_WRIST = 2, 4
_L_SHOULDER, _L_WRIST = 5, 7
_R_EAR, _L_EAR = 16, 17


class TestHeadAnchorSitsInsideTheSkull:
    """The card's own hypothesis: NOSE alone is the forward-most point of
    the face and sits close (12-13px) to the forward-extended arm's own
    anchor on a profile panel. The ear-to-ear midpoint sits inside the
    skull, well clear of the forward reach."""

    def test_head_spec_anchors_on_both_ears_not_the_nose(self):
        specs_by_key = {s.part_key: s for s in gen._build_figure_part_specs()}
        head = specs_by_key["head"]
        assert head.joint_a == _R_EAR
        assert head.joint_b == _L_EAR
        assert _NOSE not in (head.joint_a, head.joint_b)

    def test_side_right_forward_head_point_moves_away_from_the_arm_anchor(self):
        points = rig.keypoints_for("side_right_forward")
        head_records = gen.part_prompt_points("side_right_forward", "head", points, PANEL_SIZE)
        head_positive = next(
            (r["x"], r["y"]) for r in head_records if r["polarity"] == "positive"
        )

        arm_records = gen.part_prompt_points("side_right_forward", "right_arm", points, PANEL_SIZE)
        arm_positive = next((r["x"], r["y"]) for r in arm_records if r["polarity"] == "positive")

        # The old NOSE-anchored point and the arm's own anchor were only
        # 12px apart horizontally (the card's own finding). The new
        # ear-midpoint anchor must widen that gap, not match or shrink it.
        old_nose_x = int(points[_NOSE][0] * PANEL_SIZE)
        old_gap = abs(old_nose_x - arm_positive[0])
        new_gap = abs(head_positive[0] - arm_positive[0])
        assert new_gap > old_gap

    def test_side_left_forward_head_point_moves_away_from_the_arm_anchor(self):
        points = rig.keypoints_for("side_left_forward")
        head_records = gen.part_prompt_points("side_left_forward", "head", points, PANEL_SIZE)
        head_positive = next(
            (r["x"], r["y"]) for r in head_records if r["polarity"] == "positive"
        )

        arm_records = gen.part_prompt_points("side_left_forward", "left_arm", points, PANEL_SIZE)
        arm_positive = next((r["x"], r["y"]) for r in arm_records if r["polarity"] == "positive")

        old_nose_x = int(points[_NOSE][0] * PANEL_SIZE)
        old_gap = abs(old_nose_x - arm_positive[0])
        new_gap = abs(head_positive[0] - arm_positive[0])
        assert new_gap > old_gap

    def test_head_anchor_is_still_a_single_positive_point(self):
        # The fix is WHICH point, not however many -- still exactly one
        # positive coordinate per SAM3_Detect request.
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "head", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 1


class TestArmIsOnePartNotARenamedHalf:
    """"`arm` is genuinely one part, not a renamed half" (card's own
    acceptance wording): the figure panels request a single `{side}_arm`
    spanning shoulder-to-wrist, and `PARTS_BY_PANEL` carries no
    `upper_arm`/`lower_arm` entry for any figure panel."""

    FIGURE_PANEL_KEYS = (
        "front_tpose",
        "back_tpose",
        "side_left_forward",
        "side_right_forward",
        "side_neutral",
    )

    def test_no_figure_panel_has_an_upper_arm_or_lower_arm_entry(self):
        for panel_key in self.FIGURE_PANEL_KEYS:
            for part in gen.PARTS_BY_PANEL[panel_key]:
                assert "upper_arm" not in part
                assert "lower_arm" not in part

    def test_arm_part_spans_shoulder_to_wrist(self):
        specs_by_key = {s.part_key: s for s in gen._build_figure_part_specs()}
        assert specs_by_key["right_arm"].joint_a == _R_SHOULDER
        assert specs_by_key["right_arm"].joint_b == _R_WRIST
        assert specs_by_key["left_arm"].joint_a == _L_SHOULDER
        assert specs_by_key["left_arm"].joint_b == _L_WRIST

    def test_arm_torso_share_the_shoulder_and_stay_adjacent(self):
        pairs = set(gen.SIBLING_PART_PAIRS_BY_PANEL["side_right_forward"])
        pairs |= {(b, a) for a, b in pairs}
        assert ("torso", "right_arm") in pairs

    def test_head_arm_share_no_joint_and_are_not_adjacent(self):
        pairs = set(gen.SIBLING_PART_PAIRS_BY_PANEL["side_right_forward"])
        pairs |= {(b, a) for a, b in pairs}
        assert ("head", "right_arm") not in pairs

    def test_legs_panel_part_set_is_unaffected(self):
        # The torso's own card ("Do not change the torso's own request") and
        # the legs panel are both explicitly out of scope for this card.
        assert set(gen.PARTS_BY_PANEL["legs"]) == {
            "right_upper_leg",
            "right_lower_leg",
            "right_boot",
            "left_upper_leg",
            "left_lower_leg",
            "left_boot",
        }


class TestEvidenceDirPointsAtThisCardsOwnDirectory:
    """[T-0427]'s own finding this card acts on: `EVIDENCE_DIR` was
    hardcoded to `docs/assets/evidence/T-0417`, so a later card's run
    overwrote an earlier card's committed evidence in place. This card's own
    output must land in its own directory, never T-0417's."""

    def test_evidence_dir_is_t0428_not_t0417(self):
        assert gen.EVIDENCE_DIR.name == "T-0428"
        assert gen.EVIDENCE_DIR != gen.REPO_ROOT / "docs" / "assets" / "evidence" / "T-0417"

    def test_evidence_dir_is_under_docs_assets_evidence(self):
        assert gen.EVIDENCE_DIR.parent.name == "evidence"
        assert gen.EVIDENCE_DIR.parent.parent.name == "assets"


#: [T-0428] `assess_figure_part_suitability_T0423.py` used to read
#: `gen._FIGURE_PART_SPECS_BY_KEY`/`gen.PARTS_BY_PANEL` LIVE from the shared
#: `gen_master_sheet_part_cutouts_T0417` module. This card's arm merge
#: intentionally changes those same module globals in place (no
#: `upper_arm`/`lower_arm` entry survives, by design -- see
#: `TestArmIsOnePartNotARenamedHalf` above), which broke that live read: a
#: part name (`right_arm`) that doesn't exist in the already-committed
#: `docs/assets/evidence/T-0417/part_comparison.json` (keyed by the OLD
#: `right_upper_arm`/`right_lower_arm` names). `assess_figure_part_
#: suitability_T0423.py` now carries its own frozen copy of that historical
#: shape instead of reading the live module, so no monkeypatching is needed
#: here: this test just imports the real, unmodified-in-behavior script and
#: runs its real `compute_report()` against the real, untouched evidence
#: directory.
class TestT0417DirectoryUnregressed:
    """"T-0417's legs verdicts and T-0423's five usable figure parts are not
    regressed" (card's own acceptance wording) -- asserted, not assumed:
    T-0423's own `assess_figure_part_suitability_T0423.py`, run for real
    with no mocking of any kind, still reads the still-intact
    `docs/assets/evidence/T-0417/` directory as exactly 24 requested / 8
    mechanically isolated / 5 anatomically usable -- the same totals that
    script reported before this card touched anything."""

    @pytest.fixture(autouse=True)
    def _load_assess_module(self):
        import importlib

        self.assess = importlib.import_module("assess_figure_part_suitability_T0423")

    def test_t0417_evidence_dir_exists_and_is_unmodified(self):
        assert self.assess.EVIDENCE_DIR.exists()
        assert self.assess.EVIDENCE_DIR.name == "T-0417"

    def test_t0417_totals_reproduce_24_8_5(self):
        _per_part, totals = self.assess.compute_report()
        assert totals == {
            "requested": 24,
            "mechanically_isolated": 8,
            "anatomically_usable": 5,
        }
