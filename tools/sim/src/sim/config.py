"""SimConfig — all tuning parameters for the economy simulation.

Free parameters are grouped by which open question blocks them:
  E-1: held/world bleed durations
  E-4: k_c, k_r, unique_count
  E-8: landing_curve_steepness
  T-1: collapse_duration
  T-2: unlock_decay_unique_keyed
  T-3: unlock_decay_tactical / session

See docs/design/08-invariants.md §4, docs/design/07-items-economy.md §4.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SimConfig:
    # ------------------------------------------------------------------
    # Population
    # ------------------------------------------------------------------
    initial_population: int

    # ------------------------------------------------------------------
    # Rarity caps (D-7, docs/design/07-items-economy.md §2)
    # ------------------------------------------------------------------
    k_c: float = 2.0          # common instances per active player
    k_r: float = 0.2          # rare instances per active player (k_r << k_c)
    unique_count: int = 5      # fixed absolute count, exempt from P scaling

    # ------------------------------------------------------------------
    # Item type counts
    # ------------------------------------------------------------------
    num_item_types_common: int = 6
    num_item_types_rare: int = 3
    num_gating_types: int = 2  # first N rare types are progression-gating (INV-7)

    # ------------------------------------------------------------------
    # World topology
    # ------------------------------------------------------------------
    num_anchors: int = 20

    # ------------------------------------------------------------------
    # Bleed durations in ticks (1 tick = 1 minute) — open param E-1
    # Held bleed: 60–90 min. World/escrow: 48–72 h.
    # ------------------------------------------------------------------
    held_bleed_min: int = 60         # 60 min
    held_bleed_max: int = 90         # 90 min
    world_bleed_min: int = 2880      # 48 h
    world_bleed_max: int = 4320      # 72 h
    unique_held_bleed_multiplier: float = 3.0  # uniques bleed slower (E-9 resolved)

    # ------------------------------------------------------------------
    # Unlock decay tiers (ticks) — open params T-2, T-3
    # ------------------------------------------------------------------
    unlock_decay_tactical: int = 30
    unlock_decay_session: int = 1440
    unlock_decay_unique_keyed: int = 10080  # ~1 week

    # ------------------------------------------------------------------
    # Collapse duration (ticks) — open param T-1
    # Nominal ~2–4 weeks; first universe gets ×multiplier.
    # ------------------------------------------------------------------
    collapse_duration: int = 20160       # 2 weeks
    first_universe_multiplier: float = 1.5

    # ------------------------------------------------------------------
    # Spawn process (Poisson λ per anchor per tick) — E-7 resolved
    # ------------------------------------------------------------------
    spawn_rate_common: float = 0.002
    spawn_rate_rare: float = 0.0002

    # ------------------------------------------------------------------
    # Landing probability under over-supply — open param E-8
    # p_land = max(0, 1 − (count − cap) / cap × steepness)
    # ------------------------------------------------------------------
    landing_curve_steepness: float = 1.0

    # ------------------------------------------------------------------
    # Agent behaviour
    # ------------------------------------------------------------------
    join_rate: float = 0.1         # Poisson λ new agents per tick
    quit_rate: float = 0.001       # probability each live agent quits per tick
    idle_probability: float = 0.2
    hoarder_fraction: float = 0.0  # fraction that never voluntarily transfers
    pickup_probability: float = 0.05
    transfer_probability: float = 0.1

    # ------------------------------------------------------------------
    # INV-9 band: per-player items/hour must stay in [min, max]
    # ------------------------------------------------------------------
    min_items_per_hour: float = 0.5
    max_items_per_hour: float = 50.0
    throughput_window_ticks: int = 60

    # ------------------------------------------------------------------
    # INV-8: encounter rate estimate
    # ------------------------------------------------------------------
    encounter_rate_per_world_item: float = 0.01
