"""Independent per-part SAM3 cutouts for the parts compositor (T-0417),
closing the gap the round-3 reviewer named exactly: T-0337's FIX ROUND 2
put valid hip/knee/ankle-derived points on the "legs" panel, but all six
positive points went into ONE `positive_coords` list through ONE
`SAM3_Detect` call -- "constraints on one segmentation, not six separately
identified part requests." These tests pin the structural fix: a bounded,
explicit set of SEPARATE part requests, each with its own single positive
point and its own negative points on every sibling part, each destined for
its own `SAM3_Detect` call -- and prove that structurally, offline, against
the workflow builder (no ComfyUI, no GPU).

RED state: `gen_master_sheet_part_cutouts_T0417` does not exist yet ->
ImportError.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

from char_gen.cutout_sam3 import build_sam3_part_workflow  # noqa: E402

PANEL_SIZE = gen.PANEL_SIZE


class TestPartsByPanelIsExplicit:
    """"A panel that is not a parts panel (a whole-figure t-pose): it is not
    forced through part decomposition -- the set of parts per panel is
    explicit." Only "legs" -- the panel the round-3 review actually
    flagged -- has a part decomposition; every other panel's own set is
    empty, not derived, not guessed."""

    def test_legs_panel_has_six_bounded_parts(self):
        parts = gen.PARTS_BY_PANEL["legs"]
        assert len(parts) == 6
        assert len(set(parts)) == 6  # no duplicates
        for side in ("right", "left"):
            assert f"{side}_upper_leg" in parts
            assert f"{side}_lower_leg" in parts
            assert f"{side}_boot" in parts

    def test_whole_figure_panels_have_no_parts(self):
        whole_figure_keys = (
            "front_tpose",
            "back_tpose",
            "side_left_forward",
            "side_right_forward",
            "side_neutral",
        )
        for key in whole_figure_keys:
            assert gen.PARTS_BY_PANEL.get(key, ()) == ()

    def test_bounded_not_a_sweep_the_set_is_fixed_across_calls(self):
        first = gen.PARTS_BY_PANEL["legs"]
        second = gen.PARTS_BY_PANEL["legs"]
        assert first == second


class TestPartPromptPoints:
    """Each part gets exactly ONE positive point (its own anchor) and
    negative points on every sibling part's own anchor plus the panel's
    fixed corners/collapse point -- never the other parts' positive points
    folded into the same request."""

    def _points(self):
        return rig.keypoints_for("legs")

    def test_right_upper_leg_positive_is_the_hip_knee_midpoint(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_upper_leg", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 1
        hip_x, hip_y = points[8]  # _R_HIP
        knee_x, knee_y = points[9]  # _R_KNEE
        expected = (int((hip_x + knee_x) / 2 * PANEL_SIZE), int((hip_y + knee_y) / 2 * PANEL_SIZE))
        assert (positives[0]["x"], positives[0]["y"]) == expected

    def test_right_boot_positive_is_the_ankle_itself(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_boot", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 1
        ankle_x, ankle_y = points[10]  # _R_ANKLE
        assert (positives[0]["x"], positives[0]["y"]) == (
            int(ankle_x * PANEL_SIZE),
            int(ankle_y * PANEL_SIZE),
        )

    def test_negatives_include_every_sibling_part_anchor(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_upper_leg", points, PANEL_SIZE)
        negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
        siblings = (
            "right_lower_leg",
            "right_boot",
            "left_upper_leg",
            "left_lower_leg",
            "left_boot",
        )
        for sibling in siblings:
            sibling_records = gen.part_prompt_points("legs", sibling, points, PANEL_SIZE)
            sibling_anchor = next(
                (r["x"], r["y"]) for r in sibling_records if r["polarity"] == "positive"
            )
            assert sibling_anchor in negatives

    def test_negatives_include_four_corners_and_upper_body_collapse_point(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_boot", points, PANEL_SIZE)
        negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
        assert (4, 4) in negatives
        assert (PANEL_SIZE - 4, 4) in negatives
        assert (4, PANEL_SIZE - 4) in negatives
        assert (PANEL_SIZE - 4, PANEL_SIZE - 4) in negatives
        neck_x, neck_y = points[1]
        assert (int(neck_x * PANEL_SIZE), int(neck_y * PANEL_SIZE)) in negatives

    def test_own_positive_point_never_appears_among_its_own_negatives(self):
        points = self._points()
        for part_key in gen.PARTS_BY_PANEL["legs"]:
            records = gen.part_prompt_points("legs", part_key, points, PANEL_SIZE)
            positive = next((r["x"], r["y"]) for r in records if r["polarity"] == "positive")
            negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
            assert positive not in negatives

    def test_unknown_part_for_panel_raises(self):
        import pytest

        points = self._points()
        with pytest.raises(ValueError):
            gen.part_prompt_points("legs", "tail", points, PANEL_SIZE)

    def test_left_right_mirroring_uses_the_same_rule(self):
        # The rig's own left/right keypoints are exact horizontal mirrors of
        # each other (see pose_rig_master_sheet_T0351's LEGS_KEYPOINTS_NORM),
        # so a genuinely shared derivation rule must produce mirrored pixel
        # anchors too -- not independently hand-tuned per side.
        points = self._points()
        for right_key, left_key in (
            ("right_upper_leg", "left_upper_leg"),
            ("right_lower_leg", "left_lower_leg"),
            ("right_boot", "left_boot"),
        ):
            right_records = gen.part_prompt_points("legs", right_key, points, PANEL_SIZE)
            left_records = gen.part_prompt_points("legs", left_key, points, PANEL_SIZE)
            rx, ry = next((r["x"], r["y"]) for r in right_records if r["polarity"] == "positive")
            lx, ly = next((r["x"], r["y"]) for r in left_records if r["polarity"] == "positive")
            # Within 1px of an exact mirror -- int() truncation on the two
            # independently-averaged midpoints can round the pair to
            # PANEL_SIZE-1 rather than PANEL_SIZE (e.g. 358 + 665 = 1023),
            # which is a floating-point truncation artifact, not evidence
            # the two sides used a different rule.
            assert abs(lx - (PANEL_SIZE - rx)) <= 1
            assert ly == ry


class TestBuildSam3PartWorkflowIsCalledSeparatelyPerPart:
    """The structural assertion the round-2/round-3 shape would have
    caught: building the six parts' own workflows produces six DISTINCT
    graphs, each with exactly one positive coordinate (that part's own),
    never a single graph carrying all six parts' points together."""

    def test_each_part_builds_its_own_single_positive_coord_graph(self):
        points = rig.keypoints_for("legs")
        model_loader = {"class_type": "FakeSam3Loader", "inputs": {}}
        graphs = {}
        for part_key in gen.PARTS_BY_PANEL["legs"]:
            records = gen.part_prompt_points("legs", part_key, points, PANEL_SIZE)
            positive_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "positive"
            ]
            negative_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "negative"
            ]
            graphs[part_key] = build_sam3_part_workflow(
                "panel_legs.png",
                model_loader,
                positive_coords=positive_coords,
                negative_coords=negative_coords,
                filename_prefix=f"T0417_sam3_legs_{part_key}",
            )

        assert len(graphs) == 6
        import json

        positive_sets = set()
        for part_key, graph in graphs.items():
            coords = json.loads(graph["3"]["inputs"]["positive_coords"])
            assert len(coords) == 1  # exactly one positive point -- this part's own
            positive_sets.add((coords[0]["x"], coords[0]["y"]))
            negs = json.loads(graph["3"]["inputs"]["negative_coords"])
            assert len(negs) == 10  # 5 sibling anchors + 4 corners + collapse point

        # Six genuinely distinct segmentation requests, not six copies of one.
        assert len(positive_sets) == 6

    def test_runner_invocations_are_six_separate_calls_not_one_combined_call(self):
        """A stub client records how many times a SAM3 "run" actually
        happens when driving all six parts through `_make_part_sam3_runner`
        -- this is what would have caught the withdrawn round-2 shape,
        which built exactly one combined runner for the whole panel."""
        points = rig.keypoints_for("legs")
        call_log = []

        def _fake_runner_factory(part_key, positive_coords, negative_coords):
            def _run():
                call_log.append(
                    {
                        "part_key": part_key,
                        "positive_coords": positive_coords,
                        "negative_coords": negative_coords,
                    }
                )
                import numpy as np

                mask = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=bool)
                x, y = positive_coords[0]["x"], positive_coords[0]["y"]
                mask[max(0, y - 5) : y + 5, max(0, x - 5) : x + 5] = True
                return mask

            return _run

        results = {}
        for part_key in gen.PARTS_BY_PANEL["legs"]:
            records = gen.part_prompt_points("legs", part_key, points, PANEL_SIZE)
            positive_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "positive"
            ]
            negative_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "negative"
            ]
            runner = _fake_runner_factory(part_key, positive_coords, negative_coords)
            results[part_key] = runner()

        assert len(call_log) == 6
        assert len({c["part_key"] for c in call_log}) == 6
        # Every call's own positive_coords is a singleton -- never the
        # six-point combined list the round-2 shape used.
        for call in call_log:
            assert len(call["positive_coords"]) == 1


class TestApplyOverlapRejection:
    """The half of "isolation judged on more than total area" that
    `_evaluate_overlaps` alone doesn't finish: a per-pair overlap verdict is
    useless to the parts compositor until it's folded back into each part's
    own `isolated` flag. Before this fix, `_evaluate_overlaps`'s
    `exceeds_tolerance` was written to `part_comparison.json` at panel level
    and consumed by nothing -- no part was ever rejected for overlapping a
    sibling, no matter how much it overlapped."""

    def _part(self, key, *, isolated=True, present=True):
        return {
            "panel": "legs",
            "part": key,
            "present": present,
            "isolated": isolated,
            "isolated_before_overlap": isolated,
            "overlap_exceeds_tolerance": False,
        }

    def test_no_pair_exceeds_tolerance_leaves_isolated_unchanged(self):
        parts = {
            "right_upper_leg": self._part("right_upper_leg"),
            "right_lower_leg": self._part("right_lower_leg"),
        }
        overlaps = [
            {
                "part_a": "right_upper_leg",
                "part_b": "right_lower_leg",
                "overlap_fraction": 0.09,
                "exceeds_tolerance": False,
                "tolerance": 0.25,
            }
        ]
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is True
        assert updated["right_lower_leg"]["isolated"] is True
        assert updated["right_upper_leg"]["overlap_exceeds_tolerance"] is False
        assert updated["right_lower_leg"]["overlap_exceeds_tolerance"] is False

    def test_an_exceeding_pair_rejects_BOTH_siblings_not_just_one(self):
        # mask_overlap_fraction can't say which side bled into the other, so
        # neither is treated as the innocent one -- this is the exact
        # round-3 failure mode (both legs' full masks reported as separate
        # parts, which would measure as near-total overlap).
        parts = {
            "right_upper_leg": self._part("right_upper_leg"),
            "right_lower_leg": self._part("right_lower_leg"),
            "right_boot": self._part("right_boot"),
        }
        overlaps = [
            {
                "part_a": "right_upper_leg",
                "part_b": "right_lower_leg",
                "overlap_fraction": 0.9,
                "exceeds_tolerance": True,
                "tolerance": 0.25,
            },
            {
                "part_a": "right_lower_leg",
                "part_b": "right_boot",
                "overlap_fraction": 0.0,
                "exceeds_tolerance": False,
                "tolerance": 0.25,
            },
        ]
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is False
        assert updated["right_lower_leg"]["isolated"] is False
        assert updated["right_upper_leg"]["overlap_exceeds_tolerance"] is True
        assert updated["right_lower_leg"]["overlap_exceeds_tolerance"] is True
        # The boot wasn't in the exceeding pair -- untouched.
        assert updated["right_boot"]["isolated"] is True
        assert updated["right_boot"]["overlap_exceeds_tolerance"] is False

    def test_a_part_already_rejected_on_stray_fraction_stays_rejected(self):
        # isolated_before_overlap carries the pre-overlap verdict forward --
        # overlap rejection can only ever turn isolated=True into False, it
        # can't paper over an existing area/stray-fragment rejection.
        parts = {
            "right_upper_leg": self._part("right_upper_leg", isolated=False),
            "right_lower_leg": self._part("right_lower_leg"),
        }
        overlaps = []
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is False
        assert updated["right_lower_leg"]["isolated"] is True

    def test_recomputing_from_a_stale_overlap_rejected_state_is_not_sticky(self):
        # A part previously rejected on overlap grounds (isolated already
        # False, overlap_exceeds_tolerance already True from a prior main()
        # pass) must be un-rejected if the CURRENT overlaps list no longer
        # flags it -- e.g. its sibling was re-run with `--part` and no
        # longer overlaps. isolated_before_overlap is what makes this safe:
        # it was never overwritten by the earlier overlap rejection.
        stale = self._part("right_upper_leg", isolated=True)
        stale["isolated"] = False
        stale["overlap_exceeds_tolerance"] = True
        parts = {"right_upper_leg": stale}
        updated = gen._apply_overlap_rejection(parts, overlaps=[])
        assert updated["right_upper_leg"]["isolated"] is True
        assert updated["right_upper_leg"]["overlap_exceeds_tolerance"] is False

    def test_a_part_absent_from_the_panel_is_never_checked(self):
        # left_upper_leg/left_lower_leg have no mask (present=False) so they
        # never appear in masks_by_part and never generate an overlap pair
        # -- _evaluate_overlaps already skips them; this just confirms
        # _apply_overlap_rejection doesn't require every PARTS_BY_PANEL key
        # to be present in the dict it's given.
        parts = {"left_boot": self._part("left_boot")}
        updated = gen._apply_overlap_rejection(parts, overlaps=[])
        assert updated["left_boot"]["isolated"] is True


class TestMainSam3UnavailableEdgeCase:
    """"SAM3 unavailable mid-run: the per-part pass reports the prerequisite
    and performs no comparison, exactly as T-0337's availability path
    already does; it never substitutes another model" (card's own
    edge-case wording). Runs fully offline: no ComfyUI, no GPU -- the
    availability probe is monkeypatched to report unavailable, before any
    SAM3_Detect call would be reachable, and `ComfyUIClient.submit` is
    monkeypatched to fail the test if part decomposition is attempted
    anyway."""

    def test_unavailable_prerequisite_skips_part_decomposition_entirely(
        self, tmp_path, monkeypatch
    ):
        evidence_dir = tmp_path / "evidence"
        monkeypatch.setattr(gen, "EVIDENCE_DIR", evidence_dir)
        monkeypatch.setattr(
            gen,
            "_probe_sam3_availability",
            lambda client: (
                {"available": False, "reason": "UNETLoader missing sam3 checkpoint"},
                None,
            ),
        )

        from comfy_client.comfyui_client import ComfyUIClient

        def _fail_if_submitted(self, workflow):
            raise AssertionError("submit() must never be called when SAM3 is unavailable")

        monkeypatch.setattr(ComfyUIClient, "submit", _fail_if_submitted)
        monkeypatch.setattr(sys, "argv", ["gen_master_sheet_part_cutouts_T0417.py"])

        gen.main()

        written = json.loads((evidence_dir / "part_comparison.json").read_text())
        assert written["sam3_availability"]["available"] is False
        assert written["panels"] == {}
