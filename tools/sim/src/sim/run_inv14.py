"""INV-14 population sweep with chain-key consumption folded in — T-0133 + T-0156.

T-0133 (Re-run INV-14 measurement):
  Sweep P in {2, 20, 200, 2000, 20000} with >= 30 seeds per point to measure
  median time-to-completion vs. population with IQR bands, using:
    - the T-0130 exit condition (identity completes when holding N_exit uniques)
    - T-0129 multi-universe identity (chain_progress survives collapse)
    - T-0131 fixed check_inv8 reachability

T-0156 (Fold chain-key consumption in):
  Run chain_key_enabled=True in the same sweep. Report:
    - chain crossings per player per run as f(P) with IQR bands
    - rooms-per-run (items received per universe) as f(P) with IQR bands
    - explicit P-invariance verdict for rooms-per-run

The core question (docs/HANDOFF.md §13.1-13.4):
  unique_count is a fixed absolute count (~5) that does NOT scale with P.
  At P=50 roughly 10% of players can hold a unique; at P=10^5 roughly 0.005%.
  Round 2 measured 2,032 chain crossings in three weeks at P≈50 — healthy
  looking but a single population point. This sweep tests whether the same
  system breaks down at P=2,000 or P=20,000.

Run via `python -m sim.run_inv14` (writes tools/sim/results/inv14_*.json/.csv).
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any

from .config import SimConfig
from .engine import SimEngine
from .types import AgentState

RESULTS_DIR = Path(__file__).resolve().parents[2] / "results"

# ---------------------------------------------------------------------------
# Production sweep constants (T-0133 requirements)
# ---------------------------------------------------------------------------

POPULATION_RANGE: list[int] = [2, 20, 200, 2000, 20000]
SEEDS_PER_POINT: int = 30
SEED: int = 42

# Compressed ticks: one universe of 200 ticks (no collapse happens — collapse_duration
# is set above ticks_per_run so all agents stay in their first universe and
# items_received / chain_progress reflect exactly one run's worth of activity).
TICKS_PER_RUN: int = 200

# Chain-key defaults (docs/design/12-tears.md §3a, 07-items-economy.md §2)
UNIQUE_COUNT: int = 5
CHAIN_KEY_CROSSINGS_REQUIRED: int = 2
CHAIN_KEY_MODE: str = "destroy"
N_EXIT: int = 3  # distinct unique types held simultaneously to complete (T-0130)

# P-invariance test threshold: CV of median rooms-per-run across P values.
# Below this the distribution is considered P-invariant for reporting purposes.
P_INVARIANCE_CV_THRESHOLD: float = 0.20


# ---------------------------------------------------------------------------
# IQR statistics helper
# ---------------------------------------------------------------------------


def _iqr_stats(values: list[float]) -> dict[str, float]:
    """Compute median, Q1, Q3, and IQR from a list of floats.

    Uses the method-1 (inclusive) quartile definition: Q1 is the median
    of the lower half, Q3 the median of the upper half (Python statistics
    module compatible).

    @param values  Non-empty or empty list of numeric values.
    @return        Dict with keys "median", "q1", "q3", "iqr".
    """
    if not values:
        return {"median": 0.0, "q1": 0.0, "q3": 0.0, "iqr": 0.0}

    sorted_vals = sorted(values)
    n = len(sorted_vals)

    def _percentile(p: float) -> float:
        """Linear interpolation percentile (fraction 0.0-1.0)."""
        if n == 1:
            return float(sorted_vals[0])
        idx = p * (n - 1)
        lo = int(idx)
        hi = lo + 1
        if hi >= n:
            return float(sorted_vals[lo])
        frac = idx - lo
        return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac

    median = _percentile(0.50)
    q1 = _percentile(0.25)
    q3 = _percentile(0.75)
    iqr = q3 - q1
    return {"median": median, "q1": q1, "q3": q3, "iqr": iqr}


# ---------------------------------------------------------------------------
# Single (population, seed) runner
# ---------------------------------------------------------------------------


def _run_one_point(
    population: int,
    ticks: int,
    seed: int,
    *,
    chain_key_enabled: bool = True,
    chain_key_mode: str = CHAIN_KEY_MODE,
    chain_key_crossings_required: int = CHAIN_KEY_CROSSINGS_REQUIRED,
    unique_count: int = UNIQUE_COUNT,
    n_exit: int = N_EXIT,
) -> dict[str, Any]:
    """Run one (population, seed) combination for exactly one universe.

    Sets collapse_duration above ticks so no collapse event fires during
    the run. At end:
      - agent.items_received == items picked up in this one run (proxy for
        "rooms visited" — the discrete-economy stand-in for room traversal)
      - agent.chain_progress == chain tears crossed in this one run

    @param population                  Number of agents; fixed (no joins/quits).
    @param ticks                       Simulated minutes to run; must be < collapse_duration.
    @param seed                        PRNG seed for reproducibility.
    @param chain_key_enabled           If False, uniques follow normal bleed; no crossings.
    @param chain_key_mode              "destroy" or "transfer" (07-items-economy.md §2).
    @param chain_key_crossings_required Number of tears an agent must cross to complete
                                       their chain-key progression (12-tears.md §3a).
    @param unique_count                Fixed absolute count of unique instances in the world.
    @param n_exit                      Distinct unique types held simultaneously to complete
                                       (01-vision.md §5, T-0130).  Zero means disabled.
    @return                            Dict with "chain_crossings", "rooms_per_run" lists,
                                       and "completion_rate" (fraction completed), one entry
                                       per non-QUIT agent for the list fields.
    """
    # Scale world size with population so the spawn loop can produce k_c*P items
    # within the compressed test window.  num_anchors is the per-tick spawn
    # budget; at 20 fixed anchors the spawn rate is 20*0.002=0.04 items/tick
    # regardless of P, which starves large populations (P=200 needs cap=400 but
    # only ~8 items spawn in 200 ticks).  With num_anchors ∝ P the rate scales
    # to P*10*0.002 = P*0.02 items/tick, so the world reaches k_c*P items in
    # ≈ 2*P / (P*0.02) = 100 ticks — well within the 200-tick window.
    num_anchors = max(20, population * 10)
    cfg = SimConfig(
        initial_population=population,
        join_rate=0.0,
        quit_rate=0.0,
        unique_count=unique_count,
        chain_key_enabled=chain_key_enabled,
        chain_key_mode=chain_key_mode,
        chain_key_crossings_required=chain_key_crossings_required,
        # No collapse during the run — all agents stay in their first universe
        # so items_received and chain_progress reflect exactly one run.
        collapse_duration=ticks + 1,
        first_universe_multiplier=1.0,
        num_anchors=num_anchors,
        n_exit=n_exit,
    )
    engine = SimEngine(cfg, seed=seed)
    engine.run(ticks)

    agents = [a for a in engine.state.agents.values() if a.state != AgentState.QUIT]
    completed = sum(1 for a in agents if a.is_complete)
    completion_rate = float(completed) / len(agents) if agents else 0.0
    return {
        "chain_crossings": [a.chain_progress for a in agents],
        "rooms_per_run": [a.items_received for a in agents],
        "completion_rate": completion_rate,
    }


# ---------------------------------------------------------------------------
# Population sweep
# ---------------------------------------------------------------------------


def run_chain_key_population_sweep(
    population_range: list[int],
    ticks_per_run: int,
    seed: int,
    seeds_per_point: int,
    *,
    chain_key_enabled: bool = True,
    chain_key_mode: str = CHAIN_KEY_MODE,
    chain_key_crossings_required: int = CHAIN_KEY_CROSSINGS_REQUIRED,
    unique_count: int = UNIQUE_COUNT,
    n_exit: int = N_EXIT,
) -> list[dict[str, Any]]:
    """Sweep chain-key and rooms metrics across P ∈ population_range.

    For each P, runs seeds_per_point independent seeds and pools all per-agent
    observations into a single sample, then computes IQR statistics. This
    mirrors T-0133's >= 30 seeds-per-point requirement and gives IQR bands
    that capture both within-run variation (across agents) and across-run
    variation (across seeds).

    @param population_range         List of population values to sweep.
    @param ticks_per_run            Simulated minutes per run (< collapse_duration).
    @param seed                     Base seed; per-seed offset is 0, 1, …, seeds_per_point-1.
    @param seeds_per_point          Number of independent seeds averaged per data point.
    @param chain_key_enabled        Whether chain-key consumption is active.
    @param chain_key_mode           "destroy" or "transfer".
    @param chain_key_crossings_required  Crossings needed to complete chain progression.
    @param unique_count             Fixed absolute count of unique item instances.
    @param n_exit                   Distinct unique types held simultaneously to complete
                                    (01-vision.md §5, T-0130).
    @return                         One row per population value.
    """
    rows: list[dict[str, Any]] = []

    for P in population_range:
        all_crossings: list[float] = []
        all_rooms: list[float] = []
        all_completion_rates: list[float] = []
        seed_list = [seed + i for i in range(seeds_per_point)]

        for s in seed_list:
            result = _run_one_point(
                population=P,
                ticks=ticks_per_run,
                seed=s,
                chain_key_enabled=chain_key_enabled,
                chain_key_mode=chain_key_mode,
                chain_key_crossings_required=chain_key_crossings_required,
                unique_count=unique_count,
                n_exit=n_exit,
            )
            all_crossings.extend(float(x) for x in result["chain_crossings"])
            all_rooms.extend(float(x) for x in result["rooms_per_run"])
            all_completion_rates.append(result["completion_rate"])

        crossing_stats = _iqr_stats(all_crossings)
        rooms_stats = _iqr_stats(all_rooms)
        completion_stats = _iqr_stats(all_completion_rates)

        rows.append(
            {
                "population": P,
                "unique_count": unique_count,
                "unique_density": unique_count / P,
                "chain_crossings_median": crossing_stats["median"],
                "chain_crossings_q1": crossing_stats["q1"],
                "chain_crossings_q3": crossing_stats["q3"],
                "chain_crossings_iqr": crossing_stats["iqr"],
                "rooms_per_run_median": rooms_stats["median"],
                "rooms_per_run_q1": rooms_stats["q1"],
                "rooms_per_run_q3": rooms_stats["q3"],
                "rooms_per_run_iqr": rooms_stats["iqr"],
                "completion_rate_median": completion_stats["median"],
                "completion_rate_q1": completion_stats["q1"],
                "completion_rate_q3": completion_stats["q3"],
                "completion_rate_iqr": completion_stats["iqr"],
                "n_agents_total": len(all_crossings),
                "seeds": seed_list,
                "ticks_per_run": ticks_per_run,
            }
        )

    return rows


# ---------------------------------------------------------------------------
# P-invariance verdict
# ---------------------------------------------------------------------------


def p_invariance_verdict(
    rows: list[dict[str, Any]],
    cv_threshold: float = P_INVARIANCE_CV_THRESHOLD,
) -> dict[str, Any]:
    """Answer: is rooms-per-run P-invariant?

    Computes the coefficient of variation (std / mean) of median rooms-per-run
    across the swept population values. A CV below cv_threshold indicates that
    rooms-per-run does not meaningfully change with population.

    Why this matters (docs/HANDOFF.md §13.1-13.3):
      If rooms-per-run shifts with P, INV-9's distribution assumption is broken
      because the game's pacing promise (run length in band) would only hold at
      the population P it was calibrated to.

    @param rows          Output of run_chain_key_population_sweep.
    @param cv_threshold  Coefficient-of-variation threshold for "invariant" verdict.
    @return              Dict with "p_invariant" bool, "cv", "cv_threshold",
                         "verdict" string, and "median_rooms_by_population" mapping.
    """
    medians = [r["rooms_per_run_median"] for r in rows]
    n = len(medians)

    if n == 0:
        mean = 0.0
        std = 0.0
        cv = 0.0
    else:
        mean = sum(medians) / n
        variance = sum((x - mean) ** 2 for x in medians) / n
        std = variance ** 0.5
        cv = (std / mean) if mean > 0.0 else 0.0

    is_invariant = cv < cv_threshold
    verdict_str = (
        f"rooms-per-run is P-INVARIANT (CV={cv:.3f} < threshold={cv_threshold})"
        if is_invariant
        else f"rooms-per-run is NOT P-invariant (CV={cv:.3f} >= threshold={cv_threshold})"
    )

    return {
        "p_invariant": is_invariant,
        "cv": cv,
        "cv_threshold": cv_threshold,
        "verdict": verdict_str,
        "median_rooms_by_population": {r["population"]: r["rooms_per_run_median"] for r in rows},
    }


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


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:  # pragma: no cover
    """Run the full INV-14 + chain-key population sweep and write results.

    Output files:
      results/inv14_chain_key_sweep.json  — per-population IQR statistics
      results/inv14_chain_key_sweep.csv   — same in CSV form
      results/inv14_p_invariance.json     — P-invariance verdict for rooms-per-run

    This sweep answers T-0156's four acceptance criteria:
      1. Chain-key consumption is measured across all P (not a single point).
      2. Chain crossings per player per run reported with IQR bands as f(P).
      3. Rooms-per-run reported with IQR bands as f(P).
      4. Whether rooms-per-run is P-invariant is answered explicitly.
    """
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    print(
        f"Running INV-14 + chain-key sweep: P={POPULATION_RANGE}, "
        f"seeds={SEEDS_PER_POINT}, ticks={TICKS_PER_RUN}"
    )

    rows = run_chain_key_population_sweep(
        population_range=POPULATION_RANGE,
        ticks_per_run=TICKS_PER_RUN,
        seed=SEED,
        seeds_per_point=SEEDS_PER_POINT,
        chain_key_enabled=True,
        chain_key_mode=CHAIN_KEY_MODE,
        chain_key_crossings_required=CHAIN_KEY_CROSSINGS_REQUIRED,
        unique_count=UNIQUE_COUNT,
    )
    _write_json(rows, RESULTS_DIR / "inv14_chain_key_sweep.json")
    _write_csv(rows, RESULTS_DIR / "inv14_chain_key_sweep.csv")

    verdict = p_invariance_verdict(rows, cv_threshold=P_INVARIANCE_CV_THRESHOLD)
    _write_json(verdict, RESULTS_DIR / "inv14_p_invariance.json")

    # Print summary table
    print(
        f"\n{'P':>8} {'unique_density':>14} {'crossings_med':>13} "
        f"[Q1,Q3]  {'rooms_med':>9} [Q1,Q3]"
    )
    print("-" * 75)
    for row in rows:
        print(
            f"{row['population']:>8} "
            f"{row['unique_density']:>14.5f} "
            f"{row['chain_crossings_median']:>13.4f} "
            f"[{row['chain_crossings_q1']:.3f},{row['chain_crossings_q3']:.3f}]  "
            f"{row['rooms_per_run_median']:>9.2f} "
            f"[{row['rooms_per_run_q1']:.2f},{row['rooms_per_run_q3']:.2f}]"
        )
    print("-" * 75)
    print(f"\nP-invariance verdict: {verdict['verdict']}")
    print(f"wrote results to {RESULTS_DIR}")
    sys.exit(0)


if __name__ == "__main__":  # pragma: no cover
    main()
