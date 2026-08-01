# HANDOFF — GDD → Development

> **Project:** **Assembled**
> **Author:** Claude (Opus 5) · **For:** dispatch session / local Claude Code · **Date:** 2026-08-01
> **Purpose:** reconcile `PLAN.md` (written pre-GDD) with the design docs (written during GDD). PLAN.md v2 predates every design decision below and has real drift. **Read this before touching Phase 3+.**

---

## 0. How To Use This

1. Apply §3 (revised tasks) and §4 (new tasks) to `tasks/`.
2. Apply §5 (schema delta) before any Phase 4 work.
3. Do **not** start anything in §6 (blocked) — those need @DennieSeth.
4. Phases 0–2 are unaffected. Nothing below invalidates work already done.

**Docs are the source of truth. This file is a diff, not a spec.** Where they disagree, the design docs win.

---

## 1. Document Index

| File | Status | Covers |
|---|---|---|
| `01-vision.md` | v3, locked | premise, pillars, loop, progression, completion, runs/death/collapse, world structure, presentation, non-goals |
| `02-notes-system.md` | v2, locked | vocabulary, grammar, anchoring, truth, tiers, petition, rating, density |
| `05-art-direction.md` | v1, locked | Soviet constructivism/brutalism, palette, asset strategy |
| `07-items-economy.md` | v3, locked | instances, rarity=quantity, transfers, topology, bleed, workbench, escrow |
| `08-invariants.md` | v3, locked | INV-1…14, simulation scope |
| `09-identity.md` | v1, locked | seed phrase, session lease, sockpuppets |
| `10-time-and-progression.md` | v1, locked | the four wall-clocks, unlock tiers, endgame |
| `03-net-protocol.md` | **missing** | needs writing — see §4 |
| `04-data-model.md` | **missing** | needs writing — see §5 |
| `06-audio.md` | **missing** | Phase 7, not urgent |

`GDD-QUESTIONS.md` is superseded for Tiers 1–6. Tier 7 (risks) is still partly unanswered.

---

## 2. Decisions That Change The Plan

Condensed. Full reasoning is in the docs.

| # | Decision | Doc |
|---|---|---|
| D-1 | World is **discrete**. Notes/items bind to `(archetype_id, anchor_tag)`, never coordinates. **No geometry, no GiST, no radius query.** | `01` §7 |
| D-2 | Three world levels: **archetype → variant → room.** 12–15 archetypes, 1+ variants each, ~15 rooms visited per run. | `01` §7 |
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

---

## 3. Revised Tasks

| Task | Was | Now |
|---|---|---|
| **T-0001b** | image LFS patterns deferred pending art direction | **Unblocked. Pixel art → plain git, no LFS for images.** LFS stays audio-only (`assets/final/audio/**`). Close this. |
| **T-0033** | windows client build | add a **Linux export job** (D-14) |
| **T-0043** | `shared/note_templates.hpp` + SQL seed | also seed **archetype + anchor-tag tables**; tags are contractual and shared client/server |
| **T-0044** | `NoteRepo` CRUD + **radius query** | **radius query deleted.** Lookup is equality on `(archetype_id, anchor_tag)` (D-1) |
| **T-0046** | `GET /v1/notes` radius+ranking | **tag equality + ranking.** Much smaller. Drop the GiST index entirely |
| **T-0066** | anon token: generate, persist, never PII | **seed-phrase derivation** (D-5). Server generates phrase → derives token → discards phrase. Client persists phrase to file |
| **T-0067** | "game fully playable with server down" | **"fully *runnable* offline, not completable"** (D-15). Explore/survive/progress work; the ending is unreachable |
| **T-0072** | style LoRA: curate 30–50 refs | **unblocked** — direction is locked. Corpus = abandoned Soviet constructivism/brutalism |
| **T-0073** | post-process chain incl. palette quantize | **blocked on V-5** (palette hex set). Cutout + upscale steps are fine to build |

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
| **T-0090** | 0 | Write `docs/design/04-data-model.md` from §5 below | — |
| **T-0091** | 0 | Write `docs/design/03-net-protocol.md` — endpoints for notes, items, escrow, session lease, petition | — |
| **T-0092** | 3 | **Build-time anchor-tag validation** (INV-12). Every variant implements every tag its archetype declares. Missing tag = build failure | missing tag rejected, extra tag warns |
| **T-0093** | 4 | Session lease: heartbeat, TTL, evict-on-takeover (INV-11) | expiry reclaims, takeover evicts, crash recovery |
| **T-0094** | 4 | Seed-phrase generation + token derivation; phrase never stored | derivation determinism, phrase absent from DB, rate limit |
| **T-0095** | 4 | `ItemRepo`: custody transfer as **compare-and-swap on `version`** (INV-2) | concurrent transfer — exactly one wins |
| **T-0096** | 4 | **Two-player economy integration test** (INV-1/2/3). A leaves X → B takes X → assert single custody, no dupe, conserved count | this *is* the test |
| **T-0097** | 4 | Escrow: atomic pay-and-release (INV-4) | no partial state, both-hold impossible |
| **T-0098** | 4 | Proof-of-play gate on rating (D-12) | rating without archetype in run → 403 |
| **T-0099** | — | **Economy simulation harness** (`08` §4). Standalone, no engine, no server. Agents join/play/idle/quit; items spawn/bleed/transfer/scatter; four clocks modelled | assertions ARE INV-6…9, INV-14 |
| **T-0100** | — | Name-collision check: "Assembled" on Steam + itch. 5 min | — |

**T-0099 is the important one.** Build the harness now — its parameters are blocked (§6) but its structure is not. Its assertions are the same predicates as T-0096's, which is the point: one definition, three consumers.

---

## 5. Schema Delta (Phase 4)

PLAN.md's data model is notes-only. Additions required. Treat as a sketch for T-0090, not final DDL.

```sql
-- IDENTITY -------------------------------------------------------------
identity(
  token             UUID PK,          -- derived from phrase; phrase NEVER stored
  collapse_expires_at TIMESTAMPTZ NOT NULL,   -- per-identity, wall-clock (D-3)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

session_lease(
  token      UUID PK REFERENCES identity,
  lease_id   UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL     -- short TTL, heartbeat-renewed (INV-11)
);

-- WORLD ----------------------------------------------------------------
archetype(id SMALLINT PK);
anchor_tag(archetype_id SMALLINT, tag SMALLINT, PRIMARY KEY(archetype_id, tag));
variant(id SMALLINT PK, archetype_id SMALLINT REFERENCES archetype,
        unlock_population INT);       -- V-9 release threshold

-- ITEMS ----------------------------------------------------------------
item_instance(
  id             UUID PK,
  type_id        SMALLINT NOT NULL,
  rarity         SMALLINT NOT NULL,   -- common | rare | unique
  origin_palette SMALLINT NOT NULL,
  holder         UUID NULL REFERENCES identity,
  anchor_arch    SMALLINT NULL,
  anchor_tag     SMALLINT NULL,
  custody_depth  INT NOT NULL DEFAULT 0,
  version        INT NOT NULL DEFAULT 0,   -- CAS guard (INV-2)
  bleed_at       TIMESTAMPTZ NOT NULL,     -- held 60-90min | world 48-72h
  CHECK (num_nonnulls(holder, anchor_arch) = 1)   -- INV-1, enforced by DB
);

offering(                              -- escrow
  id            UUID PK,
  item_instance UUID NOT NULL UNIQUE REFERENCES item_instance,
  wants_type    SMALLINT NOT NULL,
  anchor_arch   SMALLINT NOT NULL,
  anchor_tag    SMALLINT NOT NULL,
  author        UUID NOT NULL REFERENCES identity,
  expires_at    TIMESTAMPTZ NOT NULL
);

-- PROGRESSION ----------------------------------------------------------
unlock(
  token      UUID REFERENCES identity,
  variant_id SMALLINT REFERENCES variant,
  tag        SMALLINT,
  expires_at TIMESTAMPTZ NOT NULL,     -- tiered decay (D-10)
  PRIMARY KEY(token, variant_id, tag)
);

vocabulary(token UUID, word_id SMALLINT, PRIMARY KEY(token, word_id));  -- never expires

run_archetypes(run_id UUID, archetype_id SMALLINT);  -- proof-of-play source (D-12)
```

**Changes to the existing `notes` table:**
- Drop `zone_id`, `pos_x`, `pos_y`.
- Add `archetype_id SMALLINT`, `anchor_tag SMALLINT`, optional `facing`, optional `item_ref`.
- Drop `CREATE INDEX ... USING gist`. Replace with `(archetype_id, anchor_tag, score DESC)`.
- Add `is_broadcast BOOLEAN` for petitions (`02` §6) — broadcasts have no anchor.

**The `CHECK` on `item_instance` is worth noticing.** INV-1 (single custody) is enforceable as a database constraint rather than application logic, which means it cannot be violated by a bug in a handler. Do this.

---

## 6. Blocked — needs @DennieSeth

Nothing in §3–5 is blocked on these. **Do not guess at them.**

| # | Question | Blocks |
|---|---|---|
| **T-1** | Collapse duration. Fixed weeks? Varies with anything? | sim tuning, V-10 |
| **T-2** | Unique-unlock decay duration — sets the endgame window | sim tuning |
| **E-7** | Spawn model: Poisson per tag per tier, or tear-driven seeding? | sim parameterisation |
| **V-5** | Home palette: colour count + hex values | T-0073, all of Phase 6 output |
| **E-1** | Exact held/world bleed durations within the stated ranges | sim finds these |

T-1, T-2 and E-7 block the *tuning sweep*, not the harness. Build T-0099 regardless.

---

## 7. Suggested Order

1. **T-0090, T-0091** — write the two missing design docs. Cheap, and Phase 4 depends on both.
2. **T-0092** — tag validation. Structural, and it wants to exist before variants do.
3. **T-0099** — sim harness. Parallelisable, unblocked, and it may surface a design problem while changes are still free.
4. **Phase 4** with the revised schema — T-0093/94 (identity, sessions) before items, since items depend on identity.
5. **T-0096 before any item handler.** It is the smallest meaningful test of the whole economy and it should fail before it passes.
6. **Phase 6 setup** — T-0070/71/72 are unblocked. Stop at T-0073 pending V-5.

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
