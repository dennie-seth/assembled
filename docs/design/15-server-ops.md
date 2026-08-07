# 15 — Server Ops & Federation

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, draft
> Related: **03 Net Protocol**, **04 Data Model**, **07 Items & Economy** §2, **08 Invariants** INV-6/7/8
> **Purpose:** how the server is deployed, scaled, federated, and backed up. Previously uncovered.

## 1. Position

**v1 ships a single server. The federation seams are built now; the distributed implementation is not.**

Sharding boundaries are expensive to retrofit and cheap to define. So `shard_id` exists on the rows that need it, unique custody sits behind a `UniqueAuthority` interface, and the orchestrator contract is written — each with exactly one in-process implementation to begin with.

This is the pattern already used elsewhere in the plan: `TaskStore` iface with one `FsTaskStore`, `AgentRunner` iface with one `ClaudeCliRunner`. The seam is real; the second implementation arrives when it is needed.

**Multi-shard deployment comes after the vertical slice.** Debugging lease recovery before knowing whether the game is fun is the wrong order.

## 2. Topology

| Component | Cardinality | Role |
|---|---|---|
| **API node** | N per shard | Stateless request handling |
| **Sweep worker** | **exactly 1 per shard** | Bleed, spawn, collapse, retention, census (**04** §7) |
| **Unique authority** | **exactly 1, global** | Owns all unique instances; brokers leases to shards |
| **Orchestrator** | 1, global | Shard assignment, health, note replication fan-out |

> **The sweep singleton is the hard scaling constraint.** Two workers processing one bleed duplicates an item — and it happens *inside* the worker, where compare-and-swap cannot see it. INV-2 is violated from the one place the anti-dupe law does not reach. Advisory lock plus `FOR UPDATE SKIP LOCKED` is the mechanism; leader election is the deployment requirement.

## 3. The Shard Model

**An identity is pinned to a shard at creation and does not roam.** One universe per identity; that universe is hosted by one shard. Roaming would mean migrating custody, unlocks, and collapse state mid-life for no gameplay benefit.

| Entity | Scope | Why |
|---|---|---|
| **Identity** | Shard-pinned | Universe lives on one shard |
| **Common / rare items** | Shard-local | Caps are `k · P`; `P` is the shard's population |
| **Uniques** | **Global, centrally owned** | Fixed absolute count — does not scale, cannot be per-shard |
| **Offerings (common/rare)** | Shard-local | Avoids cross-shard transactions entirely |
| **Offerings (unique-backed)** | **Global** | Brokered by the unique authority — see §4 |
| **Notes + ratings** | **Replicated async, best-effort** | Pillar-level: a note surfaces in *every* Hospital (`01` §7) |

> **Shard assignment is a gameplay parameter, not an ops parameter.** Common and rare caps scale with shard population, and INV-7/INV-8 depend on enough supply and enough players to deliver it. Too many thin shards starves everyone simultaneously — a drought produced by deployment policy rather than by design. The orchestrator must bias toward **fewer, fuller shards**, and shard population floor belongs in the sim (T-0099) alongside the economy constants.

### Schema consequences

```sql
-- notes.id can no longer be BIGSERIAL: two shards would mint colliding IDs
notes.id        UUID PRIMARY KEY
-- shard ownership
identity.shard_id     SMALLINT NOT NULL
item_instance.shard_id SMALLINT NOT NULL
offering.shard_id     SMALLINT NULL      -- NULL = global (unique-backed)
```

**Ratings replicate with notes.** A note's score drives top-N display *and* the author's held-bleed bonus (**02** §7). Shard-local ratings on a globally replicated note would make the author's timer depend on which shard you ask.

## 4. Unique Authority

Uniques are seeded once, never respawned, and exempt from population scaling (**07** §2). That makes them the one thing that cannot be partitioned.

```
UniqueAuthority
  lease(unique_id, shard_id, ttl)   -> granted | denied
  release(unique_id)
  transfer(unique_id, from_shard, to_shard)
```

A shard hosting a unique holds a **lease**, not ownership. Leases expire; an expired lease returns the instance to the authority, which re-places it. This is the same lease-not-flag reasoning as session ownership (**09** §3): a shard that dies must not strand a unique forever, and there are only a handful of them in existence.

**Unique-backed offerings are the only cross-shard transaction in the system.** The claim commits at the authority, which coordinates the payment item's custody change on the claimant's shard. In v1 this is one in-process transaction against one database and is trivial; the interface exists so that the distributed version has somewhere to live.

> **This is the highest-risk component in the architecture.** It sits directly on the win condition — completion requires several uniques held simultaneously (`01` §5). An authority outage means the game becomes *permanently* uncompletable while otherwise appearing healthy, which is a strictly worse failure than the designed "runnable, not completable" offline state. It needs the strongest availability guarantees in the system, and it is the argument for keeping the deployment single until it must not be.

## 5. Backup & Restore

**Stakes here are unusual, and higher than in most services.**

- **Uniques cannot be regenerated.** Respawning them is precisely what the design forbids (**07** §2). Losing them is unrepairable, not inconvenient.
- **A lost `identity` row is a lost player, permanently.** The server stores only a derived token and there is no account system to appeal to (**09** §1). No support channel exists, by design.
- **Restore rewinds custody.** Players experience it as items teleporting backwards into hands that already traded them away.

Minimum policy for v1:

| | |
|---|---|
| **RPO target** | ≤ 5 min — continuous WAL archiving, not nightly dumps |
| **RTO target** | Best-effort; the game degrades gracefully offline (**03** §6) |
| **Restore drill** | Rehearsed before launch, not after. Untested backups are not backups |
| **Unique audit** | Post-restore assertion: every seeded unique exists exactly once |

That last check is cheap and is the only way to detect the failure that cannot be undone.

## 6. Forks

**Community and self-hosted instances are fully independent.** They seed their own uniques, run their own economy, and do not join the official federation. The client can point at any server.

This answers **7.5 (fork risk)**, open since the first GDD session. It is the right answer because federation requires trusting a peer's item custody, and the client is open-source — a hostile instance could mint uniques at will. Independence costs nothing and removes the attack surface entirely.

The orchestrator governs **official** shards only.

## 7. Abuse Without Accounts

Identity is free to mint and carries no PII, so there is no account friction to lean on.

- **Rate limits per token** (T-0049), tighter for petitions — broadcast is powerful (**02** §6).
- **Proof-of-play** already prices sockpuppet rating-farming at "actually play the game" (**09** §4).
- **Derivation attempts rate-limited** to blunt phrase brute-force (S-5).
- No IP banning as a primary control; it fails against the same population it would inconvenience.

## 8. Open

| # | Question | Blocks |
|---|---|---|
| **OPS-1** | Shard population floor — below which INV-7/INV-8 fail | **sim (T-0099)** |
| **OPS-2** | Unique lease TTL, and reclaim policy for a dead shard | authority impl |
| **OPS-3** | Note replication lag budget — what is acceptable before "the network is the world" feels false? | federation |
| **OPS-4** | Leader election for the sweep singleton — advisory lock, or external coordination? | multi-node |
| **OPS-5** | Hosting target and cost envelope | launch |
| **OPS-6** | Telemetry sink for INV-6/INV-7 monitoring | **uncovered topic — telemetry** |

## 9. Copy-on-Write

Two layers, deliberately different, because the volumes are wildly different.

### 9.1 Storage layer — all shards

COW filesystem or volume snapshots (ZFS/btrfs, or cloud block-storage snapshots) alongside WAL archiving.

Snapshots are near-instant and cheap, so they can be taken far more often than a dump — before every migration, before every deploy, hourly in normal operation. They complement WAL rather than replacing it: WAL gives arbitrary point-in-time recovery, snapshots give *fast* rollback to a known-good moment. The pre-migration snapshot is the one that matters most, because §5 established that a botched migration against live items is unrepairable.

### 9.2 Logical layer — uniques only

> **Unique custody is append-only. Never update a unique's custody in place.**

Each custody change writes a new row rather than mutating the existing one; current custody is the latest row per `unique_id`.

```sql
unique_custody_log(
  unique_id     UUID NOT NULL,
  seq           BIGINT NOT NULL,        -- monotonic per unique_id
  holder        UUID NULL,
  hosted_by     UUID NULL,
  shard_id      SMALLINT NULL,
  lease_expires TIMESTAMPTZ NULL,
  event         SMALLINT NOT NULL,      -- seed|lease|take|use|bleed|release|complete
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (unique_id, seq)
);
```

**This is affordable precisely because uniques do not scale.** There is a fixed small absolute count (**07** §2), so the whole history of every unique that has ever existed stays trivially small — the same property that makes them un-shardable makes them cheap to record exhaustively. Common and rare instances stay as in-place rows under ordinary MVCC; an append-only log at `k · P` volume would be a different and much worse proposition.

What it buys:

| | |
|---|---|
| **Exact reconstruction** | Rebuild unique custody to any instant without restoring the database |
| **Duplication detection** | Two `take` events with no intervening release is INV-2 violated, and it is *visible* rather than inferred |
| **Post-restore audit** | §5's "every unique exists exactly once" check becomes a query over the log, not a guess |
| **Lease forensics** | A dead shard's stranded lease has a full trail, which OPS-2 needs |
| **Free provenance** | `custody_depth` and the *"passed through 14 universes"* lore line are derived, not separately maintained |

The last one is a genuine simplification: **07** §1 treats `custody_depth` as a counter to increment. For uniques it becomes `count(*)` over the log, so the number cannot drift from the history it claims to summarise.

**Consequence for the authority:** a lease grant is an append, and a reclaim is an append. Nothing is destructive, so a partition that causes a double-grant is detectable after the fact rather than silently resolved — which matters when the resource being contested is one of the few objects the win condition depends on.

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | Initial — seams now/single deployment, shard model, unique authority, backup stakes, forks independent (answers 7.5) | Claude, rev. pending |
