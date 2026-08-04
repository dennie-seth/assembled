# 18 — First-Run Experience

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, draft
> Related: `09 — Identity` §1/§3a, `03 — Net Protocol` §5/§6, `01 — Vision` §6/§8/§10, `02 — Notes System` §5/§11, `14 — Vertical Slice` (Ground Relay pattern)
> **Purpose:** what a brand-new player experiences before and during their first run. Closes the last of the three previously-uncovered topics (level design, localization, first-run).

---

## 1. Trigger & Sequence

Press **New Game** → identity created (`POST /v1/identity`) → phrase-reveal screen (unskippable) → offline notice, if unreachable → drop into the first run at the archetype's calm entry room.

---

## 2. The Phrase Moment

- Triggered by **New Game**. Server generates the phrase and returns it exactly once (`03` §5); the client **immediately auto-saves it to a plain text file** in the local save directory — no manual export step, no clipboard dependency. This removes the "I forgot to save it" failure mode entirely rather than warning against it.
- Full-screen, unskippable, nothing else competing for attention.
- **Requires explicit acknowledgment** before continuing — not a claim that the player personally saved it (the client already has), but confirmation that they've read and registered what it means. A dismissible "Continue" button lets this get glossed over like a EULA; an acknowledgment keeps it a real moment.
- **Draft copy** (illustrative — needs a full authored pass against `17` §5's register rules, FR-2):
  > *This phrase is you. It's already saved at \[path\] — write it down somewhere else too, if you want.*
  > *Lose it, and there is no way back. No password reset. No support ticket. This is how the world works.*
  > **\[ I understand \]**
- **Names both endings explicitly** (`09` §3a — they're different losses, worth distinguishing here rather than only after the fact):
  - *Lose the phrase → lose everything. Vocabulary, notes, the world itself — gone.*
  - *Let the universe collapse → lose that universe's unlocks and whatever you're holding. You keep the phrase, and what you've learned.*

---

## 3. Teaching the Clock Without a Number

**Order matters:** calm exploration first (a few minutes — matches the vertical slice's Ground-Relay-style entry, `14` §10), *then* the one-time chroma explanation. The player needs to have seen the "normal" palette before being told it will drift, or the explanation has nothing to anchor to.

One-time textual note, no numbers, ever:

> *Draft: "The color of this place isn't decoration. Watch how it changes — that's your only clock, and it never lies."*

**The first-universe grace multiplier (~1.5×, `01` §6/§9) stays completely invisible to the player.** It's protective design intent, not a stated fact — surfacing it ("you get bonus time your first run") would undercut the fiction's weight for no benefit.

---

## 4. Offline Signaling

Per `03` §6's explicit UX obligation:

- **Pre-play:** unmissable notice if the server is unreachable at launch — *"This universe can't be reached. Nothing that happens here will be remembered."* Blocks continuing until acknowledged — same weight-class as the phrase screen, distinct tone (a warning, not a rite).
- **During play:** a small, persistent, non-diegetic indicator — the one deliberate exception to the no-HUD aspiration (`GDD-OPEN` 5.8), justified because honesty here is load-bearing, not decorative.
- **Session end, still offline:** a recap reminder that nothing from this session was saved. Prevents exactly the failure `03` §6 flags: "a player who loses a forty-minute run they did not know was unrecorded will read it as a bug, and they will be right to."

---

## 5. Core Loop — Taught by Rooms, Not Text

No tutorial popups for movement, hiding, or traversal. The first room a player ever stands in is deliberately calm and entity-free — the pattern already used for Signal Tower's Ground Relay (`14` §10): a hiding spot exists there before it matters, a ladder exists before it's urgent.

**This is now a stated principle, not a one-off choice:** every archetype's first reachable room should give the player a zero-risk look at its interaction vocabulary (`11` §5) before any Hazard room asks them to use it under pressure.

---

## 6. Vocabulary & Notes

No explicit tier explanation. The note composer (dropdown-only, `PLAN` T-0065) shows exactly what's currently available; unlocking new vocabulary reads as gaining voice (`02` §5), not as a gate being explained to you.

---

## 7. Cold Start

A first-run player must never encounter an empty, lifeless archetype, even with zero real players on the network yet. Seeded ghosts (`02` §11) carry this — full richness depends on V-8 (corpus size/authorship, still open), but the intent holds regardless of corpus size specifics.

---

## 8. Non-Goals Reaffirmed

No voice, no cutscenes, no branching dialogue (`01` §10). The entire first-run sequence is text (phrase screen, offline notice, one clock explanation) plus environment. Nothing else.

---

## 9. Resolved

**S-3 resolved:** the phrase is auto-saved to a plain text file in the client's local save directory the instant it's generated — no manual export step, no clipboard-copy dependency. Removes the failure mode rather than warning about it.

---

## 10. Open

| # | Question |
|---|---|
| FR-1 | Exact save path / filename convention for the phrase file |
| FR-2 | Full authored copy pass for all first-run text, against `17` §5's register rules |
| FR-3 | Exact timing of "a few minutes" before the chroma explanation — tuning |
| FR-4 | Does the offline persistent indicator have a visual spec yet, or does that belong in `13`/`05`? |

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-03 | Initial — phrase-reveal sequence, clock-teaching timing, offline signaling, room-as-tutorial principle, cold-start note. S-3 resolved (auto-save, no manual export) | Claude, rev. @DennieSeth |
