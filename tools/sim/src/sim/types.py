"""Domain types for the economy simulation.

ItemInstance is the atom of the economy: a UUID-like tracked instance with
a custody chain and a bleed timer. Agent holds the identity-level state.
SimState is the world snapshot passed to invariant checkers.
SimResult is the output of a completed run.

See docs/design/07-items-economy.md §1, docs/design/08-invariants.md §4.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Rarity(Enum):
    COMMON = "common"
    RARE = "rare"
    UNIQUE = "unique"


class AgentState(Enum):
    PLAYING = "playing"
    IDLE = "idle"
    QUIT = "quit"  # terminal — items scattered, identity collapsed or departed


@dataclass
class ItemType:
    """Static descriptor for a category of item."""

    type_id: int
    rarity: Rarity
    is_gating: bool = False  # required for progression; checked by INV-7


@dataclass
class ItemInstance:
    """A single tracked item instance (never copied, only moved — INV-2).

    Exactly one of (holder, anchor) is non-None at any time (INV-1).
    bleed_at is a tick timestamp; the engine triggers the bleed event at that tick.
    """

    instance_id: int
    type_id: int
    rarity: Rarity
    holder: int | None  # agent_id; exclusive with anchor
    anchor: int | None  # anchor slot 0..N-1; exclusive with holder
    bleed_at: int       # tick at which this instance bleeds
    custody_depth: int = 0  # how many universes it has passed through (INV-5)


@dataclass
class Unlock:
    """A live `(agent_id, tag)` unlock — the third wall-clock (10 §2/§3).

    Tiered by what granted it: common pickups are tactical (minutes), rare
    are session (hours-days), unique are unique-keyed (~1 week — the only
    tier that accumulates into real progression).
    """

    unlock_id: int
    agent_id: int
    tag: int  # granting item's type_id — stands in for (variant_id, tag)
    tier: str  # "tactical" | "session" | "unique_keyed"
    expires_at: int


@dataclass
class Agent:
    """Live identity participating in the simulation."""

    agent_id: int
    state: AgentState
    collapse_at: int          # tick at which the universe collapses
    is_first_universe: bool = True
    is_hoarder: bool = False  # never voluntarily transfers (hoarder cohort sweep)
    items_received: int = 0   # cumulative pickups; used by INV-9
    ticks_active: int = 0     # ticks in PLAYING or IDLE; denominator for INV-9


@dataclass
class SimState:
    """Snapshot of the world at the current tick.

    Passed read-only to all invariant checker functions. The engine owns
    mutation; invariant checkers must not modify state.
    """

    tick: int
    agents: dict[int, Agent]
    items: dict[int, ItemInstance]
    item_types: dict[int, ItemType]
    population: int  # count of non-QUIT agents; maintained by engine
    unlocks: dict[int, Unlock] = field(default_factory=dict)


@dataclass
class SimResult:
    """Aggregated output from a completed simulation run."""

    violations: list  # list[InvariantViolation] — avoid circular import
    ticks_run: int
    final_population: int
    final_item_count: int

    def ok(self) -> bool:
        """True iff no invariant violations were recorded."""
        return len(self.violations) == 0

    def violation_summary(self) -> dict[str, int]:
        """Count violations by invariant name."""
        counts: dict[str, int] = {}
        for v in self.violations:
            counts[v.invariant] = counts.get(v.invariant, 0) + 1
        return counts
