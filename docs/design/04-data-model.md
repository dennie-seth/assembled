# 04 — Data Model

> **Author:** Claude (Opus 5)
> **Status:** v1, drafted (T-0090) from `docs/HANDOFF.md` §5, cross-checked against `07-items-economy.md`
> Related: `08-invariants.md`, `09-identity.md`, `02-notes-system.md`, `07-items-economy.md`, `10-time-and-progression.md`

Postgres schema (Phase 4, `server/`), plain SQL migrations, no ORM. This
supersedes the Phase-0 stub seeded from `PLAN.md` — that version was
notes-only and predates the GDD. **This doc is a design sketch for the
migrations, not final DDL** — column types and constraints may tighten
during T-0042 implementation, but the entities, relationships, and the
`CHECK` constraints called out below are load-bearing and must not be
dropped.

---

## 1. Identity

```sql
identity(
  token               UUID PRIMARY KEY,   -- derived from seed phrase; phrase NEVER stored
  collapse_expires_at TIMESTAMPTZ NOT NULL,   -- per-identity wall-clock (09-identity.md §3a)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The server stores the derived token only — the seed phrase itself is
generated, used to derive `token`, and discarded (`09-identity.md` §1). A
database dump must not compromise every identity at once.

`collapse_expires_at` is set once at creation and **never extended by
ratings** (`02-notes-system.md` §7, `10-time-and-progression.md` §5). This
is the universe's death clock — it belongs to the identity, not to any run.

```sql
session_lease(
  token      UUID PRIMARY KEY REFERENCES identity,
  lease_id   UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL     -- short TTL, heartbeat-renewed
);
```

**INV-11** (at most one live session per identity) is enforced here, not by
client honesty. A boolean "logged in" flag would lock a crashed client out
until manual intervention; the lease expires on its own and a new session
simply evicts the old one (`09-identity.md` §3). Acquiring a lease means
writing a fresh `lease_id` and `expires_at` — the previous lease holder's
next heartbeat fails, telling that client its universe continued elsewhere.

---

## 2. World

```sql
archetype(id SMALLINT PRIMARY KEY);

anchor_tag(
  archetype_id SMALLINT NOT NULL REFERENCES archetype,
  tag          SMALLINT NOT NULL,
  PRIMARY KEY (archetype_id, tag)
);

variant(
  id                 SMALLINT PRIMARY KEY,
  archetype_id       SMALLINT NOT NULL REFERENCES archetype,
  unlock_population  INT NOT NULL   -- population threshold that releases this variant
);
```

World structure is **archetype → variant → room** (`01-vision.md` §7). An
archetype is a kind of place (e.g. "Hospital"); a variant is one authored
instance of it; a room is inside a variant and isn't modeled here — rooms
are content, not schema.

`anchor_tag` is the contract between archetypes and their variants: every
tag an archetype declares must be implemented by every one of its variants.
This is **INV-12**, enforced at build time (T-0092), not by this schema —
the FK here only guarantees a tag references a real archetype, not that
every variant honors it.

`variant.unlock_population` is the population-gated release threshold
(open question **V-9**, `01-vision.md` §11) — more variants unlock as `P`
grows, which is how "more rooms" scales without inflating a single run's
length (`08-invariants.md` INV-9, O-2).

---

## 3. Items

```sql
item_instance(
  id             UUID PRIMARY KEY,
  type_id        SMALLINT NOT NULL,
  rarity         SMALLINT NOT NULL,   -- common | rare | unique
  origin_palette SMALLINT NOT NULL,
  holder         UUID NULL REFERENCES identity,
  anchor_arch    SMALLINT NULL REFERENCES archetype,
  anchor_tag     SMALLINT NULL,
  custody_depth  INT NOT NULL DEFAULT 0,
  version        INT NOT NULL DEFAULT 0,
  bleed_at       TIMESTAMPTZ NOT NULL,   -- held 60-90min | world 48-72h (10-time-and-progression.md §2)

  CHECK (num_nonnulls(holder, anchor_arch) = 1),
  FOREIGN KEY (anchor_arch, anchor_tag) REFERENCES anchor_tag (archetype_id, tag)
);
```

Two constraints here are load-bearing, not incidental:

- **`CHECK (num_nonnulls(holder, anchor_arch) = 1)` is INV-1 (single
  custody) enforced by the database, not application logic.** Every
  instance is in exactly one of `{holder, world_anchor, escrow}` — this
  row can never represent "held by nobody and anchored nowhere" or "held
  *and* anchored" simultaneously. A bug in a handler cannot violate this;
  the database rejects the write. See `08-invariants.md` §1.
- **`version` is the CAS guard for INV-2** (no duplication). Every custody
  transfer is `UPDATE ... SET holder = $new, version = version + 1 WHERE
  id = $id AND version = $expected`. A losing concurrent writer affects
  zero rows and must retry or fail — it never merges. This is what
  `ItemRepo` (T-0095) wraps, and what the two-player integration test
  (T-0096) exercises directly.
- **Escrow is not a third state on this row.** Per §4 below, escrow is
  modeled as a separate `offering` row that references an
  `item_instance` still (nominally) anchored or held; the atomicity of
  "in escrow" is a transactional property (INV-4), not a column value.
  This matches `07-items-economy.md` §7 exactly: escrow is "ships in v1"
  and is deliberately the only exchange mechanism — the deferred v2
  "plea" object is out of scope for this schema.

`custody_depth` increases strictly on every transfer (INV-5) — never
decremented, never reset. It's a monotonic counter, not a stack depth; it
exists to detect stuck or looping custody chains during simulation and
monitoring.

`bleed_at` is the wall-clock deadline for this instance's current custody
state: **held bleed** (60–90 min, ≈2× run length) while `holder IS NOT
NULL`, **world/escrow bleed** (48–72 h) while anchored or in escrow — the
two-timer split is deliberate, not an oversight: at 90 minutes escrow
would be unusable, since exchange is a multi-session social process while
held bleed is anti-hoarding pressure within a session
(`07-items-economy.md` §5, `10-time-and-progression.md` §2). Both exact
values within their ranges are open pending **E-1**
(`docs/design/OPEN-QUESTIONS.md`) — the simulation harness (T-0099) finds
the precise numbers. INV-10 (bleed termination) requires that no instance
sits past `bleed_at` without a transfer attempt being made. A well-rated
note slows its author's held bleed only, never the collapse clock
(`10-time-and-progression.md` §5).

```sql
offering(   -- escrow
  id            UUID PRIMARY KEY,
  item_instance UUID NOT NULL UNIQUE REFERENCES item_instance,
  wants_type    SMALLINT NOT NULL,
  anchor_arch   SMALLINT NOT NULL REFERENCES archetype,
  anchor_tag    SMALLINT NOT NULL,
  author        UUID NOT NULL REFERENCES identity,
  expires_at    TIMESTAMPTZ NOT NULL,

  FOREIGN KEY (anchor_arch, anchor_tag) REFERENCES anchor_tag (archetype_id, tag)
);
```

An offering is a standing trade: "I've placed item X at `(anchor_arch,
anchor_tag)`; I want `wants_type` in return." The `UNIQUE` on
`item_instance` guarantees one instance is offered at most once at a time.
**INV-4 (escrow atomicity)** requires that matching an offering — releasing
the offered item to the taker and releasing the taker's payment to the
author — happens in one transaction; there must be no observable
intermediate state where both parties hold their own item, or neither does
(T-0097). `expires_at` is set from the same 48–72 h world/escrow bleed
range as any other anchored instance — **unclaimed offerings bleed away on
the standard timer, not a special one** (`07-items-economy.md` §5, §7).
The workbench/transmuter (`07-items-economy.md` §6, two instances in, one
out, net −1) needs no schema of its own beyond `item_instance` itself — it
consumes two existing rows and inserts one new one in a single
transaction, with no intermediate table.

---

## 4. Progression

```sql
unlock(
  token      UUID NOT NULL REFERENCES identity,
  variant_id SMALLINT NOT NULL REFERENCES variant,
  tag        SMALLINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,   -- tiered decay, 10-time-and-progression.md §3
  PRIMARY KEY (token, variant_id, tag)
);

vocabulary(
  token   UUID NOT NULL REFERENCES identity,
  word_id SMALLINT NOT NULL,
  PRIMARY KEY (token, word_id)
);   -- never expires

run_archetypes(
  run_id       UUID NOT NULL,
  archetype_id SMALLINT NOT NULL REFERENCES archetype,
  PRIMARY KEY (run_id, archetype_id)
);
```

`unlock` is per-`(variant_id, tag)` and decays — this is the *access* axis,
scoped to the current universe (dies with it, per `09-identity.md` §3a).
`vocabulary` is the one thing that **never expires**: composition tiers
persist across runs and across universe collapse (`02-notes-system.md`
§5). This asymmetry is deliberate — see `09-identity.md` §3a for why losing
a seed phrase and letting a universe collapse are different kinds of loss.

`run_archetypes` records which archetypes a given run actually visited.
This is the **proof-of-play source** for rating (D-12, T-0098): a player
may only rate notes anchored to an archetype their own
`run_archetypes` row confirms they played. Server-verifiable, costs one
join, adds no friction for legitimate players (`09-identity.md` §4).

---

## 5. Notes

Revises the Phase-0 stub. The coordinate-space columns are gone entirely —
this is not a narrowing of an existing query, it's a different addressing
scheme.

```sql
note_templates(id SMALLINT PRIMARY KEY, slots SMALLINT);   -- e.g. "Try {0} ahead"
note_words(id SMALLINT PRIMARY KEY, category SMALLINT);

notes(
  id           BIGSERIAL PRIMARY KEY,
  archetype_id SMALLINT NOT NULL REFERENCES archetype,
  anchor_tag   SMALLINT NOT NULL,
  is_broadcast BOOLEAN NOT NULL DEFAULT false,   -- petitions: no anchor, surfaces widely
  facing       SMALLINT NULL,
  item_ref     UUID NULL REFERENCES item_instance,
  template_id  SMALLINT NOT NULL REFERENCES note_templates,
  slot_a       SMALLINT REFERENCES note_words,
  slot_b       SMALLINT REFERENCES note_words,
  author       UUID NOT NULL REFERENCES identity,
  score        INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (archetype_id, anchor_tag) REFERENCES anchor_tag (archetype_id, tag)
);
CREATE INDEX ON notes (archetype_id, anchor_tag, score DESC);

ratings(note_id BIGINT NOT NULL REFERENCES notes, voter UUID NOT NULL REFERENCES identity, val SMALLINT NOT NULL, PRIMARY KEY (note_id, voter));
```

Changes from the Phase-0 stub, explicitly:

- **Dropped:** `zone_id`, `pos_x`, `pos_y`.
- **Added:** `archetype_id`, `anchor_tag` (the anchor pair,
  `02-notes-system.md` §3), optional `facing`, optional `item_ref`.
- **Dropped:** `CREATE INDEX ... USING gist (point(pos_x, pos_y))`. There is
  no spatial index because there is no space to index — lookup is equality
  on `(archetype_id, anchor_tag)`, backed by the plain btree index above.
- **Added:** `is_broadcast` for unique-tier petitions (`02-notes-system.md`
  §6) — a broadcast note has no meaningful anchor; `archetype_id`/
  `anchor_tag` are still present as NOT NULL columns for FK simplicity but
  are not used for lookup when `is_broadcast` is true. (Whether a broadcast
  row should instead nullify the anchor columns is worth revisiting during
  T-0042 implementation — tracked as an implementation detail, not a design
  question.)

`secret_drops` and `drop_grants` from the Phase-0 stub are **removed, not
carried forward.** They modeled drops as a weighted-RNG roll against a flat
payload table — that model is superseded by the rarity-cap `item_instance`
system above, now confirmed directly by `07-items-economy.md` §2 and §4:
rarity is a hard instance-count cap, not a drop probability, and sources
are spontaneous world spawn rather than a per-request roll. `T-0048`
(`/v1/roll`) is rescoped accordingly — see `03-net-protocol.md` §5.

`shared/note_templates.hpp` (T-0043) and this table's seed generator must
stay in parity — enforced by a C++/SQL parity test. T-0043 now also seeds
the `archetype` and `anchor_tag` tables: tags are contractual and shared
between client and server, not server-private.

---

## 6. Cross-References

- **`08-invariants.md`** — INV-1 (single custody, the `CHECK` above), INV-2
  (no duplication, the `version` CAS column), INV-4 (escrow atomicity,
  `offering`), INV-5 (custody_depth monotonic), INV-11 (session
  uniqueness, `session_lease`), INV-12 (tag completeness, `anchor_tag` +
  build-time check).
- **`09-identity.md`** — `identity`/`session_lease` implement §1 and §3
  directly; `collapse_expires_at` implements §3a.
- **`07-items-economy.md`** — authoritative on rarity caps (§2), transfer
  semantics (§3, `leave`/`use`/`take` in `03-net-protocol.md` §3),
  bleed-timer curves (§5), and escrow/workbench mechanics (§6–7) beyond
  what's needed to keep INV-1/2/4 enforceable at the schema level.
- **`10-time-and-progression.md`** — the four wall-clocks this schema's
  `bleed_at`, `unlock.expires_at`, `offering.expires_at`, and
  `identity.collapse_expires_at` columns each implement one of.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | v1: replaces the Phase-0 notes-only stub. Identity, session lease, world (archetype/anchor_tag/variant), items (item_instance/offering), progression (unlock/vocabulary/run_archetypes), revised notes table | Claude (Opus 5) |
| 2026-08-01 | v1.1: cross-checked against `07-items-economy.md` and `10-time-and-progression.md`, now both landed - "pending" framing removed throughout; escrow/workbench and bleed-timer notes confirmed rather than provisional | Claude (Opus 5) |
