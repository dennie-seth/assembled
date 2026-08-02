# GDD Discovery — Question Set

> **Author:** Claude (Opus 5) · **For:** @DennieSeth · **Status:** superseded (Tiers 1–6); Tier 7 partly open
> Archived working doc from the pre-GDD dispatch session.
>
> **Superseded per `docs/HANDOFF.md` §1:** Tiers 1–6 answers now live in
> `01-vision.md`, `02-notes-system.md`, `05-art-direction.md`,
> `07-items-economy.md` (pending delivery), `08-invariants.md`,
> `09-identity.md`, and `10-time-and-progression.md` (pending delivery).
> **Tier 7 (risks) is still partly unanswered** — see
> `docs/design/OPEN-QUESTIONS.md` for what's left.
>
> Kept for historical record of how the Tier 1–6 questions were originally
> framed; do not use as a live spec.

Ordered by blast radius — Tier 1 answers change everything below them.

---

## Tier 1 — Identity

Nothing else can be decided until these are.

**1.1 One sentence.** What is this game? Not genre — the sentence you'd say to a stranger.

**1.2 The core loop.** What does the player actually do, minute to minute? Write it as a cycle:
`observe -> ? -> ? -> ?`

**1.3 The note fantasy.** What is the emotional beat of encountering a stranger's message?
> *Reference: Dark Souls' answer was "you are alone in a hostile place; a stranger may be helping you or killing you." That one sentence generated the templated vocabulary, the ratings, and the lies.*

**1.4 Who are the other players, diegetically?** Ghosts? Prior expeditions? Parallel timelines? Anonymous contemporaries? Or is it non-diegetic — just a UI layer?

**1.5 Progression axis.** What makes the player more capable over time?
- [ ] **Knowledge** — the player learns; the character never changes *(pairs natively with the notes system; enormous scope savings — no inventory, stats, gear, or balance pass)*
- [ ] **Power** — items, stats, upgrades
- [ ] **Access** — traversal abilities unlock regions (metroidvania)
- [ ] Hybrid: ______

**1.6 Failure.** Is there death/loss? What does it cost? Does failure leave a trace others can see?

---

## Tier 2 — Structure
*Blocks: T-0046 (radius query), Phase 5 scene architecture*

**2.1 World topology.** Continuous map, or discrete rooms/levels?
> Technical consequence: continuous -> real 2D geometry queries. Discrete -> `zone_id` equality, dramatically cheaper and simpler. Do not pick this for the tech reason, but know the cost.

**2.2 Session shape.** Persistent world, run-based (roguelite), or level-based?

**2.3 Do notes persist across sessions/runs?** If run-based, are notes tied to a seed, or global?

**2.4 World size.** Rough count of distinct zones/screens/rooms in v1.

**2.5 Camera.** Side-on / top-down / isometric / fixed-screen?
> Largest single multiplier on art volume. Isometric is ~4x the sprite work of side-on.

**2.6 Player character.** Visible avatar or first-person-ish/abstract? Animated? How many animation states?

---

## Tier 3 — The Notes System
*Blocks: T-0043 (template tables), T-0064/65 (rendering + composer)*

**3.1 Vocabulary budget.** How many templates? How many nouns per category?
> Every entry is a localization cost across every shipped language. Dark Souls shipped ~100 templates / ~200 words. Suggest starting at 20/60 and growing.

**3.2 Can notes lie?** Is misleading other players a supported action?
> If yes: ratings become functional, trust becomes a mechanic, and the system has teeth. If no: notes are pure assistance and the rating system is decorative.

**3.3 Does rating do anything mechanically?** Reward for the author? Visibility weighting only? Nothing?

**3.4 Density and decay.** How many notes visible at once? Do they expire? Score-decay? Cap per zone?

**3.5 Placement cost.** Can players spam notes, or is placement limited (consumable, cooldown, one-per-zone)?

**3.6 Can the player see their own notes' impact?** ("Your message was read 40 times.")

**3.7 What can a note point *at*?** Just a position? A direction? An object? A hidden thing?

---

## Tier 4 — Secret Drops
*The least-specified and possibly most distinctive system. Blocks T-0048, `secret_drops` schema.*

**4.1 What is dropped?** Cosmetic / real content / lore fragment / mechanical advantage?

**4.2 Does the recipient know it's rare?**
> The most consequential question in this section. Unmarked -> players don't know what's normal, and rumor/mythology emerges organically. Marked -> it becomes a collectible with a completion urge. These are different games.

**4.3 Rarity target.** What fraction of players should ever see a given drop? 1%? 10%? One player, ever?

**4.4 Is it shareable?** Can a player who received it tell others via the note system? *(If the vocabulary can't express it, they'll go to Discord — which may be exactly what you want.)*

**4.5 Repeatable?** One grant per player forever, or re-rollable?

**4.6 Does it affect play, or only perception?**

**4.7 Verifiability.** If a player claims they saw something, can anyone confirm it? Deliberate ambiguity is a design option here.

---

## Tier 5 — Presentation
*Blocks: T-0001b (LFS patterns), Phase 6 model/LoRA stack, Phase 7*

**5.1 Art direction.** Pixel art / painted 2D / vector / monochrome / photographic collage / other?
> Pixel art: KB-sized assets, plain git, mature LoRA ecosystem, forgiving of AI-gen artifacts, cheap to iterate.
> Painted: MB-sized, needs LFS, harder to keep stylistically consistent across many generated assets, less forgiving.
> **Recommendation given 8GB VRAM and solo scope: pixel art, unless the game's identity actively requires otherwise.**

**5.2 Internal resolution and aspect.** e.g. 320x180 @ 16:9, integer-scaled.
> Fix this before generating a single asset. Retrofitting resolution is a full redraw.

**5.3 Palette.** Constrained (fixed N colors) or open?
> A locked palette is the single most effective tool for making heterogeneous AI-generated assets look like one game. Strongly recommended.

**5.4 Asset inventory estimate.** Rough counts: tiles, props, characters, VFX, UI elements.

**5.5 Music.** How many tracks? Looping ambient or adaptive? Diegetic?

**5.6 SFX count.** Rough.

**5.7 Does audio carry information?** (Audio cues as puzzle content pairs very well with knowledge-progression.)

**5.8 UI language.** Diegetic/minimal or conventional HUD?

---

## Tier 6 — Scope & Production

**6.1 Target playtime.** First session, and to completion.

**6.2 Platforms for v1.** Windows only? +Linux? +Web export?

**6.3 Distribution.** itch.io / Steam / GitHub releases / self-hosted?

**6.4 Vertical slice definition.** The smallest build that proves the concept works. Be specific — this is the Phase 8 acceptance criterion.

**6.5 Explicit non-goals.** What is *not* in v1? Write these down; they're the only defense against scope creep when an agent pipeline makes adding things feel cheap.

**6.6 What happens if the server is down forever?** Confirm: the game is fully playable, notes silently absent. *(Assumed in T-0067 — confirm it's a design intent, not just an engineering fallback.)*

**6.7 Localization.** Which languages at v1? Affects the vocabulary budget in 3.1.

---

## Tier 7 — Risks

**7.1 Cold start.** The notes system is worthless with zero players. Seed with authored notes? Bot-generated? Ship with a starter set?
> Needs an answer before launch, not after.

**7.2 Empty-server experience.** What does a solo player with no network see? Is it still a complete game?

**7.3 What breaks if it gets popular?** 10k notes in one zone — what's the curation story?

**7.4 What breaks if nobody plays?** Is the single-player experience self-sufficient?

**7.5 Fork risk.** Open source + open server means anyone can run their own instance or spoof clients. Is that acceptable? (My read: yes, and probably a feature — but decide deliberately.)

---

## Answers Log

| Date | Question | Decision |
|---|---|---|
| | | |
