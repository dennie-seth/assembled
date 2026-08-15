"""SimEngine — discrete-time economy simulation driver.

Advances the world one tick (= 1 minute) at a time. Each tick:
  1. Agent lifecycle (joins, transitions, quits, collapses)
  2. Bleed timers (held and world/escrow)
  3. Unlock decay (tiered: tactical / session / unique-keyed)
  4. Rarity-cap enforcement (excess supply forced below cap on depopulation)
  5. Poisson item spawning (respecting rarity caps)
  6. Agent actions (pickup, transfer)
  7. Throughput tracking for INV-9 / INV-14
  8. Invariant checks — violations collected but never raised

Four wall-clocks are modelled together (docs/design/10-time-and-progression.md §2):
  held bleed · world/escrow bleed · unlock decay (tiered, §3) · collapse

See docs/design/08-invariants.md §4.
"""

from __future__ import annotations

import random

from .config import SimConfig
from .invariants import InvariantViolation, check_all
from .types import (
    Agent,
    AgentState,
    ItemInstance,
    ItemType,
    Rarity,
    SimResult,
    SimState,
    Unlock,
)


class SimEngine:
    """Discrete-time economy simulation.

    @param cfg  Tuning parameters for this run.
    @param seed Seed for the internal PRNG; same seed → deterministic replay.
    """

    def __init__(self, cfg: SimConfig, seed: int = 42) -> None:
        self.cfg = cfg
        self._rng = random.Random(seed)
        self._next_agent_id = 0
        self._next_instance_id = 0
        self._next_unlock_id = 0
        # Rolling history for INV-14: (tick, population, per_player_items/hr)
        self._pop_throughput_history: list[tuple[int, int, float]] = []

        # Build item-type catalogue
        item_types: dict[int, ItemType] = {}
        for i in range(cfg.num_item_types_common):
            item_types[i] = ItemType(type_id=i, rarity=Rarity.COMMON)
        for i in range(cfg.num_item_types_rare):
            tid = cfg.num_item_types_common + i
            item_types[tid] = ItemType(
                type_id=tid,
                rarity=Rarity.RARE,
                is_gating=(i < cfg.num_gating_types),
            )
        for i in range(cfg.unique_count):
            tid = cfg.num_item_types_common + cfg.num_item_types_rare + i
            item_types[tid] = ItemType(type_id=tid, rarity=Rarity.UNIQUE, is_gating=True)

        self._state = SimState(
            tick=0,
            agents={},
            items={},
            item_types=item_types,
            population=0,
            unlocks={},
        )

        # Seed initial population
        for _ in range(cfg.initial_population):
            self._spawn_agent()

        # Seed unique items at random anchors (seeded once at launch — never respawned)
        unique_types = [t for t in item_types.values() if t.rarity == Rarity.UNIQUE]
        for utype in unique_types:
            self._place_item_at_anchor(utype.type_id, Rarity.UNIQUE)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    @property
    def state(self) -> SimState:
        """Read-only view of the current world state."""
        return self._state

    def tick(self) -> list[InvariantViolation]:
        """Advance simulation by one minute. Returns any invariant violations."""
        self._state.tick += 1
        tick = self._state.tick

        self._process_agent_lifecycle()
        self._process_bleeds()
        self._process_unlock_decay()
        self._enforce_rarity_cap()
        self._spawn_items()
        self._process_agent_actions()
        self._update_throughput()

        return check_all(self._state, self.cfg, tick, self._pop_throughput_history)

    def run(self, num_ticks: int) -> SimResult:
        """Run for num_ticks ticks, collecting all invariant violations.

        @param num_ticks  Duration of the run in simulated minutes.
        @return           SimResult with all violations and summary metrics.
        """
        all_violations: list[InvariantViolation] = []
        for _ in range(num_ticks):
            all_violations.extend(self.tick())

        return SimResult(
            violations=all_violations,
            ticks_run=num_ticks,
            final_population=self._state.population,
            final_item_count=len(self._state.items),
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _spawn_agent(self) -> Agent:
        aid = self._next_agent_id
        self._next_agent_id += 1
        # Newly-joined agents start in their first universe — apply the grace multiplier.
        collapse_duration = int(self.cfg.collapse_duration * self.cfg.first_universe_multiplier)
        agent = Agent(
            agent_id=aid,
            state=AgentState.PLAYING,
            collapse_at=self._state.tick + collapse_duration,
            universe_count=0,
            is_hoarder=(self._rng.random() < self.cfg.hoarder_fraction),
        )
        self._state.agents[aid] = agent
        self._state.population += 1
        return agent

    def _place_item_at_anchor(self, type_id: int, rarity: Rarity) -> ItemInstance:
        anchor = self._rng.randrange(self.cfg.num_anchors)
        bleed_dur = self._rng.randint(self.cfg.world_bleed_min, self.cfg.world_bleed_max)
        iid = self._next_instance_id
        self._next_instance_id += 1
        item = ItemInstance(
            instance_id=iid,
            type_id=type_id,
            rarity=rarity,
            holder=None,
            anchor=anchor,
            bleed_at=self._state.tick + bleed_dur,
        )
        self._state.items[iid] = item
        return item

    def _landing_probability(self, rarity: Rarity) -> float:
        """Compute p(land) for a bleeding item (E-8 landing curve).

        Uniques always land. Common/rare use a linear curve that falls
        from 1.0 at count=cap to 0.0 at count=cap*(1+1/steepness).
        """
        if rarity == Rarity.UNIQUE:
            return 1.0

        P = self._state.population
        if P == 0:
            return 0.0

        if rarity == Rarity.COMMON:
            count = sum(1 for it in self._state.items.values() if it.rarity == Rarity.COMMON)
            cap = self.cfg.k_c * P
        else:
            count = sum(1 for it in self._state.items.values() if it.rarity == Rarity.RARE)
            cap = self.cfg.k_r * P

        if cap <= 0 or count <= cap:
            return 1.0

        ratio = (count - cap) / cap
        return max(0.0, 1.0 - ratio * self.cfg.landing_curve_steepness)

    def _grant_unlock(self, agent_id: int, tag: int, rarity: Rarity) -> None:
        """Record a tiered unlock when an agent picks up an item (10 §2/§3).

        Tier follows the granting item's rarity: common -> tactical
        (minutes), rare -> session (hours-days), unique -> unique-keyed
        (~1 week — the only tier that accumulates into progression).
        """
        cfg = self.cfg
        if rarity == Rarity.COMMON:
            tier, duration = "tactical", cfg.unlock_decay_tactical
        elif rarity == Rarity.RARE:
            tier, duration = "session", cfg.unlock_decay_session
        else:
            tier, duration = "unique_keyed", cfg.unlock_decay_unique_keyed

        uid = self._next_unlock_id
        self._next_unlock_id += 1
        self._state.unlocks[uid] = Unlock(
            unlock_id=uid,
            agent_id=agent_id,
            tag=tag,
            tier=tier,
            expires_at=self._state.tick + duration,
        )

    def _process_unlock_decay(self) -> None:
        """Expire unlocks whose tiered wall-clock has elapsed (10 §2/§3)."""
        tick = self._state.tick
        expired = [uid for uid, u in self._state.unlocks.items() if u.expires_at <= tick]
        for uid in expired:
            del self._state.unlocks[uid]

    def _enforce_rarity_cap(self) -> None:
        """Force world-anchored excess above the hard rarity cap to bleed away now.

        INV-6 is a hard instance-count ceiling (07-items-economy.md §2), not
        a soft target — when population shrinkage drops the cap below
        existing supply, the excess cannot simply wait out its natural
        bleed timer while the invariant is checked every tick. Held items
        are never touched (07 §4: "not by a reaper confiscating items from
        players' hands"); only world-anchored instances are forced to fail
        landing, same as an ordinary over-supply bleed.
        """
        cfg = self.cfg
        P = self._state.population
        caps = {
            Rarity.COMMON: int(cfg.k_c * P),
            Rarity.RARE: int(cfg.k_r * P),
        }
        for rarity, cap in caps.items():
            all_items = [it for it in self._state.items.values() if it.rarity == rarity]
            excess = len(all_items) - cap
            if excess <= 0:
                continue
            world_items = [it for it in all_items if it.anchor is not None]
            self._rng.shuffle(world_items)
            for item in world_items[:excess]:
                del self._state.items[item.instance_id]

    def _bleed_item(self, item: ItemInstance) -> None:
        """Execute a bleed event: item re-anchors or fails to land (is removed)."""
        p_land = self._landing_probability(item.rarity)

        if self._rng.random() < p_land:
            # Item lands at a new world anchor
            anchor = self._rng.randrange(self.cfg.num_anchors)
            bleed_dur = self._rng.randint(self.cfg.world_bleed_min, self.cfg.world_bleed_max)
            item.holder = None
            item.anchor = anchor
            item.bleed_at = self._state.tick + bleed_dur
            item.custody_depth += 1
        else:
            # Fails to land — supply shrinks (the collapse ate it)
            del self._state.items[item.instance_id]

    def _scatter_agent_items(self, agent: Agent) -> None:
        """Scatter all held items on quit/collapse (D-8: quit == death for items)."""
        held = [it for it in list(self._state.items.values()) if it.holder == agent.agent_id]
        for item in held:
            self._bleed_item(item)

    def _start_new_universe(self, agent: Agent) -> None:
        """Collapse the current universe and start the next one for this identity.

        The identity survives — it is NOT set to QUIT. Run-scoped state resets
        (items_received, ticks_active); identity-scoped state persists (vocabulary,
        unique_keyed unlocks). Tactical and session unlocks are cleared when
        unlock_scope is "per_run"; they survive until natural expiry when "per_week".

        @param agent  The agent whose universe is collapsing.
        """
        tick = self._state.tick
        cfg = self.cfg

        # Scatter held items (identity does not carry items across the boundary)
        self._scatter_agent_items(agent)

        # Advance universe counter; reset run-scoped stats
        agent.universe_count += 1
        agent.items_received = 0
        agent.ticks_active = 0

        # Schedule next collapse using the base duration (no multiplier after first universe)
        agent.collapse_at = tick + cfg.collapse_duration

        # Clear per-run unlock tiers if configured; unique_keyed always survives
        if cfg.unlock_scope == "per_run":
            to_remove = [
                uid for uid, u in self._state.unlocks.items()
                if u.agent_id == agent.agent_id and u.tier in ("tactical", "session")
            ]
            for uid in to_remove:
                del self._state.unlocks[uid]

    def _process_agent_lifecycle(self) -> None:
        cfg = self.cfg
        tick = self._state.tick

        # New agent joins (Poisson arrivals)
        if self._rng.random() < cfg.join_rate:
            self._spawn_agent()

        for agent in list(self._state.agents.values()):
            if agent.state == AgentState.QUIT:
                continue

            agent.ticks_active += 1

            # Collapse check (wall-clock — the identity survives into a new universe)
            if tick >= agent.collapse_at:
                self._start_new_universe(agent)
                continue

            # Random voluntary quit
            if self._rng.random() < cfg.quit_rate:
                self._scatter_agent_items(agent)
                agent.state = AgentState.QUIT
                self._state.population -= 1
                continue

            # Idle / play transitions
            if agent.state == AgentState.IDLE:
                if self._rng.random() < 0.1:
                    agent.state = AgentState.PLAYING
            else:
                if self._rng.random() < cfg.idle_probability * 0.01:
                    agent.state = AgentState.IDLE

    def _process_bleeds(self) -> None:
        tick = self._state.tick
        to_bleed = [
            it for it in list(self._state.items.values()) if it.bleed_at <= tick
        ]
        for item in to_bleed:
            if item.instance_id in self._state.items:
                self._bleed_item(item)

    def _spawn_items(self) -> None:
        """Poisson spawn for common and rare tiers; never spawns above cap."""
        cfg = self.cfg
        P = self._state.population
        if P == 0:
            return

        common_cap = int(cfg.k_c * P)
        rare_cap = int(cfg.k_r * P)

        common_count = sum(1 for it in self._state.items.values() if it.rarity == Rarity.COMMON)
        rare_count = sum(1 for it in self._state.items.values() if it.rarity == Rarity.RARE)

        # Common spawn pass
        for anchor in range(cfg.num_anchors):
            if common_count >= common_cap:
                break
            if self._rng.random() < cfg.spawn_rate_common:
                type_id = self._rng.randrange(cfg.num_item_types_common)
                self._place_item_at_anchor(type_id, Rarity.COMMON)
                common_count += 1

        # Rare spawn pass
        for anchor in range(cfg.num_anchors):
            if rare_count >= rare_cap:
                break
            if self._rng.random() < cfg.spawn_rate_rare:
                offset = self._rng.randrange(cfg.num_item_types_rare)
                type_id = cfg.num_item_types_common + offset
                self._place_item_at_anchor(type_id, Rarity.RARE)
                rare_count += 1

    def _ordered_playing_agents(self) -> list[Agent]:
        """Order PLAYING agents for this tick's pickup attempts (DM-5).

        When several agents roll a successful pickup in the same tick and
        compete for the same scarce world_items pool, this order decides
        who wins — see config.py's recipient_policy docstring.
        """
        playing = [a for a in self._state.agents.values() if a.state == AgentState.PLAYING]
        policy = self.cfg.recipient_policy
        if policy == "random":
            self._rng.shuffle(playing)
        elif policy == "need_weighted":
            playing.sort(key=lambda a: a.items_received)
        elif policy != "fifo":
            raise ValueError(f"unknown recipient_policy {policy!r}")
        return playing

    def _process_agent_actions(self) -> None:
        """Playing agents pick up from and deposit items into the world."""
        cfg = self.cfg
        playing = self._ordered_playing_agents()
        world_items = [it for it in self._state.items.values() if it.anchor is not None]

        for agent in playing:
            held = [it for it in self._state.items.values() if it.holder == agent.agent_id]

            # Non-hoarders may deposit held items
            if not agent.is_hoarder and held and self._rng.random() < cfg.transfer_probability:
                item = self._rng.choice(held)
                anchor = self._rng.randrange(cfg.num_anchors)
                bleed_dur = self._rng.randint(cfg.world_bleed_min, cfg.world_bleed_max)
                item.holder = None
                item.anchor = anchor
                item.bleed_at = self._state.tick + bleed_dur
                item.custody_depth += 1
                world_items.append(item)

            # Pick up a world item
            if world_items and self._rng.random() < cfg.pickup_probability:
                item = self._rng.choice(world_items)
                world_items.remove(item)
                item.anchor = None
                item.holder = agent.agent_id
                agent.items_received += 1
                agent.vocabulary.add(item.type_id)
                self._grant_unlock(agent.agent_id, item.type_id, item.rarity)

                if (
                    cfg.chain_key_enabled
                    and item.rarity == Rarity.UNIQUE
                    and agent.chain_progress < cfg.chain_key_crossings_required
                ):
                    self._consume_chain_key(agent, item, world_items)
                else:
                    bleed_dur = self._rng.randint(cfg.held_bleed_min, cfg.held_bleed_max)
                    if item.rarity == Rarity.UNIQUE:
                        bleed_dur = int(bleed_dur * cfg.unique_held_bleed_multiplier)
                    item.bleed_at = self._state.tick + bleed_dur

                # Exit condition: mark complete if now holding N_exit distinct
                # unique type_ids simultaneously (01-vision.md §5, T-0130).
                if not agent.is_complete and cfg.n_exit > 0:
                    held_unique_types = {
                        it.type_id
                        for it in self._state.items.values()
                        if it.holder == agent.agent_id and it.rarity == Rarity.UNIQUE
                    }
                    if len(held_unique_types) >= cfg.n_exit:
                        agent.is_complete = True
                        agent.completed_at = self._state.tick

    def _consume_chain_key(
        self, agent: Agent, item: ItemInstance, world_items: list[ItemInstance]
    ) -> None:
        """Spend a held unique to cross a chain tear (12 §3a, 07 §2 — Q4).

        "destroy": the instance is permanently removed — literally the
        "pool that never respawns." "transfer": it is sent onward
        immediately, same as the door-key semantics in 12 §3a — it stays
        in circulation rather than being destroyed.
        """
        cfg = self.cfg
        agent.chain_progress += 1
        if cfg.chain_key_mode == "destroy":
            del self._state.items[item.instance_id]
        elif cfg.chain_key_mode == "transfer":
            anchor = self._rng.randrange(cfg.num_anchors)
            bleed_dur = self._rng.randint(cfg.world_bleed_min, cfg.world_bleed_max)
            item.holder = None
            item.anchor = anchor
            item.bleed_at = self._state.tick + bleed_dur
            item.custody_depth += 1
            world_items.append(item)
        else:
            raise ValueError(f"unknown chain_key_mode {cfg.chain_key_mode!r}")

    def _update_throughput(self) -> None:
        """Record per-player throughput snapshot for INV-9/INV-14 tracking."""
        active = [
            a for a in self._state.agents.values()
            if a.state != AgentState.QUIT and a.ticks_active > 0
        ]
        if not active:
            return

        total_received = sum(a.items_received for a in active)
        total_hours = sum(a.ticks_active / 60.0 for a in active)
        rate = (total_received / total_hours) if total_hours > 0 else 0.0

        entry = (self._state.tick, self._state.population, rate)
        self._pop_throughput_history.append(entry)
        # Keep only the last 200 observations to bound memory
        if len(self._pop_throughput_history) > 200:
            self._pop_throughput_history = self._pop_throughput_history[-200:]
