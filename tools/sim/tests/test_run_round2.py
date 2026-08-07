"""Tests for the Round-2 sweep runner — population helps, DM-5, chain-key drain.

See docs/design/08-invariants.md §4, docs/design/15-server-ops.md §8,
docs/design/12-tears.md §3a.
"""

from __future__ import annotations

from sim.run_round2 import (
    gini,
    run_chain_key_sweep,
    run_dm5_sweep,
    run_population_sweep,
)


class TestGini:
    def test_perfect_equality_is_zero(self):
        assert gini([5, 5, 5, 5]) == 0.0

    def test_maximal_inequality_approaches_one(self):
        # One agent holds everything, the rest hold nothing.
        values = [0, 0, 0, 100]
        assert gini(values) > 0.7

    def test_empty_is_zero(self):
        assert gini([]) == 0.0

    def test_all_zero_is_zero(self):
        assert gini([0, 0, 0]) == 0.0

    def test_more_spread_is_more_unequal(self):
        equal = gini([10, 10, 10, 10])
        unequal = gini([1, 1, 1, 37])
        assert unequal > equal


class TestPopulationSweep:
    def test_returns_one_row_per_population_point(self):
        rows = run_population_sweep(
            population_range=[2, 10, 50], ticks=200, seed=1, seeds_per_point=1
        )
        assert [r["population"] for r in rows] == [2, 10, 50]

    def test_row_shape(self):
        rows = run_population_sweep(population_range=[10], ticks=200, seed=1, seeds_per_point=2)
        row = rows[0]
        for key in (
            "population",
            "ticks_run",
            "seeds",
            "avg_steady_state_items_per_hour",
            "inv7_tick_fraction",
            "inv7_tick_fraction_min",
            "inv7_tick_fraction_max",
            "inv8_tick_fraction",
            "inv9_tick_fraction",
        ):
            assert key in row
        assert 0.0 <= row["inv7_tick_fraction"] <= 1.0
        assert len(row["seeds"]) == 2

    def test_deterministic_for_fixed_seed(self):
        rows1 = run_population_sweep(
            population_range=[2, 20], ticks=300, seed=5, seeds_per_point=2
        )
        rows2 = run_population_sweep(
            population_range=[2, 20], ticks=300, seed=5, seeds_per_point=2
        )
        assert rows1 == rows2

    def test_very_low_population_starves_rare_gating_types(self):
        # k_r=0.2 default => rare_cap = int(0.2*P) = 0 for P < 5, so the two
        # rare gating types can structurally never spawn — INV-7 must fail
        # on effectively every tick, regardless of seed.
        rows = run_population_sweep(
            population_range=[2], ticks=500, seed=1, seeds_per_point=2
        )
        assert rows[0]["inv7_tick_fraction"] > 0.9


class TestDm5Sweep:
    def test_returns_one_row_per_policy(self):
        rows = run_dm5_sweep(policies=["fifo", "random", "need_weighted"], ticks=500, seed=1)
        assert [r["policy"] for r in rows] == ["fifo", "random", "need_weighted"]

    def test_row_shape(self):
        rows = run_dm5_sweep(policies=["fifo"], ticks=500, seed=1)
        row = rows[0]
        for key in (
            "policy",
            "gini_items_received",
            "min_items_received",
            "max_items_received",
            "mean_items_received",
            "violation_summary",
        ):
            assert key in row
        assert row["gini_items_received"] >= 0.0

    def test_recipient_policy_measurably_changes_the_distribution(self):
        # DM-5's actual ask: does the policy have a measurable effect on
        # distribution at all? (The engine-level TestRecipientPolicy suite
        # already proves the underlying per-tick tie-break mechanism is
        # order-dependent; here we confirm it shows up in aggregate.)
        rows = run_dm5_sweep(
            policies=["fifo", "random", "need_weighted"], ticks=4000, seed=1
        )
        ginis = {r["policy"]: r["gini_items_received"] for r in rows}
        assert len(set(ginis.values())) > 1

    def test_deterministic_for_fixed_seed(self):
        rows1 = run_dm5_sweep(policies=["random"], ticks=500, seed=3)
        rows2 = run_dm5_sweep(policies=["random"], ticks=500, seed=3)
        assert rows1 == rows2


class TestChainKeySweep:
    def test_returns_series_and_summary_for_each_mode(self):
        result = run_chain_key_sweep(
            modes=["destroy", "transfer"], ticks=600, sample_every=60, seed=1
        )
        assert {row["mode"] for row in result["summary"]} == {"destroy", "transfer"}
        assert all(row["mode"] in ("destroy", "transfer") for row in result["series"])

    def test_destroy_mode_never_exceeds_initial_unique_count(self):
        result = run_chain_key_sweep(modes=["destroy"], ticks=600, sample_every=60, seed=1)
        for row in result["series"]:
            assert row["unique_count"] <= 5

    def test_transfer_mode_keeps_pool_at_initial_size(self):
        result = run_chain_key_sweep(modes=["transfer"], ticks=600, sample_every=60, seed=1)
        summary = result["summary"][0]
        assert summary["unique_count_final"] == summary["unique_count_initial"]
        assert summary["exhausted_at_tick"] is None

    def test_destroy_mode_can_drain_the_pool_under_sustained_demand(self):
        result = run_chain_key_sweep(modes=["destroy"], ticks=3000, sample_every=30, seed=1)
        summary = result["summary"][0]
        assert summary["unique_count_final"] == 0
        assert summary["exhausted_at_tick"] is not None

    def test_deterministic_for_fixed_seed(self):
        r1 = run_chain_key_sweep(modes=["destroy"], ticks=500, sample_every=60, seed=9)
        r2 = run_chain_key_sweep(modes=["destroy"], ticks=500, sample_every=60, seed=9)
        assert r1 == r2
