"""Round-3 sweep runner — E-4: k_c, k_r, unique_count swept with population.

Round 2 reported P≈20 as the shard-population floor under a single set of
rarity-cap constants (k_c=2.0, k_r=0.2, unique_count=5). Three seeds at P=30
already showed an 8× spread (2.4%–19.2%) in the transition zone, indicating the
floor is a function of the unswept constants rather than a stable scalar.

This round sweeps k_c, k_r, unique_count jointly with population and derives the
floor as a surface over (k_r, unique_count) — the axes that actually gate rare
gating type coverage (INV-7). k_c controls the common cap and has only an indirect
effect on INV-7 via pickup dilution (fewer common items → agents pick up rares
relatively more often); it is still swept to quantify this coupling.

E-4 open question: docs/design/07-items-economy.md §9.
OPS-1 context: docs/design/15-server-ops.md §8.
Task: T-0132.
"""

from __future__ import annotations

import csv
import json
import sys
from itertools import product
from pathlib import Path
from typing import Any

from .config import SimConfig
from .engine import SimEngine

# Default violation-rate threshold below which a population is deemed adequate.
# A tick-fraction below this means INV-7 (rare gating coverage) is satisfied
# for the overwhelming majority of simulated time at this parameter combination.
FLOOR_THRESHOLD: float = 0.05

RESULTS_DIR = Path(__file__).resolve().parents[2] / "results"


# ---------------------------------------------------------------------------
# Core sweep
# ---------------------------------------------------------------------------


def _run_one_point(
    k_c: float,
    k_r: float,
    unique_count: int,
    population: int,
    ticks: int,
    seed: int,
) -> dict[str, Any]:
    """Run the engine for one (k_c, k_r, unique_count, P, seed) combination."""
    cfg = SimConfig(
        initial_population=population,
        join_rate=0.0,
        quit_rate=0.0,
        k_c=k_c,
        k_r=k_r,
        unique_count=unique_count,
    )
    engine = SimEngine(cfg, seed=seed)
    violations = []
    for _ in range(ticks):
        violations.extend(engine.tick())

    ticks_with_inv7: set[int] = set()
    for v in violations:
        if v.invariant == "INV-7":
            ticks_with_inv7.add(v.tick)

    return {
        "inv7_tick_fraction": len(ticks_with_inv7) / ticks,
    }


def run_e4_sweep(
    kr_values: list[float],
    kc_values: list[float],
    unique_count_values: list[int],
    population_range: list[int],
    ticks: int,
    seed: int,
    seeds_per_point: int = 1,
) -> list[dict[str, Any]]:
    """Sweep k_c, k_r, unique_count jointly with population.

    For each combination of (k_c, k_r, unique_count, P), runs `seeds_per_point`
    independent seeds and averages the results. Returns one row per combination.

    @param kr_values          k_r values to sweep.
    @param kc_values          k_c values to sweep.
    @param unique_count_values unique_count values to sweep.
    @param population_range   Population values to sweep.
    @param ticks              Simulated minutes per run.
    @param seed               Base seed; per-seed offsets are 0, 1, …, seeds_per_point-1.
    @param seeds_per_point    Number of independent seeds averaged per data point.
    @return                   List of row dicts, one per (k_c, k_r, unique_count, P).
    """
    rows: list[dict[str, Any]] = []

    for k_c, k_r, unique_count, population in product(
        kc_values, kr_values, unique_count_values, population_range
    ):
        seeds = [seed + i for i in range(seeds_per_point)]
        points = [_run_one_point(k_c, k_r, unique_count, population, ticks, s) for s in seeds]

        avg_frac = sum(pt["inv7_tick_fraction"] for pt in points) / len(points)
        min_frac = min(pt["inv7_tick_fraction"] for pt in points)
        max_frac = max(pt["inv7_tick_fraction"] for pt in points)

        rows.append(
            {
                "k_c": k_c,
                "k_r": k_r,
                "unique_count": unique_count,
                "population": population,
                "ticks_run": ticks,
                "seeds": seeds,
                "inv7_tick_fraction": avg_frac,
                "inv7_tick_fraction_min": min_frac,
                "inv7_tick_fraction_max": max_frac,
            }
        )

    return rows


# ---------------------------------------------------------------------------
# Floor surface derivation
# ---------------------------------------------------------------------------


def population_floor_surface(
    raw_rows: list[dict[str, Any]],
    threshold: float = FLOOR_THRESHOLD,
) -> list[dict[str, Any]]:
    """Derive the population floor surface from a completed E-4 sweep.

    Groups rows by (k_c, k_r, unique_count) and finds the minimum population P
    at which inv7_tick_fraction first drops below `threshold`. This converts
    the raw sweep data into a compact surface over the constant axes.

    @param raw_rows  Output of run_e4_sweep (or any list of compatible dicts).
    @param threshold INV-7 tick-fraction threshold that defines "adequate" population.
    @return          One row per (k_c, k_r, unique_count) triple, with floor_population
                     set to the minimum adequate P, or None if no P in the data clears
                     the threshold.
    """
    # Group by (k_c, k_r, unique_count)
    groups: dict[tuple[float, float, int], list[dict[str, Any]]] = {}
    for row in raw_rows:
        key = (row["k_c"], row["k_r"], row["unique_count"])
        groups.setdefault(key, []).append(row)

    surface: list[dict[str, Any]] = []
    for (k_c, k_r, unique_count), group_rows in groups.items():
        # Find minimum P where inv7_tick_fraction < threshold
        adequate = [r for r in group_rows if r["inv7_tick_fraction"] < threshold]
        floor_population: int | None = min(r["population"] for r in adequate) if adequate else None

        surface.append(
            {
                "k_c": k_c,
                "k_r": k_r,
                "unique_count": unique_count,
                "floor_population": floor_population,
                "floor_threshold": threshold,
            }
        )

    return surface


# ---------------------------------------------------------------------------
# Default sweep parameters (full production run)
# ---------------------------------------------------------------------------

KR_VALUES: list[float] = [0.05, 0.1, 0.2, 0.3, 0.5]
KC_VALUES: list[float] = [0.5, 1.0, 2.0, 4.0]
UNIQUE_COUNT_VALUES: list[int] = [3, 5, 8]
POPULATION_RANGE: list[int] = [5, 10, 15, 20, 30, 50, 75, 100]
TICKS: int = 10_000
SEEDS_PER_POINT: int = 3
SEED: int = 42


# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------


def _write_json(data: Any, path: Path) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


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
                if isinstance(val, (list, dict)):
                    flat[key] = json.dumps(val)
            writer.writerow(flat)


def main() -> None:  # pragma: no cover
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    raw = run_e4_sweep(
        kr_values=KR_VALUES,
        kc_values=KC_VALUES,
        unique_count_values=UNIQUE_COUNT_VALUES,
        population_range=POPULATION_RANGE,
        ticks=TICKS,
        seed=SEED,
        seeds_per_point=SEEDS_PER_POINT,
    )
    _write_json(raw, RESULTS_DIR / "round3_e4_sweep.json")
    _write_csv(raw, RESULTS_DIR / "round3_e4_sweep.csv")

    surface = population_floor_surface(raw, threshold=FLOOR_THRESHOLD)
    _write_json(surface, RESULTS_DIR / "round3_floor_surface.json")
    _write_csv(surface, RESULTS_DIR / "round3_floor_surface.csv")

    print(f"wrote round3 E-4 sweep to {RESULTS_DIR}")
    sys.exit(0)


if __name__ == "__main__":  # pragma: no cover
    main()
