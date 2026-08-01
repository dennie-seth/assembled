# 07 — Items & Economy

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v2, locked
> Related: `01-vision.md`, `02-notes-system.md`, `08-invariants.md`
> **This document defines the master balance dial of the entire game.** Treat changes here as gameplay-critical.

---

## 1. Item Identity

Every item is a **unique tracked instance** — a UUID with a custody chain, not a stack count.

```
item_instance
  id             UUID          unique forever
  type_id        SMALLINT      what kind of thing it is
  rarity         ENUM          common | rare | unique
  origin_palette SMALLINT      which universe it came from -> renders its chroma
  holder         UUID | NULL   current player, or NULL if in world/escrow
  anchor         (archetype_id, anchor_tag) | NULL
  custody_depth  INT           how many universes it has passed through
  version        INT           optimistic-concurrency guard (INV-2)
  created_at     TIMESTAMPTZ
```

- Some item **types** have multiple instances in existence.
- Two instances of the same type are mechanically identical but historically distinct.
- `custody_depth` is free lore for one integer: *"this passed through 14 universes before it reached you."* Surface it.
- `origin_palette` drives the chroma rule from `01-vision.md` §8 — an item's travel history is visible in its colour.

---

## 2. Rarity = Quantity

**Rarity is not a drop probability. It is a hard ceiling on how many instances exist.**

This is materially better than a drop table: it is directly observable, directly testable, monitorable in production, and it cannot silently drift.

| Tier | Cap | Scales with population? |
|---|---|---|
| Common | `k_c · P` | yes |
| Rare | `k_r · P`, `k_r ≪ k_c` | yes |
| **Unique** | fixed small absolute count | **no** |

---

## 3. Transfer Rules

| Event | Effect |
|---|---|
| **Leave** | Instance leaves your inventory, enters the world at an anchor |
| **Use** | Instance leaves your inventory, surfaces for another player |
| **Death** | All held instances scatter into the network |
| **Quit** | Identical to death — instances scatter, nothing is lost |
| **Bleed** | Held too long without use — instance departs to another universe |
| **Transmute** | Two instances in, one out (§6) |

**No instance is ever copied.** Every transfer is a move, guarded by compare-and-swap on `version`. Duplication is impossible by construction.

Items are **one-taker**: an instance left in the world goes to exactly one recipient.

---

## 4. Economy Topology

| | |
|---|---|
| **Sources** | Spontaneous world spawn, rate-controlled to hold each type between floor and cap |
| **Sinks** | Depopulation only — supply targets shrink as `P` falls |
| **Neutral** | Leave, use, death, **quit**, bleed, transfer |

### The quitter rule inverts the failure mode

A departing player's items scatter back into the pool exactly as on death. **Attrition is not a leak.** The economy never drains, and the drought scenario — the one that threatened completability — largely evaporates.

What replaces it is the mirror risk: **over-supply after depopulation.** 10,000 players become 200, the item count was tuned for 10,000, and nothing is scarce any more. Same sweep, opposite direction — and far more survivable, because flooding degrades *feel* while drought degrades *completability*.

### How count actually decreases

Not by a reaper confiscating items from players' hands. **Reuse the bleed timer:** an item that bleeds normally re-anchors in someone else's world; when supply sits above target, some fraction simply never arrives. The collapse ate it.

No new system, no confiscation, fictionally exact. The reaper is a **landing probability**, nothing more.

**Uniques are exempt.** Their count does not scale with population, so they are never over-supply, so they always re-anchor. They circulate forever.

---

## 5. Bleed Timers — two, not one

**All wall-clock.** Full treatment in `10-time-and-progression.md`.

| Timer | Scope | Duration | Job |
|---|---|---|---|
| **Held** | item in inventory | **60–90 min** (≈2× run length) | Anti-hoarding, circulation |
| **World / escrow** | item at an anchor | **48–72 h** | Social latency buffer |

The split is not optional. At 90 minutes escrow would be unusable — nobody can find an offering, hold the demanded item, and pay before it evaporates. Exchange spans sessions; hoarding pressure does not.

Fiction absorbs it: *a thing anchored to a place is more anchored than a thing carried by someone whose universe is ending.*

**Mechanical effects of held bleed:**
- Kills hoarding — you cannot bank progress
- Guarantees circulation continues even while players idle
- Reclaims instances from inactive players without requiring them to die
- Makes holding a rare item tense within a session
- Doubles as the supply regulator (§4)

Nothing survives absence: whatever you carry at logoff is gone before you return.

**Modifiers:**
- Well-rated notes **slow held bleed** (`02-notes-system.md` §7). They do **not** slow the collapse clock — see `10` §5.
- Longer `custody_depth` may bleed faster — older things are less anchored *(proposed, TBD)*

E-1 now has a starting range rather than a blank. The sim's job is the exact multiplier.

---

## 6. Workbench (Transmuter)

```
input:  instance A (the pattern) + instance B (the fuel)
output: new instance of type(A)
        A and B destroyed
net instance count: -1
```

A **transmuter, not a copier**. It converts abundance into scarcity of the right shape.

With spontaneous spawn now supplying the world (§4), the workbench being a net sink is no longer a structural problem — it is a *player-driven* sink balancing an automatic source. **E-2 is resolved.**

---

## 7. Exchange (Escrow)

**Ships in v1: escrow only.**

A player leaves an item locked to a request. The world releases it only on payment.

```
offering
  id            UUID
  item_instance UUID
  wants_type    SMALLINT
  anchor        (archetype_id, anchor_tag)
  author        UUID
  expires_at    TIMESTAMPTZ
```

- Reliable and exploit-free — no trust required, no betrayal possible.
- This is what makes **collective completion survivable**: gated progression needs a transfer mechanism that cannot be griefed.
- **Unclaimed offerings bleed away on the standard timer.** No permanent vaults.

### Plea (v2, deferred)

An unlocked item with a request attached — anyone may take it and walk away. Trust-based, betrayal possible, thematically richer. **Ships later as a separately-marked object**, so players opt into vulnerability deliberately rather than being exposed by default.

---

## 8. Enemies as Items

Foreign entities obey the same world rules as objects:
- They bled in from elsewhere
- They can be **trapped or locked** — delayed, never killed
- They **bleed away** on their own timer

Enemies are an obstacle to *outlast*, not defeat. A trapped enemy is a solved problem that solves itself given time. Consistent with no-combat, costs no additional systems.

Enemy layer is **local per universe** — see `01-vision.md` §7.

---

## 9. Open

| # | Question | Severity |
|---|---|---|
| **E-1** | Exact held / world durations within the ranges in §5 | **critical — master tuning number** |
| E-9 | Do uniques use the same held timer, or a longer one? | balance |
| E-3 | Does `custody_depth` accelerate bleed? | tuning |
| E-4 | `k_c`, `k_r`, absolute unique count | balance |
| E-5 | Can a player refuse an incoming item? Inventory cap? | design |
| E-6 | Escrow behaviour if the demanded type goes extinct | edge case |
| E-7 | Spawn model: Poisson per tag per tier, or tear-driven seeding? | **blocks simulation** |
| E-8 | Landing-probability curve vs. over-supply ratio (§4) | balance |

**Resolved:** E-2 — spontaneous spawn is the source.

**E-1, E-7 and E-8 cannot be resolved analytically.** See `08-invariants.md` §4 for simulation scope.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial, from GDD session | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | v2: rarity=quantity cap, spontaneous spawn resolves E-2, quitter rule, bleed-as-regulator, anchor tags, version column | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | v3: bleed split into held (60–90 min) and world/escrow (48–72 h); wall-clock confirmed; timers consolidated into `10-time-and-progression.md` | Claude (Opus 5), rev. @DennieSeth |
