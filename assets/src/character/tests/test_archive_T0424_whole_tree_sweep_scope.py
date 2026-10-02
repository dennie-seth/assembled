"""T-0424 round 3 — the three WHOLE-TREE asset-gate sweeps (provenance-sweep,
generator-sweep, generator-hash-sweep) are not rooted at `assets/final/` the
way `character-gate` is. `.github/workflows/ci-asset-gate.yml` points all
three at `../../assets` — the entire tree (`:60`, `:84`, `:105`). Round 2's
archive move re-keyed the three v1 sidecars (crouch_hide/die/move) out of
their pre-existing `provenance_baseline.txt` / `generator_baseline.txt`
exemption lines, which are written relative to that `assets/` sweep root as
`final/character/player_*_sheet_v1.provenance.json` — the exemption no
longer matches once the file lives under `archive/character/` instead, so
each sidecar's unchanged, always-null `model_hash` / always-unresolvable
synth-fallback `generator` field produces a brand-new `[FAIL]` instead of
the pre-existing documented-gap pass it reported before the move.

RED before the re-key: the three v1 sidecars fail both sweeps outside their
baseline (the exemption lines still say `final/character/...`). GREEN
after: re-keying those lines to `archive/character/...` in both baseline
files restores the exact same pass-via-exemption outcome — no new entry,
no threshold change, same documented gap, new path (acceptance #4).

The v2 trio never needed a baseline exemption (their `model_hash`/
`generator` always resolved on merit) — confirmed here too, so the move
hasn't regressed them into needing one.
"""

from __future__ import annotations

from pathlib import Path

import pytest

provenance_mod = pytest.importorskip("asset_gate.provenance")
generator_mod = pytest.importorskip("asset_gate.generator")

REPO_ROOT = Path(__file__).resolve().parents[4]
ASSETS_ROOT = REPO_ROOT / "assets"

ARCHIVED_V1_STEMS = [
    "player_crouch_hide_sheet_v1",
    "player_die_sheet_v1",
    "player_move_sheet_v1",
]

ARCHIVED_V2_STEMS = [
    "player_crouch_hide_sheet_v2",
    "player_die_sheet_v2",
    "player_move_sheet_v2",
]


def _result_for(results, rel_path: str):
    for result in results:
        if result.details.get("path") == rel_path:
            return result
    raise AssertionError(f"no result for {rel_path} in sweep output")


@pytest.mark.parametrize("stem", ARCHIVED_V1_STEMS)
def test_archived_v1_sidecar_still_baseline_exempt_in_provenance_sweep(stem: str) -> None:
    baseline = provenance_mod.load_baseline()
    results = provenance_mod.sweep_provenance_model_hash(ASSETS_ROOT, baseline=baseline)
    rel = f"archive/character/{stem}.provenance.json"
    result = _result_for(results, rel)
    assert result.passed, (
        f"{rel} is not baseline-exempt in provenance-sweep -- re-key the existing "
        "final/character/... exemption line in provenance_baseline.txt to its archive/ path"
    )
    assert result.details.get("baseline_exempt"), (
        f"{rel} passed provenance-sweep but not via the pre-existing baseline exemption -- "
        "its model_hash should still be null (it's a synth-fallback placeholder)"
    )


@pytest.mark.parametrize("stem", ARCHIVED_V1_STEMS)
def test_archived_v1_sidecar_still_baseline_exempt_in_generator_sweep(stem: str) -> None:
    baseline = generator_mod.load_generator_baseline()
    results = generator_mod.sweep_provenance_generator_resolvable(
        ASSETS_ROOT, repo_root=REPO_ROOT, baseline=baseline
    )
    rel = f"archive/character/{stem}.provenance.json"
    result = _result_for(results, rel)
    assert result.passed, (
        f"{rel} is not baseline-exempt in generator-sweep -- re-key the existing "
        "final/character/... exemption line in generator_baseline.txt to its archive/ path"
    )
    assert result.details.get("baseline_exempt"), (
        f"{rel} passed generator-sweep but not via the pre-existing baseline exemption"
    )


@pytest.mark.parametrize("stem", ARCHIVED_V2_STEMS)
def test_archived_v2_sidecar_passes_both_sweeps_on_merit_not_exemption(stem: str) -> None:
    rel = f"archive/character/{stem}.provenance.json"

    prov_baseline = provenance_mod.load_baseline()
    prov_result = _result_for(
        provenance_mod.sweep_provenance_model_hash(ASSETS_ROOT, baseline=prov_baseline), rel
    )
    assert prov_result.passed and not prov_result.details.get("baseline_exempt"), (
        f"{rel} regressed in provenance-sweep, or now relies on a baseline exemption it "
        "never needed before the move"
    )

    gen_baseline = generator_mod.load_generator_baseline()
    gen_result = _result_for(
        generator_mod.sweep_provenance_generator_resolvable(
            ASSETS_ROOT, repo_root=REPO_ROOT, baseline=gen_baseline
        ),
        rel,
    )
    assert gen_result.passed and not gen_result.details.get("baseline_exempt"), (
        f"{rel} regressed in generator-sweep, or now relies on a baseline exemption it "
        "never needed before the move"
    )


@pytest.mark.parametrize(
    ("baseline_name", "loader"),
    [
        ("provenance_baseline.txt", provenance_mod.load_baseline),
        ("generator_baseline.txt", generator_mod.load_generator_baseline),
    ],
)
def test_baseline_rekey_adds_no_new_entry_and_leaves_no_stale_one(baseline_name, loader) -> None:
    """The re-key swaps three lines' paths in place -- it must not grow
    either baseline file's entry count, and it must not leave the old
    final/character/... line behind alongside the new one (that would be a
    duplicate exemption, not a re-key)."""
    entries = loader()
    archived_stems = set(ARCHIVED_V1_STEMS)

    rekeyed = {
        e
        for e in entries
        if e.startswith("archive/character/player_")
        and e.removeprefix("archive/character/").removesuffix(".provenance.json") in archived_stems
    }
    assert len(rekeyed) == 3, (
        f"{baseline_name}: expected exactly 3 re-keyed archive/character/ entries for the v1 "
        f"trio, found {len(rekeyed)}: {sorted(rekeyed)}"
    )

    stale = {
        e
        for e in entries
        if e.startswith("final/character/player_")
        and e.removeprefix("final/character/").removesuffix(".provenance.json") in archived_stems
    }
    assert not stale, (
        f"{baseline_name}: stale final/character/ exemption(s) for moved assets still present: "
        f"{sorted(stale)} -- re-key in place, don't duplicate"
    )


@pytest.mark.parametrize(
    ("baseline_name", "loader"),
    [
        ("provenance_baseline.txt", provenance_mod.load_baseline),
        ("generator_baseline.txt", generator_mod.load_generator_baseline),
    ],
)
def test_idle_v1_exemption_is_untouched_by_the_rekey(baseline_name, loader) -> None:
    """player_idle_sheet_v1 was never part of this card's archive move --
    its pre-existing exemption line must stay exactly as it was, still keyed
    at final/character/."""
    entries = loader()
    assert "final/character/player_idle_sheet_v1.provenance.json" in entries, (
        f"{baseline_name}: player_idle_sheet_v1's exemption moved or vanished -- it was never "
        "archived by this card and must stay keyed at final/character/"
    )
