# 02 — Notes System

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v3, locked
> Related: `01-vision.md`, `07-items-economy.md`, `08-invariants.md`, `09-identity.md`

---

## 1. Constraint

**No user-generated content, ever.** Players compose from a fixed vocabulary. This is not a moderation policy bolted on — it is enforced at the schema level by foreign keys, making arbitrary text *unrepresentable* rather than merely forbidden.

Consequences, all positive:
- Zero moderation burden at any scale
- Free localization (translate the vocabulary once, all notes translate)
- Wire format is a few integers
- No spam, slurs, doxxing, or link injection surface
- No Steam Tier 2 AI disclosure — nothing is generated at runtime

---

## 2. Grammar

Notes must express more than *Dark Souls* required — this game needs **requests and offers**, not just warnings.

### Slot types

| Category | Count | Examples |
|---|---|---|
| `DIRECTION` | 8 | ahead, behind, below, above, left, right, within, beyond |
| `HAZARD` | 12 | the drop, the watcher, the sound, the cold, the still air… |
| `ACTION` | 12 | wait, run, hide, cross, turn back, listen, do not… |
| `OBJECT` | 16 | the door, the lamp, the bones, the machine, the seam… |
| `QUALIFIER` | 8 | slowly, twice, never, only once, if alone… |
| `ITEM_REF` | — | resolves against the item table (already localized — no extra cost) |

**Vocabulary: 56 words + ~24 templates = 80 strings per language.** Cheap, growable.

### Template form

```
TEMPLATE  "{ACTION} {QUALIFIER}, {DIRECTION}"        -> "Hide slowly, below"
          "{HAZARD} {DIRECTION}"                     -> "The watcher ahead"
          "I need {ITEM_REF}"                        -> exchange request
          "{OBJECT} opens with {ITEM_REF}"           -> path hint
```

Templates declare slot arity and types. Server validates arity and category on write — a mismatch is a `400`.

### Start point

Ship **20 templates / 60 words**, grow from telemetry. Do not front-load vocabulary; every entry is a permanent localization liability.

---

## 3. Anchoring

Notes bind to **anchor tags**, not coordinates.

```
anchor  = (archetype_id, anchor_tag)
        + optional facing        (direction the author was looking)
        + optional item_ref      (subject of the note)
```

A note left at `hospital.ward_north` surfaces for every player whose universe contains a Hospital — **any variant of it**. Variants may differ in layout entirely; only the tag set is contractual (`01-vision.md` §7).

Two consequences worth stating plainly:

- **Variants never fragment the note pool.** Unlocking a sixth Hospital does not divide readership six ways. Population growth raises note density, as intended, instead of quietly lowering it.
- **The spatial index disappears.** Lookup is equality on `(archetype_id, anchor_tag)`. No GiST, no radius query, no geometry.

**Notes persist across runs and across universes, globally and permanently.** They outlive the run that made them and the universe that died. This is the point.

---

## 4. Truth

**Notes may lie.** Deliberately misleading messages are a legitimate, supported play. A false "safe passage" that leads into a hazard is working as designed.

Combined with **local enemy layers** (`01-vision.md` §7), this produces a valuable ambiguity: a warning about a hazard you do not have may be a lie, or may be honest testimony from a universe unlike yours. **This is never resolvable, by design.** Players cannot distinguish deception from divergence — which is exactly the epistemic condition the fiction demands.

---

## 5. Vocabulary Tiers

Vocabulary unlocks across runs, mirroring item rarity. This is the mechanism behind "what you know" in `01-vision.md` §4.

| Tier | Availability | Role |
|---|---|---|
| **Common** | From run one | Core communicative function |
| **Rare** | Unlocked through loop experience | Nuance, precision, specificity |
| **Unique** | Deep unlock, few per player | Broadcast petition (§6) |

### Two rules that are not negotiable

**1. Comprehension is never gated.** A player reads every note from run one, at full fidelity. Only *composition* is tiered. An unreadable note is a hard failure; a note you cannot yet write is an aspiration. Unlocking must feel like gaining voice, never like being handed a decoder.

**2. Core function stays common-tier.** Exchange requests especially — `"I need {ITEM_REF}"` must be available immediately. If asking for things were rare, new players could not participate in the economy at all, and the social gate would become a wall. Rarity gates *flourish*, never *utility*.

---

## 6. Broadcast Petition (unique tier)

A unique note does not anchor to a place. It **broadcasts** — surfacing in many players' worlds at once as a visible plea.

You are not asking a room. You are asking the Universe, and the Universe is the network.

- Preserves the "cannot finish alone" pillar: the answer still comes from players.
- When population is thin, the **seeded-ghost corpus answers** — so a petition is never shouted into silence.
- Rare by construction, because broadcast is powerful. Rate-limited per player.

**This is the enforcement mechanism for INV-8** (`08-invariants.md`). Reachability was previously an arithmetic hope; the petition makes it an actual affordance a stuck player can reach for.

**N-5 resolved: a petition may name a gating (unique) item.** This is what makes it the actual anti-lockout valve rather than a convenience feature — a player stuck on a third unique can ask for exactly that. Cost, cooldown, and broadcast breadth remain open tuning.

---

## 7. Rating

Players rate notes ±1. One vote per player per note, idempotent.

### Rating feeds the economy

**A well-rated note slows the author's bleed timer.**

Being useful to the network tightens your own grip on reality. This:
- Makes helpfulness mechanically self-interested (no altruism required)
- Gives ratings genuine weight rather than decorative signal
- Requires no new system — it is a multiplier on a timer that already exists (`07-items-economy.md` §4)

Exact curve TBD. Suggested shape: diminishing returns, floor and ceiling clamped, so a single viral note cannot suspend the economy indefinitely.

**Scope: held bleed only.** Ratings do **not** slow the collapse clock. A prolific solo player could otherwise extend their universe indefinitely, re-opening the permanent-lockout hole the clock exists to close. Rejected deliberately — see `10-time-and-progression.md` §5.

### Proof-of-play requirement

Because ratings carry economic weight and identity is free to mint (`09-identity.md`), **only a player whose run actually contained that archetype may rate notes anchored there.** Server-verifiable against the run's assembled archetype set.

This closes sockpuppet rating-farming without adding identity friction, and it costs one join. Alt accounts remain possible; farming with them stops being cheap.

---

## 8. Density & Decay

- Display: **top N by score** per anchor tag.
- Unrated and negatively-rated notes decay out over time.
- Self-cleaning: no manual curation, no admin tooling, scales to any note volume.

`N` is a tuning constant — start at 5 visible per tag.

---

## 9. Placement

- **Free to place.** No resource cost.
- **Capped at 5 active notes per player.** Placing a sixth expires the oldest.

No spam surface, and the cap forces authorial choice — the player must decide what is actually worth saying. Cheaper and better than a consumable cost.

---

## 10. Feedback

The author sees, per note: **read count** and **rating split**.

This is the strongest retention hook in the design — it closes the loop on an otherwise one-way action, and it feeds directly into the bleed-timer benefit so the number has stakes.

---

## 11. Seeded Ghosts

The server carries a corpus of authored and historical notes so that solo and low-population players always encounter *someone*.

- Indistinguishable from live player notes in presentation.
- Drawn from authored content at launch, supplemented by high-scoring historical notes over time.
- Sized so that a player never traverses a populated archetype empty-handed.
- **Also answer broadcast petitions** when live population cannot.

Corpus size and authorship: **open (V-8)**.

---

## 12. Open

| # | Question |
|---|---|
| N-1 | Bleed-timer bonus curve (§7) |
| N-2 | Decay rate + `N` visible (§8) |
| N-3 | Final template/word list — needs the archetype set to exist first |
| N-4 | Do ghost notes rate? Can they be rated? |
| N-5 | Petition cost, cooldown, breadth (may name a gating item — resolved, §6) |
| N-6 | Unlock triggers per tier — runs survived? archetypes seen? notes rated well? |

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial, from GDD session | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | v2: anchor tags replace coordinates, vocabulary tiers, broadcast petition, proof-of-play rating | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | N-5 resolved: petitions may name a gating/unique item | Claude, rev. @DennieSeth |
| 2026-08-02 | v3: status line corrected; no content change | Claude, rev. pending |
