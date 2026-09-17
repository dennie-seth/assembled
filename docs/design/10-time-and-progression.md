# 10 — Time & Progression

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v2, locked
> Related: `01-vision.md` §6, `07-items-economy.md`, `08-invariants.md`
> **All timers in this document are wall-clock.** Real time passes whether or not the player is present. This is a design position, not an oversight.

---

## 1. Why One Document

The design has **four nested timers**. They interact, they must be tuned against each other, and tuning any one in isolation is how this breaks. They live here so that is impossible to forget.

```
collapse        weeks         identity     -> meta fail state
  unlock decay  min -> long   (variant,tag)-> re-exploration pressure
    escrow      48-72 h       anchored item-> social latency buffer
      held      60-75 min     inventory    -> anti-hoarding
```

---

## 2. The Four Clocks

| Clock | Scope | Duration | Job |
|---|---|---|---|
| **Held bleed** | item in inventory | **60–75 min** (≈2× run; sim-settled, DL-20) | Kills hoarding, forces circulation |
| **World / escrow** | item at an anchor | **48–72 h** | Lets exchange span sessions |
| **Unlock decay** | `(variant_id, tag)` | **minutes → long** (§3) | Keeps variants worth re-exploring |
| **Collapse** | identity | **~2–4 weeks nominal, ~1.5× for first universe** (V-10) | Ends the universe; the losing ending |

### Held vs. escrow must differ

At 90 minutes, escrow would be dead on arrival — nobody can find an offering, possess the demanded item, and pay before it evaporates. Exchange is a multi-session social process; held bleed is anti-hoarding pressure. **Different jobs, different constants.**

Fiction absorbs it without strain: *a thing anchored to a place is more anchored than a thing carried by someone whose universe is ending.*

### Held bleed at 60–75 min (sim-settled, DL-20)

Short enough that a long hold inside a single session bites, so bleed contributes real in-run tension. Nothing survives absence: whatever you carry at logoff is gone before you return.

The 60–75 min range was settled by simulation (Round 1 `RESULTS.md` Finding 2, confirmed
by T-0129's multi-point sweep). The cliff at `held_max = 75 min` tracks run length: items
return to the world within ~2 runs at the fast end; beyond 75 min a hoarder can hold through
an entire session without the item bleeding back. Starting value: ~68 min (midpoint); playtest
is the tuning gate for the exact value within the range. See DL-20.

> **Correction to `07` §5 (v1–v2).** Earlier drafts claimed bleed makes holding a rare item "tense rather than safe" while implying multi-day durations. At multi-day scale that was false. At 60–75 min it is true. Death still carries the moment-to-moment tension; bleed carries the *session* tension.

---

## 3. Unlock Tiers

Unlocks are per-`(variant_id, tag)` — you opened *that* door in *that* Hospital (`01-vision.md` §7).

Decay duration turns "unlock" into a spectrum, and the ends are different mechanics. Level design should treat them as such.

| Tier | Duration | What it actually is |
|---|---|---|
| **Tactical** | minutes | A shortcut opened and used *now*. Not progression at all. |
| **Session** | hours – days | Cross-session convenience. |
| **Unique-keyed** | **~1 week** (T-2), always < collapse | **The only thing that accumulates.** |

A month of play is built from **unique-keyed unlocks plus vocabulary**. Nothing else survives.

### How a unique unlock works

Using a unique to open a lock sends the instance onward to another player (`07` §3, "use"). The item circulates; the knowledge stays. **No new transfer rule is required** — the existing "use" semantics already do exactly this.

Framing matters: the player does not have a door propped open in a dead world. They *know how that lock opens*. It folds into "what you hold + what you know" rather than adding a fourth progression system. Storage is one small table.

```
unlock(identity, variant_id, tag, expires_at)
```

---

## 4. The Endgame Falls Out

Unique-keyed unlocks decay, and the unique that opened one has circulated away — so it is **not re-doable on demand**.

Each unique unlock therefore starts a **window**. The final act becomes a race: open the remaining unique locks before the earliest ones lapse.

**Convergence under decay, socially gated, on a real clock.** This is a far better ending than "wait for the third item to arrive," and it emerged from the decay rule rather than being designed in. Nothing new is required to support it.

---

## 5. Collapse

One collapsing universe per identity, dying on a wall-clock, whether or not the player is present (`01-vision.md` §6).

| Survives | Dies |
|---|---|
| Vocabulary tiers | Unlocks |
| Notes left | Held items (scatter) |

**A two-week absence costs the universe.** Brutal, coherent, and it makes the calendar month a countdown rather than a wait.

### Never shown as a number

Collapse proximity drives **chroma intensity** (`01-vision.md` §8). The screen is the clock. One shader parameter carries the entire meta-timer, and it costs no UI.

### Ratings do not slow collapse

Well-rated notes slow the **held bleed** timer (`02-notes-system.md` §7). They do **not** slow collapse.

Tempting — a strong pro-social pull — but a prolific solo player could extend their universe indefinitely, which re-opens exactly the permanent-lockout hole the clock was introduced to close. **Rejected.** If revisited, it must be a hard cap, never a multiplier.

### Ending & restart

Full sequence defined in `01-vision.md` §6 ("The Ending"): chroma overwhelm → summary (vocab tier, notes-left count) → a beat, no auto-continue → player-initiated restart. Same phrase, same identity — collapse ends the universe, not the identity (`09-identity.md` §3a).

### First-universe grace

The clock runs longer for a player's very first universe only — same mechanism as base duration, just a different multiplier (both sim territory, `08-invariants.md` §4). No pause/resume state: kept as a duration parameter, not a fifth clock-state, to avoid adding fragility to a system already flagged as breaking when tuned in isolation (§1).

---

## 6. Tuning Burden

Four interacting wall-clocks are the real balance problem, and none of them can be set analytically. The simulation (`08-invariants.md` §4) must model all four.

Known interaction risks:

| Risk | Detail |
|---|---|
| **Veteran run compression** | Unlocks make repeat runs faster; decay counteracts. Do they cancel? INV-9 has to measure it, not assume it. |
| **Re-work stacking** | Decay + variant unlocks (V-9) + pool growth all add unsolved locks to veterans. Three sources, one player. May over-correct into running to stand still. |
| **Does population actually help?** | Item flow *and* lock surface both grow with `P`. Which wins is not obvious and matters enormously — the pitch is "more players, faster progress." **The sim must confirm this is true.** |

---

## 7. Open

| # | Question | Severity |
|---|---|---|
| **T-1** | Exact collapse duration within the ~2–4 week bracket (§2) | sim tuning (V-10) |
| **T-2** | Exact unique-unlock decay within the ~1 week bracket (§3) | sim tuning |
| T-3 | Tactical / session tier durations | tuning |
| T-4 | Warning as collapse nears — is chroma alone enough? | design |

**T-1 and T-2 together define the shape of the entire late game — order of magnitude is now set; the sim finds the exact values within these brackets.**

**Resolved:** T-5 — first-universe grace multiplier, no pause state (§5). T-6 — beat + player-initiated restart (§5, `01-vision.md` §6). T-1/T-2 order of magnitude — collapse ~2–4 weeks, unique decay ~1 week (§2, §3).

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial — four clocks, unlock tiers, endgame race | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | Collapse cluster: T-5/T-6 resolved — ending/restart flow, first-universe grace multiplier | Claude, rev. @DennieSeth |
| 2026-08-01 | T-1/T-2 order of magnitude set: collapse ~2–4 weeks (~1.5× first universe), unique decay ~1 week | Claude, rev. @DennieSeth |
| 2026-08-02 | v2: status line corrected | Claude, rev. pending |
