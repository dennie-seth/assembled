"""Invariant predicate functions for the economy simulation.

One definition, three consumers: these predicates are used by
  1. This module's unit tests (test_invariants.py)
  2. SimEngine.tick() — checked every tick during a run
  3. Production monitoring (future, same predicate logic)

Invariants INV-6..9 and INV-14 from docs/design/08-invariants.md §2.
All functions are pure: they read SimState and return a list of violations.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import SimConfig
from .types import AgentState, Rarity, SimState


@dataclass
class InvariantViolation:
    """A single invariant failure recorded at a specific simulation tick."""

    tick: int
    invariant: str  # "INV-6", "INV-7", etc.
    message: str


def check_inv6(state: SimState, cfg: SimConfig, tick: int) -> list[InvariantViolation]:
    """INV-6: count(T) ≤ cap(T, P) for every rarity tier.

    The spawner is designed never to create above cap; a violation here
    indicates an engine bug. Transient over-supply from depopulation (P
    shrinks while existing items persist) is expected and not flagged.
    """
    P = state.population
    violations: list[InvariantViolation] = []

    common_count = sum(1 for it in state.items.values() if it.rarity == Rarity.COMMON)
    rare_count = sum(1 for it in state.items.values() if it.rarity == Rarity.RARE)
    unique_count = sum(1 for it in state.items.values() if it.rarity == Rarity.UNIQUE)

    common_cap = int(cfg.k_c * P)
    rare_cap = int(cfg.k_r * P)
    unique_cap = cfg.unique_count

    if common_count > common_cap:
        violations.append(
            InvariantViolation(
                tick, "INV-6", f"common {common_count} > cap {common_cap} (P={P})"
            )
        )
    if rare_count > rare_cap:
        violations.append(
            InvariantViolation(
                tick, "INV-6", f"rare {rare_count} > cap {rare_cap} (P={P})"
            )
        )
    if unique_count > unique_cap:
        violations.append(
            InvariantViolation(
                tick, "INV-6", f"unique {unique_count} > cap {unique_cap}"
            )
        )

    return violations


def check_inv7(state: SimState, cfg: SimConfig, tick: int) -> list[InvariantViolation]:
    """INV-7: every gating type has at least one instance in existence.

    A gating type at zero means progression is impossible; this is the
    drought failure mode. See docs/design/08-invariants.md §2.
    """
    if state.population == 0:
        return []

    violations: list[InvariantViolation] = []
    gating = [t for t in state.item_types.values() if t.is_gating]

    for itype in gating:
        count = sum(1 for it in state.items.values() if it.type_id == itype.type_id)
        if count < 1:
            violations.append(
                InvariantViolation(
                    tick, "INV-7", f"gating type {itype.type_id} extinct (count=0)"
                )
            )

    return violations


def check_inv8(state: SimState, cfg: SimConfig, tick: int) -> list[InvariantViolation]:
    """INV-8: expected time-to-delivery(T) < remaining collapse time for all active players.

    Estimates expected delivery ticks as the minimum of two paths:
      - World path: 1 / (world_count * encounter_rate_per_world_item)
      - Held path: max(0, bleed_at - tick) + 1 / encounter_rate_per_world_item
        for the soonest-returning held instance of this type

    Held-but-circulating items are not counted as unreachable; they contribute
    a delivery estimate via their bleed timer instead.
    """
    active = [a for a in state.agents.values() if a.state != AgentState.QUIT]
    if not active:
        return []

    gating = [t for t in state.item_types.values() if t.is_gating]
    violations: list[InvariantViolation] = []
    rate = cfg.encounter_rate_per_world_item

    for itype in gating:
        world_count = sum(
            1
            for it in state.items.values()
            if it.type_id == itype.type_id and it.anchor is not None
        )
        world_expected = (1.0 / (world_count * rate)) if world_count > 0 else float("inf")

        held_instances = [
            it
            for it in state.items.values()
            if it.type_id == itype.type_id and it.holder is not None
        ]
        if held_instances:
            soonest_return = min(max(0, it.bleed_at - tick) for it in held_instances)
            held_expected = soonest_return + (1.0 / rate)
        else:
            held_expected = float("inf")

        effective_expected = min(world_expected, held_expected)

        for agent in active:
            remaining = agent.collapse_at - tick
            if remaining <= 0:
                continue
            if effective_expected >= remaining:
                violations.append(
                    InvariantViolation(
                        tick,
                        "INV-8",
                        f"agent {agent.agent_id}: expected delivery "
                        f"{effective_expected:.0f} >= remaining collapse {remaining} "
                        f"for type {itype.type_id}",
                    )
                )

    return violations


def check_inv9(state: SimState, cfg: SimConfig, tick: int) -> list[InvariantViolation]:
    """INV-9: per-player items/hour stays within [min_items_per_hour, max_items_per_hour].

    Only checked for agents active ≥ 60 ticks to allow a warm-up window.
    """
    violations: list[InvariantViolation] = []
    candidates = [
        a for a in state.agents.values()
        if a.state != AgentState.QUIT and a.ticks_active >= 60
    ]

    for agent in candidates:
        hours = agent.ticks_active / 60.0
        rate = agent.items_received / hours

        if rate < cfg.min_items_per_hour:
            violations.append(
                InvariantViolation(
                    tick,
                    "INV-9",
                    f"agent {agent.agent_id}: {rate:.3f} items/hr "
                    f"< floor {cfg.min_items_per_hour}",
                )
            )
        elif rate > cfg.max_items_per_hour:
            violations.append(
                InvariantViolation(
                    tick,
                    "INV-9",
                    f"agent {agent.agent_id}: {rate:.3f} items/hr "
                    f"> ceiling {cfg.max_items_per_hour}",
                )
            )

    return violations


def check_inv14(
    pop_throughput_history: list[tuple[int, int, float]],
    tick: int,
) -> list[InvariantViolation]:
    """INV-14: increasing P must not slow a player's progress.

    Checked continuously via pop_throughput_history: each entry is
    (tick, population, per_player_items_per_hour). If population grows
    between two consecutive observations but throughput drops by > 20%,
    that is a candidate violation.

    20% tolerance absorbs statistical noise in short windows.
    """
    if len(pop_throughput_history) < 2:
        return []

    violations: list[InvariantViolation] = []
    _tick_prev, pop_prev, tput_prev = pop_throughput_history[-2]
    _tick_curr, pop_curr, tput_curr = pop_throughput_history[-1]

    if pop_curr > pop_prev and tput_prev > 0 and tput_curr < tput_prev * 0.8:
        violations.append(
            InvariantViolation(
                tick,
                "INV-14",
                f"population {pop_prev}→{pop_curr} but throughput "
                f"{tput_prev:.3f}→{tput_curr:.3f} items/hr (>20% drop)",
            )
        )

    return violations


def check_all(
    state: SimState,
    cfg: SimConfig,
    tick: int,
    pop_throughput_history: list[tuple[int, int, float]] | None = None,
) -> list[InvariantViolation]:
    """Run all invariant checks and return every violation found."""
    violations: list[InvariantViolation] = []
    violations.extend(check_inv6(state, cfg, tick))
    violations.extend(check_inv7(state, cfg, tick))
    violations.extend(check_inv8(state, cfg, tick))
    violations.extend(check_inv9(state, cfg, tick))
    if pop_throughput_history is not None:
        violations.extend(check_inv14(pop_throughput_history, tick))
    return violations
