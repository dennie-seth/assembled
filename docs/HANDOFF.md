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
| `01-vision.md` | v6, locked | premise, pillars, loop, progression, completion, runs/death/collapse, world structure, presentation, non-goals |
| `02-notes-system.md` | v3, locked | vocabulary, grammar, anchoring, truth, tiers, petition, rating, density |
| `05-art-direction.md` | v2, locked | Soviet constructivism/brutalism, palette family, tile size, asset strategy |
| `07-items-economy.md` | v5, locked | instances, rarity=quantity, transfers, topology, bleed, workbench, escrow |
| `08-invariants.md` | v3, locked | INV-1…14, simulation scope |
| `09-identity.md` | v2, locked | seed phrase, session lease, sockpuppets |
| `10-time-and-progression.md` | v2, locked | the four wall-clocks, unlock tiers, endgame |
| `11-moment-to-moment.md` | v2, locked | sensor kit, hiding, trap/lock, room vocabulary, puzzles |
| `12-tears.md` | v1, locked | the core-loop verb — tear as anchor tag, crossing, traces |
| `13-asset-pipeline.md` | v2, locked | **art + audio generation pipeline**, validation gate, P-1…P-5 |
| `03-net-protocol.md` | **wrong in repo** | delete and rewrite — see §4/§5 |
| `04-data-model.md` | **wrong in repo** | delete and rewrite — see §4/§5 |
| `06-audio.md` | **superseded** | pipeline half is `13` §4. Only track/SFX counts would remain; may not be needed |

`GDD-QUESTIONS.md` is superseded for Tiers 1–6 and archived. Tier 7 (risks) is partly answered in `GDD-OPEN.md` §5.

**The repo's `03` and `04` are not merely stale — they describe cut systems.** `03` specifies `GET /v1/roll`; `04` has `secret_drops`, `drop_grants`, and `zone_id`. Secret drops were cut (`PLAN.md` v3) and coordinates were replaced by anchor tags. Delete, do not edit.

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
| D-16 | **Tiles are 16px**; rooms authored on a 24×14 grid (384×224) with an 8px non-gameplay band. Viewport is fixed and letterboxed — never widened, because extra sightline is a competitive advantage. | `05` §5, `13` §3.3 |
| D-17 | **Assets ship as indexed PNGs + a separate 1D palette LUT.** Index `N` means palette slot `N` in *every* asset (**P-4**). The chroma swap is a LUT substitution, so non-uniform index semantics corrupt it silently. Build-time check. | `13` §3.0 |
| D-18 | **Generated output ships as-is — no hand editing (P-1).** Rejection means regenerate with an adjusted recipe. Hand-edited files are unregenerable from seed and would break provenance and the gitignore policy. | `13` §1 |
| D-19 | **Atlases are build artifacts, not committed.** Per-archetype atlases would be written by two different `art/*` branches, violating the strictly-additive rule. Commit individual sprites; pack in CI, deterministically. | `13` §3.6 |
| D-20 | **Gameplay SFX are never ducked (P-5).** Music ducks ambience only. Entity telegraph is the sole warning for no-LOS entities, so masking it is a fairness bug. Requires a four-bus split. | `13` §4.1, `11` §1 |

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
| **T-0072** | style LoRA: curate 30–50 refs | **unblocked** — direction is locked, and the LoRA stays palette-agnostic so it does **not** wait on V-5 (`13` §3.2). Corpus = abandoned Soviet constructivism/brutalism |
| **T-0073** | post-process chain incl. palette quantize | **blocked on V-5** (palette hex set) for the quantizer only. Box downscale, cutout, and cleanup are fine to build. Quantize in Oklab/CIELAB, **dithering off** — dithering breaks index semantics (D-17) |
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
| **T-0101** | 7 | **Deterministic one-shot synthesis script** (`assets/src/`). Seeded numpy/scipy renders footsteps, switches, doors, pickups offline to WAV. Physically-inspired (noise burst → resonant filter → envelope), *not* sfxr chiptune | same seed → byte-identical WAV |
| **T-0102** | 3 | **Asset validation gate** (`13` §2, §4.8). Palette membership, index semantics (P-4), tile seamlessness, transition adjacency, cell fit, orphan pixels, frame-silhouette delta; audio loop seam, LUFS, true peak, DC offset | **write these before the generation chain** — they turn generation into red→green |
| **T-0103** | 5 | **Audio bus split** (D-20): Ambience (duckable), Music, World SFX (lightly duckable), Gameplay SFX (priority, never ducked) | ducking music never attenuates the gameplay bus |

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
| **T-1** | Exact collapse duration within ~2–4 weeks (~1.5× first universe) | sim tuning, V-10 |
| **T-2** | Exact unique-unlock decay within ~1 week | sim tuning |
| **V-5** | Home palette: colour count + hex values | T-0073, all of Phase 6 output |
| **E-1** | Exact held/world bleed durations within the stated ranges | sim finds these |

T-1 and T-2 block the *tuning sweep*, not the harness — and now have starting brackets to sweep within. Build T-0099 regardless. **E-7 (spawn model) is resolved** — ambient Poisson process per `(archetype_id, anchor_tag, tier)`; uniques are a one-time seed, never respawned. See `07-items-economy.md` §2/§4.

---

## 7. Suggested Order

1. **T-0090, T-0091** — write the two missing design docs. Cheap, and Phase 4 depends on both.
2. **T-0092** — tag validation. Structural, and it wants to exist before variants do.
3. **T-0099** — sim harness. Parallelisable, unblocked, and it may surface a design problem while changes are still free.
4. **Phase 4** with the revised schema — T-0093/94 (identity, sessions) before items, since items depend on identity.
5. **T-0096 before any item handler.** It is the smallest meaningful test of the whole economy and it should fail before it passes.
6. **T-0102 before any generation work.** The validation gate is the whole quality mechanism under D-18 — there is no manual repair step, so the tests are what make "ships as-is" viable.
7. **Phase 6 setup** — T-0070/71/72 are unblocked (T-0072 no longer waits on V-5). Only the quantizer inside T-0073 is blocked.
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
