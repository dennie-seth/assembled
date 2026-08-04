# T-0099 tuning sweep — results

**Generated:** 2026-08-04 · **Seed:** 42 (fixed, deterministic) · **Sim base:** commit `be6375b` (`origin/develop`) + this branch's `sim.run` module
**Reproduce:** `cd tools/sim && .venv/bin/python -m sim.run` (writes `tuning_sweep.json` / `tuning_sweep.csv` in this directory; ~2 minutes)

This sweeps the three still-open tuning questions from
[`docs/design/OPEN-QUESTIONS.md`](../../../docs/design/OPEN-QUESTIONS.md) and
[`10-time-and-progression.md`](../../../docs/design/10-time-and-progression.md) §2/§3/§7:

- **E-1** — exact held-bleed (60–90 min) / world-escrow-bleed (48–72h) durations within their stated ranges
- **T-1** — exact collapse duration within the ~2–4 week bracket
- **T-2** — exact unique-unlock decay within the ~1 week bracket

`k_c`/`k_r`/`unique_count` (E-4) are **not** swept — `OPEN-QUESTIONS.md` does not list E-4 as blocked, only T-1/T-2/E-7(resolved)/E-1/V-5, so those coefficients are treated as already-locked at their `SimConfig` defaults (`k_c=2.0`, `k_r=0.2`, `unique_count=5`). Their behaviour is still validated (see Finding 1) across every run in this sweep.

## Method

38 runs total (27 for E-1, 11 for T-1/T-2), each a full, uncompressed `SimConfig` (real
minute-resolution ticks, not the CI sweeps' compressed time in `sweeps.py`), fixed
population (`join_rate=0`, `quit_rate=0`) so the run isolates the wall-clock parameter
under test rather than population dynamics, and `first_universe_multiplier=1.0` so T-1 is
tested directly (the documented ×1.5 first-universe grace is a separate, orthogonal
multiplier layered on top — not re-derived here).

- **E-1 grid**: 3 held-bleed sub-ranges × 3 world-bleed sub-ranges (9 combos) × 2 stress
  scenarios (`hoarder_cohort`: P=20, 20% never transfer; `unique_circulation`: P=15,
  higher pickup rate, `unique_count=2`), each run 17,280 ticks (4× the outer world-bleed
  max, i.e. several full escrow cycles).
- **T-1/T-2 grid**: T-1 swept at 5 points (2, 2.5, 3, 3.5, 4 weeks) with T-2 held at its
  bracket midpoint, T-2 swept at 5 points (5–9 days) with T-1 held at its bracket
  midpoint, plus 2 paired extremes (short/short, long/long) — 11 unique combos after
  dedup, `p2_stability` scenario (P=20, no joins/quits), each run for exactly its own
  `collapse_duration` in ticks.

Raw data: [`tuning_sweep.json`](tuning_sweep.json) / [`tuning_sweep.csv`](tuning_sweep.csv).

## Finding 1 — INV-6 (rarity cap) holds everywhere tested

**Zero INV-6 violations across all 38 runs**, spanning the full E-1 bracket and the full
T-1/T-2 bracket, at the locked `k_c=2.0` / `k_r=0.2` / `unique_count=5`. The spawner and
`_enforce_rarity_cap` never let common/rare/unique instance counts exceed `cap(T, P)`
regardless of how fast or slow items bleed or how long a universe survives. This is a
clean pass — no E-4 revisit needed.

## Finding 2 — E-1: held-bleed duration is the dominant, differentiating lever; world-bleed duration is not

Under the `hoarder_cohort` stress test (20% of agents never voluntarily transfer),
INV-7 (gating-type extinction) violation count depends almost entirely on the **held**
sub-range, not the **world** sub-range:

| held sub-range | world sub-range | INV-7 violations / 17,280 ticks |
|---|---|---|
| 60–75 min (fast) | 2880–3600 or 3600–4320 | **1,016** (5.9%) |
| 60–75 min (fast) | 2880–4320 (full) | 1,586 (9.2%) |
| 60–90 min (full, current default) | any | 17,425–17,730 (~101–103%*) |
| 75–90 min (slow) | any | 18,253 (105.6%*) |

*(>100% because a single tick can register multiple simultaneous INV-7 violations — one
per extinct gating type.)*

For every held sub-range, the three world sub-ranges land within noise of each other —
world/escrow duration has **no measurable effect** on this failure mode. That matches
the design doc's own reasoning (`10-time-and-progression.md` §2: "different jobs,
different constants") — held bleed is the anti-hoarding lever, and the sim confirms it's
the one that actually keeps gating types circulating when a fifth of the population
hoards.

The `unique_circulation` scenario (no hoarders, higher pickup rate) shows the same
world-range insensitivity (each held sub-range gives byte-identical INV-7 counts across
all three world sub-ranges: 319 / 779 / 1,261) but a smaller, non-monotonic held-range
effect (319 at 60–90 vs. 779 at 60–75 vs. 1,261 at 75–90) — magnitude is small (≤7.3% of
ticks) and, with a single seed, plausibly noise rather than a clean causal trend. The
hoarder_cohort effect is an order of magnitude larger and directionally consistent
(faster held bleed → fewer extinctions), so it's the one worth acting on.

**Recommendation: set held bleed to the fast end of the bracket — 60–75 min** (e.g.
midpoint ~68 min). World/escrow bleed can stay at the full documented range, **48–72h
(2880–4320 ticks)** — nothing in this sweep penalizes the wider range, and it maximizes
the cross-session exchange window the design doc calls for (§2: "lets exchange span
sessions").

## Finding 3 — T-1/T-2: the current invariant set does not differentiate within either bracket

This is the important negative result. Holding T-1 fixed at its bracket midpoint (3
weeks) and sweeping T-2 across all 5 candidate values (5, 6, 7, 8, 9 days) produces
**byte-identical results at every value** — same violation counts, same summary, down to
the last digit (1,554,611 total violations, `INV-7: 1019, INV-8: 1553020, INV-9: 572`
in every single T-2 row). Unique-unlock decay is applied to `state.unlocks` in
`engine.py:_process_unlock_decay`, but **none of INV-6/7/8/9 read unlock state at all**
— T-2 is currently invisible to every invariant the sim checks.

Sweeping T-1 alone (5, 6, 7, 8, 9 → collapse at 20,160 / 25,200 / 30,240 / 35,280 /
40,320 ticks, T-2 fixed) shows:

| collapse duration | INV-7 | INV-9 | INV-8 | INV-8 rate/tick |
|---|---|---|---|---|
| 2.0 wk (20,160) | 1,019 | 572 | 1,077,640 | 53.5 |
| 2.5 wk (25,200) | 1,019 | 572 | 1,310,640 | 52.0 |
| 3.0 wk (30,240) | 1,019 | 572 | 1,553,020 | 51.4 |
| 3.5 wk (35,280) | 1,019 | 572 | 1,816,060 | 51.5 |
| 4.0 wk (40,320) | 1,019 | 572 | 2,083,240 | 51.7 |

INV-7 and INV-9 counts are **identical across all five T-1 values** — both are
early-ramp transients (gating-type drought while the spawner reaches cap, and agents
below the 60-tick INV-9 warm-up window) that finish accumulating well before any of
these collapse durations elapse, so collapse timing itself never touches them. INV-8's
*rate* is also flat at ~51–53 violations/tick regardless of T-1 — collapse duration
changes the run's total length (hence the rising raw total) but not the per-tick risk,
meaning there is no "racing collapse" signal building up as the end of a shorter run
approaches.

The reason INV-8's rate is high and flat rather than only spiking near collapse: its
heuristic (`invariants.py:check_inv8`) scores a gating type as unencounterable whenever
its **world-anchored** instance count is currently zero — which is also true whenever
that type is simply being *held* by a player rather than sitting at an anchor, not just
when it's genuinely extinct or undiscoverable. With 7 gating types (2 rare + 5 unique)
and P=20, it's common for at least one gating type to be in someone's hands rather than
in the world at any given tick, regardless of how much collapse runway remains. That's a
heuristic quality issue, not evidence that any of the tested collapse durations are
unsafe.

**Recommendation: keep both at their documented bracket midpoints** — **collapse
duration = 3 weeks (30,240 ticks)**, **unique-unlock decay = 7 days (10,080 ticks)** —
since the sim provides no differentiating signal to move off them within either
bracket. T-2 < T-1 holds by construction across the whole grid (max T-2 candidate,
12,960, is well under min T-1 candidate, 20,160), so the "endgame race" ordering the
design relies on (§4) is safe at every combination tested, including the paired
short/short (20,160 / 7,200) and long/long (40,320 / 12,960) extremes.

**Follow-up, not built here** (out of scope for this sweep): if T-1/T-2 sensitivity is
wanted directly from the sim in the future, INV-8 would need to distinguish
"held-not-anchored" from "truly extinct," and a new metric tracking unlock
expiry-vs.-remaining-collapse-time would be needed to make T-2's actual job (the
endgame-race window, §4) visible to any check at all.

## Summary

| Param | Bracket | Recommendation | Basis |
|---|---|---|---|
| Held bleed (E-1) | 60–90 min | **60–75 min** | INV-7 under hoarder stress: 5.9–9.2% of ticks vs. ~101–106% at the range's slow/full end — order-of-magnitude, monotonic, seed-robust in direction |
| World/escrow bleed (E-1) | 48–72h | **48–72h (full range, no change)** | No measurable effect on any invariant in this sweep; keep the wider cross-session window |
| Collapse duration (T-1) | ~2–4 wk | **3 weeks (30,240 ticks)** | No differentiating signal; hold at bracket midpoint |
| Unique-unlock decay (T-2) | ~1 wk | **7 days (10,080 ticks)** | No differentiating signal (T-2 currently invisible to all checked invariants); hold at bracket midpoint |

## Artifacts

- [`tuning_sweep.json`](tuning_sweep.json) — all 38 rows, full detail
- [`tuning_sweep.csv`](tuning_sweep.csv) — same data, flat
- Runner: `tools/sim/src/sim/run.py` (`python -m sim.run`), tests: `tools/sim/tests/test_run.py`
