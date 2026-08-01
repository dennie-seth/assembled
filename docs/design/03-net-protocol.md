# 03 — Net Protocol

> **Author:** Claude (Opus 5)
> **Status:** v1, drafted (T-0091) from `docs/HANDOFF.md` schema delta + invariants
> Related: `04-data-model.md`, `08-invariants.md`, `09-identity.md`, `02-notes-system.md`, `07-items-economy.md` (pending)

REST API surface, Phase 4 (`server/`). Supersedes the Phase-0 stub, which
covered notes only and assumed continuous-space radius queries. Wire
structs backing every route live in `shared/` — single source of truth for
client and server (root `CLAUDE.md`).

> **Reconciliation flag.** Sections 3 (Items) and 4 (Escrow / Offering)
> are derived from the `04-data-model.md` schema and INV-1/2/4/5 — they are
> *sufficient to keep the invariants enforceable*, not a full account of
> the items economy. `07-items-economy.md` (pending delivery) is
> authoritative on rarity-cap presentation, bleed-timer UX, and
> workbench/trade flows. **Re-review these two sections against
> `07-items-economy.md` once it lands** — request/response shapes here may
> gain fields but should not need to lose the invariant-critical ones
> (`version`, CAS semantics, atomic escrow release).

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
  prior vote.
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
POST   /v1/items/{id}/transfer  {to_anchor|to_holder, expected_version}
                                                              -> 200 {version} | 409 {conflict:true}
```

- Every `item_instance` representation includes `version`. **Every
  transfer is a compare-and-swap**: the client submits the `version` it
  last observed; the server applies the transfer only if it still matches,
  incrementing `version` and `custody_depth` atomically (INV-2, INV-5,
  T-0095). A `409 {conflict:true}` means the item moved since the client
  last saw it — the loser of the race must re-fetch and decide whether to
  retry, never merge.
- `to_anchor` and `to_holder` are mutually exclusive in the request body,
  mirroring the schema's `CHECK (num_nonnulls(holder, anchor_arch) = 1)`
  (INV-1) — a transfer request that supplies both, or neither, is a `400`
  before it ever reaches the CAS logic.
- There is no "delete" or "destroy" verb. Quitting or dying scatters an
  identity's held items back to world anchors server-side (D-8) — the
  client does not call a special endpoint for this; it's a consequence of
  session eviction / lease expiry, handled the same way custody transfer
  always is.
- The **two-player integration test** (T-0096) is the canonical exercise
  of this section: identity A transfers an item away, identity B takes it,
  and the test asserts A no longer holds it, exactly one holder exists,
  no third identity can also take it, and total instance count is
  unchanged. This should be written, and fail, before any handler in this
  section exists.

---

## 4. Escrow / Offering

```
POST   /v1/offerings         {item_instance, wants_type, archetype_id, anchor_tag}
                                                              -> 201 {id, expires_at}
POST   /v1/offerings/{id}/take {expected_version}            -> 200 {} | 409 {conflict:true}
DELETE /v1/offerings/{id}                                    -> 204
```

- `POST /v1/offerings` places an item into escrow at an anchor, wanting
  `wants_type` in return (mirrors the `offering` table in
  `04-data-model.md` §3). The offered item's custody moves out of the
  author's direct holding into the escrow state implied by this row.
- `POST /v1/offerings/{id}/take` is the atomic pay-and-release (INV-4,
  T-0097): the taker's payment item and the offered item change custody
  in one transaction. **There is no observable intermediate state** where
  the taker has paid but not received, or received but not paid — the
  handler either commits both custody changes or neither. `expected_version`
  guards the offered item the same way §3's transfer does; a losing
  concurrent taker gets `409`, not a partial trade.
- `DELETE /v1/offerings/{id}` withdraws an unfulfilled offering, returning
  the item to its author's custody. Only the author may withdraw; anyone
  may `take`.
- Full workbench/trade UX (browsing offerings, matching suggestions,
  offering expiry notifications) belongs to `07-items-economy.md` — this
  section only specifies enough surface to keep INV-4 enforceable across
  the wire, not the complete feature.

---

## 5. Superseded

`GET /v1/roll?zone -> {drop_id, payload_id}` from the Phase-0 stub is
**removed.** It modeled drops as a weighted RNG roll against a flat
`secret_drops`/`drop_grants` pair, which the rarity-cap `item_instance`
model replaces entirely (`04-data-model.md` §5, D-7/D-8). There is no
direct replacement endpoint yet — item spawning is a server-internal
process (the economy simulation harness, T-0099, models it) rather than a
client-invoked roll. If a client-facing "what did I just find" affordance
turns out to be needed, it belongs with `07-items-economy.md`'s eventual
spec, not as a revival of `/v1/roll`.

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
