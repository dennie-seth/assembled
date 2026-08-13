"""Tests for the INV-14 + chain-key population sweep — T-0133 + T-0156.

T-0133: Re-run INV-14 across P in {2, 20, 200, 2000, 20000} with >= 30 seeds.
T-0156: Fold chain-key consumption into this sweep; report chain crossings per
        player per run and rooms-per-run as functions of P with IQR bands.

The core question (docs/HANDOFF.md §13.1-13.4):
  - unique_count is a fixed absolute count (~5); it does NOT scale with P.
  - At P=50: ~10% of players can hold one; at P=10^5: ~0.005%.
  - Does per-player chain-crossing rate fall as P grows? (expected: yes)
  - Is rooms-per-run (items received per universe) P-invariant? (expected: yes,
    because common+rare supply scales with k_c*P / k_r*P).
"""

from __future__ import annotations

import pytest

from sim.run_inv14 import (
    POPULATION_RANGE,
    SEEDS_PER_POINT,
    _iqr_stats,
    _run_one_point,
    p_invariance_verdict,
    run_chain_key_population_sweep,
)

# ---------------------------------------------------------------------------
# _iqr_stats
# ---------------------------------------------------------------------------


class TestIqrStats:
    def test_known_values(self):
        # [1,2,3,4,5] -> median=3, q1=1.5 or 2, q3=4 or 4.5 depending on method
        stats = _iqr_stats([1.0, 2.0, 3.0, 4.0, 5.0])
        assert stats["median"] == pytest.approx(3.0)
        assert "q1" in stats
        assert "q3" in stats
        assert "iqr" in stats
        assert stats["iqr"] == pytest.approx(stats["q3"] - stats["q1"])

    def test_single_value(self):
        stats = _iqr_stats([7.0])
        assert stats["median"] == pytest.approx(7.0)
        assert stats["iqr"] == pytest.approx(0.0)

    def test_uniform_list(self):
        stats = _iqr_stats([5.0, 5.0, 5.0, 5.0])
        assert stats["median"] == pytest.approx(5.0)
        assert stats["iqr"] == pytest.approx(0.0)

    def test_empty_returns_zeros(self):
        stats = _iqr_stats([])
        assert stats["median"] == pytest.approx(0.0)
        assert stats["q1"] == pytest.approx(0.0)
        assert stats["q3"] == pytest.approx(0.0)
        assert stats["iqr"] == pytest.approx(0.0)

    def test_ordering_does_not_matter(self):
        s1 = _iqr_stats([5.0, 1.0, 3.0, 2.0, 4.0])
        s2 = _iqr_stats([1.0, 2.0, 3.0, 4.0, 5.0])
        assert s1["median"] == pytest.approx(s2["median"])
        assert s1["iqr"] == pytest.approx(s2["iqr"])


# ---------------------------------------------------------------------------
# _run_one_point
# ---------------------------------------------------------------------------


class TestRunOnePoint:
    def test_returns_required_fields(self):
        result = _run_one_point(population=5, ticks=50, seed=1)
        assert "chain_crossings" in result
        assert "rooms_per_run" in result
        assert isinstance(result["chain_crossings"], list)
        assert isinstance(result["rooms_per_run"], list)

    def test_agent_count_matches_population(self):
        result = _run_one_point(population=8, ticks=50, seed=1)
        # Non-quit agents should equal initial population (no joins/quits)
        assert len(result["chain_crossings"]) == 8
        assert len(result["rooms_per_run"]) == 8

    def test_rooms_per_run_non_negative(self):
        result = _run_one_point(population=10, ticks=80, seed=2)
        assert all(r >= 0 for r in result["rooms_per_run"])

    def test_chain_crossings_non_negative(self):
        result = _run_one_point(population=10, ticks=80, seed=2)
        assert all(c >= 0 for c in result["chain_crossings"])

    def test_chain_crossings_bounded_by_required(self):
        """chain_progress never exceeds chain_key_crossings_required per agent."""
        crossings_required = 2
        result = _run_one_point(
            population=10, ticks=200, seed=3, chain_key_crossings_required=crossings_required
        )
        assert all(c <= crossings_required for c in result["chain_crossings"])

    def test_deterministic_for_fixed_seed(self):
        kwargs = dict(population=10, ticks=80, seed=7)
        r1 = _run_one_point(**kwargs)
        r2 = _run_one_point(**kwargs)
        assert r1["chain_crossings"] == r2["chain_crossings"]
        assert r1["rooms_per_run"] == r2["rooms_per_run"]

    def test_no_crossings_when_chain_key_disabled(self):
        """When chain_key_enabled=False, chain_progress must stay 0."""
        result = _run_one_point(
            population=10, ticks=200, seed=1, chain_key_enabled=False
        )
        assert all(c == 0 for c in result["chain_crossings"])

    def test_unique_consumed_reduces_pool(self):
        """In destroy mode, crossings should consume uniques from the world pool.
        After enough crossings in a small population, the pool may be depleted.
        This is a qualitative test: just confirm the field is there and makes sense."""
        result = _run_one_point(
            population=3,
            ticks=300,
            seed=1,
            chain_key_enabled=True,
            chain_key_mode="destroy",
            unique_count=2,
            chain_key_crossings_required=2,
        )
        # Total crossings cannot exceed unique_count * (chain_key_crossings_required)
        # because each crossing requires a unique, and destroy removes them permanently.
        # However, transfer mode recirculates so this bound doesn't hold for transfer.
        total_crossings = sum(result["chain_crossings"])
        # In destroy mode, each crossing removes one unique permanently.
        # We started with unique_count=2 uniques, so at most 2 crossings total.
        assert total_crossings <= 2


# ---------------------------------------------------------------------------
# run_chain_key_population_sweep
# ---------------------------------------------------------------------------


class TestRunChainKeyPopulationSweep:
    def test_returns_one_row_per_population(self):
        rows = run_chain_key_population_sweep(
            population_range=[2, 20],
            ticks_per_run=50,
            seed=1,
            seeds_per_point=2,
        )
        assert len(rows) == 2

    def test_each_row_has_required_fields(self):
        rows = run_chain_key_population_sweep(
            population_range=[10],
            ticks_per_run=60,
            seed=1,
            seeds_per_point=2,
        )
        row = rows[0]
        required = [
            "population",
            "chain_crossings_median",
            "chain_crossings_q1",
            "chain_crossings_q3",
            "chain_crossings_iqr",
            "rooms_per_run_median",
            "rooms_per_run_q1",
            "rooms_per_run_q3",
            "rooms_per_run_iqr",
            "unique_count",
            "unique_density",
            "n_agents_total",
            "seeds",
        ]
        for field in required:
            assert field in row, f"missing field: {field}"

    def test_population_recorded_correctly(self):
        rows = run_chain_key_population_sweep(
            population_range=[5, 15],
            ticks_per_run=50,
            seed=1,
            seeds_per_point=2,
        )
        assert rows[0]["population"] == 5
        assert rows[1]["population"] == 15

    def test_unique_density_falls_with_population(self):
        """unique_density = unique_count / P — must strictly decrease as P grows."""
        rows = run_chain_key_population_sweep(
            population_range=[2, 20, 200],
            ticks_per_run=50,
            seed=1,
            seeds_per_point=1,
            unique_count=5,
        )
        densities = [r["unique_density"] for r in rows]
        for i in range(len(densities) - 1):
            assert densities[i] > densities[i + 1]

    def test_chain_crossings_fall_as_p_grows(self):
        """Median chain crossings per player fall as P grows (unique pool is fixed
        absolute count; at high P each player has a much lower chance of encountering
        one). Requires enough ticks and seeds to be signal-not-noise.

        docs/HANDOFF.md §13.1: at P=50 ~10% hold a unique; at P=10^5 ~0.005%.
        """
        rows = run_chain_key_population_sweep(
            population_range=[2, 200],
            ticks_per_run=300,
            seed=1,
            seeds_per_point=5,
            unique_count=5,
            chain_key_enabled=True,
        )
        crossings_low_p = rows[0]["chain_crossings_median"]
        crossings_high_p = rows[1]["chain_crossings_median"]
        # Low P should have more crossings per player than high P
        assert crossings_low_p >= crossings_high_p, (
            f"expected fewer crossings at P=200 than P=2, "
            f"got {crossings_low_p} vs {crossings_high_p}"
        )

    def test_rooms_per_run_non_negative(self):
        rows = run_chain_key_population_sweep(
            population_range=[5, 20],
            ticks_per_run=60,
            seed=1,
            seeds_per_point=2,
        )
        for row in rows:
            assert row["rooms_per_run_median"] >= 0
            assert row["rooms_per_run_q1"] >= 0

    def test_n_agents_total_matches_seeds_times_population(self):
        """n_agents_total = seeds_per_point × population (no joins/quits)."""
        pop = 10
        seeds = 3
        rows = run_chain_key_population_sweep(
            population_range=[pop],
            ticks_per_run=50,
            seed=1,
            seeds_per_point=seeds,
        )
        assert rows[0]["n_agents_total"] == pop * seeds

    def test_deterministic_for_fixed_seed(self):
        kwargs = dict(
            population_range=[5, 20],
            ticks_per_run=60,
            seed=3,
            seeds_per_point=2,
        )
        rows1 = run_chain_key_population_sweep(**kwargs)
        rows2 = run_chain_key_population_sweep(**kwargs)
        for r1, r2 in zip(rows1, rows2):
            assert r1["chain_crossings_median"] == pytest.approx(r2["chain_crossings_median"])
            assert r1["rooms_per_run_median"] == pytest.approx(r2["rooms_per_run_median"])

    def test_iqr_bounds_are_consistent(self):
        """q1 <= median <= q3 and iqr == q3 - q1 for both metrics."""
        rows = run_chain_key_population_sweep(
            population_range=[20],
            ticks_per_run=100,
            seed=1,
            seeds_per_point=3,
        )
        row = rows[0]
        assert row["chain_crossings_q1"] <= row["chain_crossings_median"]
        assert row["chain_crossings_median"] <= row["chain_crossings_q3"]
        assert row["chain_crossings_iqr"] == pytest.approx(
            row["chain_crossings_q3"] - row["chain_crossings_q1"]
        )
        assert row["rooms_per_run_q1"] <= row["rooms_per_run_median"]
        assert row["rooms_per_run_median"] <= row["rooms_per_run_q3"]
        assert row["rooms_per_run_iqr"] == pytest.approx(
            row["rooms_per_run_q3"] - row["rooms_per_run_q1"]
        )


# ---------------------------------------------------------------------------
# p_invariance_verdict
# ---------------------------------------------------------------------------


class TestPInvarianceVerdict:
    def _make_rows(self, pop_medians: dict[int, float]) -> list[dict]:
        return [
            {
                "population": p,
                "rooms_per_run_median": m,
                "rooms_per_run_q1": m * 0.8,
                "rooms_per_run_q3": m * 1.2,
                "rooms_per_run_iqr": m * 0.4,
                "chain_crossings_median": 0.0,
                "chain_crossings_q1": 0.0,
                "chain_crossings_q3": 0.0,
                "chain_crossings_iqr": 0.0,
                "unique_count": 5,
                "unique_density": 5 / p,
                "n_agents_total": p * 3,
                "seeds": [1, 2, 3],
            }
            for p, m in pop_medians.items()
        ]

    def test_returns_required_fields(self):
        rows = self._make_rows({2: 10.0, 20: 11.0, 200: 10.5})
        verdict = p_invariance_verdict(rows)
        assert "p_invariant" in verdict
        assert "cv" in verdict
        assert "cv_threshold" in verdict
        assert "verdict" in verdict
        assert "median_rooms_by_population" in verdict

    def test_constant_rooms_is_invariant(self):
        """If rooms-per-run is the same across all P values, it's P-invariant."""
        rows = self._make_rows({2: 10.0, 20: 10.0, 200: 10.0})
        verdict = p_invariance_verdict(rows, cv_threshold=0.20)
        assert verdict["p_invariant"] is True
        assert verdict["cv"] == pytest.approx(0.0)

    def test_highly_variable_rooms_is_not_invariant(self):
        """If rooms-per-run varies wildly, it's not P-invariant."""
        rows = self._make_rows({2: 1.0, 20: 10.0, 200: 100.0})
        verdict = p_invariance_verdict(rows, cv_threshold=0.20)
        assert verdict["p_invariant"] is False
        assert verdict["cv"] > 0.20

    def test_verdict_string_contains_p_invariant(self):
        rows = self._make_rows({2: 10.0, 20: 10.0, 200: 10.0})
        v = p_invariance_verdict(rows)
        assert "P-INVARIANT" in v["verdict"].upper() or "invariant" in v["verdict"].lower()

    def test_verdict_string_contains_not_invariant(self):
        rows = self._make_rows({2: 1.0, 20: 50.0, 200: 200.0})
        v = p_invariance_verdict(rows, cv_threshold=0.20)
        assert "NOT" in v["verdict"].upper() or "not" in v["verdict"].lower()

    def test_median_rooms_recorded_per_population(self):
        rows = self._make_rows({2: 8.0, 20: 9.5})
        verdict = p_invariance_verdict(rows)
        assert verdict["median_rooms_by_population"][2] == pytest.approx(8.0)
        assert verdict["median_rooms_by_population"][20] == pytest.approx(9.5)

    def test_cv_threshold_respected(self):
        """The same data is invariant at a loose threshold but not at a strict one."""
        rows = self._make_rows({2: 10.0, 20: 12.0, 200: 10.5})
        loose = p_invariance_verdict(rows, cv_threshold=0.50)
        strict = p_invariance_verdict(rows, cv_threshold=0.01)
        assert loose["p_invariant"] is True
        assert strict["p_invariant"] is False

    def test_single_population_point_is_invariant(self):
        """With one data point, CV is 0 — trivially invariant."""
        rows = self._make_rows({20: 10.0})
        verdict = p_invariance_verdict(rows)
        assert verdict["p_invariant"] is True


# ---------------------------------------------------------------------------
# Production constants
# ---------------------------------------------------------------------------


class TestProductionConstants:
    def test_population_range_has_five_points(self):
        """T-0133 requires P in {2, 20, 200, 2000, 20000}."""
        assert POPULATION_RANGE == [2, 20, 200, 2000, 20000]

    def test_seeds_per_point_at_least_30(self):
        """T-0133 requires >= 30 seeds per population point."""
        assert SEEDS_PER_POINT >= 30

    def test_rooms_per_run_is_p_invariant_in_sim(self):
        """Integration: rooms-per-run (items received per universe) should be roughly
        P-invariant because common+rare supply scales with k_c*P / k_r*P.

        Uses compressed time and small populations for CI speed. The CV threshold
        is set to 0.50 — generous enough to absorb compressed-time noise while
        still catching a systematic P-dependence.
        """
        rows = run_chain_key_population_sweep(
            population_range=[2, 20, 200],
            ticks_per_run=200,
            seed=42,
            seeds_per_point=5,
            chain_key_enabled=True,
        )
        verdict = p_invariance_verdict(rows, cv_threshold=0.50)
        assert verdict["p_invariant"], (
            f"rooms-per-run unexpectedly P-variant: {verdict['verdict']}, "
            f"CV={verdict['cv']:.3f}, medians={verdict['median_rooms_by_population']}"
        )
