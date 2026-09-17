"""T-0361 (2026-09-17 Codex fix): character_part_identity proven through the
PRODUCTION gate (`sweep_character_gate` / the `character-gate` CLI), not
just a unit test of the region comparator.

Codex's review of the first cut found `character_part_identity` compared
each frame's real pixels against a RENDERED RIG SILHOUETTE
(`asset_gate.art.render_rig_silhouette`), which always uses ONE fixed
foreground palette index -- so the check measured agreement with that
index, not identity. `identity-probe.py` (embedded in the card body)
proved this: the identical rig silhouette passed recoloured at palette
index 1 and failed recoloured at index 2. `asset_gate.art.
check_region_identity_against_reference` / `asset_gate.character.
_recompute_part_identity_from_frames` fix this by comparing each frame
against a REAL reference frame's own region content (this sheet's own
frame 0) instead -- see that function's own docstring for the fix and its
documented limit.

Two committed fixtures prove the fix end to end:

- `fixtures/positive_controls/multi_color_identity/`: every frame colours
  head/torso/near_limb/far_limb with its own distinct palette index and
  correct motion -- must PASS `character_part_identity`. Lives OUTSIDE
  `fixtures/negative_controls/` so the six-control suite's own "every
  control makes the CLI exit non-zero" assertion keeps applying to negative
  controls only.
- `fixtures/part_identity_negative_controls/swapped_limb_colors/`: frame 0
  is byte-identical to the positive fixture's own frame 0 (correct);
  frames 1-7 swap which colour near_limb/far_limb use. Geometry is
  unperturbed (matches the correct rig keypoints exactly) and near_limb/
  far_limb are always equal-area (mirror construction), so the swap exactly
  preserves the whole-frame palette histogram every frame -- yet
  `character_part_identity` must FAIL it, since it compares each frame
  against frame 0's own real per-part pixels, not an aggregate. Lives in
  its own directory, separate from `fixtures/negative_controls/`'s six
  motion-gate controls, because that suite's own calibration table pins
  EXACT pose-fidelity/identity-stability numbers per fixture that only a
  real PIL recompute can produce (see that suite's own module docstring);
  this fixture's own tests assert `character_part_identity` specifically
  and do not depend on those numbers.

Both fixtures are built by the committed, deterministic
`generate_part_identity_controls_T0361.js` generator (never the T-0338
compositor) -- see that script's own header for why flat rectangle fills
rather than rendered capsules, and its own self-checks (disjoint regions,
equal near/far area, frame-0 parity, exact whole-frame histogram
preservation) that ran at generation time.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from asset_gate.character import sweep_character_gate

_FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures"
_POSITIVE_DIR = _FIXTURES_ROOT / "positive_controls" / "multi_color_identity"
_SWAP_DIR = _FIXTURES_ROOT / "part_identity_negative_controls" / "swapped_limb_colors"
_SRC_DIR = Path(__file__).resolve().parents[1] / "src"


def _run_cli(control_dir: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(_SRC_DIR), "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run(
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


# ---- fixtures exist, are not compositor-produced ----


def test_both_fixtures_exist_as_committed_files():
    for control_dir in (_POSITIVE_DIR, _SWAP_DIR):
        character_dir = control_dir / "character"
        assert (character_dir / "sheet.png").is_file()
        assert (character_dir / "sheet.provenance.json").is_file()
        for i in range(8):
            assert (character_dir / "rig" / f"frame_{i}.json").is_file()


def test_neither_fixture_is_produced_by_the_t0338_compositor():
    for control_dir in (_POSITIVE_DIR, _SWAP_DIR):
        provenance = json.loads((control_dir / "character" / "sheet.provenance.json").read_text())
        assert provenance["model"] == "synthetic-part-identity-rig/v1"


def test_positive_fixture_lives_outside_the_negative_controls_directory():
    negative_controls_root = _FIXTURES_ROOT / "negative_controls"
    assert negative_controls_root not in _POSITIVE_DIR.parents
    assert _POSITIVE_DIR.is_dir()


def test_frame_0_is_byte_identical_between_the_positive_and_swap_fixtures():
    """The swap fixture's own proof depends on frame 0 NOT carrying the
    defect (see `_recompute_part_identity_from_frames`'s documented
    anchor-frame limit) -- assert the two fixtures' frame 0 rig keypoints
    (their generator's own declared "correct" pose for every frame) agree,
    the same cross-check the generator itself runs at build time."""
    positive_frame0 = json.loads(
        (_POSITIVE_DIR / "character" / "rig" / "frame_0.json").read_text()
    )
    swap_frame0 = json.loads((_SWAP_DIR / "character" / "rig" / "frame_0.json").read_text())
    assert positive_frame0 == swap_frame0


# ---- character_part_identity through sweep_character_gate ----


def test_positive_fixture_passes_character_part_identity_via_sweep():
    results = sweep_character_gate(_POSITIVE_DIR, repo_root=_POSITIVE_DIR)
    part_identity_results = [r for r in results if r.check == "character_part_identity"]
    assert len(part_identity_results) == 1
    assert part_identity_results[0].passed, part_identity_results[0].reason
    assert part_identity_results[0].details["part_identity_range"] == [0.0, 0.0]


def test_swap_fixture_fails_character_part_identity_via_sweep():
    results = sweep_character_gate(_SWAP_DIR, repo_root=_SWAP_DIR)
    part_identity_results = [r for r in results if r.check == "character_part_identity"]
    assert len(part_identity_results) == 1
    assert not part_identity_results[0].passed
    worst = part_identity_results[0].details["part_identity_range"][1]
    assert worst > 0.4  # PART_IDENTITY_HISTOGRAM_CAP -- named, not imported, to catch drift


def test_swap_fixture_worst_regions_are_near_and_far_limb_not_head_or_torso():
    """The swap only touches near_limb/far_limb colouring -- head and torso
    must stay at distance 0, isolating exactly which regions the defect is
    in (a stronger proof than the aggregate range alone)."""
    results = sweep_character_gate(_SWAP_DIR, repo_root=_SWAP_DIR)
    part_identity = next(r for r in results if r.check == "character_part_identity")
    per_region_max = part_identity.details["per_region_max"]
    assert per_region_max["head"] == 0.0
    assert per_region_max["torso"] == 0.0
    assert per_region_max["near_limb"] > 0.4
    assert per_region_max["far_limb"] > 0.4


# ---- through the real character-gate CLI ----


def test_positive_fixture_does_not_fail_character_part_identity_via_cli():
    """Asserts specifically that `character_part_identity` is not among the
    CLI's failing checks -- not that the CLI exits 0 overall, since this
    fixture's bespoke (non-gait) rig topology does not attempt to also
    satisfy `character_motion_fidelity`'s own pose-fidelity floor (see the
    generator's own header)."""
    proc = _run_cli(_POSITIVE_DIR)
    assert "[FAIL] character_part_identity" not in proc.stdout, proc.stdout + proc.stderr


def test_swap_fixture_makes_the_real_cli_exit_non_zero_naming_character_part_identity():
    proc = _run_cli(_SWAP_DIR)
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "character_part_identity" in proc.stdout
