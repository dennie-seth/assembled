# 03 — Net Protocol

> **Author:** Claude (Opus 5)
> **Status:** v2, written (T-0091) directly from `07-items-economy.md` and `10-time-and-progression.md`
> Related: `04-data-model.md`, `08-invariants.md`, `09-identity.md`, `02-notes-system.md`, `07-items-economy.md`, `10-time-and-progression.md`

REST API surface, Phase 4 (`server/`). Supersedes the Phase-0 stub, which
covered notes only and assumed continuous-space radius queries. Wire
structs backing every route live in `shared/` — single source of truth for
client and server (root `CLAUDE.md`).

All seven locked design docs are now in the repo. Sections 3 (Items) and 4
(Escrow / Offering) below are written directly against `07-items-economy.md`
- no reconciliation flag remains.

---

## 1. Identity & Session

```
POST   /v1/identity                         -> 201 {phrase}          (first run only)
POST   /v1/identity/derive  {phrase}        -> 200 {token}
POST   /v1/session          {token}         -> 200 {lease_id, expires_at}
POST   /v1/session/heartbeat {lease_id}     -> 200 {expires_at} | 409 {evicted:true}
```

- `POST /v1/identity` generates a seed phrase server-side, derives the
  token, **discards the phrase**, and returns it to the client exactly
  once. The server never stores it (`09-identity.md` §1). Rate-limited
  hard (S-5, open) — this is the only mint path and it must not be free to
  hammer.
- `POST /v1/identity/derive` re-derives the token from a client-held phrase
  on later runs. Deterministic; same phrase always yields the same token.
- `POST /v1/session` acquires the lease for a token, evicting any existing
  live session for that identity (INV-11, `09-identity.md` §3 — new
  session wins, not the old one).
- `POST /v1/session/heartbeat` renews the lease before its short TTL
  (S-1, open) expires. A `409 {evicted:true}` means another session took
  over — the client's copy is told its universe continued elsewhere and
  should stop acting as if it holds custody of anything.
- Every subsequent authenticated request in this document carries the
  current `lease_id`, not just `token` — handlers reject a request whose
  lease doesn't match the live one, which is what makes INV-11 the primary
  double-spend defense (INV-2's CAS on `item_instance.version` catches the
  residual race across the eviction boundary itself).

---

## 2. Notes

```
POST   /v1/notes            {archetype_id, anchor_tag, template_id, slots[], facing?, item_ref?}
                                                              -> 201 {id}
GET    /v1/notes?archetype_id&anchor_tag&limit               -> 200 [{...}]
POST   /v1/notes/{id}/rate  {val: +1|-1}                     -> 204
POST   /v1/notes/petition   {template_id, slots[]}            -> 201 {id}   (unique-tier broadcast)
```

- `template_id` and `slots[]` are the *only* content a client can submit
  for a note body — no free-text field exists anywhere in this API.
  Validation rejects an unknown `template_id` or a slot-arity/category
  mismatch with `400` (`02-notes-system.md` §1–2).
- **`GET /v1/notes` has no radius, no `x`/`y`, no `zone`.** Lookup is
  equality on `(archetype_id, anchor_tag)` — the spatial index is gone
  because there is no space to index (D-1, `02-notes-system.md` §3). This
  is the schema change that closed PLAN.md open question 2 and unblocks
  T-0046 (now much smaller than originally scoped: tag equality + ranking
  by `score DESC`, no GiST).
- Composing a note requires the write template's tier be unlocked for the
  author (`02-notes-system.md` §5) — a `template_id` above the caller's
  unlocked tier is a `403`, not a `400` (it's an authorization failure, not
  a malformed request).
- `POST /v1/notes/{id}/rate` requires **proof-of-play**: the server checks
  `run_archetypes` for a run belonging to this identity that contains the
  note's `archetype_id` before accepting the vote. No qualifying run ->
  `403` (T-0098, D-12). One vote per `(note_id, voter)`, idempotent —
  resubmitting the same `val` is a no-op, changing `val` overwrites the
  prior vote. A well-rated note slows the *author's* held-bleed timer
  (`07-items-economy.md` §5, `10-time-and-progression.md` §5) — it never
  slows collapse.
- `POST /v1/notes/petition` is the unique-tier broadcast (`02-notes-system.md`
  §6) — no anchor at all; it surfaces across many players' worlds rather
  than at a single `(archetype_id, anchor_tag)`. Requires the unique
  vocabulary tier. Rate-limited per player (exact cost/cooldown is open,
  N-5). When live population can't answer, the seeded-ghost corpus does
  (§11 of `02-notes-system.md`) — that's a server-side fallback, not a
  distinct endpoint.

---

## 3. Items

```
GET    /v1/items/{id}                                        -> 200 {..., version}
POST   /v1/items/{id}/leave     {archetype_id, anchor_tag, expected_version}
                                                              -> 200 {version} | 409 {conflict:true}
POST   /v1/items/{id}/use       {archetype_id, anchor_tag, expected_version}
                                                              -> 200 {version, unlock?} | 409 {conflict:true}
POST   /v1/items/{id}/take      {expected_version}           -> 200 {version} | 409 {conflict:true}
```

Every route in this section moves exactly one `item_instance`
(`07-items-economy.md` §1) between the states `{holder, world_anchor,
escrow}`, guarded by compare-and-swap on `version` (INV-2). The instance
representation returned by `GET /v1/items/{id}` includes `type_id`,
`rarity`, `origin_palette` (drives client-side chroma render,
`01-vision.md` §8), `holder`, `anchor`, `custody_depth`, and `version` —
the full row from `04-data-model.md` §3.

**Transfer verbs map directly to `07-items-economy.md` §3:**

- **`leave`** — the held instance enters the world at `(archetype_id,
  anchor_tag)`. `holder` clears, `anchor` is set, `custody_depth`
  increments (INV-5). This is what a player does when placing an item for
  someone else to find, distinct from escrow (§4) in that it carries no
  demand attached.
- **`use`** — the held instance is spent against a lock at `(archetype_id,
  anchor_tag)`. If the anchor's tag has an unlock rule keyed to this
  item's `type_id`, the response includes `unlock: {variant_id, tag,
  expires_at}` (`10-time-and-progression.md` §3) and the instance itself
  moves onward into the world exactly as `leave` does — **the item
  circulates, the knowledge stays** with the calling identity. No separate
  "unlock" endpoint exists; unlocking is a side effect of `use`, not a
  distinct transfer.
- **`take`** — picks up an instance currently at a world anchor (or
  received via escrow release, §4) into the caller's holding. `anchor`
  clears, `holder` is set to the caller, `custody_depth` increments. Items
  are **one-taker**: the first `take` to win the CAS gets it, every other
  concurrent caller receives `409`.
- **Death and quit are not client-invoked verbs.** Per D-8, they are
  identical: all of an identity's held instances scatter back to world
  anchors server-side, triggered by session eviction/expiry or an explicit
  "end run" signal, never by a client calling a per-item endpoint. A
  scattered instance re-enters exactly the same held/world bleed-timer
  machinery as everything else (§5 below).
- `to_anchor`/`to_holder` ambiguity from the schema's `CHECK
  (num_nonnulls(holder, anchor_arch) = 1)` (INV-1) is resolved by having
  distinct verbs (`leave`/`use` vs. `take`) rather than a single generic
  transfer call with a polymorphic target — a request can't accidentally
  supply both or neither, because each verb's target is implicit in the
  route.
- The **two-player integration test** (T-0096) is the canonical exercise
  of this section: identity A calls `leave`, identity B calls `take`, and
  the test asserts A no longer holds the instance, exactly one holder
  exists, no third identity can also `take` it, and total instance count
  is unchanged. This should be written, and fail, before any handler in
  this section exists.

### Workbench (transmute)

```
POST   /v1/items/transmute  {pattern: {id, expected_version}, fuel: {id, expected_version}}
                                                              -> 201 {new_item_id} | 409 {conflict:true}
```

Implements `07-items-economy.md` §6: consumes both `pattern` and `fuel`
instances (both must be held by the caller; both CAS-guarded), destroys
them, and mints one new instance of `type(pattern)`. Net instance count
is **−1** — this is the economy's only player-driven sink, balancing the
automatic spontaneous-spawn source (§9 of `07-items-economy.md` §4). Not a
copier: the output type always matches the pattern's type, never the
fuel's.

---

## 4. Escrow / Offering

```
POST   /v1/offerings         {item_instance, expected_version, wants_type, archetype_id, anchor_tag}
                                                              -> 201 {id, expires_at}
POST   /v1/offerings/{id}/take {item_instance, expected_version}
                                                              -> 200 {} | 409 {conflict:true}
DELETE /v1/offerings/{id}                                    -> 204
```

**Ships in v1: escrow only** (`07-items-economy.md` §7) — reliable and
exploit-free, no trust required, no betrayal possible. The **plea**
variant (an unlocked item with a request attached, anyone may take it and
walk away) is explicitly deferred to v2 and ships later as a
separately-marked object; nothing in this section should be built to
accidentally support it early.

- `POST /v1/offerings` moves an item instance out of the author's holding
  and into escrow, locked to `(archetype_id, anchor_tag)` and a
  `wants_type` demand. Mirrors the `offering` table in `04-data-model.md`
  §3.
- `POST /v1/offerings/{id}/take` is the atomic pay-and-release (INV-4,
  T-0097): the taker supplies the payment instance (`item_instance` +
  `expected_version`, matching `wants_type`); the server verifies it,
  then commits both custody changes — payment to the offering's author,
  offered item to the taker — in one transaction. **There is no
  observable intermediate state** where the taker has paid but not
  received, or received but not paid.
- `DELETE /v1/offerings/{id}` withdraws an unfulfilled offering, returning
  the item to its author's custody. Only the author may withdraw; anyone
  may `take`.
- **Unclaimed offerings bleed away on the standard world/escrow timer —
  48–72 h** (`07-items-economy.md` §5, `10-time-and-progression.md` §2).
  There are no permanent vaults; an offering that nobody takes eventually
  re-enters general circulation via the same bleed/landing-probability
  mechanism as any other world-anchored instance (`07-items-economy.md`
  §4). No separate expiry job exists for offerings distinct from the
  bleed timer already modelled for `item_instance` in general.
- E-6 (`07-items-economy.md` §9, open): behaviour if `wants_type` goes
  extinct while an offering is outstanding is not yet specified — likely
  resolves to the standard bleed-away rather than a special case, but
  confirm against the simulation (T-0099) before relying on it.

---

## 5. Superseded

`GET /v1/roll?zone -> {drop_id, payload_id}` from the Phase-0 stub is
**removed, confirmed by `07-items-economy.md`.** Item acquisition is not a
client-invoked roll at all — sources are **spontaneous world spawn**,
rate-controlled to hold each type between floor and cap
(`07-items-economy.md` §4), a purely server-internal process with no
client-facing trigger. A player receives new items only through the
transfer verbs in §3 (`take`, escrow `take`) acting on instances the
spawner already placed — there is no "roll for a drop" moment to give an
endpoint to. The economy simulation harness (T-0099) models the spawner
directly. `T-0048` is rescoped accordingly (see its task card).

---

## 6. Rate Limiting

Per anonymous identity token, per route group (identity mint separately and
much stricter — see §1). Exact limits are an implementation detail of
T-0049, not a design constraint; nothing above depends on a specific
number.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | v1: replaces the Phase-0 notes-only stub. Session lease, notes (tag equality, petition, proof-of-play rating), items (CAS transfer), escrow/offering (atomic pay-and-release), `/v1/roll` marked superseded | Claude (Opus 5) |
| 2026-08-01 | v2: items section rewritten directly from `07-items-economy.md` - explicit leave/use/take verbs replace the generic transfer call, workbench/transmute endpoint added; escrow section confirms v1-is-escrow-only (plea deferred) and cross-references the 48-72h world/escrow timer from `10-time-and-progression.md`; `/v1/roll` supersession confirmed (spontaneous spawn, no client roll) | Claude (Opus 5) |
