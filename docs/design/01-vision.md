# 01 — Vision

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v3, locked
> Source: GDD sessions 2026-08-01. Supersedes `GDD-QUESTIONS.md` Tiers 1–6.

---

## 1. Premise

A universe is collapsing. As it dies it tears — and through the tears, other universes bleed in: their objects, their messages, their creatures, their colours.

You are trying to get out. You cannot do it alone.

**The other universes are other players.** This is not a metaphor layered over a multiplayer feature; it is the same fact stated twice. Every note, every item, every anomaly that reaches you came from another person's dying world. Asynchronous multiplayer *is* the fiction.

---

## 2. Design Pillars

| Pillar | Consequence |
|---|---|
| **The network is the world** | Nothing arrives from a designer. Everything arrives from someone. |
| **Alone you endure; together you escape** | Solo play is survivable and meaningful, but terminal. |
| **Colour is information** | Chroma encodes origin, foreignness, and threat. No HUD does this job. |
| **You cannot fight what came through** | Foreign entities obey foreign rules. Avoid, delay, hide. Never win. |
| **Nothing stays** | Items, enemies, offerings, notes, unlocks, universes — everything ends on a timer. |

---

## 3. Core Loop

```
explore -> survive -> find a tear -> cross (dangerous)
   -> recover something (item / knowledge / path)
   -> leave a trace at the tear
   -> someone else's trace opens your next tear
```

Crossing is an **action**, not a discovery: deliberate, costly, dangerous.

---

## 4. Progression

**Hybrid: access-gated, socially-keyed.**

The locks are physical — an item, a path, a way through. But the keys arrive from other players. You cannot manufacture your own progress; you can only make yourself worth helping, and wait for the network to deliver.

- No stats, no levels, no character power curve.
- No combat, so no gear or damage numbers.
- Capability = what you currently hold + **what you know**.

**"What you know" is mechanical, and it is the only thing that accumulates:**

| Persists | Scope | Ends when |
|---|---|---|
| **Vocabulary tiers** | identity | never |
| **Unlocks** | `(variant, tag)` | decay timer, or collapse |
| **Notes you left** | global | decay by rating |

Everything else — items, paths, position, the world itself — is temporary by construction. See `10-time-and-progression.md`.

---

## 5. Completion

**Genuinely gated.** A single player cannot finish the game.

The exit requires **several unique items held simultaneously in one run**. Uniques circulate permanently and are exempt from supply scaling (`07-items-economy.md` §2), so the wait is for the right ones to reach you at the same time — socially gated by construction, needing no additional system.

> **Hard rule: exit progress never persists.** The condition is evaluated at the instant of simultaneous possession, every time, forever. There is no partial credit, no saved progress, no accumulation.
>
> This is pillar-level and non-negotiable. If exit progress accrued the way unlocks do, a patient solo player would eventually walk out alone and "you cannot finish alone" would die quietly — no bug, no error, just the design dissolving over forty runs. (`08-invariants.md` INV-13.)

Two mitigations keep the gate honest rather than cruel:
- **Seeded ghosts** — the server carries a corpus of authored and historical notes/offerings, so a solo or low-population player always encounters *someone*.
- **Broadcast petition** — a unique-tier note asks the whole network at once. When population is thin, ghosts answer. (`08-invariants.md` INV-8.)

**Server unreachable:** the game runs, the player explores and survives and progresses partway, but the ending is unreachable. Design intent, not a failure state.

> Supersedes plan task **T-0067** — "fully playable offline" is revised to "fully *runnable* offline, not completable."

---

## 6. Runs, Death, and Collapse

Three nested scopes. Conflating them was a real bug in v1–v2 of this document.

```
identity   -> one universe, dying on a wall-clock. Weeks.
  run      -> one waking. 30–45 min. Ends in death or logoff.
    room   -> one screen. ~15 per run.
```

### The universe is yours, and it is singular

**One collapsing universe per identity.** It dies continuously, on a wall-clock, whether or not you are playing.

Each run is you waking up in **another configuration of the same dying universe** — further along, differently assembled, the same place. This is why the Hospital is always the Hospital.

> **Correction to v1–v2.** Earlier drafts said *new run = new universe*. That was incoherent with the premise — why would a fresh universe already be dying? — and it silently destroyed the fail state: if death granted a new universe, the collapse clock could never expire. Die before it runs out, forever.
>
> Death ends a **run**. Only the clock ends the **universe**.

### Death

Traps and foreign entities kill. Death ends the run.

- Held items scatter into the network — they surface in other players' worlds.
- The next run seeds with items and notes from elsewhere.
- **Unlocks survive.** They belong to the universe, not the run.
- Notes and vocabulary persist.

Death is **generative**, not punitive: it is the primary engine that circulates content through the network.

### Collapse — the meta fail state

When the clock expires, your universe finishes dying. You did not get out. **That is the losing ending**, and until now the design did not have one — "alone you endure" was structurally true but never happened to anyone.

| Survives collapse | Dies with the universe |
|---|---|
| Vocabulary tiers — knowledge of the multiverse | Unlocks — knowledge of *that* Hospital, and it is gone |
| Notes you left | Held items (scatter, as on death) |

A returning player is fluent but genuinely starting over.

Collapse also resolves the design's cruelest state. A solo player with every path known, standing at a door needing a third unique, does not stand there forever. Their universe ends. **Losing is kinder than waiting.**

---

## 7. World Structure

Three levels. Keeping them distinct matters — different budgets, different scaling behaviour.

| Level | Meaning | Count |
|---|---|---|
| **Archetype** | A named place. *Hospital, Signal Tower, Long Descent.* | 12–15 in v1 |
| **Variant** | One authored realization of an archetype. Same place, different configuration. | 1 at launch, grows |
| **Room** | A screen-scale space inside a variant. | ~15 visited per run |

A run selects **5–7 archetypes**, picks one **variant** of each, and assembles them.

### Anchor tags

Rooms carry named spawn points — `hospital.ward_north`, `hospital.stairwell` — declared by the archetype and implemented by every variant.

```
anchor = (archetype_id, anchor_tag)
```

Notes and items bind to **tags, not coordinates**:

- Variants may differ freely in layout. Only the tag set is contractual.
- A note left in one Hospital surfaces in every Hospital, in every universe.
- Spatial queries disappear — lookup is equality, not geometry. *(Settles `PLAN.md` open question 2 in favour of discrete.)*
- A variant missing a required tag is a **build failure**, not a runtime surprise.

**Unlocks, by contrast, are per-variant** — `(variant_id, tag)`. You opened *that* door in *that* Hospital. This is deliberate: it rewards exploring every variant for its own clues, notes, and items, rather than solving an archetype once and being done.

### Content release scales with population

All content — items, vocabulary, variants — is **authored up front and released gradually**. As population grows, more variants become eligible when a universe is configured.

**What scales is variety, not size.** A run is ~15 rooms at any population. On a quiet server the Hospital is always the same Hospital; on a busy one it could be any of six. Per-player pacing is constant; the world gets *deeper*, never longer. (`08-invariants.md` INV-9.)

**Enemy layer is local.** Each universe rolls its own hazards. Consequence: warnings in notes are *unreliable* — someone warning of a horror you do not have is not lying, they are simply from elsewhere.

---

## 8. Presentation

**Art:** pixel art, locked palette, side-on camera. **384×216**, integer-scaled.
**Direction:** abandoned Soviet constructivism and brutalism. See `05-art-direction.md`.

### Chroma = distance from home

The home universe is muted — concrete, oxide, institutional greens. Anything that bled in renders in **its own palette**, and the further it travelled, the more chromatically violent it is.

| Effect | Mechanism |
|---|---|
| Foreign objects readable at a glance | Palette swap on render, indexed by origin |
| Threat legible before contact | Danger correlates with foreignness correlates with saturation |
| **Time remaining visible in the frame** | Chroma intensity is driven by **collapse-clock proximity** |
| Zero UI cost | No labels, no icons, no tooltips |

The collapse clock is never shown as a number. **The screen is the clock.** A late universe is chromatically overrun, and the player reads how long they have from how wrong the world looks. One shader parameter carries the entire meta-timer.

**Player character:** visible avatar. Four animation states — idle / move / crouch-hide / die. No combat states.

**Camera:** side-on. Cheapest animation, clearest sightlines for avoidance play, best-supported by pixel-art LoRAs.

---

## 9. Scope & Distribution

| | |
|---|---|
| **Run length** | 30–45 min |
| **Session** | 45–90 min, 1–3 runs |
| **Universe lifetime** | weeks — ~1 month worst case at low population |
| **Platforms v1** | Windows + Linux |
| **Distribution** | itch.io confirmed. Steam probable — cleared, see below. |

**Steam AI disclosure (verified 2026-08-01):** the Jan 2026 rewrite scopes disclosure to content players consume. Generated sprites and audio need a Tier 1 pre-generated disclosure on the store page; Claude Code and other dev tooling are explicitly exempt. No live generation anywhere in this design — notes are integer lookups — so Tier 2 does not apply. Valve does not reject games for AI content when disclosure is accurate, but does enforce against omission. Residual risk is commercial, not procedural: AI-disclosed titles show measurably worse review behaviour.

---

## 10. Non-Goals (v1)

- No combat, weapons, damage, or health bars
- No character stats, levels, or skill trees
- No real-time multiplayer or player co-presence
- No free-text player input, anywhere, ever
- **No persistent exit progress** (§5) — pillar-level
- **No accounts, no email, no PII** — identity is a seed phrase (`09-identity.md`)
- **No AI generation at runtime** — all generation is offline, pre-shipped
- No procedural room generation — variants are authored
- No voice, no cutscenes, no branching dialogue
- No item crafting beyond the workbench transmuter
- No in-game moderation tooling (unnecessary by construction)

---

## 11. Open

| # | Question | Blocks |
|---|---|---|
| V-5 | Home palette — exact hex set | **Phase 6** |
| V-6 | Localization set for v1 | vocabulary budget |
| V-7 | Vertical slice definition | Phase 8 acceptance |
| V-8 | Cold-start: size and authorship of the seeded-ghost corpus | launch |
| V-9 | Variant release schedule — which population thresholds unlock what | balance |
| V-10 | Collapse duration, and whether it varies with anything | **simulation** |
| V-11 | What the losing ending actually shows | content |

**Resolved:** V-1 (§9) · V-2 (Windows + Linux) · V-3 (itch, Steam cleared) · V-4 (384×216)

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial, from GDD session | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | v2: archetype/variant/room model, anchor tags, population-scaled variety, art direction, platforms | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | v3: **identity-scoped collapse clock replaces "new run = new universe"**; meta fail state; exit-never-persists rule; per-variant unlocks; chroma drives collapse readout; V-1/V-4 resolved | Claude (Opus 5), rev. @DennieSeth |
