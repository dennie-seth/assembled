# 20 — Vertical Slice: Long Descent

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, draft
> Related: `01 — Vision` §7, `11 — Moment-to-Moment Play`, `12 — Tears` §3a, `16 — Level Design`, `19 — Vertical Slice: Hospital` (archetype 2 in the chain)
> **Purpose:** archetype 3 (terminal) of the vertical slice's 3-archetype chain. Entered via Hospital's chain tear; ends the chain with a free pocket tear, reusing Signal Tower's original Dead Frequency Room content.

---

## 1. Archetype

`archetype_id: long_descent` — a stairwell/tunnel descent, linear and claustrophobic (matches the original `GDD-QUESTIONS` naming intent). Terminal archetype in the run's sequence (`12` §3a): its tear is a free **pocket** tear, not a chain tear — nowhere further to connect to.

---

## 2. Room Layout

**6 rooms** — medium end of the band, **including the pocket** (`01` §7's rule: the pocket counts as one of the archetype's own rooms). 5 named rooms, linear, no branches.

| Anchor tag | Room | Contents |
|---|---|---|
| `long_descent.upper_landing` | **Upper Landing** | Entry (from Hospital's tear). Calm, no entity. |
| `long_descent.switchback_stair` | **Switchback Stair** | **The Still Air.** Narrow, winding, no LOS — same behavior as Signal Tower's Antenna Shaft. |
| `long_descent.flooded_sublevel` | **Flooded Sublevel** | **The Sound.** Standing water, echoey. |
| `long_descent.storage_vault` | **Storage Vault** | **Climax only — no Gate.** Demonstrates the role is genuinely optional (`16` §1): reachable on the main path, no lock. |
| `long_descent.watchers_landing` | **Watcher's Landing** | **The Watcher + pocket tear**, combined on one room (same double-duty pattern as Signal Tower's Power Substation, `16` §1). |
| `long_descent.tear` | *Dead Frequency Room* (beyond the pocket tear) | **Reused wholesale from the original `14` design** (pre-redesign): foreign-palette Watcher, **Fractured Receiver** reward (rare, foreign `origin_palette`). |

**Declared anchor tags:** `upper_landing`, `switchback_stair`, `flooded_sublevel`, `storage_vault`, `watchers_landing`, `tear`, `climax`. (`climax` co-located at Storage Vault.)

**No Gate room in this archetype — deliberate.** `16` §2's Gate budget is "recommended ≥1, not enforced." The run already has three Gates (two in Signal Tower, one in Hospital); Long Descent tests the zero-Gate case for real rather than leaving it a hypothetical.

---

## 3. Entities

| Entity | Sensor | Location | Flavor |
|---|---|---|---|
| **The Still Air** | Proximity/patrol, no LOS | Switchback Stair | Same behavior as `14`'s Antenna Shaft — pure timing avoidance in a narrow descent. |
| **The Sound** | Sound radius | Flooded Sublevel | Water amplifies noise; same mechanic, new dressing. |
| **The Watcher** | Sight cone | Watcher's Landing | Guards the pocket tear directly — last obstacle before the terminal crossing. |
| **The Watcher (foreign)** | Sight cone | Dead Frequency Room (beyond) | **Reused from the original `14` VS-1 resolution** — foreign-palette reskin, same sensor. |

---

## 4. Pocket Tear — Watcher's Landing

| Property | Value |
|---|---|
| Anchor tag | `long_descent.tear` |
| Type | **Pocket** (`12` §3a) — terminal archetype, free to cross |
| Cost | None mechanical — risk of death is the cost |
| Danger | Dead Frequency Room beyond it — genuinely foreign, unlike the chain tears in `14`/`19` |
| Trip type | Round trip, re-crossable within the run |
| Reward | **Fractured Receiver** (rare, foreign palette), from the capped spawn pool |

This is the only point in the entire vertical-slice chain where crossing feels like *another player's universe bleeding through* — by design, foreignness is reserved for exactly this one room (`12` §3a).

---

## 5. Items Introduced

| Item | Tier | Source | Notes |
|---|---|---|---|
| **Fractured Receiver** | Rare | Spawn pool, beyond the pocket tear | Foreign-palette, round-trip reward — unchanged from the original `14` design. |

Storage Vault's Climax slot delivers whatever's currently hosted (unique if available, else rare, else empty) — no dedicated new item type, by design; it's the generic climax mechanism doing its job without a story-critical dependency riding on it.

---

## 6. Sample Notes

| Note | Template | Anchors near |
|---|---|---|
| "The still air ahead" | `{HAZARD} {DIRECTION}` | Switchback Stair |
| "Run, never" | `{ACTION}, {QUALIFIER}` | Flooded Sublevel (warns against running near Sound) |
| "Need the fractured receiver" | `"Need {item_ref}"` | Exchange request, any anchor |

May be false, per `02` §4. Same N-3 caveat as `14`/`19` — illustrative.

---

## 7. Audio

- `music_cue`: Storage Vault — the Climax Room, same low-pressure pattern as `14`/`19`.
- Archetype bed: one looping ambience for `long_descent`.
- Entity telegraph on the never-ducked Gameplay SFX bus (`13` §4.1, P-5).

---

## 8. Level Design Pass

```
Upper Landing (entry)
  → Switchback Stair [Still Air]
     → Flooded Sublevel [Sound]
        → Storage Vault [climax, no gate]
           → Watcher's Landing [Watcher, pocket tear]
              → (tear) Dead Frequency Room [foreign Watcher]
```

Linear throughout — the most claustrophobic of the three archetypes, matching its name and terminal position (escalating tension across the whole chain, not just within one archetype).

| Room | Shape & scale | Sightlines / patrol | Hiding & cover |
|---|---|---|---|
| Upper Landing | Small landing, open | No entity | Hiding spot present, unneeded |
| Switchback Stair | Narrow, winding descent | Still Air fixed lap (~20–30s), no LOS | Hiding alcove partway down — primary safety valve |
| Flooded Sublevel | Low-ceiling, standing water | Sound roams, no fixed patrol | One dedicated hiding spot (dry alcove) |
| Storage Vault | Small, shelved | No entity | — |
| Watcher's Landing | Landing before the tear, open sightline to it | Watcher ~90°/6 tile sweep, guards the crossing | Cover-break behind shelving |
| Dead Frequency Room | Distorted mirror room, foreign-palette | Foreign Watcher, same sweep logic | Cover-break available |

**Sensor parameters:** Still Air ~20–30s lap, ~1.5 tile catch radius; Sound ~1–2 tile walk / ~5 tile run; Watcher (both instances) 90°/6 tiles, ~4s sweep — all unchanged from `14`, reused directly.

---

## 9. Open

None — reuses `14`'s original Dead Frequency Room design and established sensor parameters wholesale; only the room graph and archetype-level framing are new.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-03 | Initial — Long Descent as the terminal archetype of the vertical-slice chain: 6 rooms including the reused Dead Frequency Room pocket, zero-Gate demonstration, pocket tear closing the chain | Claude, rev. @DennieSeth |
