"""Tuning-sweep runner for the open T-1/T-2/E-1 parameter questions.

Unlike `sweeps.py` (nine fixed-config scenarios exercising specific failure
modes at CI-speed compressed time), this module sweeps a *grid* of candidate
values for the still-open tuning knobs and exports the results so a human
can pick exact numbers within the documented brackets:

  E-1  held bleed (60-90 min) / world-escrow bleed (48-72h)   — §2
  T-1  collapse duration (~2-4 week bracket)                  — §7
  T-2  unique-unlock decay (~1 week bracket)                  — §7

See docs/design/OPEN-QUESTIONS.md and docs/design/10-time-and-progression.md.

Run via `python -m sim.run` (writes tools/sim/results/*).
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any

from .config import SimConfig
from .engine import SimEngine

SEED = 42

RESULTS_DIR = Path(__file__).resolve().parents[2] / "results"

# ---------------------------------------------------------------------------
# E-1 grid: held/world bleed sub-ranges within the documented outer bracket
# ---------------------------------------------------------------------------

E1_HELD_CANDIDATES: list[tuple[int, int]] = [(60, 90), (60, 75), (75, 90)]
E1_WORLD_CANDIDATES: list[tuple[int, int]] = [(2880, 4320), (2880, 3600), (3600, 4320)]

# Fixed run length for every E-1 combo (4x the outer world-bleed max, so every
# combo gets several full world-bleed cycles regardless of its own duration).
E1_TICKS = max(w[1] for w in E1_WORLD_CANDIDATES) * 4


def e1_grid() -> list[dict[str, Any]]:
    """Every (held, world) sub-range combo, tagged with a readable variant id."""
    grid = []
    for held_min, held_max in E1_HELD_CANDIDATES:
        for world_min, world_max in E1_WORLD_CANDIDATES:
            grid.append(
                {
                    "variant": f"held({held_min},{held_max})_world({world_min},{world_max})",
                    "held_bleed_min": held_min,
                    "held_bleed_max": held_max,
                    "world_bleed_min": world_min,
                    "world_bleed_max": world_max,
                }
            )
    return grid


# ---------------------------------------------------------------------------
# T-1/T-2 grid: collapse duration x unique-unlock decay, within their brackets
# ---------------------------------------------------------------------------

T1_CANDIDATES: list[int] = [20160, 25200, 30240, 35280, 40320]  # 2, 2.5, 3, 3.5, 4 weeks
T2_CANDIDATES: list[int] = [7200, 8640, 10080, 11520, 12960]  # 5, 6, 7, 8, 9 days

T1_NOMINAL = 30240  # 3 weeks — midpoint of the bracket
T2_NOMINAL = 10080  # 7 days — midpoint of the bracket


def t1_t2_grid() -> list[dict[str, Any]]:
    """T-1-only sweep + T-2-only sweep + two paired extremes, deduplicated."""
    seen: dict[tuple[int, int], dict[str, Any]] = {}

    for collapse in T1_CANDIDATES:
        key = (collapse, T2_NOMINAL)
        seen.setdefault(
            key,
            {
                "variant": f"T1={collapse}_T2=nominal",
                "collapse_duration": collapse,
                "unlock_decay_unique_keyed": T2_NOMINAL,
            },
        )

    for unlock in T2_CANDIDATES:
        key = (T1_NOMINAL, unlock)
        seen.setdefault(
            key,
            {
                "variant": f"T1=nominal_T2={unlock}",
                "collapse_duration": T1_NOMINAL,
                "unlock_decay_unique_keyed": unlock,
            },
        )

    for label, collapse, unlock in (
        ("paired_short", T1_CANDIDATES[0], T2_CANDIDATES[0]),
        ("paired_long", T1_CANDIDATES[-1], T2_CANDIDATES[-1]),
    ):
        key = (collapse, unlock)
        seen.setdefault(
            key,
            {
                "variant": label,
                "collapse_duration": collapse,
                "unlock_decay_unique_keyed": unlock,
            },
        )

    return list(seen.values())


# ---------------------------------------------------------------------------
# Scenario configs — fixed population, no joins/quits, so the run isolates
# the wall-clock parameter under test rather than population dynamics.
# ---------------------------------------------------------------------------


def _scenario_overrides(scenario: str, initial_population: int) -> dict[str, Any]:
    common: dict[str, Any] = dict(
        initial_population=initial_population,
        join_rate=0.0,
        quit_rate=0.0,
    )
    if scenario == "p2_stability":
        return common
    if scenario == "hoarder_cohort":
        return {**common, "hoarder_fraction": 0.2}
    if scenario == "unique_circulation":
        return {**common, "pickup_probability": 0.2, "unique_count": 2}
    raise ValueError(f"unknown scenario {scenario!r}")


def _run_one(
    *,
    sweep: str,
    variant: str,
    scenario: str,
    overrides: dict[str, Any],
    initial_population: int,
    ticks: int,
    seed: int = SEED,
) -> dict[str, Any]:
    """Run one (scenario x tuning-param) combo and return a result row."""
    cfg_kwargs = _scenario_overrides(scenario, initial_population)
    cfg_kwargs["first_universe_multiplier"] = 1.0  # isolate T-1 itself; grace is a separate x1.5
    cfg_kwargs.update(overrides)
    cfg = SimConfig(**cfg_kwargs)

    result = SimEngine(cfg, seed=seed).run(ticks)
    summary = result.violation_summary()

    return {
        "sweep": sweep,
        "variant": variant,
        "scenario": scenario,
        "seed": seed,
        "ticks_run": ticks,
        "params": overrides,
        "final_population": result.final_population,
        "final_item_count": result.final_item_count,
        "violations_total": len(result.violations),
        "violation_summary": summary,
        "ok": result.ok(),
    }


# ---------------------------------------------------------------------------
# Sweep drivers
# ---------------------------------------------------------------------------


def run_e1_sweep() -> list[dict[str, Any]]:
    rows = []
    for params in e1_grid():
        overrides = {k: v for k, v in params.items() if k != "variant"}
        for scenario, pop in (("hoarder_cohort", 20), ("unique_circulation", 15)):
            rows.append(
                _run_one(
                    sweep="E-1",
                    variant=params["variant"],
                    scenario=scenario,
                    overrides=overrides,
                    initial_population=pop,
                    ticks=E1_TICKS,
                )
            )
    return rows


def run_t1_t2_sweep() -> list[dict[str, Any]]:
    rows = []
    for params in t1_t2_grid():
        overrides = {k: v for k, v in params.items() if k != "variant"}
        ticks = overrides["collapse_duration"]
        rows.append(
            _run_one(
                sweep="T-1/T-2",
                variant=params["variant"],
                scenario="p2_stability",
                overrides=overrides,
                initial_population=20,
                ticks=ticks,
            )
        )
    return rows


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def _write_json(rows: list[dict[str, Any]], path: Path) -> None:
    path.write_text(json.dumps(rows, indent=2) + "\n")


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fieldnames = [
        "sweep",
        "variant",
        "scenario",
        "seed",
        "ticks_run",
        "params",
        "final_population",
        "final_item_count",
        "violations_total",
        "violation_summary",
        "ok",
    ]
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            flat = dict(row)
            flat["params"] = json.dumps(row["params"])
            flat["violation_summary"] = json.dumps(row["violation_summary"])
            writer.writerow(flat)


def main() -> None:  # pragma: no cover
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    e1_rows = run_e1_sweep()
    t1t2_rows = run_t1_t2_sweep()
    all_rows = e1_rows + t1t2_rows

    _write_json(all_rows, RESULTS_DIR / "tuning_sweep.json")
    _write_csv(all_rows, RESULTS_DIR / "tuning_sweep.csv")

    print(f"wrote {len(all_rows)} rows to {RESULTS_DIR}")
    sys.exit(0)


if __name__ == "__main__":  # pragma: no cover
    main()
