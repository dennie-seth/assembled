"""Unit tests for SimEngine mechanics.

Tests discrete-time event processing: agent lifecycle, item spawning,
bleed timers, scatter on quit, landing probability, and the four
wall-clocks (held bleed, world/escrow bleed, unlock decay, collapse).
See docs/design/08-invariants.md §4 and docs/design/07-items-economy.md.
"""

from __future__ import annotations

from conftest import make_cfg
from sim.engine import SimEngine
from sim.types import AgentState, Rarity

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
# Unlock decay — the third wall-clock (10 §2/§3)
# ---------------------------------------------------------------------------


class TestUnlockDecay:
    def test_pickup_grants_a_tiered_unlock(self):
        cfg = make_cfg(
            initial_population=1,
            join_rate=0.0,
            quit_rate=0.0,
            idle_probability=0.0,
            transfer_probability=0.0,
            pickup_probability=1.0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
            unique_count=0,
        )
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))
        from sim.types import ItemInstance

        engine.state.items[500] = ItemInstance(
            instance_id=500,
            type_id=0,
            rarity=Rarity.COMMON,
            holder=None,
            anchor=0,
            bleed_at=FAR_FUTURE,
        )
        engine.tick()

        assert len(engine.state.unlocks) == 1
        unlock = next(iter(engine.state.unlocks.values()))
        assert unlock.agent_id == agent_id
        assert unlock.tag == 0
        assert unlock.tier == "tactical"
        assert unlock.expires_at == engine.state.tick + cfg.unlock_decay_tactical

    def test_unlock_tier_and_duration_matches_granting_rarity(self):
        cfg = make_cfg(
            initial_population=1,
            unlock_decay_tactical=10,
            unlock_decay_session=50,
            unlock_decay_unique_keyed=200,
        )
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))

        engine._grant_unlock(agent_id, tag=0, rarity=Rarity.COMMON)
        engine._grant_unlock(agent_id, tag=1, rarity=Rarity.RARE)
        engine._grant_unlock(agent_id, tag=2, rarity=Rarity.UNIQUE)

        by_tag = {u.tag: u for u in engine.state.unlocks.values()}
        assert by_tag[0].tier == "tactical"
        assert by_tag[0].expires_at == cfg.unlock_decay_tactical
        assert by_tag[1].tier == "session"
        assert by_tag[1].expires_at == cfg.unlock_decay_session
        assert by_tag[2].tier == "unique_keyed"
        assert by_tag[2].expires_at == cfg.unlock_decay_unique_keyed

    def test_unlock_decays_after_its_tier_duration(self):
        cfg = make_cfg(initial_population=1, unlock_decay_tactical=3)
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))
        engine._grant_unlock(agent_id, tag=0, rarity=Rarity.COMMON)
        assert len(engine.state.unlocks) == 1

        engine._state.tick = 2
        engine.tick()  # tick 3 — expires_at == 3, decay fires

        assert len(engine.state.unlocks) == 0

    def test_unlock_survives_before_its_expiry(self):
        cfg = make_cfg(initial_population=1, unlock_decay_tactical=3)
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))
        engine._grant_unlock(agent_id, tag=0, rarity=Rarity.COMMON)

        engine._state.tick = 1
        engine.tick()  # tick 2 — still short of expires_at == 3

        assert len(engine.state.unlocks) == 1


# ---------------------------------------------------------------------------
# Rarity-cap enforcement under population shrinkage (INV-6 hard ceiling)
# ---------------------------------------------------------------------------


class TestRarityCapEnforcement:
    def test_population_crash_forces_common_supply_below_new_cap(self):
        cfg = make_cfg(
            initial_population=10,
            k_c=2.0,
            k_r=0.0,
            join_rate=0.0,
            quit_rate=0.0,
            unique_count=0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
        )
        engine = SimEngine(cfg, seed=0)
        from sim.types import ItemInstance

        # Inflate common supply to what P=10 allows (cap = 20)
        for i in range(20):
            engine.state.items[i] = ItemInstance(
                instance_id=i,
                type_id=0,
                rarity=Rarity.COMMON,
                holder=None,
                anchor=0,
                bleed_at=FAR_FUTURE,
            )
        # Every agent collapses on the very next tick — P crashes to 0
        for agent in engine.state.agents.values():
            agent.collapse_at = engine.state.tick + 1

        engine.tick()

        common_cap = int(cfg.k_c * engine.state.population)
        assert _count(engine, Rarity.COMMON) <= common_cap

    def test_enforcement_never_touches_held_items(self):
        cfg = make_cfg(
            initial_population=1,
            k_c=1.0,  # cap = 1
            k_r=0.0,
            join_rate=0.0,
            quit_rate=0.0,
            unique_count=0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
            pickup_probability=0.0,
            transfer_probability=0.0,
        )
        engine = SimEngine(cfg, seed=0)
        from sim.types import ItemInstance

        agent_id = next(iter(engine.state.agents))
        # Agent alone holds 2 common items — already over the cap of 1, with
        # no world-anchored instances to sacrifice instead. Design (07 §4)
        # forbids confiscating from a player's hands, so enforcement must
        # leave both held instances in place even though the cap stays
        # violated — that is an over-supply finding, not a bug to paper over.
        for iid in (100, 101):
            engine.state.items[iid] = ItemInstance(
                instance_id=iid,
                type_id=0,
                rarity=Rarity.COMMON,
                holder=agent_id,
                anchor=None,
                bleed_at=FAR_FUTURE,
            )
        engine.tick()

        for iid in (100, 101):
            assert iid in engine.state.items
            assert engine.state.items[iid].holder == agent_id


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


# ---------------------------------------------------------------------------
# Recipient selection on pickup contention (DM-5)
# ---------------------------------------------------------------------------


class TestRecipientPolicy:
    def test_fifo_is_creation_order(self):
        cfg = make_cfg(initial_population=5, recipient_policy="fifo")
        engine = SimEngine(cfg, seed=0)
        ordered = engine._ordered_playing_agents()
        assert [a.agent_id for a in ordered] == sorted(engine.state.agents.keys())

    def test_need_weighted_sorts_by_fewest_items_received_first(self):
        cfg = make_cfg(initial_population=4, recipient_policy="need_weighted")
        engine = SimEngine(cfg, seed=0)
        agents = list(engine.state.agents.values())
        agents[0].items_received = 5
        agents[1].items_received = 0
        agents[2].items_received = 2
        agents[3].items_received = 1

        ordered = engine._ordered_playing_agents()
        assert [a.items_received for a in ordered] == [0, 1, 2, 5]

    def test_random_policy_is_a_permutation_of_all_playing_agents(self):
        cfg = make_cfg(initial_population=10, recipient_policy="random")
        engine = SimEngine(cfg, seed=0)
        ordered = engine._ordered_playing_agents()
        assert sorted(a.agent_id for a in ordered) == sorted(engine.state.agents.keys())

    def test_unknown_policy_raises(self):
        cfg = make_cfg(initial_population=2, recipient_policy="bogus")
        engine = SimEngine(cfg, seed=0)
        try:
            engine._ordered_playing_agents()
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError for unknown recipient_policy")

    def test_fifo_vs_need_weighted_change_who_wins_scarce_pickup(self):
        """Two agents, one scarce world item, both roll a successful pickup
        in the same tick — the winner must depend on recipient_policy."""
        from sim.types import ItemInstance

        def run_once(policy: str) -> int:
            cfg = make_cfg(
                initial_population=2,
                recipient_policy=policy,
                pickup_probability=1.0,
                transfer_probability=0.0,
                spawn_rate_common=0.0,
                spawn_rate_rare=0.0,
                unique_count=0,
                idle_probability=0.0,
            )
            engine = SimEngine(cfg, seed=0)
            ids = sorted(engine.state.agents.keys())
            engine.state.agents[ids[0]].items_received = 3  # richer, but first in creation order
            engine.state.items[999] = ItemInstance(
                instance_id=999,
                type_id=0,
                rarity=Rarity.COMMON,
                holder=None,
                anchor=0,
                bleed_at=FAR_FUTURE,
            )
            engine.tick()
            return engine.state.items[999].holder

        assert run_once("fifo") == 0  # creation order — agent 0 goes first regardless of wealth
        assert run_once("need_weighted") == 1  # agent 1 has fewer items_received, goes first


# ---------------------------------------------------------------------------
# Chain-tear key consumption (Q4 — unique drain)
# ---------------------------------------------------------------------------


class TestChainKeyConsumption:
    def _pickup_cfg(self, **overrides):
        defaults = dict(
            initial_population=1,
            unique_count=1,
            join_rate=0.0,
            quit_rate=0.0,
            idle_probability=0.0,
            pickup_probability=1.0,
            transfer_probability=0.0,
            spawn_rate_common=0.0,
            spawn_rate_rare=0.0,
            chain_key_enabled=True,
            chain_key_crossings_required=2,
        )
        defaults.update(overrides)
        return make_cfg(**defaults)

    def test_destroy_mode_permanently_removes_the_unique(self):
        cfg = self._pickup_cfg(chain_key_mode="destroy")
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))

        engine.tick()

        assert _count(engine, Rarity.UNIQUE) == 0
        assert engine.state.agents[agent_id].chain_progress == 1

    def test_transfer_mode_keeps_the_unique_in_circulation(self):
        cfg = self._pickup_cfg(chain_key_mode="transfer")
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))

        engine.tick()

        assert _count(engine, Rarity.UNIQUE) == 1
        item = next(iter(engine.state.items.values()))
        assert item.anchor is not None
        assert item.holder is None
        assert engine.state.agents[agent_id].chain_progress == 1

    def test_disabled_by_default_falls_back_to_ordinary_held_bleed(self):
        cfg = self._pickup_cfg(chain_key_enabled=False)
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))

        engine.tick()

        assert _count(engine, Rarity.UNIQUE) == 1
        item = next(iter(engine.state.items.values()))
        assert item.holder == agent_id
        assert engine.state.agents[agent_id].chain_progress == 0

    def test_stops_consuming_once_crossings_required_reached(self):
        cfg = self._pickup_cfg(chain_key_mode="destroy", chain_key_crossings_required=1)
        engine = SimEngine(cfg, seed=0)
        agent_id = next(iter(engine.state.agents))

        engine.tick()  # crosses once, unique #1 destroyed
        assert engine.state.agents[agent_id].chain_progress == 1

        # Give the agent a second unique — it should NOT be consumed now.
        from sim.types import ItemInstance

        engine.state.items[7777] = ItemInstance(
            instance_id=7777,
            type_id=cfg.num_item_types_common + cfg.num_item_types_rare,
            rarity=Rarity.UNIQUE,
            holder=None,
            anchor=0,
            bleed_at=FAR_FUTURE,
        )
        engine.tick()

        assert 7777 in engine.state.items
        assert engine.state.items[7777].holder == agent_id
        assert engine.state.agents[agent_id].chain_progress == 1


FAR_FUTURE = 100_000
