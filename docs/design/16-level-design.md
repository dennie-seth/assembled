# 16 — Level Design

> **Author:** Claude · **Reviewed:** pending · **Status:** v2, draft — chain/pocket tears folded in
> Related: `01 — Vision` §7 (world structure), `05 — Art Direction` §4 (variants are dressing, not rebuilds), `11 — Moment-to-Moment Play` §5 (room interaction vocabulary), §7 (climax rooms), `12 — Tears`, `14 — Vertical Slice` (worked example)
> **Purpose:** room-type taxonomy, placement budget, and variant authoring rules — what a level designer may change between one variant of an archetype and the next. Blocks **A-3** (variant authoring cost estimate) and therefore the affordability of the whole population-scaled variety model.

---

## 1. Room Types Are Composable Roles, Not Exclusive Categories

A room can carry more than one role at once — Signal Tower's Power Substation is both **Gate** and **Hazard** simultaneously. Roles are level-design metadata, not a room's identity.

| Role | What it means | Anchor mechanism | Placement budget |
|---|---|---|---|
| **Climax** | Guaranteed rare/unique delivery point (`11` §7) | Own declared tag | ≤1 per archetype |
| **Tear** | Crossable to a foreign pocket (`12`) | Own declared tag | Exactly 1 per archetype |
| **Gate** | Required progression — item-lock or puzzle (`11` §5–§6) | Role on a named room tag | Recommended ≥1, not enforced |
| **Hazard** | Entity-capable slot (§3) | Role on a named room tag | Flexible — expected majority |
| **Transit** | No special content; connective tissue or padding | Plain named room tag | Flexible |

### Why Climax and Tear get dedicated tags, and Gate/Hazard don't

Climax and Tear are **system-facing**: the spawner and the crossing logic need to find "the guaranteed delivery point" or "the crossable tear" generically, across any archetype, without per-archetype hardcoding. A dedicated tag makes that a lookup, not a special case.

Gate and Hazard are **author-facing**: they describe what a level designer put inside an ordinary named room. The room's own tag already identifies it; a second tag would be redundant.

**Retroactive fix for `14`:** Climax should be its own declared tag (`signal_tower.climax`), co-located with `records_room` and `music_cue` — the same pattern already used for `music_cue`. Propagated below (§5) and into `14` directly.

---

## 2. Placement Budget

- **Tear — exactly one per archetype** (`12` §3), unconditional. **This is why a run's "1–3 tears" (`12` §2) lines up with exactly 3 archetypes per run** (`01` §7): every archetype offers one tear opportunity; crossing all three, some, or none is player choice, not a supply variable. **Chain vs. pocket** (`12` §3a): archetypes 1–2 in the run's sequence carry a chain tear (unique-keyed, connects onward); archetype 3 carries a free pocket tear (terminal, foreign reward). Only the terminal archetype's tear content is thematically foreign — chain crossings stay home-palette.
- **Climax — at most one per archetype** (`11` §7).
- **Gate — no hard minimum**, but an archetype with zero gates contributes nothing to the unique-keyed unlock economy (`10` §3). Recommended at least one.
- **Hazard — no cap.** Expected to be the majority of an archetype's rooms — Signal Tower is 3 of 8.
- **Transit — flexible.** Padding to hit the archetype's 5–8 room band (`01` §7), or breathing room around a Gate/Hazard room.

---

## 3. Entity Slots, Not Entity Instances

A Hazard room is authored with a **sensor-category slot**, not a specific entity. Its geometry — cover placement, patrol space, hiding spots (`11` §1–§2) — is built to support exactly one sensor category: sight cone, sound radius, or proximity/patrol.

**Which entity occupies the slot is rolled per-universe** (`01` §7 — "the enemy layer is local"). Today's roster has exactly one entity per sensor category, so the roll is currently deterministic — but the system is built for a growing roster (`11` M-3). Once a second sight-cone entity exists, two different universes' "same" Hazard room could hold different entities. That's exactly what makes note warnings unreliable **by design** (`02` §4) rather than by bug.

**Consequence for authoring:** a variant's Hazard room declares its sensor-category requirement once. It does not need to be re-authored when the entity roster grows — the slot absorbs new content for free.

---

## 4. Variant Authoring Rules

### Fixed across every variant (contractual, INV-12-checked)

- The anchor tag set — every named room, plus Tear / Climax / `music_cue` if declared.
- Which tag is Tear (exactly one) and which is Climax (at most one).
- Total room count, and therefore the archetype's place in the 5–8 size band (`01` §7).

### Free to vary per variant

- **Room-to-room connectivity** — which door leads where, ladder placement.
- Room shape, dimensions, internal layout.
- Prop dressing, decay state, palette weighting (`05` §4).
- **Which named room carries the Gate or Hazard role.** Moving the puzzle from Power Substation to Equipment Floor in variant 2 doesn't break the tag contract — it's exactly the re-exploration value `01` §7 wants ("rewards exploring every variant for its own clues... rather than solving an archetype once and being done").
- Puzzle specifics within a Gate room (switch count, cue design).
- Sensor-category choice for each Hazard slot.

### What this means for A-3

The cost driver for a second variant is **level-design labor** — new room shapes, a new connectivity graph, re-placement of Gate/Hazard roles — not new asset generation. Tileset, entity content, and the sensor kit are reused wholesale (`05` §4). This doesn't produce an hour figure on its own — **A-3 stays Class C** (`GDD-OPEN`), estimated once a first variant exists — but it bounds what that estimate has to cover, which is what was missing before now.

---

## 5. Worked Example — The Vertical Slice Chain

`14`/`19`/`20` are the reference implementation, and together they exercise the full chain-tear sequence (`12` §3a): **Signal Tower → Hospital → Long Descent.**

### Signal Tower (7 rooms — revised from 8; the pocket moved to Long Descent, §3a below)

| Room | Role(s) |
|---|---|
| Ground Relay | Transit |
| Records Room | Climax + Gate (puzzle) |
| Power Substation | Gate + Hazard (sight-cone slot) |
| Equipment Floor | Hazard (sound-radius slot) |
| Storage Cache | Transit |
| Antenna Shaft | Hazard (proximity/patrol slot) |
| Broadcast Deck | Tear — **chain**, leads to Hospital |

Matches the placement budget: 1 Tear, 1 Climax, 2 Gate, majority Hazard (3 of 7), Transit filling the rest.

Full detail for Hospital and Long Descent lives in their own docs (`19`, `20`).

---

## 6. Open

| # | Question |
|---|---|
| LD-1 | Minimum/maximum Hazard-room count per archetype — tuning, not blocking |
| LD-2 | Does a Transit room ever carry an ambient item spawn by default, or is that also author's choice per room (as in `14`, Ground Relay/Antenna Shaft)? |
| LD-3 | A-3 itself — actual hours for a second variant, once one is authored |

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-03 | Initial — room-type taxonomy (Climax/Gate/Hazard/Tear/Transit), placement budget, entity-slot vs. entity-instance rule, variant authoring rules (fixed vs. free), worked example against `14` | Claude, rev. @DennieSeth |
| 2026-08-03 | v2: Tear budget updated for chain vs. pocket (`12` §3a); worked example expanded to the full 3-archetype chain (Signal Tower → Hospital → Long Descent); Signal Tower revised to 7 rooms | Claude, rev. @DennieSeth |
