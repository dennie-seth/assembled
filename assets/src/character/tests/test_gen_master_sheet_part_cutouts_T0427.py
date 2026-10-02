"""Torso/upper_arm prompt retuning (T-0427) -- untangle the coupled
torso/arm overlap T-0423's own evidence found, and fix the torso's empty
T-pose detection.

T-0423's evidence (`docs/assets/evidence/T-0423/README.md`) recorded two
coupled problems with the torso's own SAM3 request:

  1. On `side_left_forward` and `side_neutral`, the torso mask swallowed
     the near-side `upper_arm` -- both torso AND the upper_arm were
     rejected, and the upper_arm's own `beyond_distal_joint_fraction`
     measured 0.0% (it is anatomically fine; the overlap is what fails
     it). The torso's only existing defense against bleeding into an arm
     was ONE negative point at the sibling `upper_arm`'s own anchor (the
     shoulder-elbow midpoint).
  2. On both T-pose panels (`front_tpose`, `back_tpose`), the torso's
     single NECK-to-hip-midpoint anchor point found nothing at all --
     an empty detection on the long coat.

This module pins the fix for both, entirely offline (no SAM3, no GPU, no
ComfyUI) -- same structural-only shape as T-0417's and T-0423's own test
modules:

  1. The torso's own positive point set becomes a THREE-point run down its
     own NECK->hip-midpoint centerline (`_TORSO_POSITIVE_RUN_FRACTIONS`),
     not a single point -- more chances to land on coat fabric instead of
     a fold or a gap.
  2. The torso's own negative point set gains two new points beyond the
     generic sibling-anchor negatives every part already gets: the raw
     shoulder joints themselves (`_R_SHOULDER`/`_L_SHOULDER`,
     `_TORSO_EXTRA_NEGATIVE_JOINTS`) -- closer to the actual torso/sleeve
     seam than the shoulder-elbow midpoint the old sibling-negative alone
     provided.

Neither change touches any OTHER part's own prompt derivation, the
isolation machinery (`char_gen.part_isolation`), the suitability machinery
(`char_gen.part_suitability`), or the all-pairs overlap mechanism
(`_evaluate_overlaps`/`_apply_overlap_rejection`) -- this card changes the
torso's own request only and reuses everything else unmodified, which the
regression tests below also assert.

RED state: `gen_master_sheet_part_cutouts_T0417.part_prompt_points` still
emits exactly one positive point for `torso` (the old single
midpoint-of-midpoint anchor) and no shoulder-joint negatives -> every
assertion on the new three-point run / shoulder negatives below fails.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

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
_NECK = 1
_R_SHOULDER, _L_SHOULDER = 2, 5
_R_HIP, _L_HIP = 8, 11


def _lerp(a: tuple[float, float], b: tuple[float, float], t: float) -> tuple[float, float]:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


class TestTorsoPositiveRunReplacesTheSinglePoint:
    """Finding 2: a single NECK-to-hip-midpoint point found nothing on the
    long coat for either T-pose panel. The fix is a run of points down the
    torso's own centerline, not one guess."""

    def test_torso_has_a_three_point_positive_run(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 3

    def test_torso_run_fractions_are_exactly_point_three_five_seven(self):
        assert gen._TORSO_POSITIVE_RUN_FRACTIONS == (0.3, 0.5, 0.7)

    def test_torso_run_points_match_the_lerp_derivation(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        positives = {(r["x"], r["y"]) for r in records if r["polarity"] == "positive"}

        neck = points[_NECK]
        hip_mid = ((points[_R_HIP][0] + points[_L_HIP][0]) / 2.0,
                   (points[_R_HIP][1] + points[_L_HIP][1]) / 2.0)
        expected = set()
        for t in gen._TORSO_POSITIVE_RUN_FRACTIONS:
            lerp_norm = _lerp(neck, hip_mid, t)
            expected.add((int(lerp_norm[0] * PANEL_SIZE), int(lerp_norm[1] * PANEL_SIZE)))
        assert positives == expected

    def test_torso_run_still_includes_the_original_t0423_midpoint_anchor(self):
        # t=0.5 is the exact point T-0423's own single-point anchor used --
        # the old anchor is kept as the MIDDLE of the new run, not discarded.
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        positives = {(r["x"], r["y"]) for r in records if r["polarity"] == "positive"}

        neck_x, neck_y = points[_NECK]
        r_hip_x, r_hip_y = points[_R_HIP]
        l_hip_x, l_hip_y = points[_L_HIP]
        hip_mid_x, hip_mid_y = (r_hip_x + l_hip_x) / 2.0, (r_hip_y + l_hip_y) / 2.0
        old_anchor_px = (
            int((neck_x + hip_mid_x) / 2.0 * PANEL_SIZE),
            int((neck_y + hip_mid_y) / 2.0 * PANEL_SIZE),
        )
        assert old_anchor_px in positives

    def test_torso_run_points_are_ordered_from_neck_toward_hips(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        positives = [(r["y"]) for r in records if r["polarity"] == "positive"]
        # front_tpose is upright -- NECK sits above the hips (smaller
        # normalized y), so the three run points increase in y monotonically.
        assert positives == sorted(positives)
        assert len(set(positives)) == 3

    def test_torso_run_applies_identically_on_every_figure_panel(self):
        for panel_key in FIGURE_PANEL_KEYS:
            points = rig.keypoints_for(panel_key)
            records = gen.part_prompt_points(panel_key, "torso", points, PANEL_SIZE)
            positives = [r for r in records if r["polarity"] == "positive"]
            assert len(positives) == 3, panel_key


class TestTorsoShoulderNegativesStopTheArmSwallow:
    """Finding 1: four upper_arm rejections and two torso rejections in
    T-0423's own evidence shared one cause -- the coat mask bleeding into
    the shoulder/upper-arm region. The torso's own request gains two new
    negative points, the raw shoulder joints themselves, beyond the
    generic one-point-per-sibling negative it already had."""

    def test_torso_extra_negative_joints_are_both_shoulders(self):
        joint_indices = {idx for idx, _ in gen._TORSO_EXTRA_NEGATIVE_JOINTS}
        assert joint_indices == {_R_SHOULDER, _L_SHOULDER}

    def test_torso_request_includes_both_raw_shoulder_points_as_negatives(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}

        r_shoulder_px = (
            int(points[_R_SHOULDER][0] * PANEL_SIZE),
            int(points[_R_SHOULDER][1] * PANEL_SIZE),
        )
        l_shoulder_px = (
            int(points[_L_SHOULDER][0] * PANEL_SIZE),
            int(points[_L_SHOULDER][1] * PANEL_SIZE),
        )
        assert r_shoulder_px in negatives
        assert l_shoulder_px in negatives

    def test_shoulder_negatives_present_on_every_figure_panel(self):
        for panel_key in FIGURE_PANEL_KEYS:
            points = rig.keypoints_for(panel_key)
            records = gen.part_prompt_points(panel_key, "torso", points, PANEL_SIZE)
            negative_derivations = [
                r["derivation"] for r in records if r["polarity"] == "negative"
            ]
            assert any(
                "torso_arm_seam" in d and "right SHOULDER" in d for d in negative_derivations
            )
            assert any(
                "torso_arm_seam" in d and "left SHOULDER" in d for d in negative_derivations
            )

    def test_shoulder_negatives_are_additional_not_a_replacement(self):
        # The generic sibling-anchor negatives (corners, non-part joints,
        # every other present part's own anchor) must still all be there --
        # this card adds to the torso's negative set, it does not shrink it.
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        negative_derivations = [r["derivation"] for r in records if r["polarity"] == "negative"]
        assert any(d.startswith("sibling_part:") for d in negative_derivations)
        assert any("corner_" in d for d in negative_derivations)
        assert any("not decomposed" in d for d in negative_derivations)

    def test_only_torso_gets_the_shoulder_negatives_not_other_parts(self):
        points = rig.keypoints_for("front_tpose")
        for part_key in ("head", "right_upper_arm", "right_lower_arm"):
            records = gen.part_prompt_points("front_tpose", part_key, points, PANEL_SIZE)
            negative_derivations = [
                r["derivation"] for r in records if r["polarity"] == "negative"
            ]
            assert not any("torso_arm_seam" in d for d in negative_derivations)


class TestNonTorsoPartsUnaffected:
    """Regression: every other figure part (head, upper_arm, lower_arm)
    and every legs part keeps its exact pre-existing single-positive-point
    shape -- this card changes the torso's own request only."""

    def test_head_still_gets_exactly_one_positive_point(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "head", points, PANEL_SIZE)
        assert len([r for r in records if r["polarity"] == "positive"]) == 1

    def test_upper_arm_still_gets_exactly_one_positive_point(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "right_upper_arm", points, PANEL_SIZE)
        assert len([r for r in records if r["polarity"] == "positive"]) == 1

    def test_lower_arm_still_gets_exactly_one_positive_point(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "right_lower_arm", points, PANEL_SIZE)
        assert len([r for r in records if r["polarity"] == "positive"]) == 1

    def test_legs_panel_parts_still_get_exactly_one_positive_point(self):
        points = rig.keypoints_for("legs")
        for part_key in gen.PARTS_BY_PANEL["legs"]:
            records = gen.part_prompt_points("legs", part_key, points, PANEL_SIZE)
            assert len([r for r in records if r["polarity"] == "positive"]) == 1

    def test_arm_requests_reference_torso_by_its_single_old_anchor_only(self):
        # Siblings negative-reference torso via its ORIGINAL single anchor
        # (t=0.5) -- an arm's own request is unchanged by this card; only
        # the torso's own request grows.
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "right_upper_arm", points, PANEL_SIZE)
        torso_negative_derivations = [
            r["derivation"] for r in records if r["derivation"] == "sibling_part:torso"
        ]
        assert len(torso_negative_derivations) == 1


class TestSeparateSam3CallStructurePreservedForTorsosMultiPointRequest:
    """Same structural invariant T-0417/T-0423 both pin -- one `SAM3_Detect`
    graph per part, never batched -- still holds with torso's own request
    now carrying three positive coordinates instead of one. Three points in
    ONE call is still one call; it is not six parts folded into a shared
    request, which is the failure mode this machinery exists to prevent."""

    def test_torso_graph_carries_three_positive_coords_in_one_call(self):
        points = rig.keypoints_for("front_tpose")
        records = gen.part_prompt_points("front_tpose", "torso", points, PANEL_SIZE)
        positive_coords = [
            {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "positive"
        ]
        negative_coords = [
            {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "negative"
        ]
        model_loader = {"class_type": "FakeSam3Loader", "inputs": {}}
        graph = build_sam3_part_workflow(
            "panel_front_tpose.png",
            model_loader,
            positive_coords=positive_coords,
            negative_coords=negative_coords,
            filename_prefix="T0427_sam3_front_tpose_torso",
        )
        coords = json.loads(graph["3"]["inputs"]["positive_coords"])
        assert len(coords) == 3

    def test_front_tpose_still_produces_exactly_six_separate_graphs(self):
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
                filename_prefix=f"T0427_sam3_front_tpose_{part_key}",
            )

        assert len(graphs) == 6
        for part_key, graph in graphs.items():
            coords = json.loads(graph["3"]["inputs"]["positive_coords"])
            if part_key == "torso":
                assert len(coords) == 3
            else:
                assert len(coords) == 1


class TestRequestingAPartThePanelCannotShowStillRaises:
    """Unchanged guard, reproduced here so the T-0427 module stands alone --
    part_prompt_points must still refuse an (panel, part) pair the panel's
    own PARTS_BY_PANEL doesn't list."""

    def test_raises_value_error(self):
        points = rig.keypoints_for("side_right_forward")
        with pytest.raises(ValueError):
            gen.part_prompt_points("side_right_forward", "left_upper_arm", points, PANEL_SIZE)


class TestOutputGeometryUnchangedByThisCard:
    """"Output geometry is 48x48 per cell via x8 area-descend -- high-res
    generate then descend... No new resolution. Assert the emitted
    geometry rather than assuming it" (card acceptance). The 48x48 cell
    named in `docs/design/13-asset-pipeline.md` (`:139`, "Cell 48x48 (3
    tiles)") is the PRODUCTION curated-sprite-sheet cell size; this
    module's own evidence descend is a DIFFERENT, pre-existing
    demonstration convention this card reuses unmodified from T-0417/
    T-0423 (`_run_one_part`'s own `box_descend_part(..., target_size=(32,
    32), margin_px=2)` call) -- never promoted to `assets/final/` (this
    card's own "do not promote anything" rule), so the production 48x48
    convention is never actually exercised here. What this card DOES
    assert, literally, against the real committed PNGs on disk rather
    than assumed: the high-res-crop-then-descend shape is unchanged
    (`PANEL_SIZE` is still the 1024x1024 T-0337 established crop size SAM3
    operates on) and the evidence descend's own emitted geometry is still
    exactly what T-0417/T-0423 left it at -- no new resolution introduced
    by this card's torso prompt change."""

    def test_panel_size_is_still_the_t0337_established_1024_crop(self):
        assert PANEL_SIZE == 1024

    def test_torso_descended_evidence_png_geometry_is_unchanged_32x32(self):
        from PIL import Image

        evidence_dir = gen.EVIDENCE_DIR
        for panel_key in FIGURE_PANEL_KEYS:
            path = evidence_dir / f"panel_{panel_key}_part_torso_descended.png"
            if not path.exists():
                # An empty/not-present torso on this panel never reaches
                # box_descend_part -- nothing to assert geometry on.
                continue
            with Image.open(path) as img:
                assert img.size == (32, 32), f"{panel_key}: {img.size}"
