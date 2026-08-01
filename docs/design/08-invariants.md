# 08 — Game Invariants

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v2, locked
> Related: `07-items-economy.md`, `09-identity.md`, `01-vision.md`
> **Purpose:** properties that must hold at *every* population size. Stated without reference to `P`; only their parameters depend on it.

---

## 0. Why This Document

The design is a distributed economy with genuinely-gated completion. That combination has a specific failure mode: **it can break silently and permanently.** No crash, no error — just a population that can no longer finish, discovered months after launch when items are already in players' hands.

The defense is to state correctness as predicates, then check them three ways:

| Consumer | Which invariants | When |
|---|---|---|
| Unit / integration tests | INV-1…5, INV-10…12 | CI, every push |
| Economy simulation | INV-6…9 | balance gate, offline |
| Production monitoring | INV-6, INV-7 | continuous |

**One definition, three consumers.** The simulation is not a separate exercise — it is these predicates run against a synthetic population.

---

## 1. Structural Invariants

Deterministic. Hold at every instant. Unit-testable at P=2.

| # | Invariant | Statement |
|---|---|---|
| **INV-1** | Single custody | Every instance is in exactly one of `{holder, world_anchor, escrow}`. Never zero, never two. |
| **INV-2** | No duplication | Instance UUID appears exactly once across all custody tables. Every transfer is a compare-and-swap on `version`; the loser of a race fails, never merges. |
| **INV-3** | Conservation | `Δ total = spawns − unlanded_bleeds`. Leave / use / death / **quit** / bleed / transfer are moves and change nothing. |
| **INV-4** | Escrow atomicity | Payment and release are one transaction. No observable state where both parties hold, or neither. |
| **INV-5** | Custody monotonic | `custody_depth` strictly increases on transfer. Never decreases, never resets. |
| **INV-10** | Bleed termination | No instance is held longer than `T_max` without transfer. There is no permanent resting state. |
| **INV-11** | Session uniqueness | At most one live session per identity. Enforced server-side by lease, not by client honesty. |
| **INV-12** | Tag completeness | Every variant implements every anchor tag its archetype declares. **Build-time check** — a missing tag fails the build, never ships. |

**INV-1, INV-2 and INV-11 together are the anti-dupe law.** INV-11 stops the same identity acting from two clients; INV-2 stops the residual race within one. Both are cheap; neither is retrofittable once items are live.

**Two-player test for INV-1/2/3:** A leaves item X → B takes X → assert A lacks X, assert exactly one holder, assert no third party can take it, assert total count unchanged. This is the smallest meaningful test of the whole economy and it should exist before any item code does.

---

## 2. Scaling Invariants

Statistical. Cannot be unit-tested — require simulation.

| # | Invariant | Statement |
|---|---|---|
| **INV-6** | Rarity cap | `∀T: count(T) ≤ cap(T, P)`. The spawner never violates this. |
| **INV-7** | Density floor | `∀T ∈ gating_set: count(T) ≥ floor(T, P) > 0`. Supply never drains a progression-critical type to extinction. |
| **INV-8** | Reachability | `∀` active player, `∀T ∈ gating_set`: expected time-to-encounter(T) is bounded **below remaining collapse time**. A universe must not expire while the network was still going to deliver. |
| **INV-9** | Scale invariance | Per-player experience metrics — items encountered/hr, notes seen/tag, rooms per run — stay within a target band for `P ∈ [2, 10⁵]`. **Veteran and new-player run length stay in band**, despite unlocks shortening runs and decay + variant growth lengthening them. |
| **INV-13** | Exit non-persistence | Exit progress is never stored. The condition is evaluated only at the instant of simultaneous possession. No partial credit, no accumulation, no cache. **Pillar-level** (`01-vision.md` §5). |
| **INV-14** | Population monotonicity | Increasing `P` must not slow a given player's progress. Item flow and unsolved-lock surface both grow with `P`; the design claims flow wins. **This is a claim, not a fact — the sim must confirm it.** |

**INV-9 is the scaling law.** The *law* is population-independent; only its parameters are tuned. Concretely: a run is ~15 rooms at P=2 and ~15 rooms at P=10⁵; what grows is which variants can appear. If the two-player experience and the ten-thousand-player experience differ in kind rather than degree, INV-9 has been violated and the design has a scaling bug regardless of what the code does.

**INV-8 now has an enforcement mechanism**, not just a hope: the broadcast petition (`02-notes-system.md` §6), answered by seeded ghosts when live population cannot. A stuck player has an affordance to reach for.

**INV-7 under the quitter rule.** Since a departing player's items scatter rather than vanish, the drought scenario is largely defused — but INV-7 still needs monitoring, because *gating-set composition* can drift even when total supply is healthy. Over-supply after depopulation is now the likelier failure, and it degrades feel rather than completability.

---

## 3. Resolved

| # | Question | Resolution |
|---|---|---|
| **O-1** | Unique items vs. gated completion | **Unique = one instance at any moment.** Uniques circulate permanently, are exempt from supply scaling, always re-anchor on bleed, and pass to a new holder on completion. Scarcity preserved, lockout impossible. |
| **O-2** | What "more rooms" means | **Variety scales, size does not.** Fixed ~15 rooms per run; population unlocks more *variants* per archetype. Preserves authored pacing and satisfies INV-9. |
| **O-3** | Universe petition semantics | **Broadcast to network.** Surfaces in many worlds at once; ghosts answer when population is thin. Preserves the "cannot finish alone" pillar and enforces INV-8. |

---

## 4. Simulation Scope

Blocked on **E-7** (spawn model). Deliberately small — a few hundred lines, no engine, no server.

**Model:** discrete-time. Agents join, play, idle, quit. Items spawn, bleed, transfer, scatter on quit or death, fail to land under over-supply.

**Four wall-clocks must be modelled together** (`10-time-and-progression.md` §2): held bleed, world/escrow, unlock decay, collapse. Tuning any one in isolation is how this breaks.

**Free parameters:** held and world bleed durations (E-1), unlock decay per tier (T-2, T-3), collapse duration (T-1), spawn rates per tier, `k_c` / `k_r`, absolute unique count, join/quit rates, note-rating bleed modifier, landing-probability curve (E-8).

**Assertions:** INV-6…9, INV-14, checked continuously.

**Sweeps that matter:**

| Scenario | Question |
|---|---|
| P = 2, sustained | Is the smallest viable game actually playable? |
| P: 2 → 10⁴ growth | Does the spawner keep up? Does variety unlock at a good rate? |
| P: 10⁴ → 200 collapse | **Most likely real-world failure.** Now an over-supply problem, not a drought. |
| Mass exodus | 80% quit in a week — does the scatter absorb it? |
| Hoarder cohort | 20% never transfer — does bleed reclaim enough? |
| Unique circulation | Do uniques keep moving, or park permanently with idle players? |
| **Veteran vs. new** | Run length in band for both? (INV-9) |
| **Does population help?** | Median time-to-completion must fall as `P` rises. (INV-14 — **the pitch depends on this**) |
| **Collapse race** | Fraction of universes expiring while a delivery was still in flight. (INV-8) |

**Output:** a viable region in `(T_bleed, spawn_rate, landing_curve)` space, or proof that none exists — a design finding worth having *now*.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial | Claude (Opus 5) |
| 2026-08-01 | v2: O-1/O-2/O-3 resolved; INV-11/12 added; INV-2 gains CAS; drought→over-supply reframing | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | v3: INV-8 bounded below collapse time; INV-9 veteran clause; INV-13 exit non-persistence; INV-14 population monotonicity; sim covers four clocks | Claude (Opus 5), rev. @DennieSeth |
