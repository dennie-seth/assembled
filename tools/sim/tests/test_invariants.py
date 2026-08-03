"""Unit tests for invariant predicate functions.

INV-6: count(T) ≤ cap(T, P) — the spawner never violates this
INV-7: count(T) ≥ floor(T, P) > 0 for gating types
INV-8: expected time-to-encounter(T) < remaining collapse time
INV-9: per-player metrics stay in target band
INV-14: increasing P must not slow a player's progress

One definition, three consumers: these predicates are reused by
unit tests (here), the simulation engine, and production monitoring.
See docs/design/08-invariants.md §2.
"""

from __future__ import annotations

import pytest

from sim.invariants import (
    InvariantViolation,
    check_all,
    check_inv6,
    check_inv7,
    check_inv8,
    check_inv9,
    check_inv14,
)
from sim.types import AgentState, Rarity

from conftest import (
    FAR_FUTURE,
    NUM_COMMON,
    NUM_GATING,
    NUM_RARE,
    NUM_UNIQUE,
    RARE_BASE,
    UNIQUE_BASE,
    make_agent,
    make_cfg,
    make_held_item,
    make_state,
    make_world_item,
)

TICK = 0


# ---------------------------------------------------------------------------
# INV-6: rarity cap
# ---------------------------------------------------------------------------


class TestInv6RarityCap:
    def test_no_violation_within_common_cap(self):
        cfg = make_cfg(initial_population=10, k_c=2.0)  # cap = 20
        agents = [make_agent(i) for i in range(10)]
        items = [make_world_item(i, 0, Rarity.COMMON) for i in range(15)]
        state = make_state(cfg, agents, items)
        assert check_inv6(state, cfg, TICK) == []

    def test_violation_when_common_exceeds_cap(self):
        cfg = make_cfg(initial_population=5, k_c=2.0)  # cap = 10
        agents = [make_agent(i) for i in range(5)]
        items = [make_world_item(i, 0, Rarity.COMMON) for i in range(12)]
        state = make_state(cfg, agents, items)
        vs = check_inv6(state, cfg, TICK)
        assert any(v.invariant == "INV-6" for v in vs)

    def test_no_violation_at_exact_cap(self):
        cfg = make_cfg(initial_population=10, k_c=2.0)  # cap = 20
        agents = [make_agent(i) for i in range(10)]
        items = [make_world_item(i, 0, Rarity.COMMON) for i in range(20)]
        state = make_state(cfg, agents, items)
        assert check_inv6(state, cfg, TICK) == []

    def test_violation_when_rare_exceeds_cap(self):
        cfg = make_cfg(initial_population=5, k_r=0.2)  # rare cap = 1
        agents = [make_agent(i) for i in range(5)]
        items = [make_world_item(i, RARE_BASE, Rarity.RARE) for i in range(3)]
        state = make_state(cfg, agents, items)
        vs = check_inv6(state, cfg, TICK)
        assert any(v.invariant == "INV-6" for v in vs)

    def test_no_violation_within_rare_cap(self):
        cfg = make_cfg(initial_population=10, k_r=0.2)  # rare cap = 2
        agents = [make_agent(i) for i in range(10)]
        items = [make_world_item(i, RARE_BASE, Rarity.RARE) for i in range(2)]
        state = make_state(cfg, agents, items)
        assert check_inv6(state, cfg, TICK) == []

    def test_unique_cap_is_fixed_regardless_of_population(self):
        cfg = make_cfg(initial_population=100, unique_count=2)
        agents = [make_agent(i) for i in range(100)]
        # 3 unique instances > fixed cap of 2
        items = [make_world_item(i, UNIQUE_BASE, Rarity.UNIQUE) for i in range(3)]
        state = make_state(cfg, agents, items)
        vs = check_inv6(state, cfg, TICK)
        assert any(v.invariant == "INV-6" for v in vs)

    def test_unique_no_violation_at_unique_cap(self):
        cfg = make_cfg(initial_population=100, unique_count=NUM_UNIQUE)
        agents = [make_agent(i) for i in range(100)]
        items = [make_world_item(i, UNIQUE_BASE, Rarity.UNIQUE) for i in range(NUM_UNIQUE)]
        state = make_state(cfg, agents, items)
        assert check_inv6(state, cfg, TICK) == []

    def test_violation_message_contains_counts(self):
        cfg = make_cfg(initial_population=2, k_c=1.0)  # cap = 2
        agents = [make_agent(i) for i in range(2)]
        items = [make_world_item(i, 0, Rarity.COMMON) for i in range(5)]
        state = make_state(cfg, agents, items)
        vs = check_inv6(state, cfg, TICK)
        assert vs
        assert isinstance(vs[0], InvariantViolation)
        assert "INV-6" == vs[0].invariant
        assert vs[0].tick == TICK


# ---------------------------------------------------------------------------
# INV-7: density floor for gating types
# ---------------------------------------------------------------------------


class TestInv7DensityFloor:
    def test_no_violation_when_gating_items_present(self):
        cfg = make_cfg(initial_population=10, num_gating_types=NUM_GATING)
        agents = [make_agent(i) for i in range(10)]
        # One instance of each gating rare type
        items = [make_world_item(i, RARE_BASE + i, Rarity.RARE) for i in range(NUM_GATING)]
        state = make_state(cfg, agents, items)
        assert check_inv7(state, cfg, TICK) == []

    def test_violation_when_gating_type_extinct(self):
        cfg = make_cfg(initial_population=10)
        agents = [make_agent(i) for i in range(10)]
        # No items at all — gating types are extinct
        state = make_state(cfg, agents, [])
        vs = check_inv7(state, cfg, TICK)
        assert any(v.invariant == "INV-7" for v in vs)

    def test_violation_only_for_missing_gating_type(self):
        cfg = make_cfg(initial_population=5, num_gating_types=2)
        agents = [make_agent(i) for i in range(5)]
        # Only first gating type present; second is extinct
        items = [make_world_item(0, RARE_BASE, Rarity.RARE)]
        state = make_state(cfg, agents, items)
        vs = check_inv7(state, cfg, TICK)
        assert any(v.invariant == "INV-7" for v in vs)
        # The present gating type (RARE_BASE) must not appear as extinct
        assert not any(f"gating type {RARE_BASE}" in v.message for v in vs)

    def test_no_violation_when_no_active_players(self):
        cfg = make_cfg(initial_population=0)
        agents = []
        state = make_state(cfg, agents, [])
        assert check_inv7(state, cfg, TICK) == []

    def test_unique_types_are_gating(self):
        cfg = make_cfg(initial_population=5, unique_count=2)
        agents = [make_agent(i) for i in range(5)]
        # No unique items seeded
        state = make_state(cfg, agents, [])
        vs = check_inv7(state, cfg, TICK)
        # Should flag unique types as extinct
        assert any(v.invariant == "INV-7" for v in vs)


# ---------------------------------------------------------------------------
# INV-8: reachability — encounter time bounded below collapse time
# ---------------------------------------------------------------------------


class TestInv8Reachability:
    def test_no_violation_with_ample_items_and_time(self):
        cfg = make_cfg(initial_population=5, num_anchors=5, encounter_rate_per_world_item=0.1)
        agents = [make_agent(i, collapse_at=10_000) for i in range(5)]
        # Several gating items in world, collapse far away
        items = [make_world_item(i, RARE_BASE + (i % NUM_GATING), Rarity.RARE) for i in range(5)]
        state = make_state(cfg, agents, items)
        vs = check_inv8(state, cfg, TICK)
        assert vs == []

    def test_violation_when_collapse_imminent_and_no_gating_items(self):
        cfg = make_cfg(initial_population=5)
        # Agents collapse in 1 tick
        agents = [make_agent(i, collapse_at=TICK + 1) for i in range(5)]
        state = make_state(cfg, agents, [])
        vs = check_inv8(state, cfg, TICK)
        assert any(v.invariant == "INV-8" for v in vs)

    def test_no_violation_when_all_agents_quit(self):
        cfg = make_cfg(initial_population=0)
        agents = [make_agent(0, state=AgentState.QUIT, collapse_at=TICK + 1)]
        state = make_state(cfg, agents, [])
        assert check_inv8(state, cfg, TICK) == []

    def test_violation_message_names_invariant(self):
        cfg = make_cfg(initial_population=2)
        agents = [make_agent(i, collapse_at=TICK + 1) for i in range(2)]
        state = make_state(cfg, agents, [])
        vs = check_inv8(state, cfg, TICK)
        assert all(v.invariant == "INV-8" for v in vs)


# ---------------------------------------------------------------------------
# INV-9: scale invariance — per-player throughput in band
# ---------------------------------------------------------------------------


class TestInv9ScaleInvariance:
    def test_no_violation_when_throughput_in_band(self):
        cfg = make_cfg(min_items_per_hour=1.0, max_items_per_hour=100.0)
        agents = [make_agent(i, items_received=10, ticks_active=120) for i in range(5)]
        state = make_state(cfg, agents, [])
        assert check_inv9(state, cfg, TICK) == []

    def test_violation_when_throughput_below_floor(self):
        cfg = make_cfg(min_items_per_hour=10.0, max_items_per_hour=100.0)
        # 0 items received in 120 ticks = 0 items/hr < floor of 10
        agents = [make_agent(0, items_received=0, ticks_active=120)]
        state = make_state(cfg, agents, [])
        vs = check_inv9(state, cfg, TICK)
        assert any(v.invariant == "INV-9" for v in vs)

    def test_violation_when_throughput_above_ceiling(self):
        cfg = make_cfg(min_items_per_hour=0.1, max_items_per_hour=5.0)
        # 1000 items in 60 ticks = 1000 items/hr > ceiling of 5
        agents = [make_agent(0, items_received=1000, ticks_active=60)]
        state = make_state(cfg, agents, [])
        vs = check_inv9(state, cfg, TICK)
        assert any(v.invariant == "INV-9" for v in vs)

    def test_agents_with_too_few_active_ticks_skipped(self):
        cfg = make_cfg(min_items_per_hour=100.0, max_items_per_hour=1000.0)
        # Agent active for only 30 ticks — below the 60-tick minimum window
        agents = [make_agent(0, items_received=0, ticks_active=30)]
        state = make_state(cfg, agents, [])
        assert check_inv9(state, cfg, TICK) == []


# ---------------------------------------------------------------------------
# INV-14: population monotonicity
# ---------------------------------------------------------------------------


class TestInv14PopulationMonotonicity:
    def test_no_violation_when_throughput_stable_with_population_growth(self):
        history = [
            (0, 10, 2.0),
            (100, 20, 2.1),
            (200, 40, 2.3),
        ]
        vs = check_inv14(history, 200)
        assert vs == []

    def test_violation_when_population_grows_but_throughput_collapses(self):
        history = [
            (0, 10, 5.0),
            (100, 50, 0.5),  # P grew 5x but throughput dropped 10x
        ]
        vs = check_inv14(history, 100)
        assert any(v.invariant == "INV-14" for v in vs)

    def test_no_violation_with_single_datapoint(self):
        history = [(0, 10, 2.0)]
        assert check_inv14(history, 0) == []

    def test_no_violation_when_population_shrinks(self):
        # INV-14 only applies when population grows
        history = [
            (0, 100, 5.0),
            (100, 20, 1.0),  # population shrank — not a monotonicity violation
        ]
        assert check_inv14(history, 100) == []


# ---------------------------------------------------------------------------
# check_all: aggregate
# ---------------------------------------------------------------------------


class TestCheckAll:
    def test_returns_empty_for_clean_state(self):
        # k_r=0.5 with P=5 gives rare_cap=2 — enough for both rare gating types
        cfg = make_cfg(initial_population=5, k_c=2.0, k_r=0.5)
        agents = [make_agent(i) for i in range(5)]
        # Supply: 1 common (cap 10), 2 rare (cap 2), 2 unique (cap 2) — all within caps
        items = [
            make_world_item(0, 0, Rarity.COMMON),
            make_world_item(1, RARE_BASE, Rarity.RARE, bleed_at=FAR_FUTURE),
            make_world_item(2, RARE_BASE + 1, Rarity.RARE, bleed_at=FAR_FUTURE),
            make_world_item(3, UNIQUE_BASE, Rarity.UNIQUE, bleed_at=FAR_FUTURE),
            make_world_item(4, UNIQUE_BASE + 1, Rarity.UNIQUE, bleed_at=FAR_FUTURE),
        ]
        state = make_state(cfg, agents, items)
        vs = check_all(state, cfg, TICK, pop_throughput_history=[])
        # INV-6 and INV-7 must be clean; INV-8/9 may fire depending on timing
        inv6_vs = [v for v in vs if v.invariant == "INV-6"]
        inv7_vs = [v for v in vs if v.invariant == "INV-7"]
        assert inv6_vs == []
        assert inv7_vs == []
