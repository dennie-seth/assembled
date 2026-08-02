# 09 — Identity & Sessions

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v2, locked
> Related: `02-notes-system.md`, `08-invariants.md`, `PLAN.md` T-0066

---

## 1. Model

**Identity is a seed phrase. There are no accounts.**

```
first run  -> server generates phrase -> derives token -> DISCARDS PHRASE
           -> client saves phrase to file
later      -> client loads phrase -> server derives token -> same identity
```

| Rule | Reason |
|---|---|
| Server stores the **derived token only**, never the phrase | A database dump must not compromise every identity at once |
| Phrase is **English, non-localized, fixed wordlist** | A phrase written down on a Russian install must restore on an English one |
| Phrase is the **whole credential** | No password layer, no support channel, no recovery |
| **Loss is final** | The server genuinely cannot help. State this plainly at first run — do not bury it |

Loss being final is thematically exact for a game about universes that end. It should read as a rule of the world, not as a warning label.

---

## 2. Why This Costs Nothing

Meta-progression made the anon token real save data — vocabulary tiers persist across runs (`02-notes-system.md` §5), so losing the token loses everything. An account system would solve that and would drag in email, PII, password reset, and a moderation surface the design has spent considerable effort not having.

The seed phrase keeps every non-goal intact and still gives portability. What it does *not* give is authentication in any meaningful sense — anyone holding the phrase is you. Acceptable here: no money, no PII, nothing worth stealing but a vocabulary.

---

## 3. Sessions

**INV-11: at most one live session per identity.** Server-enforced.

### It must be a lease, not a flag

A boolean "logged in" column locks a player out of their own identity the moment a client crashes. The lease is the fix:

| Mechanism | Value |
|---|---|
| Client heartbeats while playing | — |
| Lease TTL | short — tens of seconds (S-1) |
| Expiry | session reclaimable |

**Reconnecting within the TTL resumes the in-progress run seamlessly** — no scatter, no penalty (`01-vision.md` §6, "Ending a Run"). Only actual expiry counts as the run ending.

### Takeover policy: new session evicts old

Rejecting the new session means a crash locks you out for the TTL. Evicting means someone holding your phrase can boot you — acceptable, since holding the phrase already means being you.

The evicted client is told its universe continued elsewhere. Which is true, and is the kind of true this game likes.

### Relationship to INV-2

Session uniqueness handles the main double-spend vector; **compare-and-swap on `item_instance.version` handles the residual** — network retries, duplicate requests, the race across an eviction boundary. Both are cheap. Neither is retrofittable once items are live.

---

## 3a. The Universe Is Identity-Scoped

The collapse clock belongs to the **identity**, not the run (`01-vision.md` §6). Consequences that land here:

| | |
|---|---|
| Clock runs on wall-clock, whether or not the player is present | A two-week absence costs the universe |
| Death does not reset it | Only expiry ends a universe |
| Survives collapse | Vocabulary tiers, notes left |
| Dies with the universe | Unlocks, held items |

**Losing the phrase and letting the universe collapse are now different losses.** Phrase loss costs vocabulary — everything. Collapse costs unlocks and the current run's items, but leaves you fluent. Worth distinguishing in first-run copy so players understand which warning is which.

Schema note: `collapse_expires_at` is per-identity, set on first run, never extended by ratings (`10-time-and-progression.md` §5). **First universe only:** duration is **~1.5× nominal** (`01-vision.md` §9) — exact base value still sim-tuned within its ~2–4 week bracket.

**S-6 resolved: the same phrase opens the next universe.** Collapse ends the universe, not the identity — otherwise vocabulary tiers (above) couldn't survive it, since they're keyed to the phrase-derived token. `collapse_expires_at` resets for the new universe on the player's next run; the token itself never changes.

---

## 4. Sockpuppets

Identity is free to mint, and always was. What changed is that **ratings now carry economic weight** — a well-rated note slows the author's bleed timer — which turns alt accounts into a *paying* exploit rather than a pointless one.

**Defense: proof-of-play.** Only a player whose run actually contained an archetype may rate notes anchored there (`02-notes-system.md` §7).

- Server-verifiable against the run's assembled archetype set
- Costs one join on the query path
- Adds no friction for legitimate players
- Makes farming require actually playing, which is the correct price

Alt accounts remain possible. They stop being cheap, which is the achievable goal — identity friction is not, and buying it would cost the non-goals in §2.

---

## 5. Lore Layer (deferred)

Two ideas worth keeping, both post-v1:

- **Phrases that mean something.** A non-localized wordlist flavoured with dead institutional vocabulary — the register of the setting. Identity reads as an artifact of the world rather than a key.
- **Encrypted phrases as an ARG.** Players decrypt them for lore.

**One constraint that must hold if either ships:**

> Generation stays **uniform-random over the wordlist**. Meaning comes from the *flavour of the words*, never from constraining which combinations occur.

Structured phrases are guessable phrases. And the ARG payload must be **separate from the credential** — if solving the puzzle teaches players the generation scheme, it teaches them how to guess others'.

Entropy target: 8 words from a 256-word list = 64 bits. Ample against online guessing given rate limits, and shorter to write down than BIP-39's twelve.

---

## 6. Open

| # | Question |
|---|---|
| S-1 | Lease TTL and heartbeat interval |
| S-2 | Wordlist: size, source, exact entropy budget |
| S-3 | Phrase file format — plain text? Does the client offer clipboard export? |
| S-4 | Does the client keep a phrase after voluntary "start a new universe"? |
| S-5 | Rate-limit policy on derivation attempts (anti-brute-force) |

**Resolved:** S-6 — same phrase opens the next universe (§3a).

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | Collapse cluster: S-6 resolved (same phrase persists across universes), first-universe grace multiplier noted (§3a) | Claude, rev. @DennieSeth |
| 2026-08-01 | NEW-1 cross-ref: reconnect-within-TTL resumes run seamlessly (§3) | Claude, rev. @DennieSeth |
| 2026-08-01 | First-universe grace multiplier set to ~1.5× nominal (§3a) | Claude, rev. @DennieSeth |
| 2026-08-02 | v2: status line corrected | Claude, rev. pending |
