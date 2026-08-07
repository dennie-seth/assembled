# Open Questions — Tuning & Parameters

> **ARCHIVED (2026-08-04)** — superseded by `docs/GDD-OPEN.md` §4 (Class D)
> and the committed sim tuning results (`tools/sim/results/`). Kept for
> history.

> **Author:** Claude (Opus 5)
> **Status:** live — blocked on @DennieSeth
> Source: `docs/HANDOFF.md` §6. These are **not tasks.** Nothing in the
> current backlog is blocked on them — the economy simulation harness
> (T-0099) and its structure are unblocked; only the final tuning sweep
> needs these answered. Do not guess at them; do not create task cards for
> them.

---

| # | Question | Blocks |
|---|---|---|
| **T-1** | Collapse duration. Fixed weeks? Varies with anything? | sim tuning, V-10 |
| **T-2** | Unique-unlock decay duration — sets the endgame window | sim tuning |
| **E-7** | Spawn model: Poisson per tag per tier, or tear-driven seeding? | sim parameterisation |
| **V-5** | Home palette: colour count + hex values | T-0073, all of Phase 6 output |
| **E-1** | Exact held/world bleed durations within the stated ranges (60–90 min held, 48–72 h world/escrow) | sim finds these |

**T-1, T-2, and E-7 block the tuning sweep, not the harness.** T-0099
should be built regardless of these answers — it's designed to take them
as free parameters.

**V-5 blocks T-0073** (the palette-quantize step of the art post-process
chain) specifically; the cutout and upscale steps around it are unblocked
and can be built without a palette decision.

---

## Related, carried from `GDD-QUESTIONS.md` Tier 7 (risks, still partly open)

These weren't restated as lettered/numbered items in the handoff but
remain live per `docs/HANDOFF.md` §1 ("Tier 7 is still partly unanswered"):

- **7.3** What breaks if it gets popular? 10k notes on one anchor tag —
  is top-N-by-score display (`02-notes-system.md` §8) sufficient curation,
  or does it need a second mechanism at scale?
- **7.5** Fork risk. Open source + open server means anyone can run their
  own instance or spoof clients. Accepted as likely-a-feature per the
  original discovery doc, but not formally re-confirmed against the
  locked identity/session model (`09-identity.md`).

Tier 7 items 7.1, 7.2, and 7.4 are effectively answered by the locked docs
(seeded ghosts, `02-notes-system.md` §11; offline-runnable mode, D-15) even
though they weren't closed out as a formal changelog entry anywhere — worth
a explicit confirmation pass when `01-vision.md` is delivered in full.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial — extracted from `docs/HANDOFF.md` §6 plus residual `GDD-QUESTIONS.md` Tier 7 items | Claude (Opus 5) |
