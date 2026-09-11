"""T-0357 findings 1, 3 and 4: recompute motion-fidelity measurements live
from the sheet's own pixels + versioned rig keypoints, instead of trusting
whatever range a provenance sidecar happens to record, and wire the single
combined result into one authoritative sweep both CI and the reviewer route
run.

`determine_character_motion_fidelity` is the authoritative determination:
when a provenance sidecar records enough to recompute from (a declared
`layout` plus one `frame_generation` entry per frame, each naming a
versioned rig-keypoints file -- exactly what
`assets/final/character/player_walk_sheet_hybrid.provenance.json` already
records for every one of its 8 frames), it renders the rig's own predicted
silhouette for each frame and re-derives pose_fidelity_range/
identity_stability_range from the sheet's actual pixels, ALWAYS overriding
whatever the sidecar itself recorded for those two fields. When there is no
rig evidence to recompute from at all, it falls back unchanged to
`check_character_motion_fidelity`'s existing sidecar-trusting predicate --
same thresholds, same predicate, just a different source for the range.

`sweep_character_gate` is the single authoritative validator (T-0357 finding
1): CHR-1 presence + the idle frame-delta cap + a validated motion_class
declaration + this recomputed motion-fidelity result, all in one sweep --
the one function the `character-gate` CLI subcommand exposes, and the one
both `ci-asset-gate.yml` and the board's reviewer route invoke.
"""

from __future__ import annotations

import json

import numpy as np

from asset_gate import art
from asset_gate.character import (
    MOTION_FIDELITY_CAPSULE_RADIUS_PX,
    RIG_LIMB_JOINT_PAIRS,
    build_character_gate_report,
    check_character_motion_fidelity,
    determine_character_motion_fidelity,
    sweep_character_gate,
)
from asset_gate.result import all_passed
from conftest import TEST_PALETTE_HEX, make_indexed_image

CELL_PX = 40

# Mirrors gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM -- copied here as inert
# test data (18-joint COCO standing-idle base pose), not imported: this
# suite only exercises the recompute/comparison machinery, not the real
# generator, and asset_gate must not depend on assets/src/character/**
# (a different agent's path scope) at import time.
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
    """Render the SAME topology/radius the production recompute path uses,
    so a sheet built from this is a pixel-perfect match for the rig's own
    prediction -- the positive control."""
    limbs = [
        (
            (points_norm[a][0] * cell_px, points_norm[a][1] * cell_px),
            (points_norm[b][0] * cell_px, points_norm[b][1] * cell_px),
        )
        for a, b in RIG_LIMB_JOINT_PAIRS
    ]
    silhouette = art.render_rig_silhouette(
        size=cell_px, limbs=limbs, radius=MOTION_FIDELITY_CAPSULE_RADIUS_PX
    )
    return make_indexed_image(silhouette.astype("uint8"), TEST_PALETTE_HEX)


def _base_provenance(keypoints_rel_path):
    return {
        "motion_class": "locomotion",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel_path}],
        # STALE recorded values from some prior, presumably-correct run --
        # deliberately still "passing" so the test proves recompute
        # overrides them rather than trusting them.
        "pose_fidelity_range": [0.95, 0.95],
        "identity_stability_range": [0.0, 0.0],
    }


# ---- determine_character_motion_fidelity: recompute-from-pixels ----


def test_recompute_passes_when_the_sheet_pixels_actually_match_the_rig(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)
    good_sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)

    result = determine_character_motion_fidelity(
        provenance, sheet=good_sheet, repo_root=tmp_path, sheet_name="good"
    )

    assert result.passed
    assert result.details.get("recomputed_from_pixels") is True


def test_stale_sidecar_score_does_not_survive_an_image_change(tmp_path):
    """T-0357 acceptance: a stale sidecar score must not survive the sheet's
    own PNG changing underneath it. Same provenance (same STALE recorded
    pose_fidelity_range/identity_stability_range, which by itself would
    still pass) -- but the image now has nothing rendered on it at all (a
    real regression: e.g. a re-export that dropped the figure). Recompute
    must catch this; trusting the sidecar's own recorded range would not."""
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)

    blank_sheet = make_indexed_image(
        np.zeros((CELL_PX, CELL_PX), dtype=np.uint8), TEST_PALETTE_HEX
    )

    result = determine_character_motion_fidelity(
        provenance, sheet=blank_sheet, repo_root=tmp_path, sheet_name="bad"
    )

    assert not result.passed
    assert result.details.get("recomputed_from_pixels") is True


def test_trusting_the_stale_sidecar_directly_would_have_wrongly_passed():
    """Illustrates the exact bug T-0357 fixes: the pre-existing predicate,
    unchanged, naively trusts whatever the sidecar records -- this asserts
    the OLD behaviour so the contrast with the recompute-based test above is
    explicit, not implied."""
    provenance = _base_provenance("irrelevant.json")
    naive = check_character_motion_fidelity(provenance)
    assert naive.passed


def test_falls_back_to_sidecar_trust_when_no_rig_evidence_recorded():
    """No layout/frame_generation at all (an older-shaped sidecar, or a
    hand-built regression fixture) -- nothing to recompute from, so this
    falls back to the existing sidecar-trusting predicate unchanged."""
    provenance = {
        "motion_class": "locomotion",
        "pose_fidelity_range": [0.75, 0.92],
        "identity_stability_range": [0.03, 0.09],
    }
    result = determine_character_motion_fidelity(provenance, sheet_name="x")
    assert result.passed
    assert "recomputed_from_pixels" not in result.details


def test_falls_back_and_fails_when_sidecar_reports_failing_range_with_no_rig_evidence():
    provenance = {
        "motion_class": "locomotion",
        "pose_fidelity_range": [0.1, 0.2],
        "identity_stability_range": [0.03, 0.09],
    }
    result = determine_character_motion_fidelity(provenance, sheet_name="x")
    assert not result.passed


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

    result = determine_character_motion_fidelity(
        provenance, sheet=blank_sheet, repo_root=tmp_path, sheet_name="idle-sheet"
    )

    assert result.passed
    assert result.details.get("skipped") is True


def test_fails_when_a_frame_generation_entry_has_no_keypoints_file(tmp_path):
    provenance = {
        "motion_class": "locomotion",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [{"frame_index": 0}],
    }
    sheet = make_indexed_image(np.zeros((CELL_PX, CELL_PX), dtype=np.uint8), TEST_PALETTE_HEX)

    result = determine_character_motion_fidelity(
        provenance, sheet=sheet, repo_root=tmp_path, sheet_name="x"
    )

    assert not result.passed


def test_fails_when_the_rig_keypoints_file_does_not_exist(tmp_path):
    provenance = _base_provenance("rig/does_not_exist.json")
    sheet = make_indexed_image(np.zeros((CELL_PX, CELL_PX), dtype=np.uint8), TEST_PALETTE_HEX)

    result = determine_character_motion_fidelity(
        provenance, sheet=sheet, repo_root=tmp_path, sheet_name="x"
    )

    assert not result.passed


def test_fails_when_sheet_path_does_not_exist(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)

    result = determine_character_motion_fidelity(
        provenance,
        sheet_path=tmp_path / "does_not_exist.png",
        repo_root=tmp_path,
        sheet_name="x",
    )

    assert not result.passed


# ---- sweep_character_gate: the single authoritative validator ----


def test_sweep_character_gate_skips_non_character_classes(tmp_path):
    _write_prov(tmp_path / "props" / "crate.provenance.json")

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert len(results) == 1
    assert results[0].passed
    assert results[0].details["skipped"]


def test_sweep_character_gate_passes_idle_sheet_with_full_fields(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_idle_new.provenance.json",
        frame_delta_range=[0.05, 0.09],
        arm_c_benchmark=[0.072, 0.112],
        beats_arm_c_benchmark=True,
        motion_class="idle",
    )

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert all_passed(results)
    assert {r.check for r in results} == {
        "character_arm_c_provenance",
        "character_frame_delta_cap",
        "character_motion_class_declared",
        "character_motion_fidelity",
    }


def test_sweep_character_gate_fails_on_codex_reproduction_fixture(tmp_path):
    """T-0357 acceptance regression: Codex's own reproduction fixture --
    valid CHR-1 fields, motion_class='locomotion', explicitly failing
    pose/identity scores -- must make this sweep (the exact function the
    `character-gate` CLI subcommand -- and therefore both the CI workflow
    and the board's reviewer route -- runs) report a failure."""
    _write_prov(
        tmp_path / "character" / "regression.provenance.json",
        frame_delta_range=[0.05, 0.09],
        arm_c_benchmark=[0.072, 0.112],
        beats_arm_c_benchmark=True,
        motion_class="locomotion",
        pose_fidelity_range=[0, 0],
        identity_stability_range=[1, 1],
    )

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert not all_passed(results)
    motion_results = [r for r in results if r.check == "character_motion_fidelity"]
    assert len(motion_results) == 1
    assert not motion_results[0].passed


def test_sweep_character_gate_fails_when_motion_class_missing_on_a_new_sidecar(tmp_path):
    _write_prov(
        tmp_path / "character" / "player_new_sheet.provenance.json",
        frame_delta_range=[0.05, 0.09],
        arm_c_benchmark=[0.072, 0.112],
        beats_arm_c_benchmark=True,
    )

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert not all_passed(results)
    declared_results = [r for r in results if r.check == "character_motion_class_declared"]
    assert len(declared_results) == 1
    assert not declared_results[0].passed


def test_sweep_character_gate_applies_both_baselines_for_a_legacy_sidecar(tmp_path):
    _write_prov(tmp_path / "character" / "player_idle_sheet_v1.provenance.json")

    results = sweep_character_gate(
        tmp_path,
        repo_root=tmp_path,
        baseline=frozenset({"character/player_idle_sheet_v1.provenance.json"}),
        motion_class_baseline=frozenset({"character/player_idle_sheet_v1.provenance.json"}),
    )

    assert all_passed(results)


def test_sweep_character_gate_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_character_gate(tmp_path, repo_root=tmp_path) == []


# ---- build_character_gate_report: finding 3+4 integration ----


def test_build_character_gate_report_recomputes_from_pixels_and_overrides_stale_range(tmp_path):
    """T-0357 findings 3+4 together: build_character_gate_report must
    recompute from the sheet's own pixels (not trust the sidecar's stale,
    still-passing recorded range) and surface the failure in its own
    `checks`, driving the CLI's exit code non-zero."""
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    provenance = _base_provenance(keypoints_rel)
    blank_sheet = make_indexed_image(
        np.zeros((CELL_PX, CELL_PX), dtype=np.uint8), TEST_PALETTE_HEX
    )

    report = build_character_gate_report(
        blank_sheet,
        provenance,
        cols=1,
        rows=1,
        cell_px=CELL_PX,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert report["checks"]["character_motion_fidelity"]["passed"] is False
    assert not all(check["passed"] for check in report["checks"].values())
    # the retired whole-silhouette cap is diagnostic-only for locomotion --
    # it must never be mistaken for the reason this report failed.
    assert report["thresholds"]["frame_delta_cap_diagnostic_only"] is True


def test_sweep_character_gate_without_baselines_fails_undocumented_legacy_gap(tmp_path):
    """Without an explicit baseline passed in, a legacy-shaped gap must
    fail, not silently pass -- baselines are opt-in, never a default."""
    _write_prov(tmp_path / "character" / "player_idle_sheet_v1.provenance.json")

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert not all_passed(results)
