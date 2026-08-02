# 11 — Moment-to-Moment Play

> **Author:** Claude · **Reviewed:** pending · **Status:** v2, locked — A-I resolved
> Related: `01-vision.md` §3/§6, `02-notes-system.md` §2 (HAZARD vocab), `07-items-economy.md` §8, `GDD-OPEN.md` A-I
> **Purpose:** what the player does with their hands. Blocks Phase 5.

---

## 1. Detection — Sensor Kit

Entities don't get bespoke AI each. They **compose** from a small, reusable sensor kit. Variety comes from combination, not new code per entity.

| Sensor | Trigger | Blocked by |
|---|---|---|
| **Sight cone** | Angle + range in front of entity | Geometry, cover (§2) |
| **Sound radius** | Player movement state (walk/run) | Nothing — omnidirectional |
| **Proximity / patrol** | Fixed route, radius check, no true LOS | Nothing — reads as environmental, inevitable |

### Vertical slice: 3 entities, one sensor each

Naming reuses existing HAZARD vocabulary (`02` §2) — no new localization cost.

| Entity | Sensor | Reads as |
|---|---|---|
| **The Watcher** | Sight cone only | Stationary or slow patrol. Telegraphed, avoidable by routing. |
| **The Sound** | Sound radius only | Roams, converges on noise. Punishes running blind. |
| **The Still Air** | Proximity/patrol only | Fixed route, no LOS check. Feels inevitable, not alert — you're not spotted, you're just *there* when it arrives. |

Combining sensors on one entity is future work, deliberately deferred past the slice.

> **Audio is the fairness channel for these sensors** (`13-asset-pipeline.md` §4.0). The Still Air runs no line-of-sight check, so sound is the *only* warning a player gets — an unannounced arrival is unfair, not tense. This is why **P-5** exists: music ducks the ambience bed but must never duck entity telegraph or player-noise feedback. The bus split is a gameplay requirement, not a mixing preference.

---

## 2. Hiding — two mechanics, different guarantees

| Mechanic | Blocks | Guarantee |
|---|---|---|
| **Cover-break** | Sight cone only | Partial — sound/proximity still catch you |
| **Dedicated hiding spot** | All sensors | Full, once inside cleanly |

**Hiding spot rules:**
- Single-occupant.
- Entry is exposed — if a sensor has you the instant you enter, it still catches you. No i-frame on the transition.
- Once inside cleanly: fully safe from all three sensors, no timer, no check.

---

## 3. Trap / Lock — the delay verb

Consistent with `07` §8: entities are delayed, never killed.

**Mechanism:** environmental object — door, cage, gate — the player activates against a positioned entity. Level design's job to place these relative to entity routes; not resolved further here.

---

## 4. Movement & Noise *(assumption — confirm)*

No tracked resource (per decision: clock is the only pressure). Noise is a **binary flag off movement state**, not a meter:

- Walk → quiet, small/no sound radius trigger
- Run → loud, triggers Sound sensor at range

No stamina, no cost to running except detection risk. Flagging this as an inferred default, not yet explicitly decided.

---

## 5. Room Interaction Vocabulary

| Object | Function | Gate |
|---|---|---|
| **Item-locked door** | Uses a held item to open | Unique-keyed unlock (`10` §3) — long, decays before collapse |
| **Switch-locked door/gate** | Puzzle solve, no item required | **Session tier** (`10` §3) — same as any puzzle, see §6 |
| **Switch / lever** | Also drives trap/lock (§3) — delays an entity | — |
| **Ladder** | Vertical/room connector | **Not gated.** Free, always-usable, part of base layout — same status as a normal door |

Item-locked and switch-locked doors mix freely per room; which to use is a level-design call, not a rule.

---

## 6. Puzzles

**Required progression gates** — same status as item-locked doors, not optional content.

| Type | Mechanism |
|---|---|
| Switch sequence | Activate switches/levers in correct order or pattern |
| Environmental logic | Light/sound cues the player interprets |
| Item placement | Combine/insert items into slots |

Mix freely per room — level design's call, same precedent as §5.

**Unlock tier: Session** (`10` §3, hours–days). A solved puzzle doesn't stay solved forever — returning players re-solve it, keeping the variant worth re-exploring rather than a one-time chore.

**Notes as hints:** a note can give the solution — and, per `02` §4, can also lie about it. A required gate is therefore not automatically trustworthy. This extends the existing epistemic-ambiguity pillar to puzzles rather than introducing a new risk: a false "solution" note is a legitimate, supported play, same as a false hazard warning.

**Item rewards:** a puzzle may grant an item on solve, instead of or alongside opening a gate. The reward draws from the **existing capped spawn pool** (`07` §4) — the puzzle is a guaranteed delivery point, not a new source, so INV-6 holds without special-casing. Re-granting requires the puzzle's session-tier unlock to decay and be re-solved: the same decay rule that already governs re-exploration value, applied for free to items too.

---

## 7. Open

| # | Question |
|---|---|
| M-1 | Movement/noise model (§4) is an **inferred default**, not an explicit decision — confirm binary walk/run noise, no stamina |
| M-2 | Sensor parameters (cone angle/range, sound radius by movement state, patrol paths) — tuning, not blocking |
| M-3 | Entity count/roster beyond the vertical-slice 3 |
| M-6 | Puzzle authoring budget — how many required per run/variant? (content, not blocking) |

**Resolved:** M-5 — switch-locked doors take the same **Session** unlock tier as any other puzzle (§5, §6). Previously marked TBD in §5 while §6 already specified it.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial — sensor kit, hiding, trap/lock resolved for A-I | Claude, rev. pending |
| 2026-08-02 | v2: **M-5 resolved** (switch-locked doors = Session tier); M-1 added (noise model still an inferred default); audio-fairness cross-ref to P-5; A-I closed | Claude, rev. pending |
