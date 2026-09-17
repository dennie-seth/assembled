"""T-0360 (Codex finding 2c, the content-hash-binding half T-0357/PR #375 did
not land): a locomotion/transition/loop character sheet's recorded
`pose_fidelity_range`/`identity_stability_range` must be bound to the content
hash of the sheet PNG, the rig/config version used to recompute it, the home
palette file's own content hash, and the evaluator's own version -- and, once
every one of those four matches, the recorded score itself must still agree
with a fresh pixel recompute within `MOTION_SCORE_TOLERANCE`.

`check_motion_score_binding` is the new, independent check this card adds.
It is deliberately separate from `character_motion_fidelity`
(`determine_character_motion_fidelity`, T-0357): that check's own
missing/malformed-rig-evidence fail-closed rule is unchanged and untouched
here -- this check only ever runs once a recompute has already happened, and
only ever grades whether the RECORDED score can still be trusted, not
whether the recompute itself passes its floor/cap.

`sweep_character_gate` wires this in as a fifth check, `sheet-name`-scoped
identically to the other four, exempting a documented pre-T-0360 gap only
through `character_motion_score_binding_baseline.txt` -- the same
explicit, path-exact, written-reason idiom `character_motion_class_baseline.txt`
already uses. No committed character sidecar declares a locomotion/
transition/loop `motion_class` today (see that baseline's own docstring), so
the default binding baseline is empty -- nothing in the tree needs an
exemption yet.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from asset_gate import art
from asset_gate import character as character_mod
from asset_gate.character import (
    EVALUATOR_VERSION,
    MOTION_FIDELITY_CAPSULE_RADIUS_PX,
    MOTION_SCORE_TOLERANCE,
    RIG_CONFIG_VERSION,
    RIG_LIMB_JOINT_PAIRS,
    check_motion_score_binding,
    compute_file_sha256,
    compute_image_content_sha256,
    determine_character_motion_fidelity,
    load_character_motion_score_binding_baseline,
    sweep_character_gate,
)
from asset_gate.result import all_passed
from conftest import TEST_PALETTE_HEX, make_indexed_image

CELL_PX = 40

# Mirrors gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM -- copied here as inert
# test data for the same import-isolation reason
# test_character_gate_pixel_recompute_T0357.py's own copy documents: this
# suite only exercises the binding/comparison machinery, not the real
# generator, and asset_gate must not depend on assets/src/character/**.
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


def _rendered_rig_image(points_norm, cell_px):
    """A sheet built from rendering the SAME topology/radius the production
    recompute path uses -- pixel-perfect match for the rig's own
    prediction, so recompute measures a real pass (high pose IoU, zero
    identity drift)."""
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


def _make_sheet(fill=1):
    arr = np.full((CELL_PX, CELL_PX), fill, dtype=np.uint8)
    return make_indexed_image(arr, TEST_PALETTE_HEX)


def _write_palette_file(path, content=b'{"slots": []}'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _valid_binding(sheet, palette_path):
    return {
        "sheet_sha256": compute_image_content_sha256(sheet),
        "rig_config_version": RIG_CONFIG_VERSION,
        "palette_sha256": compute_file_sha256(palette_path),
        "evaluator_version": EVALUATOR_VERSION,
    }


def _write_prov(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"model": "x.safetensors", "seed": 1, **fields}))


# ---- check_motion_score_binding: presence/shape ----


def test_fails_when_motion_score_binding_and_score_fields_are_all_absent():
    result = check_motion_score_binding(
        {},
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=_make_sheet(),
        repo_root=".",
        sheet_name="x.png",
    )
    assert not result.passed
    assert "motion_score_binding" in result.reason
    assert "pose_fidelity_range" in result.details["missing"]
    assert "identity_stability_range" in result.details["missing"]


@pytest.mark.parametrize(
    "field_to_drop", ["sheet_sha256", "rig_config_version", "palette_sha256", "evaluator_version"]
)
def test_fails_when_a_single_binding_field_is_missing(tmp_path, field_to_drop):
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    del binding[field_to_drop]
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert field_to_drop in result.details["missing"]


# ---- check_motion_score_binding: staleness (each of the four bindings) ----


def test_fails_when_sheet_content_changed_after_scores_were_recorded(tmp_path):
    """T-0360 acceptance: change one pixel of a fixture sheet after its
    scores were recorded -- the gate must fail as stale."""
    sheet_v1 = _make_sheet(fill=1)
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet_v1, palette_path)
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    arr_v2 = np.full((CELL_PX, CELL_PX), 1, dtype=np.uint8)
    arr_v2[0, 0] = 2  # one pixel changed
    sheet_v2 = make_indexed_image(arr_v2, TEST_PALETTE_HEX)

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet_v2,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "sheet_sha256" in result.details["mismatches"]


def test_fails_when_the_palette_file_content_changed_after_scores_were_recorded(tmp_path):
    """T-0360 acceptance: same, but for the palette file."""
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path, content=b'{"slots": [{"index": 0, "hex": "#000000"}]}')
    binding = _valid_binding(sheet, palette_path)
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    # The palette file changes underneath the recorded binding.
    _write_palette_file(palette_path, content=b'{"slots": [{"index": 0, "hex": "#111111"}]}')

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "palette_sha256" in result.details["mismatches"]


def test_fails_when_the_evaluator_version_changes_after_scores_were_recorded(
    monkeypatch, tmp_path
):
    """T-0360 acceptance: same, but for the evaluator version."""
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    # The evaluator itself is upgraded after the score was recorded.
    monkeypatch.setattr(character_mod, "EVALUATOR_VERSION", "evaluator-v2-bumped")

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "evaluator_version" in result.details["mismatches"]


def test_fails_when_the_rig_config_version_is_stale(tmp_path):
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    binding["rig_config_version"] = "some-old-rig-version"
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "rig_config_version" in result.details["mismatches"]


def test_fails_when_palette_source_is_not_recorded_on_the_sidecar(tmp_path):
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    provenance = {
        # no palette_source at all
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "palette_sha256" in result.details["mismatches"]


def test_fails_when_palette_source_file_does_not_exist(tmp_path):
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    provenance = {
        "palette_source": "palette/does_not_exist.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "palette_sha256" in result.details["mismatches"]


# ---- check_motion_score_binding: recorded-vs-recomputed drift/tolerance ----


def test_fails_when_recorded_pose_fidelity_range_disagrees_beyond_tolerance(tmp_path):
    """T-0360 acceptance: a recorded score that disagrees with the pixel
    recompute beyond the stated tolerance fails, even when every hash
    matches."""
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.5, 0.5],
        "identity_stability_range": [0.02, 0.02],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.9],
        recomputed_identity_stability_range=[0.02, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "pose_fidelity_range" in result.details["drift"]
    assert "identity_stability_range" not in result.details["drift"]


def test_fails_when_recorded_identity_stability_range_disagrees_beyond_tolerance(tmp_path):
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.9],
        "identity_stability_range": [0.5, 0.5],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.9],
        recomputed_identity_stability_range=[0.02, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert not result.passed
    assert "identity_stability_range" in result.details["drift"]
    assert "pose_fidelity_range" not in result.details["drift"]


def test_passes_when_drift_is_within_tolerance(tmp_path):
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    tiny = MOTION_SCORE_TOLERANCE / 10
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9 + tiny, 0.95],
        "identity_stability_range": [0.0, 0.02 - tiny],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert result.passed


def test_passes_when_binding_and_scores_match_exactly(tmp_path):
    sheet = _make_sheet()
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)
    binding = _valid_binding(sheet, palette_path)
    provenance = {
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
        "pose_fidelity_range": [0.9, 0.95],
        "identity_stability_range": [0.0, 0.02],
    }

    result = check_motion_score_binding(
        provenance,
        recomputed_pose_fidelity_range=[0.9, 0.95],
        recomputed_identity_stability_range=[0.0, 0.02],
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="x.png",
    )

    assert result.passed
    assert result.details["binding"] == binding


# ---- load_character_motion_score_binding_baseline ----


def test_load_binding_baseline_returns_empty_set_when_file_missing(tmp_path):
    assert (
        load_character_motion_score_binding_baseline(tmp_path / "does_not_exist.txt")
        == frozenset()
    )


def test_load_binding_baseline_parses_lines_and_skips_comments_and_blanks(tmp_path):
    baseline_file = tmp_path / "baseline.txt"
    baseline_file.write_text(
        "# a comment\ncharacter/foo.provenance.json\n\ncharacter/bar.provenance.json\n"
    )

    assert load_character_motion_score_binding_baseline(baseline_file) == frozenset(
        {"character/foo.provenance.json", "character/bar.provenance.json"}
    )


def test_default_binding_baseline_is_empty():
    """No committed character sidecar declares a locomotion/transition/loop
    motion_class today (character_motion_class_baseline.txt's own
    docstring), so nothing in the tree needs a binding exemption yet."""
    assert load_character_motion_score_binding_baseline() == frozenset()


def test_every_entry_in_the_default_binding_baseline_has_a_preceding_reason_comment():
    """Mechanical guard against a future SILENT exemption: whatever gets
    added to this baseline must sit directly under a comment line, the same
    written-reason idiom character_motion_class_baseline.txt's own walk
    entry uses. Vacuously true today (the file has no real entries), but
    stands as a structural check for whatever gets added next."""
    baseline_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "asset_gate"
        / character_mod._MOTION_SCORE_BINDING_BASELINE_FILENAME
    )
    lines = baseline_path.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.strip() and not line.strip().startswith("#"):
            assert i > 0 and lines[i - 1].strip().startswith("#"), (
                f"baseline entry {line.strip()!r} has no reason comment directly above it"
            )


# ---- sweep_character_gate: end-to-end wiring ----


def _write_recomputable_locomotion_fixture(
    character_dir: Path, name: str, *, sheet, keypoints_rel: str, extra_fields: dict
):
    prov = {
        "model": "x.safetensors",
        "seed": 1,
        "frame_delta_range": [0.05, 0.09],
        "arm_c_benchmark": [0.072, 0.112],
        "beats_arm_c_benchmark": True,
        "motion_class": "locomotion",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
        **extra_fields,
    }
    prov_path = character_dir / f"{name}.provenance.json"
    prov_path.parent.mkdir(parents=True, exist_ok=True)
    prov_path.write_text(json.dumps(prov))
    sheet.save(character_dir / f"{name}.png")
    return prov_path


def test_sweep_character_gate_fails_for_a_recomputable_sheet_with_no_binding_recorded(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)

    # First, learn what a correct recompute actually measures for this
    # fixture, so pose_fidelity_range/identity_stability_range legitimately
    # pass the T-0340 floor/cap (isolating THIS card's new check).
    probe = determine_character_motion_fidelity(
        {
            "motion_class": "locomotion",
            "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
            "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
        },
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="probe",
    )
    assert probe.passed

    character_dir = tmp_path / "character"
    _write_recomputable_locomotion_fixture(
        character_dir,
        "no_binding",
        sheet=sheet,
        keypoints_rel=keypoints_rel,
        extra_fields={
            "pose_fidelity_range": probe.details["pose_fidelity_range"],
            "identity_stability_range": probe.details["identity_stability_range"],
            "palette_source": "palette/home.json",
            # motion_score_binding deliberately absent
        },
    )
    _write_palette_file(tmp_path / "palette" / "home.json")

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    by_check = {
        r.check: r
        for r in results
        if r.details.get("path", "").endswith("no_binding.provenance.json")
    }
    assert by_check["character_motion_fidelity"].passed
    assert "character_motion_score_binding" in by_check
    assert not by_check["character_motion_score_binding"].passed
    assert not all_passed(results)


def test_sweep_character_gate_passes_motion_score_binding_when_everything_matches(tmp_path):
    """The sheet's own sha256 must be computed the same way on both sides of
    this comparison -- from the actual committed PNG on disk, not an
    in-memory pre-save object -- so this test saves the sheet first and
    reopens it, exactly as `sweep_character_gate` itself does."""
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)
    palette_path = tmp_path / "palette" / "home.json"
    _write_palette_file(palette_path)

    character_dir = tmp_path / "character"
    character_dir.mkdir(parents=True, exist_ok=True)
    sheet_path = character_dir / "correct_binding.png"
    sheet.save(sheet_path)

    probe = determine_character_motion_fidelity(
        {
            "motion_class": "locomotion",
            "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
            "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
        },
        sheet_path=sheet_path,
        repo_root=tmp_path,
        sheet_name="probe",
    )
    assert probe.passed

    binding = {
        "sheet_sha256": compute_image_content_sha256(Image.open(sheet_path)),
        "rig_config_version": RIG_CONFIG_VERSION,
        "palette_sha256": compute_file_sha256(palette_path),
        "evaluator_version": EVALUATOR_VERSION,
    }
    prov = {
        "model": "x.safetensors",
        "seed": 1,
        "frame_delta_range": [0.05, 0.09],
        "arm_c_benchmark": [0.072, 0.112],
        "beats_arm_c_benchmark": True,
        "motion_class": "locomotion",
        "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
        "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
        "pose_fidelity_range": probe.details["pose_fidelity_range"],
        "identity_stability_range": probe.details["identity_stability_range"],
        "palette_source": "palette/home.json",
        "motion_score_binding": binding,
    }
    (character_dir / "correct_binding.provenance.json").write_text(json.dumps(prov))

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert all_passed(results)
    assert any(r.check == "character_motion_score_binding" for r in results)


def test_sweep_character_gate_binding_baseline_exempts_documented_gap_path_exactly(tmp_path):
    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)

    probe = determine_character_motion_fidelity(
        {
            "motion_class": "locomotion",
            "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
            "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
        },
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="probe",
    )
    assert probe.passed

    character_dir = tmp_path / "character"
    _write_recomputable_locomotion_fixture(
        character_dir,
        "legacy_no_binding",
        sheet=sheet,
        keypoints_rel=keypoints_rel,
        extra_fields={
            "pose_fidelity_range": probe.details["pose_fidelity_range"],
            "identity_stability_range": probe.details["identity_stability_range"],
            "palette_source": "palette/home.json",
        },
    )
    # Near-name sidecar with the SAME defect -- must not be rescued by an
    # exemption scoped to a different, exact path.
    _write_recomputable_locomotion_fixture(
        character_dir,
        "legacy_no_binding_v2",
        sheet=sheet,
        keypoints_rel=keypoints_rel,
        extra_fields={
            "pose_fidelity_range": probe.details["pose_fidelity_range"],
            "identity_stability_range": probe.details["identity_stability_range"],
            "palette_source": "palette/home.json",
        },
    )
    _write_palette_file(tmp_path / "palette" / "home.json")

    results = sweep_character_gate(
        tmp_path,
        repo_root=tmp_path,
        motion_score_binding_baseline=frozenset(
            {"character/legacy_no_binding.provenance.json"}
        ),
    )

    binding_results = {
        r.details["path"]: r for r in results if r.check == "character_motion_score_binding"
    }
    assert binding_results["character/legacy_no_binding.provenance.json"].passed
    assert binding_results["character/legacy_no_binding.provenance.json"].details[
        "baseline_exempt"
    ]
    assert not binding_results["character/legacy_no_binding_v2.provenance.json"].passed
    assert (
        "baseline_exempt"
        not in binding_results["character/legacy_no_binding_v2.provenance.json"].details
    )


def test_sweep_character_gate_never_emits_binding_check_when_recompute_did_not_run(tmp_path):
    """Idle sheets (and anything that never recomputes) must not gain a
    spurious character_motion_score_binding entry -- this card's scope is
    strictly the recompute path T-0357 already established."""
    _write_prov(
        tmp_path / "character" / "player_idle_new.provenance.json",
        frame_delta_range=[0.05, 0.09],
        arm_c_benchmark=[0.072, 0.112],
        beats_arm_c_benchmark=True,
        motion_class="idle",
    )

    results = sweep_character_gate(tmp_path, repo_root=tmp_path)

    assert all_passed(results)
    assert not any(r.check == "character_motion_score_binding" for r in results)


# ---- CLI regression: the exact command CI/the reviewer route run ----


def test_cli_character_gate_fails_when_binding_missing_on_a_fresh_recomputable_sheet(tmp_path):
    import os
    import subprocess
    import sys

    keypoints_rel = "rig/frame_0_keypoints.json"
    _write_keypoints_file(tmp_path / keypoints_rel, _BASE_POSE_NORM)
    sheet = _rendered_rig_image(_BASE_POSE_NORM, CELL_PX)

    probe = determine_character_motion_fidelity(
        {
            "motion_class": "locomotion",
            "layout": {"cols": 1, "rows": 1, "cell_px": CELL_PX},
            "frame_generation": [{"frame_index": 0, "pose_keypoints_file": keypoints_rel}],
        },
        sheet=sheet,
        repo_root=tmp_path,
        sheet_name="probe",
    )
    assert probe.passed

    character_dir = tmp_path / "character"
    _write_recomputable_locomotion_fixture(
        character_dir,
        "fresh_walk",
        sheet=sheet,
        keypoints_rel=keypoints_rel,
        extra_fields={
            "pose_fidelity_range": probe.details["pose_fidelity_range"],
            "identity_stability_range": probe.details["identity_stability_range"],
        },
    )

    src = Path(__file__).resolve().parents[1] / "src"
    env = {**os.environ, "PYTHONPATH": str(src), "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "asset_gate.cli",
            "character-gate",
            str(tmp_path),
            "--repo-root",
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        env=env,
    )

    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "character_motion_score_binding" in proc.stdout
    assert "fresh_walk.provenance.json" in proc.stdout


def test_cli_character_gate_still_exits_zero_on_the_committed_asset_tree():
    """T-0360 must not regress the committed tree: no committed sidecar
    declares a locomotion/transition/loop motion_class today, so the new
    binding check never fires against anything real yet."""
    import os
    import subprocess
    import sys

    repo_root = Path(__file__).resolve().parents[3]
    src = Path(__file__).resolve().parents[1] / "src"
    env = {**os.environ, "PYTHONPATH": str(src), "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "asset_gate.cli",
            "character-gate",
            str(repo_root / "assets" / "final"),
            "--repo-root",
            str(repo_root),
        ],
        capture_output=True,
        text=True,
        env=env,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
