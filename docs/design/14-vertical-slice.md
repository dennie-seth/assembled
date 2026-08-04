# 14 — Vertical Slice: Signal Tower

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, repo copy — **Notion is canonical, this may lag**
> Related: `01-vision.md` §3/§7 (anchor tags), `05-art-direction.md`, `11-moment-to-moment.md` (entities, puzzles, hiding), `12-tears.md`, `13-asset-pipeline.md` §6 (concept art), `PLAN.md` Phase 8
> **Purpose:** the concrete room-by-room content for Phase 8's vertical slice, and the first archetype concept art (`13-asset-pipeline.md` §6) conditions against.

---

## 1. Archetype

**`signal_tower`** — an abandoned Soviet-brutalist comms/broadcast tower.
Structurally a **vertical climb**: rooms stack rather than sprawl, and the
player ascends via ladders and stairwells rather than corridors. This is
a deliberate contrast with a more horizontal archetype (e.g. a hospital)
— the vertical slice should exercise both traversal shapes early rather
than discover the difference is hard once more archetypes exist.

Direction and palette process per `05-art-direction.md` and
`13-asset-pipeline.md` §6: concrete, oxide staining, institutional green,
exposed relay/antenna equipment. The Signal Tower is the **first
archetype through concept review** (T-0104) — its approved concept sheet
is what T-0105 extracts the home palette from, and what T-0106 will later
condition every other Signal Tower concept sheet against.

---

## 2. Rooms

Eight rooms, bottom to top. Entities and pressure escalate with altitude
— the climb gets more dangerous, not just longer.

| # | Room | Tags | Notes |
|---|---|---|---|
| 1 | **ground_relay** | entry | Ground floor. Relay equipment, the climb's starting point. |
| 2 | **records_room** | `optional`, `music_cue`, `Clearance-Chit` door | Optional side room, gated behind a Clearance-Chit item. Low-pressure per `13-asset-pipeline.md` §4.1 — a `music_cue` room, not a threat room. |
| 3 | **power_substation** | entity: The Watcher, puzzle: restore-power | Sight-cone-only entity (`11-moment-to-moment.md` §1) — telegraphed, avoidable by routing. Restore-power puzzle (environmental-logic type, `11` §6) grants the **Relay Fuse** on solve. |
| 4 | **equipment_floor** | entity: The Sound | Sound-radius-only entity — roams, converges on noise. Punishes running blind through exposed equipment. |
| 5 | **storage_cache** | `optional` | Optional side room. Contains the **Copper Coil**. |
| 6 | **antenna_shaft** | entity: The Still Air | Narrowest, most dangerous room in the slice. No line-of-sight check (`11-moment-to-moment.md` §1) — audio is the only warning (`13-asset-pipeline.md` §4.0), which is exactly why P-5 (gameplay SFX never ducked) exists. |
| 7 | **broadcast_deck** | climax, tear | The climax room. Contains the run's tear (`12-tears.md`) — rare, deliberate, round-trip, re-crossable. |
| 8 | **dead_frequency_room** | beyond tear, foreign palette, item: Fractured Receiver | Beyond the tear. Renders in a **foreign `origin_palette`** (`01-vision.md` §8, `07-items-economy.md` §1) — chroma signals "not home" the moment the player crosses. Contains the **Fractured Receiver**. |

### Progression shape

```
ground_relay
  -> records_room [optional, behind Clearance-Chit]
  -> power_substation [The Watcher, restore-power puzzle -> Relay Fuse]
  -> equipment_floor [The Sound]
  -> storage_cache [optional, Copper Coil]
  -> antenna_shaft [The Still Air, narrowest/most dangerous, no LOS]
  -> broadcast_deck [climax, the tear]
  -> dead_frequency_room [beyond tear, foreign palette, Fractured Receiver]
```

Entities escalate bottom to top: a stationary sight-cone entity first
(most avoidable), then a roaming sound-sensitive one, then a no-LOS
patrol entity immediately before the climax. This mirrors
`11-moment-to-moment.md` §1's sensor-kit ordering — each sensor type
introduced in isolation before the climax asks the player to have
internalized all three.

---

## 3. Anchor tags

Every room's tags above are **anchor tags** — the same mechanism used for
notes, items, and tears (`01-vision.md` §7): `(archetype_id, anchor_tag)`.
No new placement system. `records_room`'s `music_cue` tag and
`broadcast_deck`'s `tear` tag are both ordinary anchor tags, checked by
the same INV-12 build-time coverage guard as every other tag on this
archetype.

---

## 4. Items

| Item | Source | Rarity (per `07-items-economy.md` §2) |
|---|---|---|
| **Relay Fuse** | Puzzle reward, `power_substation` | Puzzle-granted — draws from the existing capped spawn pool, not a new source (`07` §4) |
| **Copper Coil** | World pickup, `storage_cache` | Ambient Poisson spawn, per `(archetype_id, anchor_tag, tier)` |
| **Fractured Receiver** | World pickup, `dead_frequency_room` (beyond tear) | Same capped-pool sourcing; `origin_palette` is foreign, so it carries visible chroma once brought home |

---

## 5. Notion sync note

This document is a **repo copy** of the canonical Notion doc "14 —
Vertical Slice: Signal Tower." Notion is the source of truth; this file
may lag behind it. This copy exists so the repo's own design-doc set is
self-consistent for the concept-art work (T-0104/105/106) that depends on
this room list, not to fork the design.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | Initial repo copy — 8-room Signal Tower vertical slice, anchor tags, items, entity escalation | Claude, rev. pending |
