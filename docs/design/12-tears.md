# 12 — Tears

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, locked — A-II resolved
> Related: `01-vision.md` §3 (core loop), §7 (anchor tags), `02-notes-system.md`, `07-items-economy.md` §7, `08-invariants.md` INV-12, `GDD-OPEN.md` A-II
> **Purpose:** define the core-loop verb. Currently a noun in a diagram (`01` §3) — this resolves it.

---

## 1. What a Tear Is

A tear is a **declared anchor tag**, same mechanism as notes and items (`01` §7): `(archetype_id, tear_tag)`. Every variant of an archetype must implement every tear tag the archetype declares — same **INV-12** build-time check as any other anchor tag.

No new placement system. A tear is structurally identical to a note/item anchor; only the verb performed there differs.

---

## 2. Frequency

**Rare, deliberate set-piece: 1–3 per run.** Not a room-to-room connector — normal traversal (doors, ladders, switches, `11-moment-to-moment.md` §5) stitches the ~15 rooms together. A tear is a distinct, weightier action layered on top, matching the pillar's "deliberate, costly, dangerous" framing (`01` §3) rather than ambient movement.

---

## 3. Crossing

| Property | Answer |
|---|---|
| **Danger** | What's beyond the tear — a hostile room/pocket. Not a hazard in the crossing act itself. |
| **Cost** | None mechanical. Risk of death **is** the cost — consistent with the no-resource-pressure rule (`11` §4). |
| **Trip type** | **Round trip** — player returns through the same tear after recovering something. |
| **Reuse** | **Re-crossable.** Not consumed after first use — a player may cross the same tear multiple times within a run. |
| **Room budget** | The room beyond **counts toward** the run's ~15-room total — not extra/bonus content. |
| **Tags per archetype** | **Fixed at one** tear tag per archetype. |

### Content beyond the tear

**Both authored and player-sourced.** The room itself is authored per-archetype "pocket" dressing (no procedural generation, per `01` §10 non-goals) — but what's found inside (notes, items) is populated from the same player-left content pool as any other anchor.

### Reward accounting

Same rule as puzzle item rewards (`07` §4, `11-moment-to-moment.md` §6): anything found beyond a tear draws from the **existing capped spawn pool** — a guaranteed delivery point, not a new source. This matters more here than for puzzles: round-trip + re-crossable means a player could revisit the same tear repeatedly in one run. Accounting stays identical regardless of revisit frequency, so INV-6 holds without special-casing.

---

## 4. Leave a Trace

Reuses the existing notes/exchange system (`02`, `07` §7) — no new object. After crossing, recovering, and returning, the player leaves a note or offering anchored at the tear tag, same as any other anchor.

*Audio note:* tear rooms are the highest-pressure content in a run, so they are poor candidates for a `music_cue` tag — music is better spent marking low-pressure set-pieces (`13-asset-pipeline.md` §4.1).

**"Someone else's trace opens your next tear" (`01` §3) is thematic, not a hard gate.** Tears are always crossable. The line describes the emergent value of the network — what you find beyond a tear is shaped by what others left there — not a blocking precondition. No exception logic required.

---

## 5. Open

None — TR-1 through TR-4 resolved. A-II is closed for the vertical slice.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial — tear defined as anchor tag, frequency, crossing properties, trace framing resolved for A-II | Claude, rev. pending |
| 2026-08-01 | v1 locked — room budget, content sourcing, tag count, re-crossability, reward accounting resolved | Claude, rev. pending |
| 2026-08-02 | cross-ref added — tear rooms are high-pressure, so `music_cue` placement belongs elsewhere (`13` §4.1) | Claude, rev. pending |
