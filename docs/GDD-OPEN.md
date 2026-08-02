# GDD — Open Questions

> **Project:** Assembled
> **Author:** Claude (Opus 5) · **For:** @DennieSeth · **Date:** 2026-08-01
> **Purpose:** complete inventory of what is still undecided. Agenda for the next GDD session.
> Supersedes `GDD-QUESTIONS.md`, which is closed for Tiers 1–3 and 6.

---

## 0. Read This First

The remaining questions are **not all the same kind**, and treating them alike wastes a session.

| Class | Count | How to resolve |
|---|---|---|
| **A — System-shaped holes** | 0 (was 3 — all closed, see §1) | Real design work. Sessions, not answers. |
| **B — Design decisions** | ~14 | Discussion. This is what a GDD session is for. |
| **C — Content budgets** | ~7 | Estimation once the first asset exists. |
| **D — Simulation-resolved** | ~8 | **Do not decide by hand.** The sim answers these. |

**Class D is the important observation.** Roughly a third of the numbered opens are tuning constants in a system with four interacting wall-clocks. Guessing at them in conversation produces numbers that feel authoritative and are wrong. They are listed in §4 so they can be *skipped* deliberately.

---

## 1. Class A — System-Shaped Holes

**These are the real gaps.** Each is a system the design refers to but has never specified. All three block Phase 8 (vertical slice), and two block Phase 5.

### A-I · Moment-to-moment play — **RESOLVED**, see `11-moment-to-moment.md`

**The single largest hole in the design.** The docs specify economy, identity, notes, time, and world structure in detail. They do not specify **what the player does with their hands.**

Known: side-on, no combat, avoidance and hiding, four animation states, ~15 rooms at 2–3 min each.

Unknown, and all of it blocks Phase 5 client work:
- What does hiding *do*? Line-of-sight break? A hiding-place object? A crouch state with a detection meter?
- How do foreign entities detect — sight cones, sound, proximity, patrol routes?
- What does "trapped or locked" mean as a verb the player performs?
- Is there resource pressure inside a run (light, noise, stamina), or is the only pressure the clock?
- What is a room's *interaction* vocabulary — doors, switches, climbables, hiding spots? This is the level-design kit and nothing exists without it.

> Recommendation: this deserves its own session before anything else. It is the layer everything else has been assuming.

### A-II · Tears — the core-loop verb — **RESOLVED**, see `12-tears.md`

`01` §3 makes crossing a tear the central action: *deliberate, costly, dangerous.* Nothing defines it.

- What is a tear, on screen? A fixed room feature, a spawned object, a scripted event?
- How does a player find one — search, note hint, always-present exit?
- What makes crossing **dangerous**? Its own hazard, or does it just deposit you somewhere hostile?
- What is the **cost**? The word "costly" appears in the pillar and is unbacked.
- Does crossing move you between rooms of one run, or is it how a run ends?
- Relationship to run structure: 15 rooms per run — how many tears is that?

> This is the loop's load-bearing verb and it is currently a noun in a diagram.

### A-III · Secret drops — **CUT**

`GDD-QUESTIONS.md` Tier 4 was never answered. Decided: the system is redundant with uniques, broadcast petitions, vocabulary tiers, and variant/puzzle unlocks, which already do the job Tier 4 was reaching for.

**Removed from `PLAN.md`:** `secret_drops`/`drop_grants` tables, `/v1/roll` endpoint, task T-0048. Phase 8's vertical-slice definition now names a tear + a puzzle reward instead of "one secret drop."

---

## 2. Class B — Design Decisions

Ordered by how much rests on them.

| # | Question | Notes |
|---|---|---|
| **T-4** | Is chroma alone enough warning as collapse nears? | Elegant, but a player may not read it. Needs a playtest, or a second cue. |
| **E-6** | Escrow behaviour if the demanded type goes extinct | Edge case, but it strands an item permanently if unhandled. |
| **N-4** | Do ghost notes rate? Can they be rated? | Ghosts answering petitions makes this load-bearing, not cosmetic. |
| **N-6** | Vocabulary unlock triggers — runs survived? archetypes seen? notes rated well? | The last is best: it makes the meta-progression social. |
| **S-3** | Phrase file format; clipboard export? | Small, but it is the first thing a new player touches. |
| **S-4** | Does the client keep a phrase after voluntary "new universe"? | — |
| **5.8** | UI language — diegetic/minimal or conventional? | Design leans hard diegetic (chroma is the clock, no numbers). Probably already answered by implication; worth stating. |

**Resolved — collapse cluster:** V-11 (`01-vision.md` §6, "The Ending"), T-6 (same section), S-6 (`09-identity.md` §3a), T-5 (`10-time-and-progression.md` §5).

**Resolved — mechanical edges:** NEW-1/NEW-2 (`01-vision.md` §6, "Ending a Run" — death/quit/unrecovered disconnect, reconnect-within-TTL grace), E-5 (`07-items-economy.md` §3 — no inventory cap), E-9 (`07-items-economy.md` §5 — uniques get a longer held timer), N-5 (`02-notes-system.md` §6 — petitions may name a gating item).

---

## 3. Class C — Content Budgets

Not decisions so much as estimates. Most need the first authored asset to exist before they can be answered honestly.

| # | Question | Unblocks |
|---|---|---|
| **V-5** | Home palette: colour count + hex values | **Phase 6 — last blocker for the art pipeline** |
| **A-2** | Asset inventory: tiles / props / characters / VFX / UI | Phase 6 scope |
| **A-3** | Variant authoring budget — hours for a second Hospital | V-9, and the whole variety model's affordability |
| **A-4** | Chroma-intensity shader ramp vs. collapse proximity | Phase 6 |
| **A-5** | Bleed-alpha ramp — item timer proximity (`07` §5) | Phase 6 |
| **N-3** | Final template + word list | needs the archetype set to exist |
| **V-6** | Localization set for v1 | vocabulary budget |
| **V-7** | Vertical slice definition | Phase 8 acceptance |
| **V-8** | Seeded-ghost corpus: size + authorship | launch, and `02` §11 |
| **V-9** | Variant release schedule — population thresholds | balance |
| **AU-1** | Per-run music density cap | assembler |
| **AU-3** | Does audio carry *puzzle* information, or only threat/state? | `11` §3 |
| **AU-5** | SFX inventory count | Phase 7 scope |

> **V-5 is the only one blocking active work.** The rest can wait for the first tileset.

**Resolved — A-1: tile size is 16px**, rooms authored on a 24×14 grid with an 8px non-gameplay band (`05-art-direction.md` §5, `13-asset-pipeline.md` §3.3).

**Resolved — the audio *pipeline*.** `13-asset-pipeline.md` §4 settles the layer stack (music cue / global collapse layer / archetype bed / SFX), placement via a `music_cue` anchor tag, generative textures plus deterministic synthesis for one-shots, the loop-fold chain, and the validation gate. Remaining audio questions are AU-1 through AU-5 in that document — content budgets, not structure. `06-audio.md` is now only needed for track/SFX *counts*, if at all.

---

## 4. Class D — Do Not Decide By Hand

These are outputs of `08-invariants.md` §4. Answering them in conversation produces plausible numbers that the four interacting clocks will falsify.

| # | Parameter |
|---|---|
| **E-1** | Exact held / world bleed durations within 60–90 min / 48–72 h |
| **E-4** | `k_c`, `k_r`, absolute unique count |
| **E-8** | Landing-probability curve vs. over-supply ratio |
| **T-1 / V-10** | Collapse duration |
| **T-2** | Unique-unlock decay duration |
| **T-3** | Tactical / session unlock tier durations |
| **N-1** | Rating → bleed-bonus curve |
| **N-2** | Note decay rate, `N` visible per tag |
| **E-3** | Does `custody_depth` accelerate bleed? |

**Resolved.** The sim is now fully unblocked, structurally and for starting bounds:

- **E-7 — spawn model.** Ambient Poisson per `(archetype_id, anchor_tag, tier)`; uniques seeded once at launch (`07-items-economy.md` §2, §4).
- **T-1 / T-2 order of magnitude.** Collapse ~2–4 weeks nominal (~1.5× first universe); unique-unlock decay ~1 week (`10-time-and-progression.md` §2, §3). Exact values remain sim-tuned within these brackets.

---

## 5. Class E — Risk Questions (GDD Tier 7)

Partly answered by design decisions since. Recorded for completeness.

| # | Question | Status |
|---|---|---|
| 7.1 | Cold start — seed with authored notes? | **Answered:** seeded ghosts (`02` §11). Size open (V-8). |
| 7.2 | Empty-server experience | **Answered:** runnable, not completable (`01` §5). |
| 7.3 | What breaks if it gets popular? | **Partly:** density is self-cleaning (`02` §8), supply scales with `P`. Open: does INV-14 actually hold? Sim confirms. |
| 7.4 | What breaks if nobody plays? | **Answered:** over-supply, not drought (`07` §4). Ghosts cover thin population. |
| 7.5 | Fork risk — open server, spoofable clients | **Open.** Previously dismissed, but items now have real scarcity and identity is a portable phrase. Worth a deliberate position. |

---

## 6. Suggested Session Order

1. ~~**A-I moment-to-moment play**~~ — done, `11-moment-to-moment.md`.
2. ~~**A-II tears**~~ — done, `12-tears.md`.
3. ~~**A-III secret drops**~~ — cut.
4. ~~**V-11, T-6, T-5, S-6** — the collapse cluster.~~ — done, see resolved note in §2.
5. ~~**NEW-1, NEW-2, E-5, E-9, N-5** — mechanical edges.~~ — done, see resolved note in §2.
6. **V-5** whenever the first tileset is being made. Not before.
7. ~~**E-7** before the sim's tuning sweep.~~ — done, see Class D §4.

**V-5 is now the only active blocker.** T-1/T-2 order of magnitude is set; the sim can run its tuning sweep whenever it's built. Everything else can wait for playtest data or the simulation.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial inventory, post-GDD-session-1 | Claude (Opus 5) |
| 2026-08-01 | A-I resolved (`11-moment-to-moment.md`), A-II resolved (`12-tears.md`), A-III cut (`PLAN.md` schema/task removed) | Claude, rev. @DennieSeth |
| 2026-08-01 | Collapse cluster resolved: V-11, T-6, S-6, T-5 | Claude, rev. @DennieSeth |
| 2026-08-01 | Mechanical edges resolved: NEW-1, NEW-2, E-5, E-9, N-5 | Claude, rev. @DennieSeth |
| 2026-08-01 | E-7 resolved — ambient Poisson spawn model, uniques seeded once. Sim harness fully unblocked structurally | Claude, rev. @DennieSeth |
| 2026-08-01 | T-1/T-2 order of magnitude set — sim now fully unblocked. V-5 is the only remaining active blocker | Claude, rev. @DennieSeth |
| 2026-08-02 | A-1 resolved; audio *pipeline* resolved via `13` §4 — remaining audio items are AU-1…AU-5 content budgets | Claude, rev. pending |
