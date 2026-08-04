"""Round-2 sweep runner — answers the four questions T-0099 exists to answer.

Round 1 (`sim.run`) tuned E-1/T-1/T-2 within their brackets but never
answered the questions the design docs actually block on
(`docs/design/08-invariants.md` §4, `docs/design/15-server-ops.md` §8,
`docs/design/12-tears.md` §3a):

  1. INV-14  Does population measurably help? ("the pitch depends on this")
  2. DM-5    Recipient-selection policy on bleed/pickup contention
  3. OPS-1   Shard population floor — below which INV-7/INV-8 fail
  4. Chain-key consumption — does the unique pool drain over time?

Run via `python -m sim.run_round2` (writes tools/sim/results/round2_*.json/.csv).
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any

from .config import SimConfig
from .engine import SimEngine
from .types import Rarity

SEED = 42

RESULTS_DIR = Path(__file__).resolve().parents[2] / "results"


def gini(values: list[float]) -> float:
    """Gini coefficient of a non-negative distribution. 0 = perfect equality."""
    n = len(values)
    if n == 0:
        return 0.0
    total = sum(values)
    if total == 0:
        return 0.0
    ordered = sorted(values)
    cum = sum((i + 1) * v for i, v in enumerate(ordered))
    return (2 * cum) / (n * total) - (n + 1) / n


# ---------------------------------------------------------------------------
# Q1 + Q3 — population sweep: does population help (INV-14), and the
# shard population floor where INV-7/INV-8 start failing (OPS-1)
# ---------------------------------------------------------------------------

POPULATION_RANGE: list[int] = [2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200]
# 20,000 ticks: long enough that the fixed cap-fill ramp-up (anchor-limited
# spawn rate, independent of P — see RESULTS-round2.md) is a small fraction
# of the cumulative-since-spawn throughput average at the top of the range,
# without pushing a 15-point x 3-seed sweep past a few minutes of wall clock.
POPULATION_TICKS = 20_000
POPULATION_SEEDS_PER_POINT = 3


def _population_config(p: int) -> SimConfig:
    return SimConfig(initial_population=p, join_rate=0.0, quit_rate=0.0)


def _run_population_point(p: int, ticks: int, seed: int) -> dict[str, Any]:
    cfg = _population_config(p)
    engine = SimEngine(cfg, seed=seed)
    violations = []
    for _ in range(ticks):
        violations.extend(engine.tick())

    ticks_with: dict[str, set[int]] = {}
    for v in violations:
        ticks_with.setdefault(v.invariant, set()).add(v.tick)

    steady_state = [rate for (_t, _pop, rate) in engine._pop_throughput_history]
    avg_throughput = sum(steady_state) / len(steady_state) if steady_state else 0.0

    return {
        "avg_steady_state_items_per_hour": avg_throughput,
        "inv7_tick_fraction": len(ticks_with.get("INV-7", set())) / ticks,
        "inv8_tick_fraction": len(ticks_with.get("INV-8", set())) / ticks,
        "inv9_tick_fraction": len(ticks_with.get("INV-9", set())) / ticks,
    }


def run_population_sweep(
    population_range: list[int] = POPULATION_RANGE,
    ticks: int = POPULATION_TICKS,
    seed: int = SEED,
    seeds_per_point: int = POPULATION_SEEDS_PER_POINT,
) -> list[dict[str, Any]]:
    """Fixed-P runs across a wide range — isolates P as the sole independent variable.

    Whether the two rare gating types end up simultaneously covered is
    largely decided once, at spawner cap-fill time, and then sticks for the
    rest of a run (rare instances essentially never get destroyed while
    under cap — see RESULTS-round2.md). A single seed is therefore noisy at
    low-to-moderate P; each point averages `seeds_per_point` independent
    seeds to separate the real population effect from that per-seed luck.

    `_pop_throughput_history` is capped to the last 200 observations by the
    engine, so an unfiltered average over it is already the steady-state
    tail of a `ticks`-long run — no separate warm-up window needed.
    """
    rows = []
    for p in population_range:
        seeds = [seed + i for i in range(seeds_per_point)]
        points = [_run_population_point(p, ticks, s) for s in seeds]

        def avg(key: str) -> float:
            return sum(pt[key] for pt in points) / len(points)

        rows.append(
            {
                "population": p,
                "ticks_run": ticks,
                "seeds": seeds,
                "avg_steady_state_items_per_hour": avg("avg_steady_state_items_per_hour"),
                "inv7_tick_fraction": avg("inv7_tick_fraction"),
                "inv7_tick_fraction_min": min(pt["inv7_tick_fraction"] for pt in points),
                "inv7_tick_fraction_max": max(pt["inv7_tick_fraction"] for pt in points),
                "inv8_tick_fraction": avg("inv8_tick_fraction"),
                "inv9_tick_fraction": avg("inv9_tick_fraction"),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Q2 — DM-5: recipient-selection policy on bleed/pickup contention
# ---------------------------------------------------------------------------

DM5_POLICIES: list[str] = ["fifo", "random", "need_weighted"]
DM5_POPULATION = 20
DM5_TICKS = 6_000


def _dm5_config(policy: str) -> SimConfig:
    return SimConfig(
        initial_population=DM5_POPULATION,
        join_rate=0.0,
        quit_rate=0.0,
        recipient_policy=policy,
        # Deliberately scarce relative to P so agents actually compete for
        # the same pickup within a tick — otherwise policy can't matter.
        k_c=0.2,
        k_r=0.05,
        unique_count=2,
        pickup_probability=0.5,
        transfer_probability=0.3,
        held_bleed_min=20,
        held_bleed_max=30,
        world_bleed_min=100,
        world_bleed_max=150,
        spawn_rate_common=0.02,
        spawn_rate_rare=0.005,
    )


def run_dm5_sweep(
    policies: list[str] = DM5_POLICIES,
    ticks: int = DM5_TICKS,
    seed: int = SEED,
) -> list[dict[str, Any]]:
    rows = []
    for policy in policies:
        cfg = _dm5_config(policy)
        engine = SimEngine(cfg, seed=seed)
        result = engine.run(ticks)
        received = [a.items_received for a in engine.state.agents.values()]

        rows.append(
            {
                "policy": policy,
                "seed": seed,
                "ticks_run": ticks,
                "population": DM5_POPULATION,
                "gini_items_received": gini(received),
                "min_items_received": min(received),
                "max_items_received": max(received),
                "mean_items_received": sum(received) / len(received),
                "violation_summary": result.violation_summary(),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Q4 — chain-key consumption / unique drain (12 §3a, 07 §2, 14/19/20)
# ---------------------------------------------------------------------------

CHAINKEY_MODES: list[str] = ["destroy", "transfer"]
TICKS_PER_WEEK = 10_080  # 7 * 24 * 60, 1 tick = 1 minute
CHAINKEY_WEEKS = 3
CHAINKEY_TICKS = CHAINKEY_WEEKS * TICKS_PER_WEEK
CHAINKEY_SAMPLE_EVERY = 60  # hourly — fine enough to resolve a fast initial drain


def _chainkey_config(mode: str) -> SimConfig:
    return SimConfig(
        initial_population=20,
        join_rate=0.05,  # steady influx of new players who each need to cross
        quit_rate=0.001,
        unique_count=5,
        chain_key_enabled=True,
        chain_key_mode=mode,
        chain_key_crossings_required=2,
    )


def run_chain_key_sweep(
    modes: list[str] = CHAINKEY_MODES,
    ticks: int = CHAINKEY_TICKS,
    sample_every: int = CHAINKEY_SAMPLE_EVERY,
    seed: int = SEED,
) -> dict[str, Any]:
    """Returns {"series": [...], "summary": [...]} — a per-mode unique-pool drain curve."""
    series: list[dict[str, Any]] = []
    summary: list[dict[str, Any]] = []

    for mode in modes:
        cfg = _chainkey_config(mode)
        engine = SimEngine(cfg, seed=seed)
        exhausted_at: int | None = None
        zero_samples = 0
        total_samples = 0

        for t in range(1, ticks + 1):
            engine.tick()
            if t % sample_every == 0 or t == ticks:
                unique_count = sum(
                    1 for it in engine.state.items.values() if it.rarity == Rarity.UNIQUE
                )
                series.append({"mode": mode, "tick": t, "unique_count": unique_count})
                total_samples += 1
                if unique_count == 0:
                    zero_samples += 1
                    if exhausted_at is None:
                        exhausted_at = t

        final_unique_count = sum(
            1 for it in engine.state.items.values() if it.rarity == Rarity.UNIQUE
        )
        total_crossings = sum(a.chain_progress for a in engine.state.agents.values())

        summary.append(
            {
                "mode": mode,
                "seed": seed,
                "ticks_run": ticks,
                "unique_count_initial": cfg.unique_count,
                "unique_count_final": final_unique_count,
                "exhausted_at_tick": exhausted_at,
                "exhausted_at_week": (exhausted_at / TICKS_PER_WEEK) if exhausted_at else None,
                "fraction_of_run_at_zero": zero_samples / total_samples if total_samples else 0.0,
                "total_chain_crossings_completed": total_crossings,
                "final_population": engine.state.population,
            }
        )

    return {"series": series, "summary": summary}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def _write_json(rows: Any, path: Path) -> None:
    path.write_text(json.dumps(rows, indent=2) + "\n")


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    if not rows:
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            flat = dict(row)
            for key, val in flat.items():
                if isinstance(val, dict):
                    flat[key] = json.dumps(val)
            writer.writerow(flat)


def main() -> None:  # pragma: no cover
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    population_rows = run_population_sweep()
    _write_json(population_rows, RESULTS_DIR / "round2_population.json")
    _write_csv(population_rows, RESULTS_DIR / "round2_population.csv")

    dm5_rows = run_dm5_sweep()
    _write_json(dm5_rows, RESULTS_DIR / "round2_dm5.json")
    _write_csv(dm5_rows, RESULTS_DIR / "round2_dm5.csv")

    chainkey = run_chain_key_sweep()
    _write_json(chainkey, RESULTS_DIR / "round2_chainkey.json")
    _write_csv(chainkey["series"], RESULTS_DIR / "round2_chainkey_series.csv")
    _write_csv(chainkey["summary"], RESULTS_DIR / "round2_chainkey_summary.csv")

    print(f"wrote round2 sweeps to {RESULTS_DIR}")
    sys.exit(0)


if __name__ == "__main__":  # pragma: no cover
    main()
