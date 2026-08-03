"""Pre-built sweep scenarios from docs/design/08-invariants.md §4.

All sweeps use compressed time (ticks represent compressed durations)
so they are CI-runnable in seconds. The structure is identical to full-scale
runs — only the parameter magnitudes differ.

Nine scenarios:
  p2_sustained      Is the smallest viable game actually playable?
  growth            Does the spawner keep up as P: 2 → large?
  collapse          Over-supply management: P: large → 200
  mass_exodus       80% quit — does scatter absorb it?
  hoarder_cohort    20% never transfer — does bleed reclaim enough?
  unique_circulation Do uniques keep moving or park with idle players?
  veteran_vs_new    Run length in band for both? (INV-9)
  population_helps  Median time-to-completion falls as P rises (INV-14)
  collapse_race     Fraction of universes expiring mid-delivery (INV-8)
"""

from __future__ import annotations

from .config import SimConfig
from .engine import SimEngine
from .types import SimResult


# ---------------------------------------------------------------------------
# Shared base for compressed-time CI runs
# ---------------------------------------------------------------------------


def _base(**overrides: object) -> SimConfig:
    """SimConfig with compressed time for CI-speed runs (~seconds, not hours)."""
    defaults: dict[str, object] = dict(
        initial_population=10,
        k_c=2.0,
        k_r=0.2,
        unique_count=2,
        num_item_types_common=3,
        num_item_types_rare=2,
        num_gating_types=2,
        num_anchors=5,
        # Compressed bleed durations
        held_bleed_min=5,
        held_bleed_max=10,
        world_bleed_min=50,
        world_bleed_max=100,
        unique_held_bleed_multiplier=2.0,
        # Compressed decay
        unlock_decay_tactical=5,
        unlock_decay_session=30,
        unlock_decay_unique_keyed=150,
        # Compressed collapse
        collapse_duration=500,
        first_universe_multiplier=1.5,
        # Faster spawn for compressed time
        spawn_rate_common=0.05,
        spawn_rate_rare=0.005,
        landing_curve_steepness=1.0,
        join_rate=0.0,
        quit_rate=0.0,
        idle_probability=0.1,
        hoarder_fraction=0.0,
        pickup_probability=0.1,
        transfer_probability=0.05,
        # Wide band — narrow band tests belong in test_invariants.py
        min_items_per_hour=0.0,
        max_items_per_hour=10000.0,
        throughput_window_ticks=60,
        encounter_rate_per_world_item=0.05,
    )
    defaults.update(overrides)
    return SimConfig(**defaults)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Sweep functions — each returns SimResult (or tuple for multi-cohort)
# ---------------------------------------------------------------------------


def sweep_p2_sustained(seed: int = 42) -> SimResult:
    """P = 2, no joins or quits. Verifies the minimum viable game is playable.

    Collapse duration is set above the run length so population stays at 2
    throughout — the goal is to verify item flow and invariants at minimum scale.
    """
    cfg = _base(
        initial_population=2,
        join_rate=0.0,
        quit_rate=0.0,
        collapse_duration=1500,          # 1500 * 1.5 = 2250 > 1000 tick run
    )
    return SimEngine(cfg, seed=seed).run(1000)


def sweep_growth(seed: int = 42) -> SimResult:
    """P grows from 2 → large via continuous joins, no quits.
    Spawner must keep up with demand as caps scale.
    """
    cfg = _base(initial_population=2, join_rate=1.0, quit_rate=0.0)
    return SimEngine(cfg, seed=seed).run(1000)


def sweep_collapse(seed: int = 42) -> SimResult:
    """P shrinks from peak to ~200 via high quit rate.
    Tests over-supply management — the landing probability is the sole regulator.
    """
    cfg = _base(initial_population=100, join_rate=0.0, quit_rate=0.05)
    return SimEngine(cfg, seed=seed).run(1000)


def sweep_mass_exodus(seed: int = 42) -> SimResult:
    """80% of the population quits in a compressed week.
    Quit == scatter (D-8); economy must not drain.
    """
    cfg = _base(initial_population=50, join_rate=0.0, quit_rate=0.15)
    return SimEngine(cfg, seed=seed).run(200)


def sweep_hoarder_cohort(seed: int = 42) -> SimResult:
    """20% of agents never voluntarily transfer items.
    Bleed must reclaim enough to keep gating types in circulation.
    """
    cfg = _base(initial_population=20, hoarder_fraction=0.2)
    return SimEngine(cfg, seed=seed).run(1000)


def sweep_unique_circulation(seed: int = 42) -> SimResult:
    """Unique items must keep circulating — never permanently parked.
    Unique held bleed ensures movement even if holder goes idle.
    """
    cfg = _base(
        initial_population=10,
        unique_count=2,
        pickup_probability=0.2,
        unique_held_bleed_multiplier=1.5,
    )
    return SimEngine(cfg, seed=seed).run(1000)


def sweep_veteran_vs_new(seed: int = 42) -> tuple[SimResult, SimResult]:
    """Two cohorts: veterans (warm run) and fresh starters.
    Both must stay in the INV-9 experience band.
    """
    veteran_cfg = _base(initial_population=10, join_rate=0.1, quit_rate=0.0)
    new_cfg = _base(initial_population=10, join_rate=0.0, quit_rate=0.0)

    veteran_engine = SimEngine(veteran_cfg, seed=seed)
    # Warm up veterans for 500 ticks before measuring
    veteran_engine.run(500)
    veteran_result = veteran_engine.run(500)

    new_result = SimEngine(new_cfg, seed=seed + 1).run(500)
    return veteran_result, new_result


def sweep_population_helps(seed: int = 42) -> tuple[SimResult, SimResult]:
    """Low-P vs. high-P stable populations. INV-14: higher P ≥ throughput.
    Caps scale with P so more players → more supply → throughput should not drop.
    """
    low_cfg = _base(initial_population=2, join_rate=0.0, quit_rate=0.0)
    high_cfg = _base(initial_population=20, join_rate=0.0, quit_rate=0.0)
    low_result = SimEngine(low_cfg, seed=seed).run(1000)
    high_result = SimEngine(high_cfg, seed=seed).run(1000)
    return low_result, high_result


def sweep_collapse_race(seed: int = 42) -> SimResult:
    """Universe collapses while gating-type delivery is still in flight.
    Exercises INV-8: collapse may expire before encounter is possible.
    Violations are informational findings, not engine bugs.
    """
    cfg = _base(
        initial_population=5,
        collapse_duration=80,       # very short collapse window
        first_universe_multiplier=1.0,
        spawn_rate_rare=0.0001,     # rare items appear slowly
        encounter_rate_per_world_item=0.001,  # hard to find
    )
    return SimEngine(cfg, seed=seed).run(150)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:  # pragma: no cover
    """Run all sweeps and print a summary table."""
    import sys

    sweeps_single = [
        ("p2_sustained", sweep_p2_sustained),
        ("growth", sweep_growth),
        ("collapse", sweep_collapse),
        ("mass_exodus", sweep_mass_exodus),
        ("hoarder_cohort", sweep_hoarder_cohort),
        ("unique_circulation", sweep_unique_circulation),
        ("collapse_race", sweep_collapse_race),
    ]
    sweeps_dual = [
        ("veteran_vs_new", sweep_veteran_vs_new),
        ("population_helps", sweep_population_helps),
    ]

    print(f"{'Scenario':<25} {'Ticks':>6} {'Pop':>6} {'Items':>6} {'Violations':>10}")
    print("-" * 60)

    for name, fn in sweeps_single:
        r = fn()
        summary = r.violation_summary()
        vstr = ", ".join(f"{k}:{v}" for k, v in summary.items()) if summary else "—"
        print(f"{name:<25} {r.ticks_run:>6} {r.final_population:>6} {r.final_item_count:>6} {vstr:>10}")

    for name, fn in sweeps_dual:
        r1, r2 = fn()
        s1 = r1.violation_summary()
        s2 = r2.violation_summary()
        any_v = {**s1, **s2}
        vstr = ", ".join(f"{k}:{v}" for k, v in any_v.items()) if any_v else "—"
        print(
            f"{name:<25} {r1.ticks_run + r2.ticks_run:>6} "
            f"{r1.final_population + r2.final_population:>6} "
            f"{r1.final_item_count + r2.final_item_count:>6} {vstr:>10}"
        )

    print("-" * 60)
    sys.exit(0)
