"""T-0424 — archiving the six legacy crouch_hide/die/move sheets narrows the
character gate's scope by construction, not by editing the gate.

docs/decision-log.md DL-32; tools/asset-gate/src/asset_gate/character.py's
four sweeps (`sweep_character_arm_c_provenance`, `sweep_character_frame_delta_cap`,
`sweep_character_motion_fidelity`, `sweep_character_motion_class_declared`) all
walk `root_path.rglob("*.provenance.json")` against whatever root the CLI is
given (`assets/final`) -- there is no manifest and no hardcoded sheet list, so
moving a sidecar out of `assets/final/` removes it from the sweep's scope
without touching a single line of gate code. This test is the mechanical
proof of that: RED before the move (the six sidecars are still under
`assets/final/character/`, so the sweep still reports them), GREEN after
(they moved to `assets/archive/character/`, outside the root the sweep is
ever pointed at -- `asset_class()` never even sees an `archive/` path).

`player_walk_sheet_hybrid` is the control: it must be reported by the sweep
both before and after, completely unaffected by this card.
"""

from __future__ import annotations

from pathlib import Path

import pytest

asset_gate_character = pytest.importorskip("asset_gate.character")

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
ARCHIVE_CHARACTER_DIR = REPO_ROOT / "assets" / "archive" / "character"

ARCHIVED_STEMS = [
    "player_crouch_hide_sheet_v1",
    "player_crouch_hide_sheet_v2",
    "player_die_sheet_v1",
    "player_die_sheet_v2",
    "player_move_sheet_v1",
    "player_move_sheet_v2",
]

WALK_STEM = "player_walk_sheet_hybrid"


def _sweep_paths(sweep_fn) -> set[str]:
    """The set of sidecar paths (posix, relative to assets/final) a sweep
    function actually reported on, scoped to the character class."""
    results = sweep_fn(FINAL_CHARACTER_DIR.parent)
    return {
        r.details["path"]
        for r in results
        if not r.details.get("skipped") and r.details.get("path", "").startswith("character/")
    }


SWEEPS = [
    asset_gate_character.sweep_character_arm_c_provenance,
    asset_gate_character.sweep_character_frame_delta_cap,
    asset_gate_character.sweep_character_motion_class_declared,
]


@pytest.mark.parametrize("sweep_fn", SWEEPS)
def test_archived_sheets_are_outside_the_sweeps_scope(sweep_fn) -> None:
    """The six archived sheets must never appear in a character sweep's
    results once they've moved -- there is nothing under assets/final/
    rglob can find them at."""
    swept = _sweep_paths(sweep_fn)
    for stem in ARCHIVED_STEMS:
        rel = f"character/{stem}.provenance.json"
        assert rel not in swept, (
            f"{rel} was still reported by {sweep_fn.__name__} -- it must have moved to "
            f"{ARCHIVE_CHARACTER_DIR}, outside assets/final/, for the gate's scope to "
            "actually narrow (T-0424)"
        )


@pytest.mark.parametrize("sweep_fn", SWEEPS)
def test_walk_hybrid_is_still_inside_the_sweeps_scope(sweep_fn) -> None:
    """Control: the walk sheet is explicitly NOT retired by this card and
    must still be swept exactly as before."""
    swept = _sweep_paths(sweep_fn)
    rel = f"character/{WALK_STEM}.provenance.json"
    assert rel in swept, (
        f"{rel} vanished from {sweep_fn.__name__}'s scope -- T-0424 must never touch the "
        "walk sheet's own gate evaluation"
    )


def test_archived_sheets_live_under_archive_not_final() -> None:
    for stem in ARCHIVED_STEMS:
        final_png = FINAL_CHARACTER_DIR / f"{stem}.png"
        final_prov = FINAL_CHARACTER_DIR / f"{stem}.provenance.json"
        assert not final_png.exists(), f"{final_png} still under assets/final/ -- not archived"
        assert not final_prov.exists(), f"{final_prov} still under assets/final/ -- not archived"

        archive_png = ARCHIVE_CHARACTER_DIR / f"{stem}.png"
        archive_prov = ARCHIVE_CHARACTER_DIR / f"{stem}.provenance.json"
        assert archive_png.exists(), f"{archive_png} missing -- archive move incomplete"
        assert archive_prov.exists(), f"{archive_prov} missing -- archive move incomplete"


def test_walk_hybrid_untouched_in_final() -> None:
    assert (FINAL_CHARACTER_DIR / f"{WALK_STEM}.png").exists()
    assert (FINAL_CHARACTER_DIR / f"{WALK_STEM}.provenance.json").exists()
    assert (FINAL_CHARACTER_DIR / f"{WALK_STEM}.gate_report.json").exists()
    assert not (ARCHIVE_CHARACTER_DIR / f"{WALK_STEM}.png").exists()


def test_archive_asset_class_is_never_the_character_gates_scope() -> None:
    """Edge case: confirm (not assume) that `asset_class()` for a path rooted
    at assets/archive/ is simply never evaluated -- the gate is only ever
    pointed at assets/final, so assets/archive/character/... is outside the
    root `rglob` walks, not a path the classifier has to special-case."""
    assert not list(FINAL_CHARACTER_DIR.parent.rglob("archive/**/*.provenance.json")), (
        "a provenance sidecar under assets/archive/ was found while rglobbing assets/final/ -- "
        "archive must be a sibling of final, never nested under it"
    )
