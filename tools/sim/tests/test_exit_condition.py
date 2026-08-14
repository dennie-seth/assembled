"""Tests for the T-0130 exit condition (01-vision.md §5).

AC-1: An identity is marked complete the moment it simultaneously holds N_exit
      distinct unique types (01-vision.md §5, 08-invariants.md INV-13).
      "Exit progress never persists" — the condition is evaluated at the instant
      of simultaneous possession; there is no partial credit.

AC-2: Completion events are recorded with a tick timestamp (sim.types.Agent).

AC-3: Completion rate is reportable per population sweep point — fraction of
      identities completed by end of run, at each P (sim.run_inv14).
"""

from __future__ import annotations

import pytest

from conftest import FAR_FUTURE, make_cfg
from sim.engine import SimEngine
from sim.run_inv14 import _run_one_point, run_chain_key_population_sweep
from sim.types import ItemInstance, Rarity

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _single_agent_engine(**cfg_kwargs: object) -> SimEngine:
    """Minimal single-agent engine with all randomness suppressed."""
    defaults: dict[str, object] = dict(
        initial_population=1,
        join_rate=0.0,
        quit_rate=0.0,
        pickup_probability=0.0,
        transfer_probability=0.0,
        spawn_rate_common=0.0,
        spawn_rate_rare=0.0,
        unique_count=0,  # no auto-placed uniques; tests place them manually
        idle_probability=0.0,
        collapse_duration=10_000,
        first_universe_multiplier=1.0,
    )
    defaults.update(cfg_kwargs)
    return SimEngine(make_cfg(**defaults), seed=0)


def _exit_engine(n_exit: int) -> SimEngine:
    """Single-agent engine with pickup_probability=1.0 and no world items except
    those placed by the test. Use to drive exit-condition detection via tick()."""
    return _single_agent_engine(
        n_exit=n_exit,
        pickup_probability=1.0,
    )


def _force_collapse(engine: SimEngine) -> None:
    """Advance a single-agent engine to the tick that triggers collapse."""
    agent = next(iter(engine.state.agents.values()))
    engine._state.tick = agent.collapse_at - 1
    engine.tick()


def _place_unique(
    engine: SimEngine,
    instance_id: int,
    type_id: int,
    anchor: int = 0,
) -> None:
    """Place a unique item at a world anchor for the engine to pick up."""
    engine.state.items[instance_id] = ItemInstance(
        instance_id=instance_id,
        type_id=type_id,
        rarity=Rarity.UNIQUE,
        holder=None,
        anchor=anchor,
        bleed_at=FAR_FUTURE,
    )


# ---------------------------------------------------------------------------
# AC-1: identity marked complete when simultaneously holding N_exit uniques
# ---------------------------------------------------------------------------


class TestExitConditionDetection:
    """An identity completes the moment it simultaneously holds N_exit distinct
    unique type_ids.  Holding fewer than N_exit is never sufficient; holding
    N_exit with duplicate type_ids is also insufficient (counts as fewer types).
    """

    def test_agent_not_complete_initially(self) -> None:
        """Fresh agent has is_complete = False and completed_at = None."""
        engine = _exit_engine(n_exit=1)
        agent = next(iter(engine.state.agents.values()))
        assert agent.is_complete is False

    def test_completed_at_none_before_any_completion(self) -> None:
        """completed_at is None until the exit condition first fires."""
        engine = _exit_engine(n_exit=1)
        agent = next(iter(engine.state.agents.values()))
        assert agent.completed_at is None

    def test_not_complete_with_fewer_than_n_exit_uniques(self) -> None:
        """Holding n_exit-1 unique types is not sufficient for completion."""
        engine = _exit_engine(n_exit=2)
        agent = next(iter(engine.state.agents.values()))
        _place_unique(engine, instance_id=100, type_id=5)
        engine.tick()  # agent picks up type 5 — holds 1 unique, needs 2
        assert agent.is_complete is False

    def test_complete_when_exactly_n_exit_uniques_held(self) -> None:
        """Picking up the N_exit-th distinct unique type marks the agent complete."""
        engine = _exit_engine(n_exit=2)
        agent = next(iter(engine.state.agents.values()))
        _place_unique(engine, instance_id=100, type_id=5)
        _place_unique(engine, instance_id=101, type_id=6)
        engine.tick()  # picks up one unique (holds 1 type)
        engine.tick()  # picks up second unique (holds 2 types) → complete
        assert agent.is_complete is True

    def test_complete_when_more_than_n_exit_uniques_held(self) -> None:
        """Holding more than N_exit distinct unique types also satisfies the condition."""
        engine = _exit_engine(n_exit=1)
        agent = next(iter(engine.state.agents.values()))
        _place_unique(engine, instance_id=100, type_id=5)
        _place_unique(engine, instance_id=101, type_id=6)
        engine.tick()  # picks up first unique → already complete (n_exit=1)
        assert agent.is_complete is True

    def test_duplicate_type_ids_count_as_one_unique_type(self) -> None:
        """Two instances of the same unique type_id count as a single unique type,
        not two, so they cannot satisfy n_exit=2 by themselves."""
        engine = _exit_engine(n_exit=2)
        agent = next(iter(engine.state.agents.values()))
        _place_unique(engine, instance_id=100, type_id=5)
        _place_unique(engine, instance_id=101, type_id=5)  # same type_id
        engine.tick()
        engine.tick()
        # Holding 2 instances of type 5 counts as 1 distinct type → not complete
        assert agent.is_complete is False

    def test_requires_simultaneous_possession_not_sequential(self) -> None:
        """Completion only fires when N_exit distinct uniques are held *at the same
        time*, not when N_exit have been held across separate pickup events where
        items may have bled away between them.

        This test places one unique, lets the agent pick it up (no completion yet),
        then places a second unique and checks completion fires only on the second
        pickup — demonstrating the simultaneous check at each pickup moment.
        """
        engine = _exit_engine(n_exit=2)
        agent = next(iter(engine.state.agents.values()))
        _place_unique(engine, instance_id=100, type_id=5)
        engine.tick()  # holds type 5; count=1, not complete
        assert agent.is_complete is False
        _place_unique(engine, instance_id=101, type_id=6)
        engine.tick()  # holds types 5 and 6; count=2 → complete
        assert agent.is_complete is True


# ---------------------------------------------------------------------------
# AC-2: completion recorded with a tick timestamp
# ---------------------------------------------------------------------------


class TestCompletionTimestamp:
    """completed_at must be set to the sim tick at which N_exit uniques were
    first held simultaneously, and must remain stable (no second completion event
    overwrites it once it is set).
    """

    def test_completed_at_set_to_tick_of_completion(self) -> None:
        """completed_at equals the tick at which the exit condition first fired."""
        engine = _exit_engine(n_exit=1)
        _place_unique(engine, instance_id=100, type_id=5)
        engine.tick()  # tick 1: agent picks up the unique → completes
        agent = next(iter(engine.state.agents.values()))
        assert agent.completed_at == engine.state.tick

    def test_completed_at_matches_current_tick_at_moment_of_completion(self) -> None:
        """Completion fires on tick N; completed_at == N, not N-1 or N+1."""
        engine = _exit_engine(n_exit=2)
        _place_unique(engine, instance_id=100, type_id=5)
        _place_unique(engine, instance_id=101, type_id=6)
        engine.tick()  # tick 1: picks up first unique, not complete
        engine.tick()  # tick 2: picks up second unique, completes
        agent = next(iter(engine.state.agents.values()))
        assert agent.completed_at == 2

    def test_completed_at_not_overwritten_on_subsequent_pickups(self) -> None:
        """Once set, completed_at stays at the first-completion tick even if the
        agent picks up additional items later."""
        engine = _exit_engine(n_exit=1)
        _place_unique(engine, instance_id=100, type_id=5)
        _place_unique(engine, instance_id=101, type_id=6)
        engine.tick()  # tick 1: completes on first unique pickup
        agent = next(iter(engine.state.agents.values()))
        first_completed_at = agent.completed_at
        engine.tick()  # tick 2: picks up second unique; is_complete already True
        assert agent.completed_at == first_completed_at  # unchanged


# ---------------------------------------------------------------------------
# AC-1 (continued): completion is identity-level — survives collapse
# ---------------------------------------------------------------------------


class TestCompletionSurvivesCollapse:
    """is_complete and completed_at are identity-level state: they survive
    collapse into a new universe (T-0129 pattern).  Once an identity completes,
    it remains complete regardless of how many subsequent universes it enters.
    """

    def test_is_complete_survives_collapse(self) -> None:
        """is_complete stays True after a collapse event."""
        engine = _exit_engine(n_exit=1)
        agent = next(iter(engine.state.agents.values()))
        _place_unique(engine, instance_id=100, type_id=5)
        engine.tick()  # completes
        assert agent.is_complete is True
        _force_collapse(engine)
        agent = next(iter(engine.state.agents.values()))
        assert agent.is_complete is True

    def test_completed_at_survives_collapse(self) -> None:
        """completed_at is preserved across the collapse boundary."""
        engine = _exit_engine(n_exit=1)
        agent = next(iter(engine.state.agents.values()))
        _place_unique(engine, instance_id=100, type_id=5)
        engine.tick()
        tick_of_completion = agent.completed_at
        _force_collapse(engine)
        agent = next(iter(engine.state.agents.values()))
        assert agent.completed_at == tick_of_completion

    def test_incomplete_identity_stays_incomplete_after_collapse(self) -> None:
        """An identity that has not yet completed does not become complete on collapse."""
        engine = _exit_engine(n_exit=2)  # needs 2 uniques, gets 0
        _force_collapse(engine)
        agent = next(iter(engine.state.agents.values()))
        assert agent.is_complete is False


# ---------------------------------------------------------------------------
# AC-3: completion rate reportable per population sweep point
# ---------------------------------------------------------------------------


class TestCompletionRateReporting:
    """completion_rate is included in _run_one_point output and in the population
    sweep rows, so T-0133 can report it as f(P) with IQR bands.
    """

    def test_run_one_point_has_completion_rate_field(self) -> None:
        """_run_one_point must return a 'completion_rate' key."""
        result = _run_one_point(population=5, ticks=50, seed=1)
        assert "completion_rate" in result

    def test_completion_rate_is_float_in_zero_one(self) -> None:
        """completion_rate must be a float in [0.0, 1.0]."""
        result = _run_one_point(population=5, ticks=50, seed=1)
        rate = result["completion_rate"]
        assert isinstance(rate, float)
        assert 0.0 <= rate <= 1.0

    def test_completion_rate_zero_when_n_exit_exceeds_unique_count(self) -> None:
        """When n_exit > unique_count, completion is impossible; rate must be 0.0."""
        result = _run_one_point(
            population=10,
            ticks=300,
            seed=1,
            n_exit=10,       # need 10 distinct uniques
            unique_count=5,  # only 5 unique types exist → impossible
        )
        assert result["completion_rate"] == pytest.approx(0.0)

    def test_completion_rate_positive_when_n_exit_equals_one(self) -> None:
        """With n_exit=1, holding any single unique suffices. Over enough ticks
        in a small population some agents should complete."""
        result = _run_one_point(
            population=2,
            ticks=400,
            seed=1,
            unique_count=5,
            n_exit=1,
            chain_key_enabled=False,  # keep uniques in circulation
        )
        assert result["completion_rate"] > 0.0

    def test_sweep_rows_include_completion_rate_stats(self) -> None:
        """run_chain_key_population_sweep rows must contain completion rate IQR fields."""
        rows = run_chain_key_population_sweep(
            population_range=[5, 20],
            ticks_per_run=60,
            seed=1,
            seeds_per_point=2,
        )
        required = [
            "completion_rate_median",
            "completion_rate_q1",
            "completion_rate_q3",
            "completion_rate_iqr",
        ]
        for row in rows:
            for field in required:
                assert field in row, f"sweep row missing field: {field!r}"

    def test_completion_rate_in_sweep_is_float_in_zero_one(self) -> None:
        """completion_rate_median in sweep rows must be in [0.0, 1.0]."""
        rows = run_chain_key_population_sweep(
            population_range=[10],
            ticks_per_run=60,
            seed=1,
            seeds_per_point=2,
        )
        assert 0.0 <= rows[0]["completion_rate_median"] <= 1.0

    def test_completion_rate_iqr_bounds_consistent(self) -> None:
        """q1 <= median <= q3 and iqr == q3 - q1 for completion_rate."""
        rows = run_chain_key_population_sweep(
            population_range=[10],
            ticks_per_run=100,
            seed=1,
            seeds_per_point=3,
        )
        row = rows[0]
        assert row["completion_rate_q1"] <= row["completion_rate_median"]
        assert row["completion_rate_median"] <= row["completion_rate_q3"]
        assert row["completion_rate_iqr"] == pytest.approx(
            row["completion_rate_q3"] - row["completion_rate_q1"]
        )

    def test_deterministic_completion_rate_for_fixed_seed(self) -> None:
        """Completion rate is reproducible for a fixed seed."""
        kwargs: dict[str, object] = dict(
            population_range=[5],
            ticks_per_run=60,
            seed=7,
            seeds_per_point=2,
        )
        rows1 = run_chain_key_population_sweep(**kwargs)
        rows2 = run_chain_key_population_sweep(**kwargs)
        assert rows1[0]["completion_rate_median"] == pytest.approx(
            rows2[0]["completion_rate_median"]
        )
