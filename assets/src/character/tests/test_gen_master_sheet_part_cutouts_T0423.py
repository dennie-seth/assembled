"""Figure-panel per-part SAM3 cutouts (T-0423): head, torso/coat and both
arms from the five whole-figure panels (front_tpose, back_tpose,
side_left_forward, side_right_forward, side_neutral), extending T-0417's
already panel-agnostic per-part machinery to the panels T-0338's own
part-to-joint chain actually names -- "upper arm, lower arm+hand, ... head,
torso/coat". T-0417 proved the mechanism on "legs" only; this module adds
`_build_figure_part_specs()` beside `_build_legs_part_specs()`, extends
`PARTS_BY_PANEL`/`SIBLING_PART_PAIRS_BY_PANEL` with explicit per-panel part
sets, and replaces the `_LEGS_ONLY_PANEL_KEYS` special-cased negative point
with a per-panel rule.

RED state: `gen_master_sheet_part_cutouts_T0417` does not yet export
`_build_figure_part_specs`, and `PARTS_BY_PANEL` has no entries for the five
figure panels -> AttributeError / assertion failures below.

All tests here run fully offline: no ComfyUI, no GPU -- same structural-only
shape as T-0417's own test module.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

from char_gen.cutout_sam3 import build_sam3_part_workflow  # noqa: E402

PANEL_SIZE = gen.PANEL_SIZE

FIGURE_PANEL_KEYS = (
    "front_tpose",
    "back_tpose",
    "side_left_forward",
    "side_right_forward",
    "side_neutral",
)

# COCO-18 indices, same numbering as pose_rig_master_sheet_T0351.py.
_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _L_HIP = 8, 11


class _StubComfyClient:
    """Reused from T-0417's own test module -- minimal stand-in for
    `ComfyUIClient`'s `submit`/`wait_for_completion`/`fetch_output` surface,
    enough to drive the production `_make_part_sam3_runner` closure for
    real, offline, with no network."""

    def __init__(self):
        self.submitted_workflows: list[dict] = []

    def submit(self, workflow: dict) -> str:
        self.submitted_workflows.append(workflow)
        return f"job-{len(self.submitted_workflows)}"

    def wait_for_completion(self, job_id: str, timeout: float = 60.0) -> dict:
        return {"job_id": job_id}

    def fetch_output(self, result: dict) -> bytes:
        import io

        from PIL import Image

        arr = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=np.uint8)
        arr[0:4, 0:4] = 255
        buf = io.BytesIO()
        Image.fromarray(arr, mode="L").save(buf, format="PNG")
        return buf.getvalue()


class TestPartsByPanelExplicitPerFigurePanel:
    """"The part set per panel is explicit -- a side panel does not claim
    parts it cannot show" (card's own acceptance wording). front/back
    T-pose show both arms; the three profile panels (side_left_forward,
    side_right_forward, side_neutral) only show their own near-side arm --
    the far arm is held back close to the body and is not requested."""

    def test_front_tpose_has_head_torso_and_both_arms(self):
        parts = gen.PARTS_BY_PANEL["front_tpose"]
        assert set(parts) == {
            "head",
            "torso",
            "right_upper_arm",
            "right_lower_arm",
            "left_upper_arm",
            "left_lower_arm",
        }

    def test_back_tpose_has_the_same_set_as_front_tpose(self):
        # Both T-pose panels show both arms spread clear of the torso --
        # see TestBackTposeHandednessConvention below for why this is also
        # geometrically identical, not just set-equal.
        assert set(gen.PARTS_BY_PANEL["back_tpose"]) == set(gen.PARTS_BY_PANEL["front_tpose"])

    def test_side_right_forward_excludes_the_far_left_arm(self):
        parts = gen.PARTS_BY_PANEL["side_right_forward"]
        assert set(parts) == {"head", "torso", "right_upper_arm", "right_lower_arm"}
        assert "left_upper_arm" not in parts
        assert "left_lower_arm" not in parts

    def test_side_left_forward_excludes_the_far_right_arm(self):
        parts = gen.PARTS_BY_PANEL["side_left_forward"]
        assert set(parts) == {"head", "torso", "left_upper_arm", "left_lower_arm"}
        assert "right_upper_arm" not in parts
        assert "right_lower_arm" not in parts

    def test_side_neutral_uses_the_same_near_side_as_side_right_forward(self):
        # side_neutral's own head keypoints (pose_rig_master_sheet_T0351)
        # are copied verbatim from side_right_forward's -- same camera
        # direction, same near/right-side-visible convention.
        points_neutral = rig.keypoints_for("side_neutral")
        points_right_forward = rig.keypoints_for("side_right_forward")
        for idx in (14, 15, 16, 17):  # R_EYE, L_EYE, R_EAR, L_EAR
            assert points_neutral[idx] == points_right_forward[idx]
        parts = gen.PARTS_BY_PANEL["side_neutral"]
        assert set(parts) == {"head", "torso", "right_upper_arm", "right_lower_arm"}

    def test_legs_panel_part_set_is_unchanged_by_this_card(self):
        assert set(gen.PARTS_BY_PANEL["legs"]) == {
            "right_upper_leg",
            "right_lower_leg",
            "right_boot",
            "left_upper_leg",
            "left_lower_leg",
            "left_boot",
        }

    def test_requesting_a_part_the_panel_cannot_show_raises(self):
        import pytest

        points = rig.keypoints_for("side_right_forward")
        with pytest.raises(ValueError):
            gen.part_prompt_points("side_right_forward", "left_upper_arm", points, PANEL_SIZE)


class TestBuildFigurePartSpecs:
    """`_build_figure_part_specs()` beside `_build_legs_part_specs()` --
    one rule generated for both sides (arms), plus the two single/derived-
    anchor parts (head, torso) -- never six independently hand-typed specs."""

    def test_returns_six_bounded_parts(self):
        specs = gen._build_figure_part_specs()
        keys = {s.part_key for s in specs}
        assert keys == {
            "head",
            "torso",
            "right_upper_arm",
            "right_lower_arm",
            "left_upper_arm",
            "left_lower_arm",
        }
        assert len(specs) == len(keys)  # no duplicates

    def test_head_anchors_on_nose(self):
        specs_by_key = {s.part_key: s for s in gen._build_figure_part_specs()}
        head = specs_by_key["head"]
        assert head.joint_a == _NOSE
        assert head.joint_b is None

    def test_upper_arm_anchors_on_shoulder_elbow_midpoint_per_side(self):
        specs_by_key = {s.part_key: s for s in gen._build_figure_part_specs()}
        assert specs_by_key["right_upper_arm"].joint_a == _R_SHOULDER
        assert specs_by_key["right_upper_arm"].joint_b == _R_ELBOW
        assert specs_by_key["left_upper_arm"].joint_a == _L_SHOULDER
        assert specs_by_key["left_upper_arm"].joint_b == _L_ELBOW

    def test_lower_arm_anchors_on_elbow_wrist_midpoint_per_side(self):
        specs_by_key = {s.part_key: s for s in gen._build_figure_part_specs()}
        assert specs_by_key["right_lower_arm"].joint_a == _R_ELBOW
        assert specs_by_key["right_lower_arm"].joint_b == _R_WRIST
        assert specs_by_key["left_lower_arm"].joint_a == _L_ELBOW
        assert specs_by_key["left_lower_arm"].joint_b == _L_WRIST

    def test_bounded_not_a_sweep_the_set_is_fixed_across_calls(self):
        first = gen._build_figure_part_specs()
        second = gen._build_figure_part_specs()
        assert first == second


class TestTorsoAnchorDesignDecision:
    """The one real design decision this card calls out up front: the torso
    doesn't fit PartSpec's one-or-two-joint anchor cleanly -- its natural
    anchor is NECK to the *hip midpoint*, itself a midpoint of
    `_R_HIP`/`_L_HIP`. Resolved by extending `PartSpec` with a third,
    explicitly-named derived-anchor field (`joint_b_pair`): when set, the
    part's anchor is `midpoint(joint_a, midpoint(*joint_b_pair))` --
    anchoring NECK to the true hip midpoint rather than approximating it
    with a single hip joint or leaving it unstated."""

    def test_torso_spec_uses_neck_and_the_hip_midpoint_pair(self):
        specs_by_key = {s.part_key: s for s in gen._build_figure_part_specs()}
        torso = specs_by_key["torso"]
        assert torso.joint_a == _NECK
        assert torso.joint_b is None
        assert torso.joint_b_pair == (_L_HIP, _R_HIP) or torso.joint_b_pair == (_R_HIP, _L_HIP)

    def test_torso_midpoint_anchor_is_still_the_middle_of_t0427s_positive_run(self):
        # [T-0427] T-0423's own evidence found this single point measured
        # an EMPTY detection on both T-pose panels -- the torso's positive
        # set is now a three-point run down its own centerline
        # (`_TORSO_POSITIVE_RUN_FRACTIONS`, see
        # tests/test_gen_master_sheet_part_cutouts_T0427.py for the full
        # pin), not one point. This design decision's own midpoint-of-
        # midpoint derivation is unchanged and still present -- as the
        # t=0.5 MIDDLE point of that run, not discarded.
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 3

        neck_x, neck_y = points[_NECK]
        r_hip_x, r_hip_y = points[_R_HIP]
        l_hip_x, l_hip_y = points[_L_HIP]
        hip_mid_x, hip_mid_y = (r_hip_x + l_hip_x) / 2.0, (r_hip_y + l_hip_y) / 2.0
        expected_x = int((neck_x + hip_mid_x) / 2.0 * PANEL_SIZE)
        expected_y = int((neck_y + hip_mid_y) / 2.0 * PANEL_SIZE)
        assert (expected_x, expected_y) in {(p["x"], p["y"]) for p in positives}

    def test_torso_anchor_sits_between_neck_and_hips_not_on_either(self):
        # The derived anchor must not collapse onto NECK alone or onto
        # either hip alone -- it's a genuine midpoint-of-a-midpoint.
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        positive = next((r["x"], r["y"]) for r in records if r["polarity"] == "positive")
        neck_px = (
            int(points[_NECK][0] * PANEL_SIZE),
            int(points[_NECK][1] * PANEL_SIZE),
        )
        r_hip_px = (
            int(points[_R_HIP][0] * PANEL_SIZE),
            int(points[_R_HIP][1] * PANEL_SIZE),
        )
        assert positive != neck_px
        assert positive != r_hip_px
        assert neck_px[1] < positive[1] < r_hip_px[1]


class TestNonPartNegativePointsPerPanel:
    """The `_LEGS_ONLY_PANEL_KEYS` special case (T-0417, ~:248) generalized
    into a per-panel rule: "legs" still gets its own NECK collapse-point
    negative (not real anatomy on that waist-down crop, unchanged), and each
    figure panel gets its own rule -- both ANKLE points as negatives, since
    legs ARE real anatomy on a figure panel but are not one of this card's
    parts (head/torso/arms only). Both rules exist side by side, keyed by
    panel, never a branch on one frozen set."""

    def test_legs_panel_negative_rule_is_unchanged(self):
        points = rig.keypoints_for("legs")
        records = gen.part_prompt_points("legs", "right_boot", points, PANEL_SIZE)
        negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
        neck_x, neck_y = points[_NECK]
        assert (int(neck_x * PANEL_SIZE), int(neck_y * PANEL_SIZE)) in negatives

    def test_figure_panel_includes_both_ankles_as_negatives(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "head", points, PANEL_SIZE)
        negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
        r_ankle_idx, l_ankle_idx = 10, 13
        r_ankle_px = (
            int(points[r_ankle_idx][0] * PANEL_SIZE),
            int(points[r_ankle_idx][1] * PANEL_SIZE),
        )
        l_ankle_px = (
            int(points[l_ankle_idx][0] * PANEL_SIZE),
            int(points[l_ankle_idx][1] * PANEL_SIZE),
        )
        assert r_ankle_px in negatives
        assert l_ankle_px in negatives

    def test_figure_panel_never_adds_the_legs_only_neck_collapse_point(self):
        # The legs panel's own collapse-point derivation text must not leak
        # onto a figure panel -- a figure panel's NECK is real anatomy (the
        # torso's own anchor uses it) and must never be marked as a
        # negative "collapse point".
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "head", points, PANEL_SIZE)
        for r in records:
            assert "collapse_point" not in r["derivation"]

    def test_every_figure_panel_has_its_own_stated_negative_rule(self):
        for panel_key in FIGURE_PANEL_KEYS:
            points = rig.keypoints_for(panel_key)
            any_part = gen.PARTS_BY_PANEL[panel_key][0]
            records = gen.part_prompt_points(panel_key, any_part, points, PANEL_SIZE)
            negative_derivations = [r["derivation"] for r in records if r["polarity"] == "negative"]
            assert any("not decomposed" in d for d in negative_derivations)


class TestBackTposeHandednessConvention:
    """"back_tpose left/right handedness -- the rig's left is the viewer's
    right on a back view. State the convention and assert it, so a mirrored
    part is not silently mislabelled." `pose_rig_master_sheet_T0351`'s own
    module docstring states the resolution for a T-pose specifically:
    `front_tpose` is bilaterally symmetric, so mirroring it (`back_tpose =
    mirror_keypoints_lr(front_tpose)`) lands on the SAME pixel positions --
    front and back T-pose are not different topologies, and the only thing
    that distinguishes them is the prompt text. This module therefore
    applies the SAME joint-index -> part-key convention to both panels
    (no extra mirroring branch); this test pins that invariant explicitly
    rather than leaving it to be discovered by a silently-mislabelled part
    on some future, asymmetric back-view rig."""

    def test_front_and_back_tpose_keypoints_are_numerically_identical(self):
        # Within float round-trip tolerance of a double x -> 1-x -> 1-(1-x)
        # mirror, not bit-identical -- mirror_keypoints_lr flips x twice
        # (once per mirrored pair member) to get from front to back.
        front = rig.keypoints_for("front_tpose")
        back = rig.keypoints_for("back_tpose")
        assert front.keys() == back.keys()
        for idx in front:
            assert front[idx] == pytest.approx(back[idx])

    def test_front_and_back_tpose_produce_identical_part_anchors(self):
        front_points = rig.keypoints_for("front_tpose")
        back_points = rig.keypoints_for("back_tpose")
        for part_key in gen.PARTS_BY_PANEL["front_tpose"]:
            front_records = gen.part_prompt_points(
                "front_tpose", part_key, front_points, PANEL_SIZE
            )
            back_records = gen.part_prompt_points("back_tpose", part_key, back_points, PANEL_SIZE)
            front_positive = next(
                (r["x"], r["y"]) for r in front_records if r["polarity"] == "positive"
            )
            back_positive = next(
                (r["x"], r["y"]) for r in back_records if r["polarity"] == "positive"
            )
            assert front_positive == back_positive


class TestSiblingPartPairsByPanelForFigurePanels:
    """Adjacent, joint-sharing pairs (head/torso at the neck, torso/upper
    arm at the shoulder, upper/lower arm at the elbow) get the 0.25
    joint-blur tolerance; every other pair (cross-side, or a pair with no
    shared joint) gets the zero non-adjacent tolerance via
    `_evaluate_overlaps`'s own general pairwise sweep -- this class only
    pins which pairs `SIBLING_PART_PAIRS_BY_PANEL` marks as adjacent."""

    def test_front_tpose_adjacency_covers_every_shared_joint(self):
        pairs = set(gen.SIBLING_PART_PAIRS_BY_PANEL["front_tpose"])
        expected = {
            ("head", "torso"),
            ("torso", "right_upper_arm"),
            ("torso", "left_upper_arm"),
            ("right_upper_arm", "right_lower_arm"),
            ("left_upper_arm", "left_lower_arm"),
        }
        assert expected <= pairs or expected <= {(b, a) for a, b in pairs}

    def test_cross_side_arms_are_not_marked_adjacent(self):
        pairs = set(gen.SIBLING_PART_PAIRS_BY_PANEL["front_tpose"])
        pairs |= {(b, a) for a, b in pairs}
        assert ("right_upper_arm", "left_upper_arm") not in pairs
        assert ("right_lower_arm", "left_lower_arm") not in pairs

    def test_side_right_forward_only_pairs_parts_it_actually_has(self):
        pairs = gen.SIBLING_PART_PAIRS_BY_PANEL["side_right_forward"]
        allowed = set(gen.PARTS_BY_PANEL["side_right_forward"])
        for a, b in pairs:
            assert a in allowed
            assert b in allowed


class TestSeparateSam3CallPerFigurePart:
    """Same structural proof T-0417 pins for the legs panel, reproduced for
    a figure panel: one separate `SAM3_Detect` graph per part, never one
    batched multi-point request."""

    def test_each_part_builds_its_own_single_positive_coord_graph(self):
        # [T-0427] "Single positive coord" no longer holds for `torso`
        # specifically -- its own request is now a three-point run down
        # its centerline (see test_gen_master_sheet_part_cutouts_T0427.py)
        # -- but every OTHER figure part still gets exactly one, and this
        # is still six separate graphs, never one shared request.
        points = rig.keypoints_for("front_tpose")
        model_loader = {"class_type": "FakeSam3Loader", "inputs": {}}
        graphs = {}
        for part_key in gen.PARTS_BY_PANEL["front_tpose"]:
            records = gen.part_prompt_points("front_tpose", part_key, points, PANEL_SIZE)
            positive_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "positive"
            ]
            negative_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "negative"
            ]
            graphs[part_key] = build_sam3_part_workflow(
                "panel_front_tpose.png",
                model_loader,
                positive_coords=positive_coords,
                negative_coords=negative_coords,
                filename_prefix=f"T0423_sam3_front_tpose_{part_key}",
            )

        assert len(graphs) == 6
        positive_sets = set()
        for part_key, graph in graphs.items():
            coords = json.loads(graph["3"]["inputs"]["positive_coords"])
            expected_len = 3 if part_key == "torso" else 1
            assert len(coords) == expected_len
            positive_sets.add(tuple(sorted((c["x"], c["y"]) for c in coords)))
        assert len(positive_sets) == 6

    def test_runner_invocations_are_six_separate_calls_not_one_combined_call(self):
        points = rig.keypoints_for("front_tpose")
        client = _StubComfyClient()

        for part_key in gen.PARTS_BY_PANEL["front_tpose"]:
            records = gen.part_prompt_points("front_tpose", part_key, points, PANEL_SIZE)
            positive_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "positive"
            ]
            negative_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "negative"
            ]
            runner = gen._make_part_sam3_runner(
                client,
                "panel_front_tpose.png",
                positive_coords,
                negative_coords,
                filename_prefix=f"T0423_sam3_front_tpose_{part_key}",
            )
            mask = runner()
            assert mask.shape == (PANEL_SIZE, PANEL_SIZE)

        assert len(client.submitted_workflows) == 6


class TestOverlapRejectionAppliesToFigurePanels:
    """"A regression proves two figure parts returning near-identical masks
    are both rejected, not both marked isolated" (card's own acceptance
    wording) -- the same all-pairs overlap machinery T-0417's FIX ROUND
    finding 3 made generic, reused unmodified for a figure panel."""

    def test_identical_cross_side_upper_arm_masks_are_rejected(self):
        mask = np.zeros((64, 64), dtype=bool)
        mask[10:40, 10:40] = True
        masks_by_part = {
            "right_upper_arm": mask.copy(),
            "left_upper_arm": mask.copy(),
        }
        overlaps = gen._evaluate_overlaps("front_tpose", masks_by_part)
        target = frozenset(("right_upper_arm", "left_upper_arm"))
        pair = next(o for o in overlaps if frozenset((o["part_a"], o["part_b"])) == target)
        assert pair["overlap_fraction"] == 1.0
        assert pair["exceeds_tolerance"] is True

        parts = {
            key: {
                "present": True,
                "isolated": True,
                "isolated_before_overlap": True,
                "overlap_exceeds_tolerance": False,
            }
            for key in masks_by_part
        }
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_arm"]["isolated"] is False
        assert updated["left_upper_arm"]["isolated"] is False

    def test_adjacent_torso_and_upper_arm_keep_the_joint_blur_tolerance(self):
        mask_a = np.zeros((64, 64), dtype=bool)
        mask_a[0:45, :] = True
        mask_b = np.zeros((64, 64), dtype=bool)
        mask_b[44:54, :] = True
        masks_by_part = {"torso": mask_a, "right_upper_arm": mask_b}
        overlaps = gen._evaluate_overlaps("front_tpose", masks_by_part)
        target = frozenset(("torso", "right_upper_arm"))
        pair = next(o for o in overlaps if frozenset((o["part_a"], o["part_b"])) == target)
        assert pair["tolerance"] == gen.PART_OVERLAP_FRACTION_TOLERANCE
        assert pair["exceeds_tolerance"] is False


class TestThermalGateRefusalIsRecordedNotCrashed:
    """[T-0423 FIX ROUND] Found running this card's own live evidence
    generation against the real ComfyUI host: the thermal gate (T-0422)
    raises `ThermalGateRefused` at `client.submit()`'s own choke point -- a
    plain `RuntimeError`, not one of the `ComfyClientError` subtypes
    (`SubmitError`/`ExecutionError`/`PollTimeoutError`)
    `_make_part_sam3_runner`'s own `_run()` closure already catches.
    Uncaught, it crashed the whole script with a bare traceback instead of
    going through the existing "SAM3 unavailable mid-run" recording path
    this card's own edge case says "applies unchanged" -- `main()` never
    got the chance to call `_record_mid_run_sam3_failure`, and a part
    already completed earlier in the same run was at risk of never being
    committed if the crash happened before that commit.

    This never touches or weakens the gate itself: `submit()` still
    refuses, no workflow is ever submitted to ComfyUI either way -- this
    only makes sure that refusal is RECORDED through the pre-existing
    driver-boundary path, not crashed on."""

    def test_thermal_gate_refusal_is_wrapped_as_sam3_unavailable(self):
        from comfy_client.thermal_gate import ThermalGateRefused

        class _ThermalRefusingClient:
            def submit(self, workflow):
                raise ThermalGateRefused(
                    "GPU temperature 75.0C is at or above the 75.0C ceiling"
                )

        runner = gen._make_part_sam3_runner(
            _ThermalRefusingClient(), "panel_front_tpose.png", [], [], filename_prefix="x"
        )
        with pytest.raises(gen.Sam3SegmentationUnavailable):
            runner()


class TestT0417RegressionUnaffected:
    """T-0417's own behaviour on the legs panel must not change: same six
    parts, same anchors, same negative rule, same overlap tolerances."""

    def test_legs_part_specs_unchanged(self):
        specs = gen._build_legs_part_specs()
        assert len(specs) == 6
        keys = {s.part_key for s in specs}
        assert keys == {
            "right_upper_leg",
            "right_lower_leg",
            "right_boot",
            "left_upper_leg",
            "left_lower_leg",
            "left_boot",
        }

    def test_legs_sibling_pairs_unchanged(self):
        pairs = set(gen.SIBLING_PART_PAIRS_BY_PANEL["legs"])
        assert pairs == {
            ("right_upper_leg", "right_lower_leg"),
            ("left_upper_leg", "left_lower_leg"),
            ("right_lower_leg", "right_boot"),
            ("left_lower_leg", "left_boot"),
        }
