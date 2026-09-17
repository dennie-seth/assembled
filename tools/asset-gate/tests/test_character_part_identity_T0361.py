"""T-0361: a spatial / part-aware identity check for the character gate.

Architecture-review finding (2026-09-11, `docs/decision-log.md` DL-31): the
torso-histogram identity-stability measure (`check_identity_stability`,
T-0340) scored a left/right limb swap at 0.0 -- it is colour-STABILITY only,
blind to WHERE content sits, because the torso box the measure evaluates
does not contain either limb by construction, and (more generally) any
whole-frame aggregate histogram is blind to a swap too: swapping two
regions' content changes where pixels of each palette index sit, never how
many of each index exist overall.

`asset_gate.art.check_region_identity_stability` (see `test_art.py` for the
check's own unit tests, including the swap-that-fools-the-whole-frame proof)
is the general per-region primitive. `determine_character_part_identity`
here is its wiring into the character gate: recomputed LIVE from a sheet's
own pixels + versioned rig keypoints, exactly like
`determine_character_motion_fidelity` (T-0357) -- never trusting a sidecar's
self-reported score, and FAILING (not skipping) a locomotion/transition/loop
asset that does not record enough rig evidence to recompute from.

This card does not change `POSE_FIDELITY_IOU_FLOOR` (0.70) or
`IDENTITY_STABILITY_HISTOGRAM_CAP` (0.15, T-0340) -- `PART_IDENTITY_HISTOGRAM_CAP`
is a NEW, separate, provisional threshold for this NEW check; T-0362 (the
positive calibration against an approved walk) is what freezes real numbers,
this card only has to establish the check and prove it catches what the
whole-frame/fixed-torso measures miss.
"""

from __future__ import annotations

import json

import numpy as np
from PIL import Image

from asset_gate import art
from asset_gate.character import (
    FAR_LIMB_JOINT_INDICES,
    HEAD_JOINT_INDICES,
    IDENTITY_STABILITY_HISTOGRAM_CAP,
    NEAR_LIMB_JOINT_INDICES,
    PART_IDENTITY_HISTOGRAM_CAP,
    POSE_FIDELITY_IOU_FLOOR,
    RIG_LIMB_JOINT_PAIRS,
    build_character_gate_report,
    determine_character_part_identity,
    sweep_character_gate,
)
from conftest import TEST_PALETTE_HEX, make_indexed_image

CELL_PX = 40

# Mirrors gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM -- copied inert test data
# (18-joint COCO standing-idle base pose), same as
# test_character_gate_pixel_recompute_T0357.py's own `_BASE_POSE_NORM`: this
# suite only exercises the recompute/comparison machinery, not the real
# generator, and asset_gate must not depend on assets/src/character/** (a
# different agent's path scope) at import time.
_BASE_POSE_NORM = {
    0: (0.500, 0.095),
    1: (0.500, 0.210),
    2: (0.417, 0.225),
    3: (0.402, 0.390),
    4: (0.387, 0.540),
    5: (0.583, 0.225),
    6: (0.598, 0.390),
    7: (0.613, 0.540),
    8: (0.446, 0.570),
    9: (0.440, 0.750),
    10: (0.435, 0.930),
    11: (0.554, 0.570),
    12: (0.560, 0.750),
    13: (0.565, 0.930),
    14: (0.476, 0.075),
    15: (0.524, 0.075),
    16: (0.452, 0.090),
    17: (0.548, 0.090),
}


def _write_keypoints_file(path, points_norm):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = [{"joint": j, "x": x, "y": y} for j, (x, y) in sorted(points_norm.items())]
    path.write_text(json.dumps(payload))


def _write_prov(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"model": "x.safetensors", "seed": 1, **fields}))


def _rendered_rig_image(points_norm, cell_px):
    """Renders the SAME topology/radius the production recompute path uses,
    so a sheet built from this is a pixel-perfect match for the rig's own
    prediction -- the positive control."""
    limbs = [
        (
            (points_norm[a][0] * cell_px, points_norm[a][1] * cell_px),
            (points_norm[b][0] * cell_px, points_norm[b][1] * cell_px),
        )
        for a, b in RIG_LIMB_JOINT_PAIRS
    ]
    silhouette = art.render_rig_silhouette(size=cell_px, limbs=limbs, radius=2.5)
    return make_indexed_image(silhouette.astype("uint8"), TEST_PALETTE_HEX)


def _base_provenance(keypoints_rel_path):
    return {
        "motion_class": "locomotion",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel_path}],
        # STALE recorded values -- deliberately still "passing" so the test
        # proves recompute overrides them rather than trusting them.
        "part_identity_range": [0.0, 0.0],
    }


# ---- thresholds this card must not touch ----


def test_this_card_does_not_change_the_t0340_thresholds():
    assert POSE_FIDELITY_IOU_FLOOR == 0.7
    assert IDENTITY_STABILITY_HISTOGRAM_CAP == 0.15


def test_part_identity_histogram_cap_is_a_new_distinct_threshold():
    assert isinstance(PART_IDENTITY_HISTOGRAM_CAP, float)
    assert PART_IDENTITY_HISTOGRAM_CAP != POSE_FIDELITY_IOU_FLOOR
    assert PART_IDENTITY_HISTOGRAM_CAP != IDENTITY_STABILITY_HISTOGRAM_CAP


# ---- named joint groups ----


def test_named_limb_groups_are_disjoint_and_exclude_head_and_torso_anchors():
    head = set(HEAD_JOINT_INDICES)
    near = set(NEAR_LIMB_JOINT_INDICES)
    far = set(FAR_LIMB_JOINT_INDICES)
    assert head & near == set()
    assert head & far == set()
    assert near & far == set()


# ---- determine_character_part_identity: skip / fail-closed ----


def test_skips_for_idle_even_with_rig_evidence_present(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = {
        "motion_class": "idle",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [{"pose_keypoints_file": keypoints_rel}],
    }
    blank_sheet = make_indexed_image(
        np.zeros((CELL_PX, CELL_PX), dtype=np.uint8), TEST_PALETTE_HEX
    )

    result = determine_character_part_identity(
        provenance, sheet=blank_sheet, repo_root=tmp_path, sheet_name="idle-sheet"
    )

    assert result.passed
    assert result.details.get("skipped") is True


def test_skips_for_missing_motion_class():
    result = determine_character_part_identity({}, sheet_name="x")
    assert result.passed
    assert result.details.get("skipped") is True


def test_fails_when_no_rig_evidence_recorded_even_if_sidecar_range_would_pass():
    """Mirrors T-0357's own P1 fix for character_motion_fidelity: a
    locomotion/transition/loop asset with no layout/frame_generation must
    FAIL this new check too, never fall back to trusting a self-reported
    part_identity_range."""
    provenance = {"motion_class": "locomotion", "part_identity_range": [0.0, 0.0]}
    result = determine_character_part_identity(provenance, sheet_name="x")
    assert not result.passed
    assert "recomputed_from_pixels" not in result.details
    assert "layout" in result.reason


# ---- determine_character_part_identity: recompute-from-pixels ----


def test_recompute_passes_when_the_sheet_pixels_actually_match_the_rig(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)
    good_sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)

    result = determine_character_part_identity(
        provenance, sheet=good_sheet, repo_root=tmp_path, sheet_name="good"
    )

    assert result.passed
    assert result.details.get("recomputed_from_pixels") is True
    assert "part_identity_range" in result.details


def test_stale_sidecar_score_does_not_survive_an_image_change(tmp_path):
    """Same STALE recorded (perfect, passing) `part_identity_range` as the
    good case -- but the image now has nothing rendered on it at all. Recompute
    must catch this; trusting the sidecar's own recorded range would not."""
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)

    blank_sheet = make_indexed_image(
        np.zeros((CELL_PX, CELL_PX), dtype=np.uint8), TEST_PALETTE_HEX
    )

    result = determine_character_part_identity(
        provenance, sheet=blank_sheet, repo_root=tmp_path, sheet_name="bad"
    )

    assert not result.passed
    assert result.details.get("recomputed_from_pixels") is True


def test_fails_naming_missing_frame_generation_when_layout_present_but_no_frame_generation():
    provenance = {
        "motion_class": "locomotion",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
    }
    result = determine_character_part_identity(provenance, sheet_name="x")
    assert not result.passed
    assert "frame_generation" in result.reason


def test_fails_when_sheet_path_does_not_exist(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)

    result = determine_character_part_identity(
        provenance,
        sheet_path=tmp_path / "does_not_exist.png",
        repo_root=tmp_path,
        sheet_name="x",
    )

    assert not result.passed


# ---- wiring: build_character_gate_report / sweep_character_gate ----


def test_build_character_gate_report_includes_character_part_identity(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = {
        "motion_class": "locomotion",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
    }
    good_sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)

    report = build_character_gate_report(
        good_sheet,
        provenance,
        cols=1,
        rows=1,
        cell_px=CELL_PX,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert "character_part_identity" in report["checks"]
    assert report["checks"]["character_part_identity"]["passed"] is True


def test_sweep_character_gate_includes_character_part_identity_check_name(tmp_path):
    keypoints_rel = "character/rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    _write_prov(
        tmp_path / "character" / "player_new_walk.provenance.json",
        frame_delta_range=[0.05, 0.09],
        arm_c_benchmark=[0.072, 0.112],
        beats_arm_c_benchmark=True,
        motion_class="locomotion",
        layout={"cols": 1, "rows": 1, "cell_px": CELL_PX},
        frame_generation=[{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
    )
    good_sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)
    good_sheet.save(tmp_path / "character" / "player_new_walk.png", transparency=0)

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert "character_part_identity" in {r.check for r in results}
    part_identity_results = [r for r in results if r.check == "character_part_identity"]
    assert len(part_identity_results) == 1
    assert part_identity_results[0].passed


def test_sweep_character_gate_fails_character_part_identity_on_a_blank_render(tmp_path):
    keypoints_rel = "character/rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    _write_prov(
        tmp_path / "character" / "regression.provenance.json",
        frame_delta_range=[0.05, 0.09],
        arm_c_benchmark=[0.072, 0.112],
        beats_arm_c_benchmark=True,
        motion_class="locomotion",
        layout={"cols": 1, "rows": 1, "cell_px": CELL_PX},
        frame_generation=[{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
    )
    blank_sheet = Image.new("P", (CELL_PX, CELL_PX), 0)
    blank_sheet.save(tmp_path / "character" / "regression.png", transparency=0)

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    part_identity_results = [r for r in results if r.check == "character_part_identity"]
    assert len(part_identity_results) == 1
    assert not part_identity_results[0].passed
