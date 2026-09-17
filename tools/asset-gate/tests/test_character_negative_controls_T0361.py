"""T-0361: the motion-gate negative-control battery, as committed fixtures.

Architecture review (Codex, 2026-09-11, `docs/decision-log.md` DL-31): the
0.70/0.15 thresholds `check_character_motion_fidelity` applies have no
approved PASSING example to calibrate against -- only the compositor's own
output, which would be a circular check. This card is the NEGATIVE half of
that calibration (T-0362 is the positive half): six named negative controls
-- frozen frame, wrong phase, swapped limbs/layers, detached joint, foot
sliding, loop-seam jump -- committed as fixtures under
`tools/asset-gate/tests/fixtures/negative_controls/`, none produced by the
T-0338 compositor (each is a deterministic rig-capsule render + one
perturbation, built by the committed generator script), each proven to make
the real `character-gate` CLI exit non-zero.

Every fixture directory is laid out as `<control>/character/{sheet.png,
sheet.provenance.json,rig/frame_N.json}` so `sweep_character_gate`
(pointed at `<control>/` with `repo_root=<control>/`) classifies it as the
`character` asset class and resolves `pose_keypoints_file` paths exactly
the way a real `assets/final/character/**` sidecar would.

See `docs/character-motion-negative-controls-T0361.md` for the full
control -> catching-check -> metric-vs-threshold table this suite's own
assertions are drawn from.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from asset_gate.character import sweep_character_gate
from asset_gate.result import all_passed

_FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures" / "negative_controls"
_SRC_DIR = Path(__file__).resolve().parents[1] / "src"

# control name -> the check(s) that must be among the failing checks,
# measured by tests/fixtures/generate_negative_controls_T0361.js against the
# committed fixtures (see docs/character-motion-negative-controls-T0361.md
# for the full table of measured values vs threshold).
_EXPECTED_FAILING_CHECKS = {
    "frozen_frame": {"character_motion_fidelity"},
    "wrong_phase": {"character_motion_fidelity"},
    "swapped_limbs": {"character_motion_fidelity"},
    "detached_joint": {"character_motion_fidelity"},
    "foot_sliding": {"character_motion_fidelity"},
    "loop_seam_jump": {
        "character_motion_fidelity",
        "character_part_identity",
    },
}


def _control_dirs():
    return sorted(p for p in _FIXTURES_ROOT.iterdir() if p.is_dir())


def test_all_six_named_controls_exist_as_committed_fixtures():
    names = {p.name for p in _control_dirs()}
    assert names == {
        "frozen_frame",
        "wrong_phase",
        "swapped_limbs",
        "detached_joint",
        "foot_sliding",
        "loop_seam_jump",
    }


@pytest.mark.parametrize("control_dir", _control_dirs(), ids=lambda p: p.name)
def test_control_fixture_has_a_sheet_and_sidecar_and_per_frame_rig_evidence(control_dir):
    character_dir = control_dir / "character"
    assert (character_dir / "sheet.png").is_file()
    assert (character_dir / "sheet.provenance.json").is_file()
    for i in range(8):
        assert (character_dir / "rig" / f"frame_{i}.json").is_file()


@pytest.mark.parametrize("control_dir", _control_dirs(), ids=lambda p: p.name)
def test_control_sidecar_declares_locomotion_and_no_free_text(control_dir):
    provenance = json.loads((control_dir / "character" / "sheet.provenance.json").read_text())
    assert provenance["motion_class"] == "locomotion"
    assert "layout" in provenance
    assert len(provenance["frame_generation"]) == 8


@pytest.mark.parametrize("control_dir", _control_dirs(), ids=lambda p: p.name)
def test_every_control_fails_sweep_character_gate_naming_the_expected_check(control_dir):
    results = sweep_character_gate(control_dir, repo_root=control_dir)

    assert not all_passed(results), f"{control_dir.name} unexpectedly passed every check"

    failing_checks = {r.check for r in results if not r.passed}
    expected = _EXPECTED_FAILING_CHECKS[control_dir.name]
    assert expected <= failing_checks, (
        f"{control_dir.name}: expected {expected} among the failing checks, got {failing_checks}"
    )


@pytest.mark.parametrize("control_dir", _control_dirs(), ids=lambda p: p.name)
def test_every_control_makes_the_real_cli_exit_non_zero(control_dir):
    """The exact command CI and the reviewer route run -- not just the
    in-process function -- must reject every control (T-0361 acceptance
    criterion 3)."""
    env = {**os.environ, "PYTHONPATH": str(_SRC_DIR), "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "asset_gate.cli",
            "character-gate",
            str(control_dir),
            "--repo-root",
            str(control_dir),
        ],
        capture_output=True,
        text=True,
        env=env,
    )

    assert proc.returncode != 0, proc.stdout + proc.stderr
    for check_name in _EXPECTED_FAILING_CHECKS[control_dir.name]:
        assert check_name in proc.stdout


def test_no_control_fixture_is_produced_by_the_t0338_compositor():
    """Every control's provenance names the deterministic rig-capsule
    generator (this card's own committed script), never a compositor model
    -- the gate must not be validated against its own silhouettes (Codex
    review, 2026-09-11)."""
    for control_dir in _control_dirs():
        provenance = json.loads((control_dir / "character" / "sheet.provenance.json").read_text())
        assert provenance["model"] == "synthetic-rig-capsule/v1"
