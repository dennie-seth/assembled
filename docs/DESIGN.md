# Design docs index

> **Project:** Assembled — a session-based survival/exploration game. One collapsing universe per identity; asynchronous multiplayer *is* the fiction.
> **Revised:** 2026-08-02 (rev 2)

## What this is

The canonical design documentation. Each child page is one document, mirroring `docs/` and `docs/design/` in the repo at `github.com/dennie-seth/assembled`.

## Conventions

- **One doc, one owning chat.** Cross-edits are requested, not made.
- **Every doc keeps a changelog table at the bottom.** A doc whose newest row isn't reflected in git failed to land.
- **Git stays canonical for code.** These pages are where design gets written and revised; a periodic export commits them into `docs/design/` so the public repo carries the GDD too.

## Read order for a new agent

1. **INDEX** — reconciliation state, and which repo docs are actively wrong
2. **HANDOFF** — the delta between the plan and the design decisions
3. **01 Vision** — premise, pillars, loop, completion, collapse
4. **08 Invariants** — the correctness predicates the economy must satisfy

## Current blockers

| # | Question | Blocks |
|---|---|---|
| **~~V-5~~** | Home palette — **resolved.** Extracted from an approved concept sheet by T-0105 (`13` §6.6) | — |
| T-1 / T-2 / E-1 | Exact clock durations within their brackets | the sim's *tuning sweep*, not the harness |

**Nothing is blocked on a human decision.** Phase 6 opens at **T-0104** (concept sheet) — no LoRA, no palette, no prior calls. Phase 4 has a complete schema (`04`) and wire contract (`03`) to build against.

**Uncovered topics:** level design / variant authoring rules · first-run experience · localization mechanism. Telemetry is tracked as OPS-6 in `15`.

- [INDEX.md](design/INDEX.md)
- [HANDOFF.md](HANDOFF.md)
- [01-vision.md](design/01-vision.md)
- [08-invariants.md](design/08-invariants.md)
- [13-asset-pipeline.md](design/13-asset-pipeline.md)
- [07-items-economy.md](design/07-items-economy.md)
- [02-notes-system.md](design/02-notes-system.md)
- [09-identity.md](design/09-identity.md)
- [10-time-and-progression.md](design/10-time-and-progression.md)
- [12-tears.md](design/12-tears.md)
- [05-art-direction.md](design/05-art-direction.md)
- [11-moment-to-moment.md](design/11-moment-to-moment.md)
- [GDD-OPEN.md](GDD-OPEN.md)
- [GDD-QUESTIONS.md](archive/GDD-QUESTIONS.md)
- [14-vertical-slice.md](design/14-vertical-slice.md)
- [03-net-protocol.md](design/03-net-protocol.md)
- [04-data-model.md](design/04-data-model.md)
- [15-server-ops.md](design/15-server-ops.md)

## Ownership

**One doc, one owning chat. Cross-edits are requested via a comment, not made.** Check this table before editing anything.

| Owner | Docs |
|---|---|
| **Design chat** | `01 Vision` · `02 Notes` · `07 Items & Economy` · `08 Invariants` · `09 Identity` · `10 Time & Progression` · `11 Moment-to-Moment` · `12 Tears` · `14 Vertical Slice` · `16 Level Design` · `18 First-Run Experience` · `19 Vertical Slice: Hospital` · `20 Vertical Slice: Long Descent` · `GDD-OPEN` · `GDD-QUESTIONS` |
| **Pipeline chat** | `03 Net Protocol` · `04 Data Model` · `05 Art Direction` · `13 Asset Pipeline` · `15 Server Ops` · `17 Localization` · `HANDOFF` · `INDEX` |
| **Neither — git only** | `PLAN.md`. Dispatch reads and amends it in the repo; a Notion copy would drift the moment task cards move |

**New docs take the next free number — check this page first.** Two documents both landed as "14" on 2026-08-02 because the number was picked from memory rather than looked up.

## Decision Log

**Cross-document decisions only.** Per-doc changelogs remain the record of what changed *in that doc*; this is the record of what got *decided*, so a chat can catch up without opening seventeen pages. If a change touched one document, it does not belong here.

| Date | Decision | Touched |
|---|---|---|
| 2026-08-02 | **Localization mechanism** (`17`). `FText`-style type split — `LocId` cannot render, display text cannot travel the wire; seed-phrase wordlist is structurally exempt. **Templates take named arguments** (positional cannot survive translation — change needed in `02` §2). ICU replaced by two rules: **no numbers inside sentences**, and a **telegraphic, grammatically inert register**. **V-6 resolved: English + Russian** | `02` `03` `07` `13` `17` |
| 2026-08-02 | **Climax rooms.** A room type carrying a rare or unique. Framed as a **delivery point, not a source** — draws from the capped pool, same precedent as puzzle rewards and tear pockets, so INV-6 holds. Surfaces the highest-tier item currently hosted in your universe; guaranteed-if-available. Suggested cap: one per archetype. **First named room type** — seed for the level-design doc | `07` `11` `13` `14` |
| 2026-08-02 | **Run structure.** 5–8 rooms per archetype; **3 archetypes per run** (floor and ceiling both 3); assembler caps the run at **18 rooms**, selecting size-aware. Run length stays 30–45 min because held bleed is defined as ≈2× it | `01` `03` `08` `12` `13` `14` `HANDOFF` |
| 2026-08-02 | **Concept art precedes generation.** Source not output, one sheet per asset set, conditions inference, two human gates. **V-5 resolved** — palette is extracted from an approved sheet (T-0105), not chosen. P-A resolves with it | `05` `13` `GDD-OPEN` `HANDOFF` |
| 2026-08-02 | **Item hosting.** An anchored instance lives in exactly one universe (`hosted_by`); offerings stay globally visible. Escrow becomes the only genuine contention point. NP-2 resolved | `03` `04` `07` |
| 2026-08-02 | **Server topology.** Federation seams built now, single deployment until after the slice. Sweep worker is a per-shard singleton. Uniques centrally brokered; forks fully independent — **answers 7.5** | `04` `15` |
| 2026-08-02 | **Copy-on-write.** Volume snapshots for all shards; **append-only custody log for uniques only**, affordable because uniques do not scale. `custody_depth` becomes derived rather than incremented | `07` `15` |
| 2026-08-02 | **Offline runs persist nothing.** A security position, not a simplification — sync-on-reconnect would mean accepting client-asserted progress from an open-source client | `01` `03` |
| 2026-08-03 | **Level design framework** (`16`). Room-type taxonomy — Climax, Tear own dedicated system-facing tags; Gate, Hazard, Transit are author-facing roles on ordinary room tags. Placement budget: Tear exactly 1/archetype, Climax ≤1, Gate recommended ≥1, Hazard/Transit flexible. **Entities are rolled per-universe onto authored sensor-category slots**, not fixed per variant. Variant authoring split into fixed (tag set, room count) vs. free (connectivity, dressing, role placement) — unblocks A-3's cost estimate | `01` `11` `12` `14` `16` |
| 2026-08-03 | **First-run experience** (`18`). Phrase auto-saved to a local text file on generation, no manual export (**S-3 resolved**); reveal screen requires explicit acknowledgment, names phrase-loss and collapse as distinct endings. Chroma-clock explained once, in text, only after a baseline exploration window — first-universe grace multiplier stays invisible to the player. Offline signaling required pre-play, during, and at session end. Core loop taught by room design (Ground Relay pattern), never by tutorial popups | `09` `18` |
| 2026-08-03 | **Full vertical-slice walkthrough review surfaced a real gap: tears now chain archetypes.** Records Room (`14`) switched from item-locked to puzzle-locked, resolving an entry circularity; its climax reward (renamed **Resonance Key**) now opens Broadcast Deck's tear — reclassified a **chain tear**. `12` §3a formalizes chain vs. pocket tears: archetypes 1–2 in a run's sequence chain onward via a unique-keyed unlock (home palette, not foreign); the terminal archetype gets a free pocket tear (genuinely foreign). Vertical slice expanded to all 3 archetypes — **Signal Tower (7) → Hospital (5, `19`) → Long Descent (6, `20`)**, summing to exactly 18 rooms. Trap/lock demoed for the first time (Hospital's Stairwell). Dead Frequency Room and its foreign Watcher reused wholesale as Long Descent's terminal pocket. Also: V-7 resolved (vertical slice now spans `14`/`19`/`20`); **Try Again/New Game** post-run screen added to `01` §6 (Try Again re-assembles the same archetype selection); solo-testing scope note added to `14` | `01` `12` `14` `16` `19` `20` |

- [17-localization.md](design/17-localization.md)

## Next Steps — as of 2026-08-03

**Single source for both chats and dispatch.** Written here rather than in comments so nothing depends on who read which thread.

**Where the project stands:** board, planner agent, CI/CD, and both dev environments are done and green. All three pipelines are wired and proven. **`16`, `17`, `18` closed the last three uncovered topics** — the design set is now complete in scope. The vertical slice is fully specified across `14`/`19`/`20`, summing to exactly 18 rooms. **T-0099 (economy sim) is in progress.** Still true: no game logic and no real content exist yet.

### Two corrections — raised 08-02, both resolved 08-03

**1. T-0073 is not blocked — it has an unmet dependency.** It waits on T-0105, which waits on T-0104. That is sequence, not a decision. `PLAN`'s task schema keeps `depends_on` and `status: blocked` as separate fields, and T-0019 built dependency validation for exactly this. Using `blocked` for dependency-waiting hides what the status is *for*: whether something needs a human. **The honest blocked count is zero.**

**2. Signal Tower is one room over the ceiling.** With 5–8 rooms per archetype, 3 per run, and an 18-room cap, the largest a single archetype can ever be is `18 − 5 − 5 = 8`. `14` specifies **8 main rooms plus a tear pocket**, and `12` §3 says the pocket counts toward the run total — so it is 9, and `9 + 5 + 5 = 19`. The first archetype authored cannot be placed by the assembler as specified. **Either the pocket sits inside the 8, or the ceiling moves.** Design chat's call; it affects every archetype authored after this one.

### For dispatch

| # | Card | Why now |
|---|---|---|
| 1 | **T-0104** — concept sheet, round 2 | Highest leverage on the board. The entire art chain hangs off it. Requirements are now concrete in `13` §6.9: flat side-on, squint-legible, value-separated, interior-only for palette extraction |
| 2 | **T-0108** — split `keyart/` from `concept/` | Trivial, and it stops key art being used as conditioning input (`13` §6.8) |
| 3 | **T-0105 → T-0073** | Palette extraction unblocks the quantizer and the descent chain |
| 4 | **T-0099** — economy sim *(in progress)* | Its assertions **are** T-0096's predicates — the test suite arriving early rather than a detour. Must answer **INV-14** (does population actually help — the claim the pitch rests on), **DM-5** (recipient selection on bleed), **OPS-1** (shard population floor). **Add chain-key consumption to the model** — a slow unique drain is exactly what a few simulated weeks would expose and no amount of reasoning will settle confidently |
| 5 | **T-0092** — anchor-tag build validation | Structural; wants to exist before variants do |
| 6 | **Phase 4**, in `HANDOFF` §7 order | T-0093/94 (identity, lease) → **T-0096 failing** → T-0095 (CAS) → T-0097 (escrow) → T-0098 (proof-of-play). T-0096 should fail before it passes |
| 7 | **Commit `03`, `04`, `17`** | Delete the repo's `03`/`04` first — they describe cut systems (`/v1/roll`, `secret_drops`, `zone_id`). Do not merge them |

> **The vertical slice is the economy plus a zone, not a zone.** It needs identity, session leases, run assembly, item custody, and anchor queries — most of Phase 4. Worth stating so "slice next" is not read as "art next."

### For the design chat

| # | Work | Why now |
|---|---|---|
| 1 | **Settle the chain-tear key** — two questions, both open on `12` §3a (see comments there) | **(a) Does a chain-tear unlock persist across runs or reset?** §3a says "for the rest of the run"; `10` §3's unique-keyed tier says ~1 week. Per-week is an ordinary item-locked door and fine. Per-run means every player burns **two uniques per run** into a pool that never respawns (`07` §2). Two orders of magnitude apart, currently left to inference. **(b) Would rare-tier keys do the same job?** Rares scale with `k_r · P`; uniques do not. Rare-tier decouples traversal from the ending so they stop sharing a pool, and "deliberate, costly" survives unchanged |
| 2 | **Clean up two self-contradictions in `12`** | §3's table still reads **Trip type: round trip**, untrue of a chain tear. §4 still states tears are **"always crossable... not a blocking precondition,"** which §3a directly overrides |
| 3 | ~~Freeze new archetype authoring~~ — **lifted 2026-08-04.** T-0099 round 2 settled the chain-key question: `destroy` semantics kill the unique pool within one simulated hour (5 crossings ever); `transfer` sustains 2,032 crossings from the same 5 instances. The docs already lock `transfer` (`10` §3). **Authoring may resume.** Worth stating `transfer` explicitly in `12` §3a so the `destroy` reading cannot resurface | See `HANDOFF` §11.1 |
| 4 | **A-3 estimate**, once the first second-variant exists | `16` §4 bounds what the estimate must cover (level-design labour, not asset generation) but does not produce hours. It is the last thing standing between here and knowing whether the population-scaled variety model is affordable |

**Closed since 08-02:** `16 Level Design` · `02` §2 named template arguments · climax rooms into `11` · `18 First-Run Experience` (S-3 resolved) · Signal Tower room count · V-7 (slice now spans `14`/`19`/`20`).

### One card each, if nothing else

- **Dispatch: T-0104.** Everything visual waits on it.
- **Design: settle the chain-tear key.** Three slice documents already rest on it, and it is the only open question that could invalidate authored content rather than merely delay it.

- [16-level-design.md](design/16-level-design.md)
- [18-first-run.md](design/18-first-run.md)
- [19-vertical-slice-hospital.md](design/19-vertical-slice-hospital.md)
- [20-vertical-slice-long-descent.md](design/20-vertical-slice-long-descent.md)
