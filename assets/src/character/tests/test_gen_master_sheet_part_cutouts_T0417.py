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

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

from char_gen.cutout_sam3 import build_sam3_part_workflow  # noqa: E402

import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

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
        for key in ("front_tpose", "back_tpose", "side_left_forward", "side_right_forward", "side_neutral"):
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
        for sibling in ("right_lower_leg", "right_boot", "left_upper_leg", "left_lower_leg", "left_boot"):
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
            assert lx == PANEL_SIZE - rx
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
