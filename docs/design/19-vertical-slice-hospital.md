# 19 — Vertical Slice: Hospital

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, draft
> Related: `01 — Vision` §7, `11 — Moment-to-Moment Play`, `12 — Tears` §3a, `16 — Level Design`, `14 — Vertical Slice: Signal Tower` (archetype 1 in the chain)
> **Purpose:** archetype 2 of the vertical slice's 3-archetype chain (`12` §3a). Entered via Signal Tower's chain tear; exited via its own chain tear to Long Descent (`20`).

---

## 1. Archetype

`archetype_id: hospital` — fulfills the `hospital.ward_north` / `hospital.stairwell` anchor-tag examples already used illustratively in `01` §7 and `02` §3. **Not foreign** — arriving here via Signal Tower's chain tear is progression within your own assembled run, home palette throughout (`12` §3a).

---

## 2. Room Layout

**5 rooms** — small end of the 5–8 band (`01` §7), linear (no branches), a deliberate contrast with Signal Tower's branching shape — archetypes don't have to share a structure (`16` §4, connectivity is free per variant/archetype).

| Anchor tag | Room | Contents |
|---|---|---|
| `hospital.ward_north` | **Ward North** | Entry (from Signal Tower's tear). Calm, no entity. Item: **Sedative Vial** (red). |
| `hospital.stairwell` | **Stairwell** | **The Watcher.** Trap/lock demo (C) — a fire gate the player can drop on the Watcher to delay it (`11` §3). Item: **Antiseptic Vial** (blue). |
| `hospital.nurses_station` | **Nurses' Station** | **Climax + Gate** (item-placement puzzle) — insert both vials to unlock. Grants **Release Order** (unique). |
| `hospital.operating_theatre` | **Operating Theatre** | **The Sound.** Cluttered surgical equipment, echoey. |
| `hospital.morgue` | **Morgue** | **Chain tear** — leads to Long Descent (`20`), `12` §3a. |

**Declared anchor tags:** `ward_north`, `stairwell`, `nurses_station`, `operating_theatre`, `morgue`, `tear`, `climax`. (`climax` co-located at Nurses' Station, same pattern as `14`.)

---

## 3. Entities

| Entity | Sensor | Location | Flavor |
|---|---|---|---|
| **The Watcher** | Sight cone | Stairwell | A fixed camera-like sentinel watching the stair — the trap/lock demo target. |
| **The Sound** | Sound radius | Operating Theatre | Reacts to noise among cluttered equipment — same behavior as Signal Tower's, different dressing. |

Only two Hazard rooms this time (vs. Signal Tower's three) — `16` §2's budget is a range, not a fixed count.

---

## 4. Trap/Lock — Stairwell (C)

**Mechanism (`11` §3):** an environmental fire gate positioned along the Watcher's route. Activating it while the Watcher is inside its bounds delays the entity — consistent with "entities are delayed, never killed" (`07` §8). This is the vertical slice's first use of the trap/lock verb; Signal Tower didn't need one.

---

## 5. Puzzle — Nurses' Station

**Type:** item placement (`11` §6) — distinct from Signal Tower's two environmental-logic/switch-sequence puzzles, completing the "mix of all three types" decided earlier for the slice.

**Mechanism:** a supply cabinet with two color-coded slots (red, blue). Insert the Sedative Vial (Ward North) and Antiseptic Vial (Stairwell) into their matching slots — order doesn't matter, only correct matching. Both vials are reachable on the linear main path, so no backtracking is required.

**Gate:** Session-tier unlock (`10` §3), same as any puzzle gate.

**Reward — Release Order (unique).** Same climax semantics as Signal Tower's Resonance Key (`14` §5): guaranteed *if* a unique is currently hosted, else rare, else empty. Opens Morgue's chain tear; using it sends it onward (`10` §3, `07` §3).

---

## 6. Chain Tear — Morgue

| Property | Value |
|---|---|
| Anchor tag | `hospital.tear` |
| Type | Chain (`12` §3a) — Hospital is archetype 2 of the sequence |
| Cost | A held **Release Order** |
| Trip type | Round trip; unlock persists after first use |
| Foreignness | None — leads to Long Descent's own entry room, home palette |

---

## 7. Items Introduced

| Item | Tier | Source | Notes |
|---|---|---|---|
| **Release Order** | Unique | Puzzle/Climax reward, Nurses' Station | Opens Morgue's chain tear. |
| **Sedative Vial** | Common | Spawn pool, Ward North | Puzzle component. |
| **Antiseptic Vial** | Common | Spawn pool, Stairwell | Puzzle component. |

---

## 8. Sample Notes

| Note | Template | Anchors near |
|---|---|---|
| "The watcher ahead" | `{HAZARD} {DIRECTION}` | Stairwell |
| "Wait, behind" | `{ACTION}, {DIRECTION}` | Stairwell (trap-timing hint) |
| "Need the release order" | `"Need {item_ref}"` | Exchange request, any anchor |

May be false, per `02` §4. Same N-3 caveat as `14` §8 — illustrative, not final vocabulary.

---

## 9. Audio

- `music_cue`: Nurses' Station — Climax Room doubles as the low-pressure beat, same pattern as `14` §9.
- Archetype bed: one looping ambience for `hospital`.
- Entity telegraph on the never-ducked Gameplay SFX bus (`13` §4.1, P-5).

---

## 10. Level Design Pass

```
Ward North (entry)
  → Stairwell [Watcher, trap]
     → Nurses' Station [puzzle, climax]
        → Operating Theatre [Sound]
           → Morgue [chain tear → Long Descent]
```

Linear — no branches. All connectors are ladders/doors per `11` §5.

| Room | Shape & scale | Sightlines / patrol | Hiding & cover |
|---|---|---|---|
| Ward North | Wide, open ward floor | Fully open, no entity | Hiding spot present, unneeded here |
| Stairwell | Vertical stair shaft with a landing | Watcher fixed, covers the landing; fire-gate trap object positioned on its route | Cover-break behind stair rails; trap object as the primary tool |
| Nurses' Station | Small, desk + supply cabinet | N/A — no entity | — |
| Operating Theatre | Cluttered with surgical equipment | Sound roams, no fixed patrol | One dedicated hiding spot (equipment alcove) |
| Morgue | Cold storage room, tear as centerpiece | No entity — breathing room | — |

**Sensor parameters (first pass, `11` M-2):** Watcher 90°/6 tiles, ~4s sweep (same as `14`); Sound ~1–2 tile walk / ~5 tile run radius (same as `14`).

---

## 11. Open

| # | Question |
|---|---|
| H-1 | Exact trap-gate placement/timing relative to the Watcher's route — level-design pass, tuning |

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-03 | Initial — Hospital as archetype 2 of the vertical-slice chain: 5 rooms, trap/lock demo, item-placement puzzle, chain tear to Long Descent | Claude, rev. @DennieSeth |
