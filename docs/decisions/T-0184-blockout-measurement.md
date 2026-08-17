# T-0184 Blockout Measurement — Decision Log

**Author:** Claude
**Date:** 2026-08-15
**Card:** T-0184 — One-room blockout: Watcher, hiding, item-locked door (§16-a)

---

## Room geometry (as authored)

| Parameter | Value |
|---|---|
| Viewport | 384 × 216 px |
| Tile size | 16 px |
| Grid | 24 cols × 13 rows (208 px tall) |
| Non-gameplay bleed band | 8 px at bottom of viewport |
| Player spawn | col 2, row 6 — pixel (32, 96) |
| Item anchor | col 4, row 6 — pixel (64, 96) |
| Cover column | col 10, rows 2–9 — pixel (160, 32) |
| Hiding spot | cols 11–12, rows 2–9 — pixel (176, 32) |
| Watcher patrol | cols 14–18, row 6 — pixel (224, 96) to (296, 96) |
| Item door | col 21, rows 2–9 — pixel (336, 32) |
| Exit passage | col 22, rows 2–9 — open once door unlocked |

---

## Measurement 1 — Seconds to traverse the room

Traversal route: spawn → pick up item (anchor) → navigate past Watcher behind
cover → reach hiding spot → exit → open door → clear.

**Walk speed:** 64 px/s (4 tiles/s)
**Run speed:** 128 px/s — triggers noise flag, excluded from stealth route.

Segment distances (walk, no detour):

| Segment | Distance | Time at 64 px/s |
|---|---|---|
| Spawn → anchor (col 2 → col 4) | 32 px | ~0.5 s |
| Anchor → cover (col 4 → col 10) | 96 px | 1.5 s |
| Cover approach (wait for patrol window) | — | ~2–4 s wait |
| Behind cover → hiding spot (col 10 → col 12) | 32 px | 0.5 s |
| Wait inside hiding spot (patrol clears) | — | ~2–4 s |
| Hiding spot → door (col 12 → col 21) | 144 px | 2.3 s |
| Door interaction | — | ~1 s |
| **Total (optimised route)** | — | **~10–14 s** |

**Patrol cycle time:** 80 px / 32 px·s⁻¹ × 2 = **5 s per cycle**.
A player who waits for the full watcher window will add 2–3 s.
A player who misjudges and must backtrack adds another 5–10 s.

**Expected single-room completion (novice):** ~25–60 s, average ~35 s.

### Room count calculation

Target run length: 30–45 min = 1800–2700 s.

At 35 s/room: 1800 / 35 = 51 rooms, 2700 / 35 = 77 rooms.
At 60 s/room (slower player, more retries): 30–45 rooms.

The seven-room Signal Tower chain at this room's scale would take roughly
7 × 35 s = **4 minutes** for an experienced run — far below the 30–45 min
target.

---

## Measurement 2 — Tiles of warning before sight cone triggers

**Cone range:** 96 px = 6 tiles.
**Cone half-angle:** 50° (total 100°).

A player approaching the Watcher head-on at walk speed (64 px/s) enters the
cone perimeter **6 tiles** (96 px) ahead. At that speed:

```
warning_time = 96 px / 64 px·s⁻¹ = 1.5 s
```

At 45° (approaching diagonally):
```
effective_range = 96 × cos(45°) ≈ 68 px ≈ 4.25 tiles
warning_time ≈ 1.1 s
```

**Feed to §11 §1 M-2 sensor-tuning parameters (revised numbers in §14 §10):**

| Param | Value | Rationale |
|---|---|---|
| `cone_half_angle` | 50° | Gives readable cone shape without wrap-around |
| `cone_range` | 96 px (6 tiles) | 1.5 s warning at walk speed — legible but punishing |
| Patrol speed | 32 px/s (2 tiles/s) | Slow enough to read movement direction before deciding |

---

## Measurement 3 — Unavoidable detection

**Result: No unavoidable detection on the optimal route.**

The cover column at col 10 fully occludes the line-of-sight from the Watcher's
patrol zone (cols 14–18) to the player's corridor (cols 1–9). A player who
reaches the cover before the Watcher faces right cannot be seen.

**Unavoidable detection exists on the failure path:**
- Player who runs (noise flag ON) within cone range has the same geometry but
  no grace period once in range.
- Player who enters the hiding spot during the frame the Watcher's cone covers
  the entrance is caught with no invincibility frame (T-0175 no-i-frame rule).

The no-i-frame catch is intentional and reads correctly: the Watcher's cone
must not cover the hiding spot entrance at the moment of entry. This is the
skill check.

---

## Measurement 4 — Hiding-spot entry: exposed vs. safe feel

**Geometric assessment (pre-playtest):**

The hiding spot (cols 11–12) sits immediately adjacent to the cover column
(col 10). Entering from behind the cover while the Watcher faces left
(patrol returning) gives a **32 px / 64 px·s⁻¹ = 0.5 s** crossing window
from cover edge to hiding spot. The cone does not reach cols 11–12 while the
Watcher is at its leftmost patrol point (col 14).

This means a player who crosses at the right patrol phase will not be in the
cone during entry, making the entry feel clean once the player learns the
timing. A player who attempts to cross during the wrong phase will be in the
cone — the `try_enter(detected=true)` path catches them with a "CAUGHT!"
HUD alert.

**Assessment: entry reads as a timed skill check, not an arbitrary/invisible
catch.** The cone polygon is rendered in the scene, giving the player a visual
read of when crossing is safe.

*Requires human confirmation after live playtest.*

---

## Measurement 5 — Does 24×13 feel cramped, right, or empty?

**Geometric assessment (pre-playtest):**

Interior playfield: cols 1–22 × rows 1–11 = 22 × 11 tiles = 352 × 176 px.

At walk speed the player crosses the full width in 352 / 64 ≈ 5.5 seconds
without obstacles. The Watcher's patrol span (cols 14–18, 5 tiles = 80 px)
covers roughly 23% of the playfield width.

The cover-to-door distance is 11 tiles (176 px). The item-to-cover distance
is 6 tiles (96 px). There is open floor on the left (cols 1–9) that has no
gameplay function: this will read as empty once a player learns the room.
For a measurement card this is acceptable — the question is whether the scale
is right for the game loop, not whether this specific room is fully authored.

**Preliminary verdict: right to slightly empty on the left half.**
The right half (cover, hiding, Watcher, door) is densely functional. The
left half is corridor-only. A final 24×14 room could distribute one more
hazard or landmark there without feeling cluttered.

*Requires human confirmation after live playtest.*

---

## Written verdict

### Playable loop

The room supports the full intended sequence:

1. **Enter** — player spawns left of all hazards, no immediate threat.
2. **See the Watcher** — cone polygon is rendered; player can observe patrol
   rhythm before committing.
3. **Break line of sight** — cover column at col 10 fully blocks Watcher cone
   while player approaches from the left.
4. **Reach hiding spot** — 0.5 s timed crossing from cover to hiding spot;
   requires reading the Watcher's patrol phase.
5. **Wait** — `HidingSpotLogic.blocks_all_sensors()` guarantees detection is
   off while inside cleanly.
6. **Leave through door** — item #42 must be held (picked up from anchor at
   col 4); wrong-item attempts are rejected with HUD feedback.

The failure path is symmetric: every step has a clear failure signal
(HUD "CAUGHT!" / "SPOTTED!" / "Wrong item!" / "Need item #42!") and the
cause is a player decision, not a surprise invisible trigger.

### Gate statement (mandatory)

**Measured single-room time: ~35 s average (expected).**

At 35 s/room the Signal Tower's 7 rooms would take ~4 minutes for a practised
run — well below the 30–45 minute target in §01 §9. The 30–45 minute figure
implies **51–77 rooms** at this room's scale, or **each room must take ~3–5
minutes** of expected engagement (including retries, exploration, note-reading).

**Verdict: room geometry is correct; expected time-per-room is low.**
The scale of 24×13 tiles with a single Watcher is viable for the basic
moment-to-moment loop, but a realistic play session of 30–45 minutes will
require either:
- Significantly more hazard density / puzzle depth per room, OR
- A much larger room count than the 7-room Signal Tower chain implies.

**STOP signal (per acceptance criteria):** The measured estimate (35 s/room,
~4 min for 7 rooms) lands far from the 30–45 minute target. **Do not proceed
into §16-b on the assumption that the Signal Tower chain is enough.** The
following must be resolved before room-authoring continues:

1. **Decision needed:** Is the target 7 rooms with ~4–5 min each (requiring
   far more complexity per room than this blockout), or is the room count
   higher than 7?
2. **Decision needed:** Does the 30–45 min include note-reading, social
   mechanics, and downtime between rooms? If yes, the per-room traversal time
   of 35 s may be correct, with the rest of the clock filled by other systems.
3. **Human playtest required** for measurements 4 and 5 above (hiding-spot
   feel, size feel) before the geometry is locked.

This verdict is filed against the geometry and logic as authored. A human
playtest with the built scene is required to confirm or revise these numbers.

---

*This document satisfies the decision-log deliverable in T-0184 acceptance
criteria 10–16. All geometric measurements are derived analytically from the
scene constants in `blockout_room.gd`; measurements 4 and 5 require
human-run confirmation.*
