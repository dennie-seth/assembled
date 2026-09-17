# 14 — Vertical Slice: Signal Tower

> **Author:** Claude · **Reviewed:** pending · **Status:** v5, locked — archetype-chain redesign
> Related: `01 — Vision` §7 (world structure), `11 — Moment-to-Moment Play`, `12 — Tears`, `05 — Art Direction`, `13 — Asset Pipeline` §4.2, PLAN.md Phase 8
> **Purpose:** concrete content for the vertical slice — the one archetype, its rooms, entities, items, notes, puzzle, and tear.

---

## 1. Archetype

`archetype_id: signal_tower` — an abandoned comms/broadcast tower. Traversal is primarily **vertical**: ladders and stairwells connect floors, using the free/always-usable ladder rule (`11` §5). One variant for the vertical slice (`01` §7 — "1 at launch, grows").

Thematically apt: a tower built to receive and transmit is exactly where a tear — another universe bleeding through — belongs.

---

## 2. Room Layout

**7 rooms total** — within the archetype's 5–8 room band (`01` §7): 5 on the main climb (escalating danger), 2 optional branches. *(Revised from 8 — the tear pocket relocated to Long Descent, **`20`**, once Broadcast Deck's tear became a chain tear rather than a pocket tear; see changelog.)*

| Anchor tag | Room | Path | Contents |
|---|---|---|---|
| `signal_tower.ground_relay` | **Ground Relay** | Entry, main | Calm, no entity. Item: **Rusted Transit Pass**. Branch to Records Room. |
| `signal_tower.records_room` | *Records Room* | Optional branch | **Puzzle-locked**, not item-locked (§5). **Climax Room** (`11` §7, `16` §1) — guaranteed rare/unique delivery, own declared tag. Notes-heavy, safe. `music_cue` tag here. |
| `signal_tower.power_substation` | **Power Substation** | Main | **The Watcher.** Puzzle: restore power — gates the climb, grants **Relay Fuse**. |
| `signal_tower.equipment_floor` | **Equipment Floor** | Main | **The Sound.** Cluttered, punishes running. Branch to Storage Cache. |
| `signal_tower.storage_cache` | *Storage Cache* | Optional branch | Item reward: **Copper Coil**. No/low danger. |
| `signal_tower.antenna_shaft` | **Antenna Shaft** | Main | **The Still Air.** Narrow, most dangerous — no LOS check. Item: **Corroded Antenna Fragment**. |
| `signal_tower.broadcast_deck` | **Broadcast Deck** | Main | Story climax. **Chain tear** lives here — leads to Hospital (`19`), `12` §3a. |

**Declared anchor tags for `signal_tower`** (INV-12 build check applies to all): `ground_relay`, `records_room`, `power_substation`, `equipment_floor`, `storage_cache`, `antenna_shaft`, `broadcast_deck`, `tear`, `climax`, `music_cue`. (`climax` and `music_cue` are both co-located at Records Room — `16` §1.)

---

## 3. Entities

Escalating order, calmest at the base (`11` §1):

| Entity | Sensor | Location | Flavor |
|---|---|---|---|
| **The Watcher** | Sight cone | Power Substation | A slow-scanning searchlight sentinel — telegraphed, avoidable by routing. |
| **The Sound** | Sound radius | Equipment Floor | Reacts to vibration in the cluttered machinery — punishes running blind. |
| **The Still Air** | Proximity/patrol, no LOS | Antenna Shaft | Fixed route in a narrow shaft — feels inevitable, not alert. |

**Note on VS-1:** the foreign-palette Watcher previously placed in "Dead Frequency Room" now lives in Long Descent's pocket tear content (`20`) — relocated along with the room itself when Broadcast Deck's tear became a chain tear. Signal Tower's own entity roster is just the three above.

---

## 4. Puzzle — Power Substation

**Type:** mix — switch sequence, order read off environmental light/hum cues (`11` §6 puzzle types).

**Gate object (D):** an explicit **switch-locked gate** (`11` §5 room vocabulary) blocking the ladder upward — not just "the room gates the climb" in prose. The breaker sequence is what unlocks the gate.

**Gate:** Session-tier unlock (`10` §3) — gates passage upward from this room. Decays; returning players re-solve it.

**Reward:** grants **Relay Fuse** on solve, drawn from the existing capped spawn pool (`11` §6, `07` §4) — not a new source.

**Mechanism (VS-2 resolved):** three breakers ("AUX", "MAIN", "SIGNAL" — stenciled, diegetic labels, no UGC concern) arranged around the room, each with a small indicator lamp. On entry, one lamp lights — flip that breaker, the next correct lamp lights, and so on. **Wrong flip: silent reset.** The sequence returns to step one, no buzz, no alert, no penalty — purely a fair, readable puzzle. The Watcher's slow sweep (§3) is the actual tension: timing breaker flips around its sight cone, not solving the sequence itself.

**Notes as hints:** a note may (honestly or falsely, per `02` §4) describe the correct switch order — optional flavor/misdirection layered on top of a puzzle that's fully solvable from the room alone.

---

## 5. Puzzle-Locked Climax — Records Room

**No longer item-locked.** Entry is gated by a puzzle, not a held item — resolving the circularity a solo player would otherwise hit (a room that's both the *source* of a unique and the thing a unique is needed to *enter*).

**Mechanism:** environmental-logic type (`11` §6), distinct from Power Substation's light-chase. Archive drawers show faded wear-marks from repeated use — the correct opening order is read off which drawer faces are most worn, not an active light cue. Session-tier unlock (`10` §3), same as any puzzle gate.

**Reward — Resonance Key (unique).** On solve, the room's Climax slot resolves (`11` §7): the highest-tier item currently hosted by the player's universe, guaranteed *if available* — unique if hosted, else rare, else empty.

**This is deliberate, not an oversight:** because the Resonance Key specifically is what opens Broadcast Deck's chain tear (§6), full progress through the archetype chain in one sitting depends on a unique currently being hosted — exactly the same social gate the exit condition itself rests on (`01` §5), just applied one level down. A solo playtester without network activity should use **T-0107** (debug grant) to guarantee a Resonance Key for deterministic testing; this is not a bug to fix, it's the pillar ("alone you endure; together you escape") working as intended.

Using the Key at the tear sends it onward, same as any unique-keyed unlock (`10` §3, `07` §3 "use").

---

## 6. Chain Tear — Broadcast Deck

| Property | Value |
|---|---|
| Anchor tag | `signal_tower.tear` (fixed, one per archetype — `12` §3) |
| Type | **Chain** (`12` §3a) — Signal Tower is archetype 1 of the run's sequence |
| Cost | A held **Resonance Key** (§5) — same unlock semantics as an item-locked door |
| Danger | Whatever Hospital's own entry room holds — not a hazard in the crossing act itself |
| Trip type | Round trip — the unlock persists once used, so re-crossing (either direction) needs no further key |
| Foreignness | **None.** Hospital is still your own assembled run, not another player's universe. Home palette throughout (`12` §3a) |
| Room budget | Not counted in Signal Tower's own 7 — the destination is Hospital's own entry room, budgeted there (`19`) |

---

## 7. Items Introduced

| Item | Tier | Source | Notes |
|---|---|---|---|
| **Resonance Key** | Unique | Puzzle/Climax reward, Records Room | Opens Broadcast Deck's chain tear. Circulates onward after use. |
| **Relay Fuse** | Common/Rare | Puzzle reward, Power Substation | Gates + rewards the climb. |
| **Copper Coil** | Common | Spawn pool, Storage Cache | Optional-branch pickup. |
| **Rusted Transit Pass** | Common | Spawn pool, Ground Relay | Flavor pickup, first thing a player can find. |
| **Corroded Antenna Fragment** | Common | Spawn pool, Antenna Shaft | Small comfort reward for clearing the hardest room. |

---

## 8. Sample Notes

Using the existing template grammar (`02` §2) — illustrative, not exhaustive:

| Note | Template | Anchors near |
|---|---|---|
| "The watcher ahead" | `{HAZARD} {DIRECTION}` | Power Substation |
| "Hide slowly, within" | `{ACTION} {QUALIFIER}, {DIRECTION}` | Antenna Shaft |
| "The shelf opens in order" | `{OBJECT} opens with {ITEM_REF}` (adapted — see FR note below) | Records Room |
| "Need the resonance key" | `"Need {item_ref}"` | Exchange request, any anchor |

Any of these may be false, per `02` §4 — including the puzzle hints. **Note:** Records Room's hint no longer fits `{OBJECT} opens with {ITEM_REF}` cleanly since entry is puzzle-, not item-, gated — flagged for N-3's authored pass (E, deferred separately) rather than resolved here.

---

## 9. Audio

- **`music_cue`:** Records Room — the Climax Room doubles as the low-pressure discovery/breath moment (`13` §4.2, `11` §7). Climax ≈ music ≈ reward, by design.
- **Archetype bed:** one looping ambience for `signal_tower` (`13` §4.3).
- Entity telegraph (Watcher/Sound/Still Air) on the never-ducked Gameplay SFX bus (`13` §4.1, P-5).

---

## 10. Level Design Pass (VS-3 resolved)

### Room graph

```
Ground Relay (entry)
├── Records Room [branch, puzzle-locked, Climax Room]
└── Power Substation [Watcher, puzzle]
     └── Equipment Floor [Sound]
          ├── Storage Cache [branch]
          └── Antenna Shaft [Still Air]
               └── Broadcast Deck [chain tear → Hospital, `19`]
```

All vertical connectors are ladders (`11` §5 — free, always-usable, ungated). Branches are single doors, dead-ending back to their parent room.

### Per-room detail

| Room | Shape & scale | Sightlines / patrol | Hiding & cover |
|---|---|---|---|
| **Ground Relay** | Wide, single-height, open floor | Fully open — no entity, nothing to route around | One dedicated hiding spot present but unnecessary here; teaches the object before it matters |
| **Records Room** | Smaller, dense shelving rows (records-office dressing) | N/A — no entity | — |
| **Power Substation** | Rectangular, breaker panel along the back wall, 2–3 transformer housings as cover | Watcher fixed on a short catwalk, ~90° sweep across the panel, ~4s pass + ~2s pause at each end | Cover-break behind the housings between flips; one dedicated hiding spot near the panel as a fallback |
| **Equipment Floor** | Cluttered, maze-like rack layout | Sound has no fixed patrol — roams toward whatever noise it last heard | Clutter aids routing, not concealment (cover doesn't block sound); one dedicated hiding spot (crawlspace) for full protection |
| **Storage Cache** | Small, cramped closet | N/A — no/low danger | — |
| **Antenna Shaft** | Narrow vertical shaft, winding ladder path | Still Air on a fixed lap (~20–30s), no LOS — avoidance is pure timing, not routing | At least one hiding alcove partway up — the room's only reliable safety valve |
| **Broadcast Deck** | Open deck, tear as a chroma-lit centerpiece | No entity — breathing room before the crossing | — |

**Sensor parameters — updated from side-on blockout measurement (DL-18 / `11` M-2):**

| Entity | Parameter | Value | Source |
|---|---|---|---|
| Watcher (Power Substation) | Range | **6 tiles** | T-0192 blockout constant (unchanged) |
| Watcher (Power Substation) | Detection model | **1-D hemisphere** (facing direction + range on the floor plane) — not a 2-D cone | DL-18: SightConeSensorV2 is 1-D; cone visual is UX only |
| ~~Watcher (Power Substation)~~ | ~~Cone angle~~ | ~~90°~~ | ~~**void** — top-down estimate; the T-0192 sensor has no angle parameter~~ |
| Watcher (Power Substation) | Patrol cycle | **6 s** (3 s/direction, 0 s pause) | DL-18 measured (96 px / 32 px·s⁻¹ × 2) |
| ~~Watcher (Power Substation)~~ | ~~Sweep timing~~ | ~~"~4 s pass, ~2 s pause at each end"~~ | ~~**void** — top-down estimate; blockout code has no pause; 3 s measured~~ |
| Sound | Detection radius, walk | **1.5 tiles** | T-0192 blockout constant (was "~1–2 tiles") |
| Sound | Detection radius, run | **5 tiles** | T-0192 blockout constant (confirmed) |
| Still Air | Patrol lap time | ~20–30 s | Design estimate (no blockout yet) |
| Still Air | Catch radius | **1.5 tiles** | T-0192 blockout constant (confirmed) |

**DL-18 M4 finding — unavoidable detection on crossing path:**
The T-0193 measurement confirmed that no safe crossing exists from the cover pillar
(col 9) to the door (col 21) in the physical-patrol model: sight triggers at t ≈ 0.83 s
(col 10.8), ≈ 171 px short of the door. The Power Substation room requires either
a mid-zone hiding alcove or the Watcher redesigned as a fixed-position sweep entity
(as described in §3 above: "fixed on a short catwalk") rather than a physical patrol.

---

## 11. Scope Note (H)

**Correctly out of scope for solo vertical-slice testing:** the exit condition (`01` §5, several uniques held simultaneously), and every genuinely multiplayer system — escrow/offerings (`07` §7), live ratings (`02` §7), and broadcast petitions (`02` §6). None of these are missing; they require a populated network to exercise meaningfully and are validated separately (T-0096 for custody, the economy sim for supply/demand). A solo playthrough of `14`/`19`/`20` exercises the full moment-to-moment and archetype-chain loop, not the network-completion layer — that distinction is deliberate, not a gap.

---

## 12. Open

None — VS-1 through VS-4 all resolved. `14` is complete for the vertical-slice pass; remaining work is asset production and implementation, not design.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | Initial — Signal Tower vertical slice: room layout, entities, puzzle, item-locked door, tear, sample notes, audio | Claude, rev. pending |
| 2026-08-02 | v2: puzzle mechanism detailed (3-breaker light-chase, silent reset on wrong flip); Records Room formalized as the archetype's Climax Room (`11` §7) — resolves VS-4 and the music_cue reachability question; 2 minor collectibles added (Rusted Transit Pass, Corroded Antenna Fragment) | Claude, rev. @DennieSeth |
| 2026-08-02 | v3: **VS-3 resolved** — room graph, per-room shape/sightline/patrol/hiding detail, first-pass sensor parameters. All vertical-slice opens closed | Claude, rev. @DennieSeth |
| 2026-08-03 | **Room-count bug fixed.** §2's summary miscounted the tear pocket as a 9th room on top of "6 main + 2 branch," overflowing the run's 18-room cap (9+5+5=19). The table was always correct at 8 rows; only the prose was wrong. Corrected to 5 main + 2 branch + 1 pocket = 8, exactly at the archetype size ceiling. Caught by the pipeline chat | Claude, rev. @DennieSeth |
| 2026-08-03 | Sample note updated: "I need \{ITEM_REF\}" → "Need \{item_ref\}" to match `02` §2's named-slot/telegraphic-register revision | Claude, rev. @DennieSeth |
| 2026-08-03 | v4: **Climax made its own declared tag** (`signal_tower.climax`, co-located with `records_room`/`music_cue`), per `16` §1 — was previously an informal role description, not a lookup-able anchor | Claude, rev. @DennieSeth |
| 2026-08-03 | v5: **Archetype-chain redesign.** Records Room switched from item-locked to **puzzle-locked** (resolves the entry circularity); its Climax reward renamed **Resonance Key**, which now opens Broadcast Deck's tear — reclassified as a **chain tear** to Hospital (`19`), not a foreign pocket. Dead Frequency Room and the foreign Watcher relocated to Long Descent (`20`) as the run's terminal pocket tear. Signal Tower now 7 rooms (was 8). Power Substation's gate made an explicit object (D). Scope note added (H) clarifying exit/multiplayer systems are deliberately untested solo. Raised by @DennieSeth against a full-playthrough review | Claude, rev. @DennieSeth |
| 2026-08-18 | **DL-18 (T-0193): §10 sensor parameters updated from side-on blockout measurement.** Top-down estimates voided: "90° cone angle" (sensor is 1-D, no angle) and "~4 s pass, ~2 s pause" (measured: 3 s/direction, 0 s pause, 6 s cycle). Sound walk radius narrowed from "~1–2 tiles" to confirmed 1.5 tiles. M4 finding noted: no safe crossing from cover pillar to door in the physical-patrol model — Power Substation needs a mid-zone alcove or fixed-sweep Watcher redesign. | Claude, rev. pending |
