"""Shared fixtures and helpers for sim test suite."""

from __future__ import annotations

from sim.config import SimConfig
from sim.types import Agent, AgentState, ItemInstance, ItemType, Rarity, SimState

# ---------------------------------------------------------------------------
# Default config
# ---------------------------------------------------------------------------

COMMON_BASE = 0           # type IDs 0..NUM_COMMON-1
NUM_COMMON = 3
NUM_RARE = 2
NUM_GATING = 2            # first NUM_GATING rare types are gating
NUM_UNIQUE = 2
RARE_BASE = NUM_COMMON
UNIQUE_BASE = NUM_COMMON + NUM_RARE


def make_cfg(**kwargs: object) -> SimConfig:
    """Build a SimConfig with test-friendly compressed-time defaults."""
    defaults: dict[str, object] = dict(
        initial_population=10,
        k_c=2.0,
        k_r=0.2,
        unique_count=NUM_UNIQUE,
        num_item_types_common=NUM_COMMON,
        num_item_types_rare=NUM_RARE,
        num_gating_types=NUM_GATING,
        num_anchors=5,
        held_bleed_min=5,
        held_bleed_max=10,
        world_bleed_min=50,
        world_bleed_max=100,
        unique_held_bleed_multiplier=3.0,
        unlock_decay_tactical=10,
        unlock_decay_session=50,
        unlock_decay_unique_keyed=200,
        collapse_duration=500,
        first_universe_multiplier=1.5,
        spawn_rate_common=0.05,
        spawn_rate_rare=0.005,
        landing_curve_steepness=1.0,
        join_rate=0.0,
        quit_rate=0.0,
        idle_probability=0.1,
        hoarder_fraction=0.0,
        pickup_probability=0.1,
        transfer_probability=0.05,
        min_items_per_hour=0.1,
        max_items_per_hour=1000.0,
        throughput_window_ticks=60,
        encounter_rate_per_world_item=0.05,
        unlock_scope="per_run",
    )
    defaults.update(kwargs)
    return SimConfig(**defaults)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# State builders
# ---------------------------------------------------------------------------

FAR_FUTURE = 100_000  # bleed_at / collapse_at far in the future


def make_item_types(cfg: SimConfig) -> dict[int, ItemType]:
    types: dict[int, ItemType] = {}
    for i in range(cfg.num_item_types_common):
        types[i] = ItemType(type_id=i, rarity=Rarity.COMMON, is_gating=False)
    for i in range(cfg.num_item_types_rare):
        tid = cfg.num_item_types_common + i
        types[tid] = ItemType(
            type_id=tid,
            rarity=Rarity.RARE,
            is_gating=(i < cfg.num_gating_types),
        )
    for i in range(cfg.unique_count):
        tid = cfg.num_item_types_common + cfg.num_item_types_rare + i
        types[tid] = ItemType(type_id=tid, rarity=Rarity.UNIQUE, is_gating=True)
    return types


def make_state(
    cfg: SimConfig,
    agents: list[Agent],
    items: list[ItemInstance],
    tick: int = 0,
) -> SimState:
    item_types = make_item_types(cfg)
    population = sum(1 for a in agents if a.state != AgentState.QUIT)
    return SimState(
        tick=tick,
        agents={a.agent_id: a for a in agents},
        items={it.instance_id: it for it in items},
        item_types=item_types,
        population=population,
    )


def make_agent(
    agent_id: int,
    state: AgentState = AgentState.PLAYING,
    collapse_at: int = FAR_FUTURE,
    is_hoarder: bool = False,
    items_received: int = 0,
    ticks_active: int = 0,
    universe_count: int = 0,
) -> Agent:
    return Agent(
        agent_id=agent_id,
        state=state,
        collapse_at=collapse_at,
        is_hoarder=is_hoarder,
        items_received=items_received,
        ticks_active=ticks_active,
        universe_count=universe_count,
    )


def make_world_item(
    instance_id: int,
    type_id: int,
    rarity: Rarity,
    anchor: int = 0,
    bleed_at: int = FAR_FUTURE,
) -> ItemInstance:
    return ItemInstance(
        instance_id=instance_id,
        type_id=type_id,
        rarity=rarity,
        holder=None,
        anchor=anchor,
        bleed_at=bleed_at,
    )


def make_held_item(
    instance_id: int,
    type_id: int,
    rarity: Rarity,
    holder: int,
    bleed_at: int = FAR_FUTURE,
) -> ItemInstance:
    return ItemInstance(
        instance_id=instance_id,
        type_id=type_id,
        rarity=rarity,
        holder=holder,
        anchor=None,
        bleed_at=bleed_at,
    )
