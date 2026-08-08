# GDD Discovery — Question Set

> **Author:** Claude (Opus 5) · **For:** @DennieSeth · **Status:** ARCHIVE — superseded
> Retained for provenance only. Tiers 1–3 and 6 are answered across the design docs; Tier 4 was **cut** (secret drops); Tier 5 is split between **05 Art Direction** and **13 Asset Pipeline**; Tier 7 is tracked in **GDD-OPEN** §5.
> The live inventory of what is still undecided is **GDD-OPEN**. Do not answer questions here.

---

## Tier 1 — Identity

**1.1 One sentence.** What is this game? Not genre — the sentence you'd say to a stranger.

**1.2 The core loop.** What does the player actually do, minute to minute?

**1.3 The note fantasy.** What is the emotional beat of encountering a stranger's message?

> *Reference: Dark Souls' answer was "you are alone in a hostile place; a stranger may be helping you or killing you." That one sentence generated the templated vocabulary, the ratings, and the lies.*

**1.4 Who are the other players, diegetically?** Ghosts? Prior expeditions? Parallel timelines? Anonymous contemporaries? Or non-diegetic — just a UI layer?

**1.5 Progression axis.** Knowledge / Power / Access / Hybrid?

**1.6 Failure.** Is there death/loss? What does it cost? Does failure leave a trace others can see?

---

## Tier 2 — Structure

**2.1 World topology.** Continuous map, or discrete rooms/levels?

> Technical consequence: continuous → real 2D geometry queries. Discrete → `zone_id` equality, dramatically cheaper.

**2.2 Session shape.** Persistent world, run-based (roguelite), or level-based?

**2.3 Do notes persist across sessions/runs?** If run-based, are notes tied to a seed, or global?

**2.4 World size.** Rough count of distinct zones/screens/rooms in v1.

**2.5 Camera.** Side-on / top-down / isometric / fixed-screen?

> Largest single multiplier on art volume. Isometric is ~4x the sprite work of side-on.

**2.6 Player character.** Visible avatar or abstract? Animated? How many animation states?

---

## Tier 3 — The Notes System

**3.1 Vocabulary budget.** How many templates? How many nouns per category?

**3.2 Can notes lie?** Is misleading other players a supported action?

**3.3 Does rating do anything mechanically?** Reward for the author? Visibility weighting only? Nothing?

**3.4 Density and decay.** How many notes visible at once? Do they expire?

**3.5 Placement cost.** Can players spam notes, or is placement limited?

**3.6 Can the player see their own notes' impact?**

**3.7 What can a note point *at*?** A position? A direction? An object? A hidden thing?

---

## Tier 4 — Secret Drops — **CUT**

Never answered; the system was cut as redundant with uniques, broadcast petitions, vocabulary tiers, and variant/puzzle unlocks. Questions retained for the record: what is dropped; does the recipient know it's rare; rarity target; is it shareable; repeatable; does it affect play or only perception; verifiability.

---

## Tier 5 — Presentation

**5.1 Art direction.** Pixel art / painted 2D / vector / monochrome / other?

**5.2 Internal resolution and aspect.** Fix this before generating a single asset.

**5.3 Palette.** Constrained (fixed N colours) or open?

> A locked palette is the single most effective tool for making heterogeneous generated assets look like one game.

**5.4 Asset inventory estimate.** Tiles, props, characters, VFX, UI.

**5.5 Music.** How many tracks? Looping ambient or adaptive? Diegetic?

**5.6 SFX count.** Rough.

**5.7 Does audio carry information?**

**5.8 UI language.** Diegetic/minimal or conventional HUD?

---

## Tier 6 — Scope & Production

**6.1 Target playtime.** First session, and to completion.

**6.2 Platforms for v1.**

**6.3 Distribution.** [itch.io](http://itch.io) / Steam / GitHub releases / self-hosted?

**6.4 Vertical slice definition.** The smallest build that proves the concept works.

**6.5 Explicit non-goals.** The only defense against scope creep when an agent pipeline makes adding things feel cheap.

**6.6 What happens if the server is down forever?**

**6.7 Localization.** Which languages at v1?

---

## Tier 7 — Risks

**7.1 Cold start.** The notes system is worthless with zero players.

**7.2 Empty-server experience.** What does a solo player with no network see?

**7.3 What breaks if it gets popular?** 10k notes in one zone — what's the curation story?

**7.4 What breaks if nobody plays?** Is the single-player experience self-sufficient?

**7.5 Fork risk.** Open source + open server means anyone can run their own instance or spoof clients.
