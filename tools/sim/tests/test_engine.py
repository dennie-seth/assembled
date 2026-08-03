"""Unit tests for SimEngine mechanics.

Tests discrete-time event processing: agent lifecycle, item spawning,
bleed timers, scatter on quit, landing probability, and the four
wall-clocks (held bleed, world/escrow bleed, unlock decay, collapse).
See docs/design/08-invariants.md §4 and docs/design/07-items-economy.md.
"""

from __future__ import annotations

import pytest

from sim.engine import SimEngine
from sim.types import AgentState, Rarity

from conftest import make_cfg


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _count(engine: SimEngine, rarity: Rarity) -> int:
    return sum(1 for it in engine.state.items.values() if it.rarity == rarity)


def _world_count(engine: SimEngine, rarity: Rarity) -> int:
    return sum(
        1 for it in engine.state.items.values()
        if it.rarity == rarity and it.anchor is not None
    )


def _held_by(engine: SimEngine, agent_id: int) -> list:
    return [it for it in engine.state.items.values() if it.holder == agent_id]


# ---------------------------------------------------------------------------
# Spawning
# ---------------------------------------------------------------------------


class TestSpawning:
    def test_initial_unique_items_are_seeded(self):
        cfg = make_cfg(unique_count=3, initial_population=5)
        engine = SimEngine(cfg, seed=0)
        assert _count(engine, Rarity.UNIQUE) == 3

    def test_spawner_never_exceeds_common_cap(self):
        cfg = make_cfg(
            initial_population=5,
            k_c=1.0,       # cap = 5 common
            k_r=0.0,
            spawn_rate_common=1.0,   # try to spawn every tick
            spawn_rate_rare=0.0,
            join_rate=0.0,
            quit_rate=0.0,
            unique_count=0,
        )
        engine = SimEngine(cfg, seed=42)
        for _ in range(200):
            engine.tick()
        common_cap = int(cfg.k_c * engine.state.population)
        assert _count(engine, Rarity.COMMON) <= common_cap

    def test_spawner_never_exceeds_rare_cap(self):
        cfg = make_cfg(
            initial_population=10,
            k_c=0.0,
            k_r=0.2,       # cap = 2 rare
            spawn_rate_common=0.0,
            spawn_rate_rare=1.0,
            join_rate=0.0,
            quit_rate=0.0,
            unique_count=0,
            num_gating_types=0,
        )
        engine = SimEngine(cfg, seed=42)
        for _ in range(200):
            engine.tick()
        rare_cap = int(cfg.k_r * engine.state.population)
        assert _count(engine, Rarity.RARE) <= rare_cap

    def test_unique_count_stays_fixed_across_ticks(self):
        cfg = make_cfg(unique_count=2, initial_population=5, join_rate=0.0, quit_rate=0.0)
        engine = SimEngine(cfg, seed=0)
        initial = _count(engine, Rarity.UNIQUE)
        for _ in range(50):
            engine.tick()
        assert _count(engine, Rarity.UNIQUE) == initial


# ---------------------------------------------------------------------------
# Held bleed timer
# ---------------------------------------------------------------------------


class TestHeldBleed:
    def test_held_item_bleeds_to_world_after_duration(self):
        cfg = make_cfg(
            initial_population=1,
            held_bleed_min=5,
            held_bleed_max=5,
            join_rate=0.0,
            quit_rate=0.0,
            pickup_probability=0.0,
            transfer_probability=0.0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
            unique_count=0,
        )
        engine = SimEngine(cfg, seed=0)
        # Manually insert a held item that bleeds at tick 3
        agent_id = next(iter(engine.state.agents))
        from sim.types import ItemInstance

        item = ItemInstance(
            instance_id=9999,
            type_id=0,
            rarity=Rarity.COMMON,
            holder=agent_id,
            anchor=None,
            bleed_at=3,
        )
        engine.state.items[item.instance_id] = item

        # Before bleed_at: item is still held
        engine._state.tick = 2
        engine.tick()  # tick 3 — bleed fires
        # Item should now be at an anchor (or removed if landing fails)
        # At P=1, cap=k_c*1; if common_count <= cap, landing_prob=1.0
        assert 9999 not in engine.state.items or engine.state.items[9999].anchor is not None

    def test_unique_held_item_always_lands_on_bleed(self):
        cfg = make_cfg(
            initial_population=5,
            held_bleed_min=3,
            held_bleed_max=3,
            unique_held_bleed_multiplier=1.0,
            join_rate=0.0,
            quit_rate=0.0,
            pickup_probability=0.0,
            transfer_probability=0.0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
        )
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))
        from sim.types import ItemInstance

        unique_type_id = cfg.num_item_types_common + cfg.num_item_types_rare
        item = ItemInstance(
            instance_id=8888,
            type_id=unique_type_id,
            rarity=Rarity.UNIQUE,
            holder=agent_id,
            anchor=None,
            bleed_at=2,
        )
        engine.state.items[item.instance_id] = item
        engine._state.tick = 1
        engine.tick()  # tick 2 — bleed fires

        # Unique must always land — it should be at an anchor, not deleted
        assert 8888 in engine.state.items
        assert engine.state.items[8888].anchor is not None
        assert engine.state.items[8888].holder is None


# ---------------------------------------------------------------------------
# Quit / scatter
# ---------------------------------------------------------------------------


class TestQuitScatter:
    def test_quit_scatters_held_items_to_world(self):
        cfg = make_cfg(
            initial_population=2,
            k_c=10.0,     # wide cap so landing_prob = 1.0
            join_rate=0.0,
            quit_rate=0.0,
            pickup_probability=0.0,
            transfer_probability=0.0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
            unique_count=0,
        )
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))
        from sim.types import ItemInstance

        # Give agent two held items
        for iid in (100, 101):
            engine.state.items[iid] = ItemInstance(
                instance_id=iid,
                type_id=0,
                rarity=Rarity.COMMON,
                holder=agent_id,
                anchor=None,
                bleed_at=FAR_FUTURE,
            )

        # Force quit
        engine._scatter_agent_items(engine.state.agents[agent_id])
        engine.state.agents[agent_id].state = AgentState.QUIT
        engine._state.population -= 1

        # Items must now be at anchors, not held
        for iid in (100, 101):
            assert iid in engine.state.items
            assert engine.state.items[iid].anchor is not None
            assert engine.state.items[iid].holder is None

    def test_quit_reduces_population(self):
        cfg = make_cfg(initial_population=5, join_rate=0.0, quit_rate=1.0)
        engine = SimEngine(cfg, seed=42)
        start_pop = engine.state.population
        engine.tick()
        assert engine.state.population < start_pop


# ---------------------------------------------------------------------------
# Collapse
# ---------------------------------------------------------------------------


class TestCollapse:
    def test_agent_collapses_at_correct_tick(self):
        cfg = make_cfg(
            initial_population=1,
            collapse_duration=10,
            first_universe_multiplier=1.0,
            join_rate=0.0,
            quit_rate=0.0,
        )
        engine = SimEngine(cfg, seed=0)
        # Agent should be alive until tick 10
        for _ in range(9):
            engine.tick()
        agent = next(iter(engine.state.agents.values()))
        assert agent.state != AgentState.QUIT

        engine.tick()  # tick 10 — collapse fires
        agent = next(iter(engine.state.agents.values()))
        assert agent.state == AgentState.QUIT

    def test_first_universe_grace_extends_collapse(self):
        cfg = make_cfg(
            initial_population=1,
            collapse_duration=10,
            first_universe_multiplier=2.0,
            join_rate=0.0,
            quit_rate=0.0,
        )
        engine = SimEngine(cfg, seed=0)
        agent = next(iter(engine.state.agents.values()))
        # First universe gets 10 * 2.0 = 20 ticks
        assert agent.collapse_at == 20


# ---------------------------------------------------------------------------
# Landing probability under over-supply
# ---------------------------------------------------------------------------


class TestLandingProbability:
    def test_landing_prob_is_one_when_within_cap(self):
        cfg = make_cfg(initial_population=10, k_c=2.0, landing_curve_steepness=1.0)
        engine = SimEngine(cfg, seed=0)
        # With 0 common items and cap=20, probability should be 1.0
        prob = engine._landing_probability(Rarity.COMMON)
        assert prob == 1.0

    def test_landing_prob_less_than_one_when_above_cap(self):
        cfg = make_cfg(
            initial_population=5, k_c=1.0,  # cap = 5
            landing_curve_steepness=1.0,
            unique_count=0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
        )
        engine = SimEngine(cfg, seed=0)
        from sim.types import ItemInstance

        # Insert 10 common items (2× cap)
        for i in range(10):
            engine.state.items[i] = ItemInstance(
                instance_id=i,
                type_id=0,
                rarity=Rarity.COMMON,
                holder=None,
                anchor=0,
                bleed_at=FAR_FUTURE,
            )
        prob = engine._landing_probability(Rarity.COMMON)
        assert prob < 1.0

    def test_unique_landing_prob_always_one(self):
        cfg = make_cfg(initial_population=5)
        engine = SimEngine(cfg, seed=0)
        assert engine._landing_probability(Rarity.UNIQUE) == 1.0


# ---------------------------------------------------------------------------
# Invariant violations reported during tick
# ---------------------------------------------------------------------------


class TestInvariantsDuringTick:
    def test_tick_returns_list(self):
        cfg = make_cfg(initial_population=5)
        engine = SimEngine(cfg, seed=0)
        result = engine.tick()
        assert isinstance(result, list)

    def test_run_returns_sim_result(self):
        from sim.types import SimResult

        cfg = make_cfg(initial_population=5)
        engine = SimEngine(cfg, seed=0)
        result = engine.run(10)
        assert isinstance(result, SimResult)
        assert result.ticks_run == 10

    def test_inv6_never_violated_in_stable_run(self):
        cfg = make_cfg(
            initial_population=10,
            k_c=2.0,
            k_r=0.2,
            join_rate=0.0,
            quit_rate=0.0,
            spawn_rate_common=0.5,
            spawn_rate_rare=0.05,
        )
        engine = SimEngine(cfg, seed=0)
        result = engine.run(200)
        inv6_violations = [v for v in result.violations if v.invariant == "INV-6"]
        assert inv6_violations == [], f"Spawner violated INV-6: {inv6_violations}"


FAR_FUTURE = 100_000
