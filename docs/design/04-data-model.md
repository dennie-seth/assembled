# 04 — Data Model

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, draft
> Related: `03-net-protocol.md`, `HANDOFF.md` §5 (superseded sketch), `08-invariants.md`, `07-items-economy.md`
> **Purpose:** the Postgres schema. Replaces the repo's `04-data-model.md`, which carries cut systems. Task **T-0090**.

---

## 1. Conventions

- Plain SQL migrations + a version table. **No ORM** (`PLAN.md` Phase 4).
- `UUID` v4 for identity, items, offerings, runs, receipts. `SMALLINT` for catalogue references — they are small, fixed, and shared with the client via `shared/`.
- All timestamps `TIMESTAMPTZ`. Every clock in this game is wall-clock (`10-time-and-progression.md`).
- **Invariants are DB constraints wherever expressible.** An invariant enforced by application logic is one a handler bug can violate.

---

## 2. Catalogue

Immutable, seeded from `shared/` headers so client and server cannot disagree (T-0043).

```sql
archetype(id SMALLINT PRIMARY KEY);

anchor_tag(
  archetype_id SMALLINT REFERENCES archetype,
  tag          SMALLINT,
  PRIMARY KEY (archetype_id, tag)
);

variant(
  id                SMALLINT PRIMARY KEY,
  archetype_id      SMALLINT NOT NULL REFERENCES archetype,
  unlock_population INT NOT NULL DEFAULT 0     -- V-9 release threshold
);

item_type(
  id     SMALLINT PRIMARY KEY,
  rarity SMALLINT NOT NULL      -- 0 common | 1 rare | 2 unique
);

note_templates(id SMALLINT PRIMARY KEY, slots SMALLINT NOT NULL);
note_words(id SMALLINT PRIMARY KEY, category SMALLINT NOT NULL);
```

> **`rarity` lives on the type, not the instance.** `HANDOFF.md` §5 placed it on `item_instance`, which would allow two instances of one type to disagree about their own rarity. Meaningless, and it would surface as an unexplained INV-6 violation. Rarity is a property of the kind of thing, so it belongs here.

---

## 3. Identity & Sessions

```sql
identity(
  token               UUID PRIMARY KEY,        -- derived; phrase NEVER stored
  collapse_expires_at TIMESTAMPTZ NOT NULL,    -- per-identity (D-3)
  first_universe      BOOLEAN NOT NULL DEFAULT true,  -- ~1.5x grace (09-identity.md 3a)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

session_lease(
  token      UUID PRIMARY KEY REFERENCES identity,
  lease_id   UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
```

`session_lease` keyed on `token` **is** INV-11 — one row per identity makes a second concurrent session unrepresentable rather than merely rejected.

---

## 4. Items

```sql
item_instance(
  id             UUID PRIMARY KEY,
  type_id        SMALLINT NOT NULL REFERENCES item_type,
  origin_palette SMALLINT NOT NULL,
  shard_id       SMALLINT NOT NULL,            -- 15-server-ops.md 3
  holder         UUID NULL REFERENCES identity,
  hosted_by      UUID NULL REFERENCES identity, -- whose universe holds it
  anchor_arch    SMALLINT NULL,
  anchor_tag     SMALLINT NULL,
  custody_depth  INT NOT NULL DEFAULT 0,
  version        INT NOT NULL DEFAULT 0,       -- CAS guard (INV-2)
  bleed_at       TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (num_nonnulls(holder, hosted_by) = 1),            -- INV-1
  CHECK ((hosted_by IS NULL) = (anchor_arch IS NULL)),
  CHECK ((anchor_arch IS NULL) = (anchor_tag IS NULL)),
  FOREIGN KEY (anchor_arch, anchor_tag) REFERENCES anchor_tag
);
```

**An anchored instance lives in exactly one universe.** `hosted_by` names whose. The anchor pair says *where in that universe*, not a global address — so no two players can ever contend for the same loose item, and the room-load query filters on `hosted_by` first.

**On bleed, the sweep chooses a recipient** and sets `hosted_by`. Under over-supply it chooses none and deletes the row — that deletion is the `unlanded` count in `economy_ledger`, and it is what `07-items-economy.md` §4 meant by "the collapse ate it." Uniques always receive a recipient and are never dropped. **Recipient selection is DM-5** and belongs in the sim: it directly shapes INV-8.

**The first `CHECK` is INV-1 made structural.** An instance held by nobody and hosted nowhere, or both at once, cannot exist — no handler bug can produce it.

### Transfer receipts

```sql
transfer_receipt(
  transfer_id   UUID PRIMARY KEY,              -- CLIENT-generated (03-net-protocol.md 4)
  token         UUID NOT NULL REFERENCES identity,
  item_instance UUID NOT NULL,
  kind          SMALLINT NOT NULL,             -- leave|use|take|transmute|claim
  outcome       SMALLINT NOT NULL,             -- 0 won | 1 lost
  reason        SMALLINT NULL,                 -- error enum when lost
  custody_depth INT NULL,
  bleed_at      TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Primary key on the client-minted ID is the whole idempotency mechanism: a retry collides and returns the stored row instead of re-running the CAS. **Retention 72h**, swept (§7).

### Escrow

```sql
offering(
  id            UUID PRIMARY KEY,
  item_instance UUID NOT NULL UNIQUE REFERENCES item_instance,
  wants_type    SMALLINT NOT NULL REFERENCES item_type,
  anchor_arch   SMALLINT NOT NULL,
  anchor_tag    SMALLINT NOT NULL,
  author        UUID NOT NULL REFERENCES identity,
  expires_at    TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (anchor_arch, anchor_tag) REFERENCES anchor_tag
);
```

`UNIQUE` on `item_instance` stops one item backing two offerings.

**Offerings do not carry `hosted_by`** — they are globally visible, which makes escrow the only genuine contention point in the schema. A claim takes `SELECT ... FOR UPDATE` on the offering row inside the single claim transaction: success commits, failure rolls back. No lock column, no reservation lease, no stale-lock sweep — all three would be required if claiming ever became a multi-step handshake.

---

## 5. Notes

```sql
notes(
  id           UUID PRIMARY KEY,                -- not BIGSERIAL: shards mint colliding IDs (15-server-ops.md 3)
  archetype_id SMALLINT NULL,
  anchor_tag   SMALLINT NULL,
  is_broadcast BOOLEAN NOT NULL DEFAULT false,  -- petitions have no anchor
  facing       SMALLINT NULL,
  item_ref     SMALLINT NULL REFERENCES item_type,
  template_id  SMALLINT NOT NULL REFERENCES note_templates,
  slot_a       SMALLINT NULL REFERENCES note_words,
  slot_b       SMALLINT NULL REFERENCES note_words,
  author       UUID NOT NULL REFERENCES identity,
  score        INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (is_broadcast = (archetype_id IS NULL))
);

ratings(
  note_id UUID REFERENCES notes,
  voter   UUID REFERENCES identity,
  val     SMALLINT NOT NULL CHECK (val IN (-1, 1)),
  PRIMARY KEY (note_id, voter)
);
```

The FKs on `template_id` and `slot_*` are the **no-UGC guarantee** — arbitrary text is unrepresentable, not merely rejected (`02-notes-system.md` §1). The `CHECK` ties broadcast and anchorless together so a petition cannot accidentally acquire a location.

---

## 6. Progression

```sql
unlock(
  token      UUID REFERENCES identity,
  variant_id SMALLINT REFERENCES variant,
  tag        SMALLINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,             -- tiered decay (10-time-and-progression.md 3)
  PRIMARY KEY (token, variant_id, tag)
);

vocabulary(
  token   UUID REFERENCES identity,
  word_id SMALLINT REFERENCES note_words,
  PRIMARY KEY (token, word_id)                 -- never expires
);

run(
  id         UUID PRIMARY KEY,
  token      UUID NOT NULL REFERENCES identity,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ NULL,
  end_reason SMALLINT NULL                     -- death | quit | lease expiry
);

run_variant(
  run_id     UUID REFERENCES run,
  variant_id SMALLINT REFERENCES variant,
  PRIMARY KEY (run_id, variant_id)
);

archetype_seen(
  token        UUID REFERENCES identity,
  archetype_id SMALLINT REFERENCES archetype,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (token, archetype_id)
);
```

> **`archetype_seen` replaces the `run_archetypes` join.** Proof-of-play (`02-notes-system.md` §7) is checked on *every rating*. Resolving it through `run` would mean a join per vote; as an upserted set it is a single primary-key lookup. `run_variant` keeps the per-run record for debugging and analytics, but it is not on the hot path.

---

## 7. The Sweep Worker

A background worker, not lazy evaluation. **The world changes whether or not anyone is looking**, which is what the fiction claims and what INV-10 requires.

| Job | Cadence | Does |
|---|---|---|
| **Bleed** | ~1 min | Expired instances: roll landing probability; survivors re-anchor with `custody_depth + 1` and a fresh `bleed_at`; the rest are deleted |
| **Spawn** | ~1 min | Poisson per `(archetype, tag, tier)`, clamped between floor and cap (E-7) |
| **Collapse** | hourly | Expired identities: unlocks dropped, held items scattered, `first_universe` cleared |
| **Retention** | hourly | Receipts older than 72h; decayed notes (`02-notes-system.md` §8) |
| **Census** | ~1 min | Refresh `type_census` for INV-6/INV-7 monitoring |

```sql
type_census(
  type_id    SMALLINT PRIMARY KEY REFERENCES item_type,
  live_count INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

economy_ledger(                                -- INV-3 audit trail
  at             TIMESTAMPTZ NOT NULL,
  spawned        INT NOT NULL,
  unlanded       INT NOT NULL,
  transmute_sink INT NOT NULL
);
```

> **`economy_ledger` is what makes INV-3 checkable in production.** Conservation says `Δ total = spawns − unlanded_bleeds`. Only the sweep knows what failed to land — if it does not record that, the invariant is stated but unverifiable, and a slow leak would be invisible until completion rates fell.

**Concurrency:** every sweep job takes a Postgres advisory lock and selects `FOR UPDATE SKIP LOCKED`. Two server instances must never double-process a bleed — that would duplicate an item and violate INV-2 from the inside, where CAS cannot see it.

**Uniques are exempt from the landing roll** and always re-anchor (`07-items-economy.md` §4).

---

## 8. Indexes

```sql
CREATE INDEX ON notes (archetype_id, anchor_tag, score DESC);
CREATE INDEX ON notes (created_at) WHERE score <= 0;         -- decay sweep
CREATE INDEX ON item_instance (hosted_by, anchor_arch, anchor_tag) WHERE holder IS NULL;
CREATE INDEX ON item_instance (holder) WHERE holder IS NOT NULL;
CREATE INDEX ON item_instance (bleed_at);                    -- sweep
CREATE INDEX ON item_instance (type_id);                     -- census
CREATE INDEX ON offering (anchor_arch, anchor_tag);
CREATE INDEX ON identity (collapse_expires_at);              -- sweep
CREATE INDEX ON transfer_receipt (created_at);               -- retention
```

**No GiST. No geometry. No radius query** — the world is discrete (D-1).

---

## 9. Migrations

Sequential numbered SQL, applied in order, recorded in a version table.

**Before launch:** downtime migrations are acceptable. Drop and recreate freely; there is nothing irreplaceable in the database.

**After launch: expand/contract, strictly.** Add a column, backfill, switch reads, then drop in a later migration — never in one step.

> The reason is sharper here than in most projects. **Items are irreplaceable by construction.** Uniques are seeded once and never regenerated (`07-items-economy.md` §2); a botched migration that loses them cannot be repaired by respawning, because respawning them is precisely what the design forbids. There is also no account system to appeal to — a lost `identity` row is a lost player, permanently (`09-identity.md` §1).

This is the same fact behind **server backup policy**, now specified in `15-server-ops.md` §5 — including the post-restore assertion that every seeded unique exists exactly once, and the append-only unique custody log (§9) that makes it a query rather than a guess.

---

## 10. Open

| # | Question | Blocks |
|---|---|---|
| **DM-1** | Sweep cadence under load — is 1 min viable at P=10⁴, or does bleed need batching/partitioning? | scale |
| **DM-2** | Does `economy_ledger` roll up, or retain forever? | ops |
| **DM-3** | Landing-probability roll lives in the worker — same code path as the sim's (T-0099)? Sharing it would keep them honest | T-0099 |
| **DM-4** | Backup/restore policy and RPO | **resolved — 15-server-ops.md §5** |
| **DM-5** | Recipient selection on bleed — uniform over active identities, weighted toward players who have seen that archetype, or biased by time since last delivery? | **sim (T-0099)**, shapes INV-8 |

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | Initial — full schema; rarity moved to `item_type`; `archetype_seen` replaces the proof-of-play join; sweep worker + `economy_ledger` for INV-3 audit; expand/contract after launch | Claude, rev. pending |
| 2026-08-02 | v2: hosting model folded into §4/§5/§8 — `hosted_by`  • `shard_id` on `item_instance`, INV-1 restated, `notes.id` becomes UUID (shard collision), index now leads on `hosted_by`. DM-4 resolved by `15-server-ops.md` §5; **DM-5** added (recipient selection on bleed) | Claude, rev. pending |
