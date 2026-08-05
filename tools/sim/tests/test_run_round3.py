"""Tests for the Round-3 E-4 sweep: k_c, k_r, unique_count swept with population.

E-4 open question: docs/design/07-items-economy.md §9.
OPS-1 (shard population floor) is contingent on this sweep:
docs/design/15-server-ops.md §8.

Round 2 reported P≈20 as the floor under a *single* set of constants
(k_c=2.0, k_r=0.2, unique_count=5). Three seeds at P=30 already showed an 8×
spread (2.4%–19.2%) in the transition zone, indicating the floor is a function
of the unswept constants rather than a stable scalar. This round sweeps all three
constants jointly with population and derives the floor surface.
"""

from __future__ import annotations

import pytest

from sim.run_round3 import (
    FLOOR_THRESHOLD,
    population_floor_surface,
    run_e4_sweep,
)


class TestE4Sweep:
    def test_returns_row_for_each_combination(self):
        rows = run_e4_sweep(
            kr_values=[0.1, 0.3],
            kc_values=[2.0],
            unique_count_values=[5],
            population_range=[10, 20],
            ticks=200,
            seed=1,
            seeds_per_point=1,
        )
        # 2 k_r × 1 k_c × 1 unique_count × 2 P = 4 rows
        assert len(rows) == 4

    def test_row_has_required_fields(self):
        rows = run_e4_sweep(
            kr_values=[0.2],
            kc_values=[2.0],
            unique_count_values=[5],
            population_range=[20],
            ticks=200,
            seed=1,
            seeds_per_point=2,
        )
        row = rows[0]
        for field in (
            "k_c",
            "k_r",
            "unique_count",
            "population",
            "ticks_run",
            "seeds",
            "inv7_tick_fraction",
            "inv7_tick_fraction_min",
            "inv7_tick_fraction_max",
        ):
            assert field in row, f"missing field: {field}"
        assert 0.0 <= row["inv7_tick_fraction"] <= 1.0
        assert len(row["seeds"]) == 2

    def test_row_records_correct_constants(self):
        rows = run_e4_sweep(
            kr_values=[0.3],
            kc_values=[1.5],
            unique_count_values=[7],
            population_range=[25],
            ticks=100,
            seed=1,
            seeds_per_point=1,
        )
        row = rows[0]
        assert row["k_r"] == pytest.approx(0.3)
        assert row["k_c"] == pytest.approx(1.5)
        assert row["unique_count"] == 7
        assert row["population"] == 25

    def test_deterministic_for_fixed_seed(self):
        kwargs = dict(
            kr_values=[0.2],
            kc_values=[2.0],
            unique_count_values=[5],
            population_range=[10, 20],
            ticks=300,
            seed=5,
            seeds_per_point=2,
        )
        rows1 = run_e4_sweep(**kwargs)
        rows2 = run_e4_sweep(**kwargs)
        assert rows1 == rows2

    def test_higher_kr_gives_lower_inv7_violation_rate_at_fixed_p(self):
        """Higher k_r → larger rare cap → more likely both gating types exist → lower INV-7 rate."""
        # k_r=0.05 at P=20: int(0.05*20)=1 — cap=1, but 2 gating types need coverage
        # k_r=0.5 at P=20: int(0.5*20)=10 — cap=10, plenty of headroom
        rows = run_e4_sweep(
            kr_values=[0.05, 0.5],
            kc_values=[2.0],
            unique_count_values=[5],
            population_range=[20],
            ticks=1000,
            seed=1,
            seeds_per_point=3,
        )
        by_kr = {r["k_r"]: r["inv7_tick_fraction"] for r in rows}
        assert by_kr[0.5] < by_kr[0.05]

    def test_zero_rare_cap_fails_inv7_structurally(self):
        """k_r so low that int(k_r*P)=0 → rare_cap=0 → rare gating types cannot exist."""
        rows = run_e4_sweep(
            kr_values=[0.01],  # int(0.01*10)=0 → cap=0
            kc_values=[2.0],
            unique_count_values=[5],
            population_range=[10],
            ticks=500,
            seed=1,
            seeds_per_point=2,
        )
        assert rows[0]["inv7_tick_fraction"] > 0.9

    def test_kc_variation_does_not_change_inv7_at_fixed_kr(self):
        """k_c controls common cap, not rare. INV-7 (rare gating coverage) is only
        indirectly affected by k_c via pickup dilution: a smaller common cap means
        fewer commons in the world, so agents pick up rares relatively more often,
        which can shift the rare-coverage distribution. This indirect effect is
        small but measurable; the delta tolerance is set to 0.30 to accommodate it."""
        rows = run_e4_sweep(
            kr_values=[0.3],
            kc_values=[0.5, 4.0],  # 8× difference in common cap
            unique_count_values=[5],
            population_range=[30],
            ticks=2000,
            seed=1,
            seeds_per_point=3,
        )
        by_kc = {r["k_c"]: r["inv7_tick_fraction"] for r in rows}
        # The two rates should be broadly similar — k_c only indirectly gates INV-7
        # (via pickup dilution), not directly. Tolerance 0.30 accounts for this coupling.
        delta = abs(by_kc[0.5] - by_kc[4.0])
        assert delta < 0.30, f"INV-7 rates diverge by {delta:.3f} — k_c coupling exceeds expected indirect effect"

    def test_seeds_per_point_averages_across_seeds(self):
        """seeds_per_point > 1 averages results; min/max track the per-seed spread."""
        rows = run_e4_sweep(
            kr_values=[0.2],
            kc_values=[2.0],
            unique_count_values=[5],
            population_range=[20],
            ticks=400,
            seed=1,
            seeds_per_point=3,
        )
        row = rows[0]
        assert row["inv7_tick_fraction_min"] <= row["inv7_tick_fraction"]
        assert row["inv7_tick_fraction"] <= row["inv7_tick_fraction_max"]
        assert len(row["seeds"]) == 3


class TestPopulationFloorSurface:
    """population_floor_surface derives the minimum P for each (k_c, k_r, unique_count)
    triple where inv7_tick_fraction first drops below the threshold."""

    def _make_rows(self, triples: list[tuple]) -> list[dict]:
        """Helper: build synthetic raw rows from (k_c, k_r, uc, p, frac) tuples."""
        return [
            {
                "k_c": kc,
                "k_r": kr,
                "unique_count": uc,
                "population": p,
                "inv7_tick_fraction": frac,
                "inv7_tick_fraction_min": frac,
                "inv7_tick_fraction_max": frac,
                "ticks_run": 100,
                "seeds": [1],
            }
            for kc, kr, uc, p, frac in triples
        ]

    def test_returns_one_row_per_constant_triple(self):
        raw = self._make_rows(
            [
                (2.0, 0.2, 5, 10, 0.9),
                (2.0, 0.2, 5, 20, 0.05),
                (2.0, 0.1, 5, 10, 1.0),
                (2.0, 0.1, 5, 20, 0.5),
            ]
        )
        surface = population_floor_surface(raw, threshold=0.10)
        assert len(surface) == 2  # one per (k_c=2.0,k_r) pair

    def test_floor_is_min_p_where_inv7_clears_threshold(self):
        raw = self._make_rows(
            [
                (2.0, 0.2, 5, 10, 0.95),
                (2.0, 0.2, 5, 20, 0.05),
                (2.0, 0.2, 5, 30, 0.03),
            ]
        )
        surface = population_floor_surface(raw, threshold=0.10)
        assert len(surface) == 1
        assert surface[0]["floor_population"] == 20

    def test_floor_none_when_no_population_clears_threshold(self):
        raw = self._make_rows(
            [(2.0, 0.01, 5, p, 0.99) for p in [10, 20, 50]]
        )
        surface = population_floor_surface(raw, threshold=0.10)
        assert surface[0]["floor_population"] is None

    def test_surface_row_has_required_fields(self):
        raw = self._make_rows([(2.0, 0.2, 5, 20, 0.05)])
        surface = population_floor_surface(raw, threshold=0.10)
        row = surface[0]
        for field in ("k_c", "k_r", "unique_count", "floor_population", "floor_threshold"):
            assert field in row, f"missing field: {field}"

    def test_floor_threshold_recorded_in_row(self):
        raw = self._make_rows([(2.0, 0.2, 5, 20, 0.05)])
        surface = population_floor_surface(raw, threshold=0.07)
        assert surface[0]["floor_threshold"] == pytest.approx(0.07)

    def test_lower_kr_yields_higher_floor_from_sim(self):
        """Round-trip: lower k_r → fewer rare instances → higher floor population.

        Mechanism: floor = min P where int(k_r*P) gives comfortable multi-type
        coverage. Halving k_r requires roughly doubling P for the same coverage.
        """
        rows = run_e4_sweep(
            kr_values=[0.1, 0.5],
            kc_values=[2.0],
            unique_count_values=[5],
            population_range=[5, 10, 20, 30, 50],
            ticks=2000,
            seed=1,
            seeds_per_point=2,
        )
        surface = population_floor_surface(rows, threshold=0.10)
        by_kr = {r["k_r"]: r["floor_population"] for r in surface}
        floor_low = by_kr[0.1] if by_kr[0.1] is not None else float("inf")
        floor_high = by_kr[0.5] if by_kr[0.5] is not None else float("inf")
        assert floor_low >= floor_high

    def test_floor_population_is_minimum_not_first_seen(self):
        """Floor must be the *smallest* P that clears the threshold, not just
        any P that happens to appear first in the data."""
        # P=30 clears but P=20 also clears — floor should be 20 (the smaller)
        raw = self._make_rows(
            [
                (2.0, 0.2, 5, 30, 0.04),
                (2.0, 0.2, 5, 20, 0.08),  # also clears 0.10 threshold
                (2.0, 0.2, 5, 10, 0.95),
            ]
        )
        surface = population_floor_surface(raw, threshold=0.10)
        assert surface[0]["floor_population"] == 20


class TestFloorThresholdConstant:
    def test_floor_threshold_module_level_is_reasonable(self):
        """FLOOR_THRESHOLD should be a small positive fraction — used as the
        module-level default when main() runs the full sweep."""
        assert 0.0 < FLOOR_THRESHOLD < 0.5
