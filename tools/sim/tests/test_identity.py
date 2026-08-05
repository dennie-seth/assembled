"""Tests for multi-universe identity separation (T-0129).

Validates that:
  - Collapse starts a new universe rather than terminating the identity
    (collapse_at fires -> universe_count increments, agent stays PLAYING)
  - Vocabulary is identity-level state: accumulated on pickup, never cleared
    by collapse regardless of unlock_scope
  - Unique-keyed unlocks are identity-level: survive collapse in both scopes
  - Per-run vs per-week unlock scope is a distinguishable config setting:
      unlock_scope="per_run"  -> tactical and session unlocks wiped on collapse
      unlock_scope="per_week" -> they persist until their timer expires

See docs/design/10-time-and-progression.md §2/§3, docs/HANDOFF.md §11.5.
"""

from __future__ import annotations

from conftest import (
    FAR_FUTURE,
    make_cfg,
)
from sim.engine import SimEngine
from sim.types import AgentState, ItemInstance, Rarity


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _force_collapse(engine: SimEngine) -> None:
    """Advance a single-agent engine to the tick that triggers collapse."""
    agent = next(iter(engine.state.agents.values()))
    engine._state.tick = agent.collapse_at - 1
    engine.tick()  # fires collapse


def _single_agent_engine(**cfg_kwargs) -> SimEngine:
    defaults = dict(
        initial_population=1,
        join_rate=0.0,
        quit_rate=0.0,
        pickup_probability=0.0,
        transfer_probability=0.0,
        spawn_rate_common=0.0,
        spawn_rate_rare=0.0,
        unique_count=0,
        idle_probability=0.0,
        collapse_duration=10,
        first_universe_multiplier=1.0,
    )
    defaults.update(cfg_kwargs)
    return SimEngine(make_cfg(**defaults), seed=0)


# ---------------------------------------------------------------------------
# AC-1: collapse starts a new universe, identity survives
# ---------------------------------------------------------------------------


class TestCollapseStartsNewUniverse:
    def test_collapse_does_not_terminate_identity(self):
        """After collapse fires, agent must NOT be in the QUIT state."""
        engine = _single_agent_engine()
        _force_collapse(engine)
        agent = next(iter(engine.state.agents.values()))
        assert agent.state != AgentState.QUIT

    def test_universe_count_increments_on_collapse(self):
        """universe_count goes from 0 to 1 on the first collapse."""
        engine = _single_agent_engine()
        agent = next(iter(engine.state.agents.values()))
        assert agent.universe_count == 0  # starts in first universe

        _force_collapse(engine)

        agent = next(iter(engine.state.agents.values()))
        assert agent.universe_count == 1

    def test_population_unchanged_by_collapse(self):
        """Population must not decrement when collapse fires — the identity
        persists into a new universe, it does not leave the simulation."""
        engine = _single_agent_engine()
        pop_before = engine.state.population
        _force_collapse(engine)
        assert engine.state.population == pop_before

    def test_second_universe_collapse_at_uses_base_duration(self):
        """After collapse, the next collapse_at = tick + collapse_duration
        (no first_universe_multiplier applied to subsequent universes)."""
        engine = _single_agent_engine(collapse_duration=10, first_universe_multiplier=2.0)
        agent = next(iter(engine.state.agents.values()))
        # First universe collapse_at = 0 + 10*2.0 = 20
        assert agent.collapse_at == 20

        _force_collapse(engine)
        tick_after = engine.state.tick
        agent = next(iter(engine.state.agents.values()))
        # Second universe: tick_after + 10 (base only, no multiplier)
        assert agent.collapse_at == tick_after + 10

    def test_per_run_stats_reset_on_collapse(self):
        """items_received and ticks_active are run-scoped and reset on collapse."""
        engine = _single_agent_engine()
        agent = next(iter(engine.state.agents.values()))
        agent.items_received = 7
        agent.ticks_active = 42

        _force_collapse(engine)

        agent = next(iter(engine.state.agents.values()))
        assert agent.items_received == 0
        assert agent.ticks_active == 0

    def test_held_items_scatter_on_collapse(self):
        """Held items must be scattered (world-anchored) when a universe ends."""
        engine = _single_agent_engine(k_c=10.0)  # wide cap so landing_prob = 1.0
        agent = next(iter(engine.state.agents.values()))
        engine.state.items[9001] = ItemInstance(
            instance_id=9001,
            type_id=0,
            rarity=Rarity.COMMON,
            holder=agent.agent_id,
            anchor=None,
            bleed_at=FAR_FUTURE,
        )
        _force_collapse(engine)
        # Item must now be world-anchored, not held
        assert 9001 in engine.state.items
        assert engine.state.items[9001].anchor is not None
        assert engine.state.items[9001].holder is None


# ---------------------------------------------------------------------------
# AC-2: vocabulary and unlock state are identity-level
# ---------------------------------------------------------------------------


class TestVocabularyIdentityLevel:
    def test_vocabulary_populated_on_pickup(self):
        """Picking up an item of type_id X adds X to agent.vocabulary."""
        engine = _single_agent_engine(
            pickup_probability=1.0,
            k_c=10.0,
            spawn_rate_common=0.0,
        )
        agent = next(iter(engine.state.agents.values()))
        engine.state.items[200] = ItemInstance(
            instance_id=200,
            type_id=0,
            rarity=Rarity.COMMON,
            holder=None,
            anchor=0,
            bleed_at=FAR_FUTURE,
        )
        engine.tick()
        assert 0 in agent.vocabulary

    def test_vocabulary_persists_across_collapse(self):
        """Words gained in universe N survive the collapse into universe N+1."""
        engine = _single_agent_engine(
            pickup_probability=1.0,
            k_c=10.0,
        )
        agent = next(iter(engine.state.agents.values()))
        # Manually seed vocabulary before collapse
        agent.vocabulary.add(99)

        _force_collapse(engine)

        agent = next(iter(engine.state.agents.values()))
        assert 99 in agent.vocabulary

    def test_vocabulary_is_additive_across_universes(self):
        """Words added in universe 2 append to the vocabulary from universe 1."""
        engine = _single_agent_engine(
            pickup_probability=1.0,
            k_c=10.0,
        )
        agent = next(iter(engine.state.agents.values()))
        agent.vocabulary.add(1)

        _force_collapse(engine)

        agent = next(iter(engine.state.agents.values()))
        agent.vocabulary.add(2)
        assert 1 in agent.vocabulary
        assert 2 in agent.vocabulary


# ---------------------------------------------------------------------------
# AC-3: per-run vs per-week unlock scopes are distinguishable
# ---------------------------------------------------------------------------


class TestUnlockScopeDistinction:
    """unlock_scope="per_run" clears tactical/session unlocks at collapse.
    unlock_scope="per_week" preserves them past the collapse boundary.
    Unique-keyed unlocks survive collapse in *both* scopes — they are
    identity-level by design (10 §3).
    """

    def _engine_with_unlocks(self, scope: str) -> SimEngine:
        engine = _single_agent_engine(
            unlock_scope=scope,
            unlock_decay_tactical=FAR_FUTURE,
            unlock_decay_session=FAR_FUTURE,
            unlock_decay_unique_keyed=FAR_FUTURE,
        )
        agent = next(iter(engine.state.agents.values()))
        engine._grant_unlock(agent.agent_id, tag=0, rarity=Rarity.COMMON)    # tactical
        engine._grant_unlock(agent.agent_id, tag=1, rarity=Rarity.RARE)      # session
        engine._grant_unlock(agent.agent_id, tag=2, rarity=Rarity.UNIQUE)    # unique_keyed
        return engine

    def _unlocks_for(self, engine: SimEngine, tier: str) -> list:
        agent = next(iter(engine.state.agents.values()))
        return [
            u for u in engine.state.unlocks.values()
            if u.agent_id == agent.agent_id and u.tier == tier
        ]

    def test_per_run_scope_clears_tactical_on_collapse(self):
        engine = self._engine_with_unlocks("per_run")
        _force_collapse(engine)
        assert self._unlocks_for(engine, "tactical") == []

    def test_per_run_scope_clears_session_on_collapse(self):
        engine = self._engine_with_unlocks("per_run")
        _force_collapse(engine)
        assert self._unlocks_for(engine, "session") == []

    def test_per_run_scope_preserves_unique_keyed_on_collapse(self):
        """unique_keyed is identity-level: must survive even in per_run scope."""
        engine = self._engine_with_unlocks("per_run")
        _force_collapse(engine)
        assert len(self._unlocks_for(engine, "unique_keyed")) == 1

    def test_per_week_scope_preserves_tactical_on_collapse(self):
        engine = self._engine_with_unlocks("per_week")
        _force_collapse(engine)
        assert len(self._unlocks_for(engine, "tactical")) == 1

    def test_per_week_scope_preserves_session_on_collapse(self):
        engine = self._engine_with_unlocks("per_week")
        _force_collapse(engine)
        assert len(self._unlocks_for(engine, "session")) == 1

    def test_per_week_scope_preserves_unique_keyed_on_collapse(self):
        engine = self._engine_with_unlocks("per_week")
        _force_collapse(engine)
        assert len(self._unlocks_for(engine, "unique_keyed")) == 1

    def test_per_run_and_per_week_differ_on_tactical_survival(self):
        """The two scope values must produce a different outcome on collapse
        for the tactical tier — this is the distinguishability requirement."""
        engine_run = self._engine_with_unlocks("per_run")
        engine_week = self._engine_with_unlocks("per_week")
        _force_collapse(engine_run)
        _force_collapse(engine_week)
        tactical_run = self._unlocks_for(engine_run, "tactical")
        tactical_week = self._unlocks_for(engine_week, "tactical")
        assert len(tactical_run) == 0
        assert len(tactical_week) == 1
