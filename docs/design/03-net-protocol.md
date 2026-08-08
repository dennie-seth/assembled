# 03 — Net Protocol

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, draft
> Related: `HANDOFF.md` §5 (schema), `08-invariants.md` INV-2/INV-4/INV-11, `09-identity.md` §3, `07-items-economy.md` §3
> **Purpose:** the wire contract. Replaces the repo's `03-net-protocol.md`, which specifies cut systems. Task **T-0091**.

---

## 1. Shape

Plain **HTTPS request/response**. No QUIC, no websockets, no SSE in v1.

This is sufficient because **everything is discovered on room entry**. Notes, anchored items, offerings, and petitions are all read when the player arrives somewhere. Bleed and collapse are wall-clocks the client computes locally from timestamps the server already sent. Nothing needs to arrive unprompted.

SSE remains the documented upgrade path if a future feature genuinely needs push — it does not today, and adding it would complicate Drogon for no gameplay benefit.

---

## 2. Auth

Every request carries the identity token as a bearer credential. **Every mutation additionally carries `lease_id`.**

```
Authorization: Bearer <derived_token>
X-Lease-Id: <lease_id>          # mutations only
```

The lease requirement is what makes INV-11 enforceable at the edge rather than by lookup. It also gives eviction a clean signal: an evicted client's next write returns `1003 LEASE_SUPERSEDED`, which is the trigger for the "your universe continued elsewhere" message (`09-identity.md` §3). Without it, an evicted client fails in ways it cannot explain to the player.

---

## 3. Errors

**Enum codes, never prose.** The design has no free text anywhere — all display strings come from a localized table (`02-notes-system.md` §1). A server error message would be the first unlocalized string in the game and would quietly break that property.

```
{ "error": 3001 }
```

HTTP status carries the class; the body carries the specific cause. The client maps the code to its own localized string.

| Range | Class |
|---|---|
| 1xxx | auth / session |
| 2xxx | validation |
| 3xxx | custody / economy |
| 4xxx | progression / permission |
| 5xxx | rate limit |
| Code | Meaning |
| 1001 | `UNKNOWN_TOKEN` |
| 1002 | `LEASE_EXPIRED` — reacquire; the run has ended |
| 1003 | `LEASE_SUPERSEDED` — evicted by a newer session |
| 1004 | `NO_ACTIVE_RUN` |
| 2001 | `BAD_TEMPLATE` |
| 2002 | `SLOT_ARITY_MISMATCH` |
| 2003 | `SLOT_CATEGORY_MISMATCH` |
| 2004 | `UNKNOWN_ANCHOR` — archetype/tag pair not declared |
| 3001 | `TRANSFER_LOST` — CAS lost. **Near-unreachable for loose items**, since exactly one universe hosts each; survives only for retries, the eviction boundary, and sweep concurrency |
| 3002 | `ITEM_NOT_HELD` |
| 3003 | `ITEM_BLED` — expired before the request landed |
| 3004 | `OFFERING_ALREADY_CLAIMED` — a **real** error, worth surfacing. Offerings are globally visible, so this means another player got there first |
| 3005 | `PAYMENT_TYPE_MISMATCH` |
| 4001 | `NO_PROOF_OF_PLAY` — archetype absent from this run (`02-notes-system.md` §7) |
| 4002 | `VOCAB_TIER_LOCKED` |
| 4003 | `NOTE_CAP_REACHED` — 5 active (`02-notes-system.md` §9) |
| 5001 | `RATE_LIMITED` |

---

## 4. Transfers and Receipts

**Every custody change is a transfer, and every transfer produces a receipt keyed on a client-generated `transfer_id`.**

### Why the client mints the ID

If the server generated it, a dropped response would leave the client unable to name what it was asking about — the exact failure this exists to solve. The client mints a UUID before sending; the receipt is therefore always re-queryable.

### Semantics

```
POST /v1/transfers
{ "transfer_id": "<uuid>",
  "kind": "leave" | "use" | "take" | "transmute",
  "item_id": "<uuid>",
  "anchor": { "archetype": 3, "tag": 11 },   // leave/take
  "fuel_item_id": "<uuid>" }                 // transmute only
-> 200 <receipt>

GET /v1/transfers/{transfer_id} -> 200 <receipt>
```

**A repeated `transfer_id` returns the stored receipt and does not re-attempt the compare-and-swap.** This is what makes retries safe: without it, a retried success and a genuine race loss are indistinguishable, since both fail CAS.

### Receipt

```
{ "transfer_id": "...",
  "outcome": "won" | "lost",
  "reason": 3001,
  "item": { "id": "...", "custody_depth": 15, "bleed_at": "..." },
  "created_at": "..." }
```

The receipt carries post-transfer state so the client can render immediately without a second round trip — the new `custody_depth` for the lore line, the new `bleed_at` for the alpha ramp (`07-items-economy.md` §5).

**Retention: 72h**, matching the world/escrow bleed window. Longer serves nothing; the item it describes has moved on.

**This is also the cleanest assertion for T-0096:** across two concurrent takers, exactly one receipt reads `won`.

---

## 5. Endpoints

### Identity & session

```
POST   /v1/identity                    -> 201 { phrase, token }
         phrase returned exactly once, never stored (09-identity.md §1)
POST   /v1/session      { phrase }     -> 200 { token, lease_id, lease_expires_at,
                                                collapse_expires_at }
POST   /v1/session/heartbeat           -> 204
DELETE /v1/session                     -> 204
```

### Runs

```
POST   /v1/runs                        -> 201 { run_id, archetypes: [ {archetype_id, variant_id} ] }
POST   /v1/runs/{id}/end  { reason }   -> 200 { scattered: n }
         reason: death | quit          (disconnect is lease expiry, not a call)
```

**Run assembly is server-authoritative.** Variant eligibility depends on population (V-9), and the archetype set is the proof-of-play record backing rating permission (`02-notes-system.md` §7). A client-assembled run would be self-certifying.

**The assembler picks 1–3 archetypes and caps the run at 18 rooms.** Archetypes are authored at varying size (Signal Tower is 8–9), so selection is size-aware rather than blind: one large zone, or several small ones, or a mix summing under the ceiling. The ceiling exists because run length is load-bearing — held bleed is defined as ≈2× it (`10-time-and-progression.md` §2), so a longer run would drag E-1 with it and ripple through the sim. **Room count per run is an INV-9 band metric**, so the sim measures it rather than assuming it holds.

### Notes

```
GET    /v1/notes?archetype=&tag=&limit=   -> 200 [ ... ]
POST   /v1/notes  { archetype, tag, template_id, slots[], facing?, item_ref? }  -> 201 { id }
POST   /v1/notes/{id}/rate  { val: +1 | -1 }                                   -> 204
GET    /v1/petitions                       -> 200 [ ... ]   // broadcasts visible to you
POST   /v1/petitions  { item_type }        -> 201 { id }    // unique tier (02-notes-system.md §6)
```

### Items & anchors

```
GET    /v1/inventory                                  -> 200 [ ... ]
GET    /v1/anchors/{archetype}/{tag}                  -> 200 { items[], offerings[], notes[] }
```

One call per room entry returns everything at that anchor. This is the request the whole push-free design rests on, and it carries **three different visibility classes**:

- **Items** — only those **hosted in your universe**. An anchored instance lives in exactly one world, so no two players can ever contend for one.
- **Offerings** — **globally visible**. Escrow is the single genuine contention point in the design.
- **Notes** — **global**, many readers, replicated across shards (`15-server-ops.md` §3).

**The response must be one consistent snapshot — a single transaction.** Three separate queries let the sweep interleave and produce a torn view: an item listed as loose while it is already backing an offering.

### Escrow

```
POST   /v1/offerings  { transfer_id, item_id, wants_type, anchor }   -> 201 { id }
POST   /v1/offerings/{id}/claim  { transfer_id, payment_item_id }    -> 200 <receipt>
```

Claim is one transaction: payment and release together, or neither (INV-4). Because offerings are global, the claim takes a **row lock inside that transaction** — `SELECT ... FOR UPDATE` — committing on success and rolling back on failure. No lock column, no reservation lease, no stale-lock sweep; all three would be needed if claiming ever became a multi-step reserve/confirm handshake.

### Progression

```
POST   /v1/unlocks  { variant_id, tag, via_item_id? }  -> 201 { expires_at }
GET    /v1/unlocks                                     -> 200 [ ... ]
GET    /v1/vocabulary                                  -> 200 [ word_id ... ]
```

---

## 6. Offline

**Offline runs persist nothing.** The client assembles a run locally when the server is unreachable; the player explores and survives, and none of it is recorded — no unlocks, no vocabulary, no items, no notes.

This is a security position, not just a simplification. The client is open-source and the server is public. Any sync-on-reconnect path would mean the server accepting client-asserted progress, which is a trivially spoofable route straight past the social gate that the entire completion design rests on.

It also states D-15 more precisely: **runnable offline, not completable, and not accumulative.**

> **Client requirement:** offline mode must be *visibly* signalled before and during play. A player who loses a forty-minute run they did not know was unrecorded will read it as a bug, and they will be right to. This is a UX obligation created by a protocol decision — flagged here so it does not get lost between documents.

---

## 7. Rate Limits

Per token, enforced server-side (T-0049). Petitions are separately and much more tightly limited — broadcast is powerful by construction (`02-notes-system.md` §6).

Exact ceilings: **open (NP-1)**.

---

## 8. Open

| # | Question | Blocks |
|---|---|---|
| **NP-1** | Rate-limit ceilings per endpoint class; petition cooldown | T-0049 |
| **~~NP-2~~** | Paging on `GET /v1/anchors/...` — **resolved.** Items are bounded by per-universe hosting; **offerings** are global and unbounded at popular anchors, so ranking and a limit apply to offerings only | — |
| **NP-3** | Protocol version negotiation — header or path prefix? Needed before the first public build, not before Phase 4 | release |
| **NP-4** | Should `POST /v1/runs` return anchor-tag sets inline, or does the client hold them from the shared table? | T-0043 |

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | Initial — receipts with client-minted IDs, enum error codes, lease on mutations, no push, offline persists nothing | Claude, rev. pending |
| 2026-08-02 | v2: hosting model folded into §3/§5 — items hosted per-universe, offerings global, three visibility classes in one snapshot; escrow row-lock documented; **NP-2 resolved** | Claude, rev. pending |
