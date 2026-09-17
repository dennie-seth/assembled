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

**2026-09-17 Codex fix.** The first cut compared each frame against a
RENDERED RIG SILHOUETTE (`asset_gate.art.render_rig_silhouette`, always a
fixed foreground palette index) -- Codex's `identity-probe.py` found this
measures agreement with that ONE hard-coded index, not identity: the same
exact rig silhouette passed recoloured at index 1 and failed recoloured at
index 2. The fix (`asset_gate.art.check_region_identity_against_reference`)
compares each frame's own named regions against a REAL reference frame's own
same-named regions -- this sheet's own frame 0 -- which is colour-agnostic
the same way `check_identity_stability`'s torso comparison already is, at
the cost of a documented blind spot: a defect present identically in every
frame (including frame 0) is invisible, since the reference agrees with it
too. See `test_swap_present_uniformly_in_every_frame_is_invisible_to_the_anchor_reference`
and `test_part_identity_is_colour_index_agnostic` below, and
`docs/character-motion-negative-controls-T0361.md`.

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


def _two_frame_sheet(frame0_arr, frame1_arr):
    return make_indexed_image(np.hstack([frame0_arr, frame1_arr]), TEST_PALETTE_HEX)


def _two_frame_provenance(keypoints_rel_0, keypoints_rel_1):
    return {
        "motion_class": "locomotion",
        "layout": {"cols": 2, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [
            {"frame_index": 0, "pose_keypoints_file": keypoints_rel_0},
            {"frame_index": 1, "pose_keypoints_file": keypoints_rel_1},
        ],
        # STALE recorded values -- deliberately still "passing" so the test
        # proves recompute overrides them rather than trusting them.
        "part_identity_range": [0.0, 0.0],
    }


def test_stale_sidecar_score_does_not_survive_an_image_change(tmp_path):
    """Frame 0 (this sheet's own reference frame, T-0361 2026-09-17 design)
    renders correctly; frame 1 has nothing rendered on it at all. Recompute
    must catch frame 1 disagreeing with frame 0's own real per-part pixels;
    trusting the sidecar's own recorded (stale, passing) range would not."""
    keypoints_rel_0 = "rig/frame_0_keypoints.json"
    keypoints_rel_1 = "rig/frame_1_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel_0, _BASE_POSE_NORM)
    _write_keypoints_file(tmp_path / keypoints_rel_1, _BASE_POSE_NORM)
    provenance = _two_frame_provenance(keypoints_rel_0, keypoints_rel_1)

    good_frame = np.array(_rendered_rig_image(_BASE_POSE_NORM, CELL_PX))
    blank_frame = np.zeros((CELL_PX, CELL_PX), dtype=np.uint8)
    sheet = _two_frame_sheet(good_frame, blank_frame)

    result = determine_character_part_identity(
        provenance, sheet=sheet, repo_root=tmp_path, sheet_name="bad"
    )

    assert not result.passed
    assert result.details.get("recomputed_from_pixels") is True
    assert result.details.get("single_frame_trivial_pass") is False


def test_single_frame_sheet_trivially_passes_part_identity_self_comparison(tmp_path):
    """A single-frame sheet has no OTHER frame to serve as a reference, so
    frame 0 is both the frame under test and its own reference -- the
    comparison is always self-consistent (distance 0 for every region)
    regardless of content. This is a documented, explicit limit
    (`single_frame_trivial_pass=True` in the details, never a silent skip
    the caller can't tell apart from a real evaluation) -- not a defect: a
    blank single-frame sheet still fails `character_motion_fidelity`'s own
    pose-fidelity floor, which does not have this blind spot."""
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)
    blank_sheet = make_indexed_image(
        np.zeros((CELL_PX, CELL_PX), dtype=np.uint8), TEST_PALETTE_HEX
    )

    result = determine_character_part_identity(
        provenance, sheet=blank_sheet, repo_root=tmp_path, sheet_name="blank-single-frame"
    )

    assert result.passed
    assert result.details.get("single_frame_trivial_pass") is True
    assert result.details["part_identity_range"] == [0.0, 0.0]


def test_swap_present_uniformly_in_every_frame_is_invisible_to_the_anchor_reference(tmp_path):
    """Documents the anchor-frame reference's own limit (2026-09-17 Codex
    fix, docs/character-motion-negative-controls-T0361.md): comparing every
    frame against frame 0's own per-part pixels cannot see a defect that is
    ALREADY present in frame 0 itself and repeated identically in every
    other frame -- frame 0 agrees with itself, and every other frame agrees
    with frame 0, so nothing ever disagrees. A real committed control for
    this check (T-0361 Codex fix) instead keeps frame 0 correct and injects
    the defect only into later frames -- see
    `test_character_negative_controls_T0361.py`."""
    keypoints_rel_0 = "rig/frame_0_keypoints.json"
    keypoints_rel_1 = "rig/frame_1_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel_0, _BASE_POSE_NORM)
    _write_keypoints_file(tmp_path / keypoints_rel_1, _BASE_POSE_NORM)
    provenance = _two_frame_provenance(keypoints_rel_0, keypoints_rel_1)

    # Both frames render the SAME (wrong) uniform colour -- a defect present
    # identically everywhere, including the reference frame itself.
    wrong_colour = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX).point(lambda x: 2 if x else 0)
    uniformly_wrong = np.array(wrong_colour)
    sheet = _two_frame_sheet(uniformly_wrong, uniformly_wrong)

    result = determine_character_part_identity(
        provenance, sheet=sheet, repo_root=tmp_path, sheet_name="uniformly-wrong"
    )

    assert result.passed
    assert result.details["part_identity_range"] == [0.0, 0.0]


def test_part_identity_is_colour_index_agnostic(tmp_path):
    """The 2026-09-17 Codex fix's own proof: the identical rig silhouette,
    recoloured at two different palette indices, must pass EITHER way --
    the pre-fix design (compare against a fixed-index rig silhouette)
    failed index 2 while passing index 1 for the exact same geometry."""
    keypoints_rel_0 = "rig/frame_0_keypoints.json"
    keypoints_rel_1 = "rig/frame_1_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel_0, _BASE_POSE_NORM)
    _write_keypoints_file(tmp_path / keypoints_rel_1, _BASE_POSE_NORM)
    provenance = _two_frame_provenance(keypoints_rel_0, keypoints_rel_1)

    base = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)
    for index in (1, 2):
        recoloured = np.array(base.point(lambda x, index=index: index if x else 0))
        sheet = _two_frame_sheet(recoloured, recoloured)

        result = determine_character_part_identity(
            provenance, sheet=sheet, repo_root=tmp_path, sheet_name=f"index-{index}"
        )

        assert result.passed, f"palette index {index} unexpectedly failed: {result.reason}"


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
    keypoints_rel_0 = "character/rig/frame_0_keypoints.json"
    keypoints_rel_1 = "character/rig/frame_1_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel_0, _BASE_POSE_NORM)
    _write_keypoints_file(tmp_path / keypoints_rel_1, _BASE_POSE_NORM)
    _write_prov(
        tmp_path / "character" / "regression.provenance.json",
        frame_delta_range=[0.05, 0.09],
        arm_c_benchmark=[0.072, 0.112],
        beats_arm_c_benchmark=True,
        motion_class="locomotion",
        layout={"cols": 2, "rows": 1, "cell_px": CELL_PX},
        frame_generation=[
            {"frame_index": 0, "pose_keypoints_file": keypoints_rel_0},
            {"frame_index": 1, "pose_keypoints_file": keypoints_rel_1},
        ],
    )
    # Frame 0 (this sheet's own reference frame) renders correctly; frame 1
    # (the regression under test) renders nothing at all.
    good_frame = np.array(_rendered_rig_image(_BASE_POSE_NORM, CELL_PX))
    blank_frame = np.zeros((CELL_PX, CELL_PX), dtype=np.uint8)
    sheet = make_indexed_image(np.hstack([good_frame, blank_frame]), TEST_PALETTE_HEX)
    sheet.save(tmp_path / "character" / "regression.png", transparency=0)

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    part_identity_results = [r for r in results if r.check == "character_part_identity"]
    assert len(part_identity_results) == 1
    assert not part_identity_results[0].passed
