# 08 — Game Invariants

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v3, locked
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

**INV-12 has an asset-side sibling.** `13-asset-pipeline.md` **P-4** requires uniform palette-index semantics across every shipped asset — index `N` means palette slot `N` everywhere. Both are build-time checks in the same CI stage, and both fail the build rather than surfacing at runtime. P-4 is not listed here because it constrains generated files, not game state, but it is enforced identically.

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
| **INV-9** | Scale invariance | The *distribution* of per-player experience metrics — items encountered/hr, notes seen/tag, rooms per run — is stable (stationary) across `P ∈ [2, 10⁵]`. Wide within-population variance is compatible with this invariant; only a shift of the distribution itself as `P` changes is a violation. **The distributions for veteran and new-player run length both stay in band**, despite unlocks shortening runs and decay + variant growth lengthening them. |
| **INV-13** | Exit non-persistence | Exit progress is never stored. The condition is evaluated only at the instant of simultaneous possession. No partial credit, no accumulation, no cache. **Pillar-level** (`01-vision.md` §5). |
| **INV-14** | Population monotonicity | Increasing `P` must not slow a given player's progress. Item flow and unsolved-lock surface both grow with `P`; the design claims flow wins. **This is a claim, not a fact — the sim must confirm it.** |

**INV-9 is the scaling law.** The *law* is population-independent; only its parameters are tuned. Concretely: the *distribution* of run lengths centres around up to 18 rooms at P=2 and at P=10⁵, assembled from **exactly 3 archetypes** of varying authored size (5–8 rooms each); what grows is which archetypes and variants are eligible to appear, not the room count. INV-9 does **not** require individual players to have similar experiences — the within-population spread may be wide. What it forbids is the distribution itself *shifting* with `P`: if the centre or shape of the metric distribution moves as population grows or shrinks, INV-9 has been violated and the design has a scaling bug regardless of what the code does.

**INV-8 now has an enforcement mechanism**, not just a hope: the broadcast petition (`02-notes-system.md` §6), answered by seeded ghosts when live population cannot. A stuck player has an affordance to reach for.

**INV-7 under the quitter rule.** Since a departing player's items scatter rather than vanish, the drought scenario is largely defused — but INV-7 still needs monitoring, because *gating-set composition* can drift even when total supply is healthy. Over-supply after depopulation is now the likelier failure, and it degrades feel rather than completability.

---

## 3. Resolved

| # | Question | Resolution |
|---|---|---|
| **O-1** | Unique items vs. gated completion | **Unique = one instance at any moment.** Uniques circulate permanently, are exempt from supply scaling, always re-anchor on bleed, and pass to a new holder on completion. Scarcity preserved, lockout impossible. |
| **O-2** | What "more rooms" means | **Variety scales, size does not.** Up to 18 rooms per run, assembled from exactly 3 archetypes; population unlocks more *variants* per archetype. Preserves authored pacing and satisfies INV-9. |
| **O-3** | Universe petition semantics | **Broadcast to network.** Surfaces in many worlds at once; ghosts answer when population is thin. Preserves the "cannot finish alone" pillar and enforces INV-8. |

---

## 4. Simulation Scope

Deliberately small — a few hundred lines, no engine, no server.

**Model:** discrete-time. Agents join, play, idle, quit. Items spawn, bleed, transfer, scatter on quit or death, fail to land under over-supply.

**Four wall-clocks must be modelled together** (`10-time-and-progression.md` §2): held bleed, world/escrow, unlock decay, collapse. Tuning any one in isolation is how this breaks.

**Free parameters:** held and world bleed durations (E-1), unlock decay per tier (T-2 — sweep within ~1 week, T-3), collapse duration (T-1 — sweep within ~2–4 weeks, ~1.5× for first universe), spawn rates per tier, `k_c` / `k_r`, absolute unique count, join/quit rates, note-rating bleed modifier, landing-probability curve (E-8).

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
| 2026-08-01 | E-7 resolved (`07-items-economy.md` §4) — simulation harness unblocked | Claude, rev. @DennieSeth |
| 2026-08-01 | T-1/T-2 order-of-magnitude sweep brackets set (§4) | Claude, rev. @DennieSeth |
| 2026-08-02 | v3: status line corrected; P-4 (asset index semantics) cross-referenced from INV-12 | Claude, rev. pending |
| 2026-08-02 | INV-9/O-2 updated for revised room budget — up to 18 rooms from 1–3 archetypes (was ~15 rooms from 5–7 archetypes) | Claude, rev. @DennieSeth |
| 2026-08-02 | INV-9/O-2 narrowed to **exactly 3 archetypes** per run (was 1–3), 5–8 rooms each | Claude, rev. @DennieSeth |
| 2026-08-08 | INV-9 wording clarified: invariant is distribution-stability across P, not per-player similarity; within-population variance explicitly acknowledged as compatible (T-0157) | Claude (Sonnet 4.6) |
