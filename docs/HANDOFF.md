# HANDOFF — GDD → Development

> **Project:** **Assembled**
> **Author:** Claude (Opus 5) · **For:** dispatch session / local Claude Code · **Date:** 2026-08-01
> **Purpose:** reconcile `PLAN.md` (written pre-GDD) with the design docs (written during GDD). PLAN.md v2 predates every design decision below and has real drift. **Read this before touching Phase 3+.**

---

## 0. How To Use This

1. Apply §3 (revised tasks) and §4 (new tasks) to `tasks/`.
2. **Use `04` for the schema** — §5 below is superseded and its DDL removed.
3. Do **not** start anything in §6 (blocked) — those need @DennieSeth.
4. Phases 0–2 are unaffected. Nothing below invalidates work already done.

**Docs are the source of truth. This file is a diff, not a spec.** Where they disagree, the design docs win.

---

## 1. Document Index

| File | Status | Covers |
|---|---|---|
| `01-vision.md` | v6, locked | premise, pillars, loop, progression, completion, runs/death/collapse, world structure, presentation, non-goals |
| `02-notes-system.md` | v3, locked | vocabulary, grammar, anchoring, truth, tiers, petition, rating, density |
| `05-art-direction.md` | v2, locked | Soviet constructivism/brutalism, palette family, tile size, asset strategy |
| `07-items-economy.md` | v5, locked | instances, rarity=quantity, transfers, topology, bleed, workbench, escrow |
| `08-invariants.md` | v3, locked | INV-1…14, simulation scope |
| `09-identity.md` | v2, locked | seed phrase, session lease, sockpuppets |
| `10-time-and-progression.md` | v2, locked | the four wall-clocks, unlock tiers, endgame |
| `11-moment-to-moment.md` | v2, locked | sensor kit, hiding, trap/lock, room vocabulary, puzzles |
| `12-tears.md` | v1, locked | the core-loop verb — tear as anchor tag, crossing, traces |
| `13-asset-pipeline.md` | v4, locked | **art + audio generation pipeline**, concept art, validation gate, P-1…P-5 |
| `14-vertical-slice.md` | v1 | Signal Tower — the Phase 8 slice zone |
| `15-server-ops.md` | v1, draft | topology, shard model, unique authority, backup, federation, copy-on-write |
| `03-net-protocol.md` | **written** — v1 draft | auth, error enums, transfer receipts, endpoints, offline. Repo copy is wrong — delete it and commit this |
| `04-data-model.md` | **written** — v1 draft | full schema, sweep worker, indexes, migrations. Repo copy is wrong — delete it and commit this |
| `06-audio.md` | **superseded** | pipeline half is `13` §4. Only track/SFX counts would remain; may not be needed |

`GDD-QUESTIONS.md` is superseded for Tiers 1–6 and archived. Tier 7 (risks) is partly answered in `GDD-OPEN.md` §5.

**The repo's `03` and `04` are not merely stale — they describe cut systems.** `03` specifies `GET /v1/roll`; `04` has `secret_drops`, `drop_grants`, and `zone_id`. Secret drops were cut (`PLAN.md` v3) and coordinates were replaced by anchor tags. Delete, do not edit.

---

## 2. Decisions That Change The Plan

Condensed. Full reasoning is in the docs.

| # | Decision | Doc |
|---|---|---|
| D-1 | World is **discrete**. Notes/items bind to `(archetype_id, anchor_tag)`, never coordinates. **No geometry, no GiST, no radius query.** | `01` §7 |
| D-2 | Three world levels: **archetype → variant → room.** 12–15 archetypes total in the pool; a run assembles **exactly 3 archetypes** (authored at 5–8 rooms each, size-aware selection), up to **18 rooms** total. (Revised 2026-08-02 — was 5–7 archetypes / ~15 rooms, then briefly 1–3 archetypes.) | `01` §7 |
| D-3 | **One universe per identity**, dying on a wall-clock over weeks. Death ends a *run*, not the universe. Collapse is the losing ending. | `01` §6 |
| D-4 | **Exit progress never persists.** Evaluated only at the instant of simultaneous possession of several uniques. Pillar-level. | `01` §5, INV-13 |
| D-5 | Identity is a **server-generated seed phrase**. Server stores derived token only, discards phrase. No accounts, no PII, loss is final. | `09` §1 |
| D-6 | **One live session per identity**, enforced by lease + heartbeat. New session evicts old. | `09` §3, INV-11 |
| D-7 | **Rarity = hard instance-count cap**, not drop probability. Common `k_c·P`, rare `k_r·P`, unique fixed absolute. | `07` §2 |
| D-8 | **Quit == death** for items — they scatter. Economy never drains. Supply shrinks via landing probability on bleed. | `07` §4 |
| D-9 | **Four wall-clocks:** held bleed 60–90 min, world/escrow 48–72 h, unlock decay (tiered), collapse (weeks). | `10` §2 |
| D-10 | **Unlocks are per-`(variant_id, tag)`** and they decay. Vocabulary tiers are the only thing that never expires. | `01` §7, `10` §3 |
| D-11 | **Vocabulary is tiered** — composition gated, comprehension never. Unique tier = broadcast petition. | `02` §5–6 |
| D-12 | Rating requires **proof-of-play**; slows held bleed only, never collapse. | `02` §7 |
| D-13 | Art: **pixel art, 384×216, 16:9, integer-scaled.** Soviet brutalism. | `05`, `01` §8 |
| D-14 | Platforms **Windows + Linux**. itch confirmed, Steam cleared (Tier 1 disclosure, dev tooling exempt). | `01` §9 |
| D-15 | Game is **runnable offline, not completable offline.** | `01` §5 |
| D-16 | **Tiles are 16px**; rooms authored on a 24×14 grid (384×224) with an 8px non-gameplay band. Viewport is fixed and letterboxed — never widened, because extra sightline is a competitive advantage. | `05` §5, `13` §3.3 |
| D-17 | **Assets ship as indexed PNGs + a separate 1D palette LUT.** Index `N` means palette slot `N` in *every* asset (**P-4**). The chroma swap is a LUT substitution, so non-uniform index semantics corrupt it silently. Build-time check. | `13` §3.0 |
| D-18 | **Generated output ships as-is — no hand editing (P-1).** Rejection means regenerate with an adjusted recipe. Hand-edited files are unregenerable from seed and would break provenance and the gitignore policy. | `13` §1 |
| D-19 | **Atlases are build artifacts, not committed.** Per-archetype atlases would be written by two different `art/*` branches, violating the strictly-additive rule. Commit individual sprites; pack in CI, deterministically. | `13` §3.6 |
| D-20 | **Gameplay SFX are never ducked (P-5).** Music ducks ambience only. Entity telegraph is the sole warning for no-LOS entities, so masking it is a fairness bug. Requires a four-bus split. | `13` §4.1, `11` §1 |
| D-21 | **Climax rooms are a named room type.** A guaranteed delivery *point* (not source) for the highest-tier item currently hosted by the player's universe — unique if one is hosted, else rare, else empty. Same capped-pool precedent as puzzle rewards and tear pockets. Cap: one per archetype (≤3/run). | `11` §7 |

---

## 3. Revised Tasks

| Task | Was | Now |
|---|---|---|
| **T-0001b** | image LFS patterns deferred pending art direction | **Unblocked. Pixel art → plain git, no LFS for images.** LFS stays audio-only (`assets/final/audio/**`). Close this. |
| **T-0033** | windows client build | add a **Linux export job** (D-14) |
| **T-0043** | `shared/note_templates.hpp`  • SQL seed | also seed **archetype + anchor-tag tables**; tags are contractual and shared client/server |
| **T-0044** | `NoteRepo` CRUD + **radius query** | **radius query deleted.** Lookup is equality on `(archetype_id, anchor_tag)` (D-1) |
| **T-0046** | `GET /v1/notes` radius+ranking | **tag equality + ranking.** Much smaller. Drop the GiST index entirely |
| **T-0066** | anon token: generate, persist, never PII | **seed-phrase derivation** (D-5). Server generates phrase → derives token → discards phrase. Client persists phrase to file |
| **T-0067** | "game fully playable with server down" | **"fully *runnable* offline, not completable"** (D-15). Explore/survive/progress work; the ending is unreachable |
| **T-0072** | style LoRA: curate 30–50 refs | **unblocked** — direction is locked, and the LoRA stays palette-agnostic so it does **not** wait on V-5 (`13` §3.2). Corpus = abandoned Soviet constructivism/brutalism |
| **T-0071** | `AssetAgent` generate → poll → fetch | also carries **concept conditioning** and records the **concept sheet hash** — without it a set is not reproducible (`13` §6.3) |
| **T-0073** | post-process chain incl. palette quantize | **unblocked via T-0105** — the palette is extracted from approved concept art, not decided by hand. Quantize in Oklab/CIELAB, **dithering off** — dithering breaks index semantics (D-17) |
| **T-0075** | provenance auto-writer | add the **concept sheet hash** to every row |
| **T-0074** | sprite-sheet packer → Godot `.tres` atlas | **moves from authoring tool to CI build step** (D-19). Adds a determinism requirement: same inputs → byte-identical layout. Also assert the packed atlas is still PIL mode `P` — Pillow silently converts to RGB |
| **T-0081** | Stable Audio Open for SFX | **scope narrows to textures only** — entity vocalizations, room events, drones. Short one-shots move to T-0101; diffusion models are weak at 0.2 s percussive sounds |
| **T-0083** | loudness normalize + Godot import presets | **add the loop-fold step and seam assertion** (`13` §4.7). Validate the *encoded* file — Ogg padding can break a seam that was clean in the source |
| **T-0082** | `AudioAgent` mirroring `AssetAgent` | also carry **bus assignment** metadata per asset (Ambience / Music / World SFX / Gameplay SFX), since D-20 makes the bus a gameplay property, not a mix setting |

### PLAN.md open questions — resolved

- ~~Q1 game genre/loop~~ → `01-vision.md`. **Closed.**
- ~~Q2 zone coordinate space~~ → **discrete, permanently** (D-1). **Closed.**
- ~~Q3 art direction~~ → pixel art, brutalism (D-13). **Closed**, and it closes the LFS question.
- ~~Q4 target resolution~~ → **384×216** (D-13). **Closed.**

---

## 4. New Tasks

Numbered from T-0090 to avoid collision with the existing backlog.

| Task | Phase | Description | Tests first |
|---|---|---|---|
| **T-0090** | 0 | ~~Write `docs/design/04-data-model.md`~~ — **done as a design artifact.** `04` is written; dispatch commits it and implements against it | — |
| **T-0091** | 0 | ~~Write `docs/design/03-net-protocol.md`~~ — **done as a design artifact.** `03` is written; dispatch commits it and implements against it | — |
| **T-0092** | 3 | **Build-time anchor-tag validation** (INV-12). Every variant implements every tag its archetype declares. Missing tag = build failure | missing tag rejected, extra tag warns |
| **T-0093** | 4 | Session lease: heartbeat, TTL, evict-on-takeover (INV-11) | expiry reclaims, takeover evicts, crash recovery |
| **T-0094** | 4 | Seed-phrase generation + token derivation; phrase never stored | derivation determinism, phrase absent from DB, rate limit |
| **T-0095** | 4 | `ItemRepo`: custody transfer as **compare-and-swap on `version`** (INV-2) | concurrent transfer — exactly one wins |
| **T-0096** | 4 | **Two-player economy integration test** (INV-1/2/3). A leaves X → B takes X → assert single custody, no dupe, conserved count | this *is* the test |
| **T-0097** | 4 | Escrow: atomic pay-and-release (INV-4) | no partial state, both-hold impossible |
| **T-0098** | 4 | Proof-of-play gate on rating (D-12) | rating without archetype in run → 403 |
| **T-0099** | — | **Economy simulation harness** (`08` §4). Standalone, no engine, no server. Agents join/play/idle/quit; items spawn/bleed/transfer/scatter; four clocks modelled | assertions ARE INV-6…9, INV-14 |
| **T-0100** | — | Name-collision check: "Assembled" on Steam + itch. 5 min | — |
| **T-0101** | 7 | **Deterministic one-shot synthesis script** (`assets/src/`). Seeded numpy/scipy renders footsteps, switches, doors, pickups offline to WAV. Physically-inspired (noise burst → resonant filter → envelope), *not* sfxr chiptune | same seed → byte-identical WAV |
| **T-0102** | 3 | **Asset validation gate** (`13` §2, §4.8). Palette membership, index semantics (P-4), tile seamlessness, transition adjacency, cell fit, orphan pixels, frame-silhouette delta; audio loop seam, LUFS, true peak, DC offset | **write these before the generation chain** — they turn generation into red→green |
| **T-0103** | 5 | **Audio bus split** (D-20): Ambience (duckable), Music, World SFX (lightly duckable), Gameplay SFX (priority, never ducked) | ducking music never attenuates the gameplay bus |
| **T-0104** | 6 | **Concept workflow** (`13` §6) — base-SDXL sheet generation, curation, commit to `assets/src/concept/`. **Blocked by nothing; the first Phase 6 task** | — |
| **T-0105** | 6 | **Palette extraction** from an approved concept sheet — cluster to N, order into a value ramp, emit the LUT. **Resolves V-5 and P-A** | same sheet → same LUT |
| **T-0106** | 6 | Concept conditioning in `AssetAgent` (IP-Adapter / img2img); concept hash written to provenance | — |
| **T-0107** | 4/8 | **Debug/seeded item-grant command**, dev+test builds only. Lets QA grant any item instance (including a unique) directly to an identity, bypassing the live economy. **Compiled out of release builds** (`#ifdef`, not a runtime flag) — the repo is public, so a runtime-only guard is a one-line fork away from an unlimited mint. Convenience for deterministic tests; the hosting model (`04` §4) makes it non-essential for basic solo testing (`14` §5). | grant works in debug build; symbol absent from release binary |

**T-0099 is the important one.** Build the harness now — its parameters are blocked (§6) but its structure is not. Its assertions are the same predicates as T-0096's, which is the point: one definition, three consumers.

---

## 5. Schema Delta (Phase 4)

**Superseded. `04` is written — use it, not this section.**

This was a sketch produced when `04` did not exist. It is now wrong in at least five ways: `rarity` belongs on `item_type` not `item_instance`; `item_instance` needs `hosted_by` and `shard_id`; `archetype_seen` replaces `run_archetypes` on the proof-of-play path; `notes.id` must be UUID rather than BIGSERIAL because shards would mint colliding IDs; and it is missing `transfer_receipt`, `type_census`, and `economy_ledger` entirely.

The DDL has been removed rather than left in place, because a stale schema next to a live one is exactly the failure this document was written to fix.

```sql
-- REMOVED: see 04 Data Model for the current schema.
-- This block was a pre-04 sketch and is superseded in five places
-- (rarity location, hosted_by, shard_id, archetype_seen, notes.id type).
```

**One thing from the original sketch is worth carrying forward as a principle**, and `04` §4 preserves it: **INV-1 (single custody) is enforceable as a database `CHECK`**, not application logic — so it cannot be violated by a bug in a handler. `04` extends the same reasoning to `session_lease` (INV-11 as a primary key) and the `notes` broadcast/anchor guard.

---

## 6. Blocked — needs @DennieSeth

Nothing in §3–5 is blocked on these. **Do not guess at them.**

| # | Question | Blocks |
|---|---|---|
| **T-1** | Exact collapse duration within ~2–4 weeks (~1.5× first universe) | sim tuning, V-10 |
| **T-2** | Exact unique-unlock decay within ~1 week | sim tuning |
| **E-1** | Exact held/world bleed durations within the stated ranges | sim finds these |

All three are **sim-tuning values within brackets that are already set** — none needs a decision made by hand, and the sim answers them (`08` §4). **V-5 is no longer on this list:** the palette is extracted from an approved concept sheet by T-0105 (`13` §6.6), not chosen.

T-1 and T-2 block the *tuning sweep*, not the harness — and now have starting brackets to sweep within. Build T-0099 regardless. **E-7 (spawn model) is resolved** — ambient Poisson process per `(archetype_id, anchor_tag, tier)`; uniques are a one-time seed, never respawned. See `07-items-economy.md` §2/§4.

---

## 7. Suggested Order

1. **Commit `03` and `04`** — they are written (T-0090/T-0091 complete as design artifacts). Delete the repo's wrong copies first; do not merge them.
2. **T-0092** — tag validation. Structural, and it wants to exist before variants do.
3. **T-0099** — sim harness. Parallelisable, unblocked, and it may surface a design problem while changes are still free.
4. **Phase 4** with the revised schema — T-0093/94 (identity, sessions) before items, since items depend on identity.
5. **T-0096 before any item handler.** It is the smallest meaningful test of the whole economy and it should fail before it passes.
6. **T-0102 before any generation work.** The validation gate is the whole quality mechanism under D-18 — there is no manual repair step, so the tests are what make "ships as-is" viable.
7. **Phase 6 — nothing is blocked.** Order: **T-0104** (concept sheet) → concept review → **T-0105** (palette extraction, resolves V-5 and P-A) → T-0072 (LoRA, parallel) → T-0102 (validation gate) → T-0073. One constraint: **do not train the LoRA on curated concept sheets** — they are generated output, and training a style model on its own output amplifies artifacts. The LoRA trains on the real reference corpus (`05` §2); concept art conditions inference only.
8. **Phase 7** — T-0101 is fully unblocked and needs no model at all.

---

## 8. Conventions Reminder

- Claude-authored commits: `Co-authored-by: Claude <noreply@anthropic.com>`
- Docs carry an `Author:` line; `CREDITS.md` rolls up per subsystem
- TDD: test file committed before implementation
- No TODO without a task ID: `// TODO(T-0042): ...`
- Agents never move a card to `done` — `review` is terminal for automation

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial handoff, GDD → development | Claude (Opus 5) |
| 2026-08-01 | E-7 resolved and removed from blocked list — sim tuning sweep now only waits on T-1/T-2 | Claude, rev. @DennieSeth |
| 2026-08-01 | T-1/T-2 order-of-magnitude brackets set: collapse ~2–4 weeks, unique decay ~1 week | Claude, rev. @DennieSeth |
| 2026-08-02 | pipeline decisions folded in: D-16…D-20, revised T-0072/73/74/81/82/83, new T-0101…T-0103, document index refreshed | Claude, rev. pending |
| 2026-08-02 | concept-art stage folded into §1/§3/§4/§6/§7 — new T-0104…T-0106; **V-5 removed from the blocked list** (extracted by T-0105, not decided); revised T-0071/73/75; index now lists 03, 04, 14, 15 | Claude, rev. pending |
| 2026-08-02 | D-2 revised (room budget: 1–3 archetypes, up to 18 rooms — raised against Signal Tower's size in `14`); T-0107 added (debug item-grant for solo QA of the unique-locked door) | Claude, rev. @DennieSeth |
| 2026-08-02 | D-2 narrowed to exactly 3 archetypes/run (5–8 rooms each); D-21 added (climax rooms, `11` §7) — dissolves the Clearance Chit testability gap via hosting-model bleed delivery; T-0107 retained as a convenience for deterministic tests, must be compiled out of release builds | Claude (design), rev. @DennieSeth |
| 2026-08-02 | §5 schema delta **superseded and DDL removed** — `04` is written and the sketch was wrong in five places (rarity location, `hosted_by`, `shard_id`, `archetype_seen`, `notes.id` type). §0 and §7 now point at `04`; T-0090/T-0091 marked done | Claude, rev. pending |

---

## 9. Backlog Review — 2026-08-04

Against the 32-card.md backlog export. Three corrections, then cards that are specified in the docs but absent from the board.

### 9.1 Corrections

**T-0090 / T-0091 are stale at P0.** They read *write* `04-data-model.md` and `03-net-protocol.md`. Both are written (§4 marks them done as design artifacts). **Rescope to: delete the repo's wrong copies, commit `03`, `04`, and `17`.** As unassigned P0s they pull attention toward finished work.

**T-0048 has been reused, and it should not have been.** It was the secret-drops `/v1/roll` card, cut in `PLAN.md` v3 — both this document and `GDD-OPEN.md` record "T-0048 removed." It is now the item spawner. **T-0013 specifies the allocator is gap-tolerant with no reuse**, precisely so a retired ID never means two things. Anyone reading the docs against the board hits a contradiction. Reissue the spawner as a fresh ID and leave T-0048 retired.

**T-0093 is under-prioritised.** Session lease (INV-11) sits at P1 while T-0094 is P0. §7 puts the lease *before* items, and INV-11 is a third of the anti-dupe law — it stops one identity acting from two clients, which CAS alone cannot. **Raise to P0.**

### 9.2 Missing — Phase 4 server

These are specified in `03` and `04` and have no card. Without the first three there is storage but no game loop.

| Proposed | Card | Spec | P |
|---|---|---|---|
| **T-0110** | **Run assembler** — select exactly 3 archetypes, one variant each, size-aware against an 18-room.md cap; variant eligibility gated on population (V-9); assembled set recorded for proof-of-play | `03` §5, `16` §2 | P0 |
| **T-0111** | **`GET /v1/anchors/{archetype}/{tag}`** — one consistent snapshot in a single transaction, returning three visibility classes: items hosted by you, globally visible offerings, global notes | `03` §5 | P0 |
| **T-0112** | **Sweep worker** — bleed (landing roll + recipient selection), collapse, receipt retention, census. Advisory lock + `FOR UPDATE SKIP LOCKED`; per-shard singleton | `04` §7, `15` §2 | P0 |
| **T-0113** | **Transfer receipts** — client-minted `transfer_id` as primary key; repeat returns the stored outcome without re-running CAS; 72h retention | `03` §4 | P0 |
| **T-0114** | **Unlock persistence** — `(token, variant_id, tag)` with tiered decay | `04` §6, `10` §3 | P1 |
| **T-0115** | **Broadcast petitions** — `POST/GET /v1/petitions`, anchorless notes, rate-limited hard | `02` §6, `03` §5 | P2 |
| **T-0116** | **Unique custody log** — append-only, never updated in place; `custody_depth` derived from it | `15` §9.2 | P2 |

> **T-0111 is the one to notice.** The entire push-free protocol rests on a single room-entry call. If it is three separate queries rather than one transaction, the sweep interleaves and the client sees a torn view — an item listed as loose while it is already backing an offering.

### 9.3 Missing — client

Three documents have no cards at all.

| Proposed | Card | Spec | P |
|---|---|---|---|
| **T-0117** | **`LocId` wrapper + L-1…L-4 build checks** — IDs cannot render, display text cannot travel the wire; every ID resolves in every shipped locale; template slot sets match across locales; no positional placeholders | `17` §2–§3 | P1 |
| **T-0118** | **First-run sequence** — phrase auto-save, reveal with explicit acknowledgment, offline signaling pre-play/during/post, clock explanation after a baseline exploration window | `18` | P1 |
| **T-0119** | **Chroma palette-swap shader** — LUT substitution keyed on `origin_palette`, plus the collapse-proximity intensity ramp (**A-4**) | `01` §8, `13` §3.0 | P1 |
| **T-0120** | **Bleed-alpha ramp** — alpha falls to contour-only as expiry nears, held and anchored alike (**A-5**) | `07` §5 | P2 |

> **T-0119 is not a polish card.** The design has no HUD: chroma *is* the collapse clock (`01` §8) and the foreignness signal. Without the shader the game has no way to tell a player how long their universe has left, and no way to show that an object came from elsewhere. It is a core mechanic wearing a graphics-task name.

### 9.4 Export request

The current export shows backlog only, with title, priority, agent, phase. Two additions would make review far more useful:

- **`status` and `depends_on`** — without them, dependency errors and mis-set statuses are invisible. The T-0073 "blocked" case (§8 of the root Next Steps) was exactly this.
- **Done cards included** — otherwise absence is ambiguous between *finished*, *never created*, and *lost*.

### 9.5 Ask

**T-0099's output.** The economy sim answers **INV-14** (does population actually help — the claim the pitch rests on), **DM-5** (recipient selection on bleed), **OPS-1** (shard population floor), and, if chain-key consumption was modelled, whether unique-keyed chain tears drain the exit pool. That last one settles an open design question empirically rather than by argument, and it is currently blocking archetype authoring.

---

## 10. T-0099 Round 1 — Review and Round 2 Spec

**Reviewed:** 2026-08-04, against `tuning_sweep.json` / `.csv` (38 runs, seed 42) and `RESULTS.md`.

**Verdict: the run is honest and well-documented, but not decision-grade. Round 2 required before its numbers are adopted.** Two genuine findings survive (§10.2) and should be kept.

### 10.1 Blocking defects

**D1 — INV-8 drowns every other signal.** Every one of the 38 runs is `ok: false`, and INV-8 is ~99% of all violations (worst case 1,987,040 of 2,006,338). `check_inv8` scores a gating type unreachable whenever its **world-anchored count is zero** — which is also true whenever a player is merely *holding* it. `violations_total` is therefore an INV-8 noise channel, and any ranking by totals is meaningless. `RESULTS.md` avoids the trap for its main finding (it reads INV-7 directly), but the CSV will mislead anyone who does not.

**D2 — The world-bleed "no effect" result is probably a wiring bug, not insensitivity.** In `hoarder_cohort`, `world(2880,3600)` and `world(3600,4320)` produce **byte-identical** output — `17730 / 2012900 / 1343` — across two **disjoint** ranges, while `world(2880,4320)` differs. Two non-overlapping ranges cannot produce identical results to the last digit if the parameter is being consumed. Debug before concluding world-bleed does not matter.

**D3 — n=1 everywhere.** All 38 runs use seed 42. `RESULTS.md` itself dismisses one comparison as "plausibly noise" — that objection applies to every number in the file. Nothing has an error bar.

**D4 — Population dynamics disabled** (`join_rate=0, quit_rate=0`). Defensible for isolating a wall-clock parameter, but it means the three scenarios `08` §4 calls the most likely real-world failures were never run: **2→10⁴ growth**, **10⁴→200 depopulation**, **mass exodus**. The quitter rule that supposedly inverts the entire failure mode is untested.

**D5 — The three must-answer questions are absent.** **INV-14** (impossible with population fixed), **DM-5** (recipient selection), **chain-key consumption**. This round therefore does **not** unfreeze archetype authoring.

**D6 — Source-of-truth drift.** `RESULTS.md` cites `docs/design/OPEN-QUESTIONS.md` and concludes E-4 is not blocked. The canonical inventory is **`GDD-OPEN.md`**, whose §4 Class D **does** list E-4 (`k_c`, `k_r`, unique count) as sim-resolved. A sweep was skipped on the authority of a document that is renamed or stale. With `unique_count=5` against an exit needing *several held simultaneously*, E-4 may be the tightest constraint in the game — it is not safe to lock by default.

### 10.2 Findings worth keeping

**F1 — T-2 is invisible to every invariant.** Five values, byte-identical results. This is not a null result about tuning; it is the discovery that **unlock decay is measured by nothing**, so `10` §4's endgame race cannot be validated at all. Real instrumentation gap, correctly identified.

**F2 — The held-bleed signal is a cliff, and it is on `held_max`, not the sub-range.**

| held range | INV-7 (hoarder_cohort) |
|---|---|
| 60–75 | 1,016–1,586 |
| 60–90 | 17,425–17,730 |
| 75–90 | 18,253 |

`60–90` and `75–90` both fail at ~17–18k; only `max=75` drops to ~1k. **The minimum barely matters.** That is a **cliff between 75 and 90 minutes**, not a gradient — more actionable than the report's framing, and worth locating precisely. If the edge sits near 2× run length (30–45 min), that is a structural finding rather than a tuning constant.

### 10.3 Round 2 cards

| Card | Work | Done when | P |
|---|---|---|---|
| **T-0121** | **Rewrite `check_inv8` as a reachability estimate, not an anchored-count test.** For each active identity and each gating type, estimate expected time-to-delivery from the bleed/landing model — roughly `1 / (bleed_rate(T) × P(recipient = this identity))` — and raise a violation only when that exceeds the identity's **remaining collapse time**. Held-but-circulating must not count as unreachable | INV-8 falls from ~99% of violations to a rate that responds to collapse proximity; a run with a healthy pool and long runway reports near-zero | P0 |
| **T-0122** | **Debug world-bleed parameter consumption.** Add a per-config histogram of *sampled* bleed durations. Assert two disjoint ranges produce different draws | Disjoint world ranges produce different sampled distributions and different results, or the identity is explained | P0 |
| **T-0123** | **Multi-seed harness.** ≥30 seeds per configuration. Report **median and IQR**, not means. Discard burn-in — first `2 × max(held_bleed)` ticks, or until the spawner reaches cap, whichever is later. Treat overlapping IQRs as no difference | Every reported comparison carries a distribution; single-number rows no longer exist | P0 |
| **T-0124** | **Model the exit condition.** The sim must represent *several uniques held simultaneously* (`01` §5) and record time-to-completion per identity. **Prerequisite for INV-14** — without it there is nothing to measure | A completion event exists and is timestamped per identity | P0 |
| **T-0125** | **INV-14 measurement.** Turn population dynamics on. Sweep `P ∈ {2, 20, 200, 2000, 20000}`. Report **median time-to-completion vs P as a curve**, not a yes/no — the interesting case is whether it is monotonic or turns over | A curve exists, with IQR bands, and the monotonicity question is answered explicitly | P0 |
| **T-0126** | **`08` §4 population scenarios**, now that dynamics are on: 2→10⁴ growth, 10⁴→200 depopulation, 80% mass exodus in a week | All three run; the over-supply failure mode `07` §4 predicts is either observed or shown absent | P1 |
| **T-0127** | **DM-5 — recipient selection policy.** Implement all three and compare under identical seeds: uniform over active identities; weighted toward identities that have seen the archetype; biased toward identities with the longest time since last delivery | The three policies are ranked by their effect on INV-8 and on time-to-completion spread | P1 |
| **T-0128** | **Chain-key consumption.** Model `12` §3a: two chain tears per run, each consuming a key with use-semantics (the instance circulates onward). Run both readings — **(a)** unlock resets per run, **(b)** unlock persists ~1 week per `(variant, tag)` — and both key tiers, **unique** and **rare** | Unique-pool size over time is plotted for all four combinations. **This is what unfreezes archetype authoring** | P1 |
| **T-0129** | **Locate the `held_max` cliff.** Sweep `held_max ∈ {75, 80, 85, 90}` with `held_min` fixed. Check whether the edge tracks run length (30–45 min) rather than being an arbitrary constant | The transition point is bracketed to ±5 min with multi-seed support | P1 |
| **T-0130** | **E-4 sweep** — `k_c`, `k_r`, and especially **`unique_count`**. `GDD-OPEN.md` §4 lists it as sim-resolved; round 1 locked it at defaults on the authority of a non-canonical doc | A viable `unique_count` range is identified against the exit condition from T-0124 | P1 |
| **T-0131** | **T-2 observability** (F1). Add a metric for unlock-expiry versus remaining collapse time, so `10` §4's endgame race is visible to some check | T-2 sweeps produce differentiated results | P2 |
| **T-0132** | **Docs fix.** Point the sim at `GDD-OPEN.md` as the canonical open-question inventory; resolve or delete `docs/design/OPEN-QUESTIONS.md` | One inventory exists | P2 |

### 10.4 Acceptance criteria for round 2

Applies to the round as a whole, not per card.

1. **No run reports `ok: false` for reasons the report then explains away.** If an invariant fires in every configuration, the check is wrong or the model is wrong — fix it before sweeping.
2. **Every comparison carries a distribution.** Median + IQR over ≥30 seeds. Overlapping IQRs mean *no difference found*, stated as such.
3. **Something must fail.** `08` §4 asks for a viable region in `(T_bleed, spawn_rate, landing_curve)` **or proof that none exists**. A sweep where every scenario passes is under-stressed, not safe — push depopulation and exodus until something breaks, then report where the boundary sits.
4. **Report the boundary, not just the recommendation.** For each parameter: the range that holds, the range that fails, and the transition.
5. **State what was not modelled.** Round 1 did this well and it is why the review was possible. Keep it.

### 10.5 Round 1 recommendations — status

| Param | Round 1 said | Status |
|---|---|---|
| Held bleed (E-1) | 60–75 min | **Directionally supported, not adopted.** Single seed; and the real signal is `held_max ≤ 75` (T-0129) |
| World bleed (E-1) | 48–72h, no change | **Not adopted.** Rests on a null result that is probably D2 |
| Collapse (T-1) | 3 weeks | **Not adopted.** No differentiating signal, because INV-8 was saturated (D1) |
| Unique decay (T-2) | 7 days | **Not adopted.** T-2 is invisible to every check (F1) — the midpoint is a default, not a finding |

**Nothing from round 1 goes into the design docs yet.** The brackets in `10` §2/§3 stand unchanged.

---

## 11. T-0099 Round 2 — Review and Round 3 Spec

**Reviewed:** 2026-08-04, against `RESULTS-round2.md`, `round2_chainkey_summary.csv`, `round2_dm5.csv`, `round2_population.csv`.

**Verdict: a large step up. One question is settled decisively and unblocks content work. Two answers are proxies rather than the questions asked, and one number must not reach the design docs yet.**

Round 2 also does something round 1 did: it states its own coverage gaps inline. That is why review is possible at all, and it should stay a standing requirement.

### 11.1 Settled — adopt this

**Q4: chain keys are `transfer`, not `destroy`. Definitive.**

| Mode | Final unique pool | Exhausted at | Crossings in 3 weeks |
|---|---|---|---|
| `destroy` | 0 / 5 | tick 60 (~1 hour) | 5 |
| `transfer` | 5 / 5 | never | 2,032 |

`destroy` breaks the exit condition within the first hour of a shard's life and never recovers. `transfer` sustains four orders of magnitude more crossings from the same five instances.

**The docs already lock `transfer`** — `10` §3: *"Using a unique to open a lock sends the instance onward to another player... The item circulates; the knowledge stays."* Round 2 confirms this is not merely the more elegant reading, it is load-bearing.

**Actions:**

- **Unfreeze archetype authoring.** The freeze in the root Next Steps (item 3) is lifted.
- **State `transfer` explicitly in `12` §3a**, so the `destroy` reading cannot resurface. Currently it is only inferable via the item-locked-door cross-reference.
- **Correction on the record:** the pipeline chat's earlier "chain tears drain the unique pool" alarm read *cost* as *consumption*. It is not. That objection is withdrawn.

### 11.2 Proxies, not answers

**Q1 — INV-14 is still untested.** The round answers *throughput* (pickup rate per agent vs P) and *existence* (INV-7: do gating types exist at all). INV-14 is neither: it is **median time-to-completion falls as P rises**. With no completion event in the model, that curve does not exist.

The negative result on throughput is honest and well-argued, and the reframing — population makes the game *finishable*, not *faster* — may well be right. But it is currently an interpretation of a proxy, and INV-14 is the claim the pitch rests on. **T-0124 was not built**; it remains the prerequisite.

**Q4's untested half.** The model spends a unique the instant an agent picks one up while short of its required crossings. If uniques are continuously consumed for traversal, does any identity ever hold **several simultaneously** — the actual exit condition (`01` §5)? The sim counts crossings, not completions. This is the surviving half of the original chain-key concern and it needs T-0124 to answer.

### 11.3 Do not adopt — Q3's floor number

**`RESULTS-round2.md` recommends writing "P=20 hard floor, target ≥50" into `15` §3. Hold that.**

The floor is very likely an artifact of unswept constants rather than a discovered property. Rare-tier cap is `k_r · P` with **`k_r = 0.2`, never validated** — round 1 skipped E-4 on the authority of a non-canonical document (§10.1 D6), and round 2 did not revisit it. Change `k_r` or the spawn rate and the floor moves with it.

**And the data shows three seeds cannot locate it.** At P=30, `inv7_tick_fraction` spans **0.024 → 0.192** across seeds 42/43/44 — an 8× spread precisely in the transition zone where the floor is being read off. Three seeds bracket the region; they do not measure it.

This number would drive real deployment topology (`15` §3's shard-assignment policy is a gameplay parameter, not an ops one). It needs E-4 swept and ≥30 seeds before it lands.

### 11.4 Carried forward, still open

- **T-0121** — INV-8 heuristic. Still ~93% of ticks in every population row; acknowledged as out of scope. Until fixed, `violations_total` remains unreadable and INV-8 cannot speak to reachability.
- **T-0123** — seeds. Round 2 used 3 for the population sweep (up from 1) and 1 elsewhere. Target remains ≥30 with median + IQR.
- **T-0124** — exit condition. Now blocking two questions rather than one.
- **T-0130** — E-4 (`k_c`, `k_r`, `unique_count`). Now blocking Q3's headline number.

**Q2 (DM-5) is effectively closed.** Gini across `fifo` / `random` / `need_weighted` is 0.039–0.051 — the three policies are indistinguishable. Recipient policy is not a lever worth tuning; pick `random` for the absence of implicit ordering bias and move on. Worth re-checking only if `15` §3's federation work makes delivery ordering visible to players.

### 11.5 Round 3 — scope

Four cards. Everything else stays parked; this round exists to convert two proxies into answers.

| Card | Work | Done when | P |
|---|---|---|---|
| **T-0124** | **Model the exit condition.** An identity completes when it holds `N_exit` uniques simultaneously. Record completion events with timestamps. Requires an identity that survives across runs — see T-0133 | Completion events exist and are timestamped; completion rate is reportable per population point | P0 |
| **T-0133** | **Multi-universe identity.** Round 2's agent lifetime is one universe; quit/collapse is terminal and a rejoin is a fresh agent. Separate **identity** (persistent, carries vocabulary and unlock state) from **run** (one universe). Prerequisite for T-0124, and the reason the per-run-vs-per-week chain-key persistence question was unanswerable | An identity survives collapse and starts a new universe; per-run and per-week unlock scoping become distinguishable | P0 |
| **T-0121** | **Fix `check_inv8`** — spec unchanged from §10.3. Expected time-to-delivery vs remaining collapse time; held-but-circulating is not unreachable | INV-8 responds to collapse proximity instead of sitting at ~93% everywhere | P0 |
| **T-0130** | **E-4 sweep** — `k_c`, `k_r`, `unique_count`, jointly with the population sweep. The shard floor is a function of these, not a constant | The P-floor is reported **as a function of `k_r` and `unique_count`**, not as a single number | P0 |

**Then, and only then:** re-run INV-14 with ≥30 seeds and report median time-to-completion vs `P ∈ {2, 20, 200, 2000, 20000}` as a curve with IQR bands, answering monotonicity explicitly.

### 11.6 Round 2 recommendations — status

| Recommendation | Status |
|---|---|
| Chain keys use `transfer` semantics | **Adopted.** Write into `12` §3a |
| Recipient policy — no meaningful difference | **Adopted.** Use `random`; DM-5 closed |
| Population enables completability, does not accelerate it | **Plausible, not adopted.** Rests on a proxy; needs T-0124 |
| P=20 hard floor, target shard ≥50 | **Not adopted.** Contingent on unswept E-4; 3 seeds cannot locate a transition with 8× spread |

---

## 11.7 Task ID Convention — corrected 2026-08-04

**The `T-NNNN` space belongs to Dispatch.** Proposals written in Notion cannot see committed Git history, so every ID proposed from here has been a guess — and three times now (§9.2, §10.3, §11.5) those guesses collided with live board cards.

**New rule, effective immediately:**

- Documents propose cards with a **section-scoped handle** — `§11-a`, `§11-b`, `§12-a` — never a `T-NNNN`.
- Handles cannot collide (they are scoped by the section that created them) and they are self-locating: `§11-c` says exactly where its specification lives.
- **Dispatch allocates the real ID** against Git when creating the card, and records the mapping below.
- Once a real ID exists, prose here uses the real ID. Handles are birth certificates, not permanent names.

Dispatch's proposal, adopted with the section-scoped variant rather than a flat `TP-n` counter, because it survives many documents proposing cards independently and points back at its own spec.

### Round 3 — authoritative IDs

§11.5's table proposed IDs that collided. **These are the real ones. Use these.**

| Real ID | Card | §11.5 called it |
|---|---|---|
| **T-0129** | Multi-universe identity — separate identity from run; prerequisite for everything else | ~~T-0133~~ |
| **T-0130** | Model the exit condition — completion events, timestamped | ~~T-0124~~ |
| **T-0131** | Fix `check_inv8` reachability | ~~T-0121~~ |
| **T-0132** | E-4 sweep — `k_c`, `k_r`, `unique_count` | ~~T-0130~~ |
| **T-0133** | Re-run INV-14 measurement — the payoff, once the four above land | *(the "then, and only then" paragraph)* |

**Dependency order stands regardless of numbering:** T-0129 → T-0130 → T-0133. T-0131 and T-0132 are parallel.

### Still to reconcile

§9.2, §9.3 and §10.3 propose IDs written blind, known to overlap live cards. **Treat every ID in those three sections as a handle, not an address** — match on card *title and spec*, not number. To be reconciled against the next backlog + done export.

### Carried onto T-0132

Reaffirmed at Dispatch's request so it lives on the card as well as here: **the "P=20 hard floor / target ≥50" recommendation must not reach `15` §3 until T-0132 lands.** The floor is a function of unswept `k_r` / `unique_count`, and three seeds showed an 8× spread (`inv7_tick_fraction` 0.024→0.192 at P=30) inside the transition zone itself. `15` §3 and §8 already carry this caveat.

---

## 12. Asset Pipeline E2E Review — 2026-08-06

**Reviewed:** `assets/final/palette/home_palette.json`, `assets/final/tiles/signal_tower_concrete_wall_16px.*`, repo tree at `develop`, and the Board Assets database.

**Verdict: the chain works end to end and produced a correctly-descended real tile with full lineage.** Three defects and one structural gap below. Cards use section-scoped handles per §11.7 — **Dispatch allocates the real IDs.**

### 12.1 Confirmed correct — no action

- **T-0105 is properly done.** 16 slots, Oklab-lightness value ramp darkest→lightest, extracted from a named sheet with sha256. The file's own comment warns that slot indices are load-bearing for P-4 and must not be renumbered on regeneration — exactly what `13` §3.0 requires. **V-5 and P-A are resolved for real, not nominally.**
- **T-0073 implemented the correct chain despite a stale card title.** Provenance reads `box_downscale -> oklab_quantize -> orphan_cleanup`. No upscale. The earlier concern (§10/§11 review notes) is **withdrawn**.
- **Provenance exceeds spec.** Carries `palette_source` *and* `palette_lineage` with hashes, so a tile traces back through the LUT to the concept sheet. `13` §6.3 asked for a concept hash; this is better.
- **`keyart/` and `concept/` are already split** under `assets/src/`. T-0108's structure exists.
- **The negative prompt encodes §6.9.** `perspective, three-quarter view, vanishing point, sky, gradient, depth of field` — the round-1 concept failures, turned into constraints. Guidance reached practice.

### 12.2 Cards to implement

| Handle | Work | Done when | P |
|---|---|---|---|
| **§12-a** | **Populate `model_hash` in provenance.** Currently `null` on the shipped tile. `PLAN.md` §0 makes provenance non-optional and names *model + license + prompt + seed*; a null hash means the exact weights that produced an asset cannot be proven. Hash the checkpoint file at generation time and fail the write if it is missing | No committed asset carries `model_hash: null`; the validation gate rejects one that does | **P0** |
| **§12-b** | **Review the palette's green weighting against `05` §3.** Six of sixteen slots are saturated institutional green (`#0b2d18`, `#123c23`, `#224d32`, `#4c553a`, `#5a6042`, `#616747`) and **there is no oxide/rust slot at all**. `05` §3 specifies concrete greys as "the structural base, widest range", institutional green for interiors, and oxide/rust as "the only warm notes". The chroma mechanic (`01` §8) needs the home palette desaturated so foreign objects read as wrong at *low* saturation — six saturated greens spend headroom the mechanic depends on. Either re-extract from a sheet with oxide present, or accept and amend `05` §3 to match reality | Palette and `05` §3 agree, whichever moves. Decision recorded in the Decision Log | **P0** |
| **§12-c** | **Transition tile sheet — wall→floor, corners, edges.** One wall tile does not exercise T-0102's gate: **tile seamlessness** (left column == right column, top row == bottom row, pixel equality) and **transition adjacency** (declared pairs match on their shared edge) are both unproven. `13` §3.4 notes a brutalist interior is *mostly* transitions, so the sliced-sheet path carries most of the tileset and is the untested half | Seamlessness and adjacency checks run against a real multi-tile set and pass | **P0** |
| **§12-d** | **Retitle T-0073.** Card reads *"cutout, palette quantize, upscale"* — pre-GDD wording. `13` §3.1 specifies box downscale and explicitly rejects upscaling. The implementation is correct; the card describes something the design forbids | Card title matches `13` §3.1 | P2 |
| **§12-e** | **Card of record for the Signal Tower key art.** The Board Assets database carries an **UNTRACKED** row — 7 assets, no card. Under `13` §6.8 key art is committed and versioned but is **not** a pipeline input and carries no provenance hash. Without a card it will drift into being used as conditioning | Key art has a card, lives in `assets/src/keyart/`, and is excluded from conditioning inputs | P2 |

### 12.3 Note on asset counts

The Board Assets database shows 1-asset folders for T-0070, T-0080, T-0081. **That is correct, not a failure** — those are install/baseline cards whose only deliverable is a baseline doc. T-0073 at 2 assets looked thin but is explained: the chain shipped one tile plus its provenance, and the tile is real.

**The gap is not missing files, it is untested breadth.** One wall tile proves the chain runs. §12-c proves it produces a *tileset*.
