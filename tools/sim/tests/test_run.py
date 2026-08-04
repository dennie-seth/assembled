"""Tests for the tuning-sweep runner (T-1/T-2/E-1 parameter grids).

See docs/archive/OPEN-QUESTIONS.md, docs/design/10-time-and-progression.md §2/§3/§7.
"""

from __future__ import annotations

from sim.run import (
    E1_HELD_CANDIDATES,
    E1_WORLD_CANDIDATES,
    T1_CANDIDATES,
    T2_CANDIDATES,
    _run_one,
    e1_grid,
    t1_t2_grid,
)


class TestE1Grid:
    def test_all_combos_present(self):
        grid = e1_grid()
        assert len(grid) == len(E1_HELD_CANDIDATES) * len(E1_WORLD_CANDIDATES)

    def test_within_documented_bracket(self):
        # 10-time-and-progression.md §2: held 60-90 min, world/escrow 48-72h (2880-4320 min)
        for params in e1_grid():
            assert 60 <= params["held_bleed_min"] < params["held_bleed_max"] <= 90
            assert 2880 <= params["world_bleed_min"] < params["world_bleed_max"] <= 4320


class TestT1T2Grid:
    def test_all_combos_present(self):
        grid = t1_t2_grid()
        assert len(grid) >= len(T1_CANDIDATES) + len(T2_CANDIDATES)

    def test_within_documented_bracket(self):
        # 10-time-and-progression.md §7: collapse ~2-4wk (20160-40320 ticks),
        # unique decay ~1wk bracket (7200-12960 ticks), always < collapse.
        for params in t1_t2_grid():
            assert 20160 <= params["collapse_duration"] <= 40320
            assert 7200 <= params["unlock_decay_unique_keyed"] <= 12960
            assert params["unlock_decay_unique_keyed"] < params["collapse_duration"]

    def test_variants_are_unique(self):
        grid = t1_t2_grid()
        variants = [g["variant"] for g in grid]
        assert len(variants) == len(set(variants))


class TestRunOne:
    def test_returns_expected_shape(self):
        row = _run_one(
            sweep="E-1",
            variant="test",
            scenario="p2_stability",
            overrides={},
            initial_population=4,
            ticks=50,
            seed=0,
        )
        assert row["sweep"] == "E-1"
        assert row["variant"] == "test"
        assert row["scenario"] == "p2_stability"
        assert row["ticks_run"] == 50
        assert row["seed"] == 0
        assert isinstance(row["final_population"], int)
        assert isinstance(row["final_item_count"], int)
        assert isinstance(row["violation_summary"], dict)
        assert isinstance(row["ok"], bool)

    def test_deterministic_for_fixed_seed(self):
        row1 = _run_one(
            sweep="E-1",
            variant="test",
            scenario="p2_stability",
            overrides={},
            initial_population=4,
            ticks=50,
            seed=7,
        )
        row2 = _run_one(
            sweep="E-1",
            variant="test",
            scenario="p2_stability",
            overrides={},
            initial_population=4,
            ticks=50,
            seed=7,
        )
        assert row1 == row2
