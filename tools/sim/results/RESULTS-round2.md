# T-0099 economy sim — Round 2 results

**Generated:** 2026-08-04 · **Seed:** 42 (fixed, deterministic; population sweep additionally
averages seeds 42/43/44 per point — see Method) · **Sim base:** `feature/T-0099-round2`,
branched from `origin/develop` @ `6b9a54d`
**Reproduce:** `cd tools/sim && .venv/bin/python -m sim.run_round2` (writes `round2_*.json` /
`round2_*.csv` in this directory; ~4–5 minutes — the population sweep dominates)

Round 1 ([`RESULTS.md`](RESULTS.md)) tuned E-1/T-1/T-2 within their documented brackets but
never answered the four questions the design docs actually block on
(`docs/design/08-invariants.md` §4, `docs/design/15-server-ops.md` §8,
`docs/design/12-tears.md` §3a, and the vertical-slice chain in `14`/`19`/`20`). This round
extends the sim (recipient-selection policy, chain-key consumption, a population-sweep
harness) and answers all four.

**Round 1's two flagged coverage gaps, carried forward:** unlock decay (T-2) is applied but
read by no invariant in this sim — still true, out of scope for these four questions. INV-8's
heuristic conflates "currently held, not world-anchored" with "extinct" — this **does** affect
Q1/Q3 below; flagged inline where it matters.

---

## Q1 — INV-14: does population actually help?

**Nuanced yes, but not in the way the raw-throughput framing suggests.** Two different
metrics tell two different stories, and the sim shows both are real:

| Metric | What it measures | Effect of P |
|---|---|---|
| Per-player items/hr (throughput) | Speed of individual progress | **Roughly flat, mild decline at the high end** |
| INV-7 density floor | Whether gating items exist *at all* | **Dramatic, sharp improvement** |

### Throughput is not the "help" — completability is

| P | avg items/hr | INV-7 fail-rate | INV-8 fail-rate* | INV-9 fail-rate |
|---|---|---|---|---|
| 2 | 2.90 | 100.0% | 100.0% | 0.0% |
| 10 | 2.92 | 100.0% | 100.0% | 0.2% |
| 20 | 2.93 | 3.2% | 93.6% | 0.7% |
| 50 | 2.88 | 7.9% | 92.5% | 1.8% |
| 100 | 2.82 | 2.8% | 92.9% | 4.1% |
| 200 | 2.71 | 4.5% | 94.9% | 8.4% |

*INV-8 fail-rate is dominated by the known heuristic flaw (Round 1, `invariants.py:check_inv8`)
— it flags a gating type as "unreachable" whenever its *world-anchored* count is zero, which
also fires whenever the type is simply sitting in a player's inventory rather than actually
extinct. With 7 gating types and P≥20 it's routine for at least one to be momentarily held,
so this number should **not** be read as "reachability breaks 93–95% of the time" — it's a
measurement artifact, not a design finding. Fixing it (distinguishing held-not-anchored from
truly-extinct) is a Round 1 follow-up still outstanding.

Per-player throughput (items/hr, cumulative since each agent's own spawn) stays in a **tight
2.71–2.95 band across the entire 100× population range tested (P=2→200)** — it does **not**
rise with population, and shows only a mild (~8%) decline at the very top of the range. That
mild decline is at least partly a residual ramp-up effect, not a steady-state penalty: **the
Poisson spawner's absolute item-creation rate is bounded by `num_anchors` (fixed at 20),
not by population** — so a larger P has a proportionally *larger* target cap (`k_c·P`,
`k_r·P`) to fill from the *same* anchor-limited spawn rate, taking longer in wall-clock ticks
to reach steady state. An earlier pass at 8,000 ticks showed a much sharper decline (2.96/hr
at P=2 down to 2.36/hr at P=200, a ~19% drop) that shrank to ~4% at P=20 vs. P=200 once run
for 30,000 ticks in a spot check — confirming most, though not conclusively all, of the
effect is transient. **This sim cannot fully separate "still ramping" from "a small genuine
anchor-bottleneck effect that persists at true steady state"** without runs far longer than
this round's time budget — flagged as a limitation, not resolved.

**INV-9's fail-rate rising with P (0.0% → 8.4%) while the average throughput stays flat is
itself informative**: it means population growth increases *variance* across individual
players (more outliers above/below the target band) even though it doesn't move the
population *average*. Growing P doesn't clearly speed anyone up, and it modestly widens the
gap between the luckiest and unluckiest players.

### Where population unambiguously helps: making gating items exist at all

INV-7 (density floor — do both rare gating types have ≥1 instance in existence,
*anywhere*, not just reachably) shows a **clean, dramatic cliff**: 100.0% of ticks in
violation for every P from 2 to 15 (min=max=1.000 across all 3 seeds at every one of those
points — not noise, a structural wall), collapsing to single digits (2.8%–8.0%) for every
P from 20 to 200. See Q3 for the mechanism and the exact floor number — it's the same result.

**Verdict:** the pitch's strong claim — "the more of us, the *faster* we escape" — is **not
supported** by raw throughput data in this model; population doesn't accelerate individual
pickup rate, and it costs a little in outlier variance. But the pitch's *weaker and more
load-bearing* claim — "alone, the economy cannot even supply what completion requires" — is
**strongly confirmed**: below the population floor, completion is structurally impossible
(gating items literally cannot exist), and above it, the game reliably can. Population's
value is enabling the game to be finishable at all, not making it finish quicker.

---

## Q2 — DM-5: recipient selection on bleed/pickup contention

**The current model hardcoded a policy** (agent dict/creation order — effectively "veteran
agents get first pick"), never surfaced as a parameter. Made it explicit as
`SimConfig.recipient_policy` (`engine.py:_ordered_playing_agents`), with three values:

- **`fifo`** — agent-creation order (the previously-implicit default)
- **`random`** — shuffled fresh each tick
- **`need_weighted`** — agents with fewer cumulative `items_received` go first

The underlying mechanism is real and deterministic: in a controlled single-item,
single-tick, two-agent test (`test_engine.py::TestRecipientPolicy`), whichever policy runs
first wins the contested item every time, and `fifo` vs. `need_weighted` produce opposite
winners for the same setup. **But at the aggregate, many-tick level the effect is small, and
counter-intuitive:**

| Policy | Gini (items_received) | min | max | mean |
|---|---|---|---|---|
| fifo | **0.0419** | 440 | 557 | 497.4 |
| random | **0.0390** | 449 | 578 | 507.7 |
| need_weighted | **0.0511** | 446 | 598 | 503.8 |

(P=20, 6,000 ticks, deliberately scarce economy — `k_c=0.2`/`k_r=0.05`/`unique_count=2`, so
~10 expected pickup attempts/tick compete for ~4–7 items in the world at any instant.)

All three land in a fairly equal regime (Gini 0.04–0.05 is low by any real-world standard),
and **`need_weighted` — the policy explicitly designed to correct for inequality — produced
the *most* unequal outcome, not the least**, with `fifo` and `random` both beating it. A
second, scarcer-economy check (`k_c=k_r=0.05`, `unique_count=1`, 4,000 ticks) reproduced the
same ordering (fifo 0.034, random 0.049, need_weighted 0.066), so this isn't a single-seed
fluke. Ruled out stable-sort tie-breaking as the cause (randomizing ties before the
`need_weighted` sort left the result essentially unchanged: 0.070 vs. 0.066).

**Why:** `need_weighted` re-sorts by *current* cumulative total every tick. With very few
items landing per tick, this creates a lock-in dynamic — an agent who gets an early lead
permanently sorts toward the back of the queue and stops winning contested picks for
extended stretches, while the currently-poorest agents cycle the scarce supply among
themselves. That's a *slower*, noisier self-correction than either `fifo`'s smooth,
predictable ID-ordered skew or `random`'s memoryless, unbiased draw — greedy neediest-first
scheduling is not automatically fairer than no correction at all once contention is real.

**Recommendation:** if recipient fairness becomes a design priority, don't reach for a
strict need-based sort — it measurably underperformed uniform randomness here. `random`
(decorrelating identity from who wins ties, with no lock-in dynamic) is both the simplest
and the best-measured option of the three tested.

---

## Q3 — OPS-1: shard population floor

**Floor: P ≈ 20** under the current default rarity-cap tuning (`k_c=2.0`, `k_r=0.2`,
`num_item_types_rare=3`, `num_gating_types=2`) — same data as Q1's INV-7 table, repeated
here as the direct OPS-1 answer:

| P | INV-7 fail-rate (avg of 3 seeds) | min–max across seeds |
|---|---|---|
| 2–15 (8 points) | **100.0%** | 1.000–1.000 (every seed, every point) |
| 20 | 3.2% | 2.8%–3.7% |
| 30 | 8.0% | 2.4%–19.2% |
| 50 | 7.9% | 4.6%–10.4% |
| 75–200 (4 points) | 2.8%–7.3% | never above 20% |

**Mechanism:** rare-tier cap is `int(k_r·P)`. With 2 of the 3 rare types marked gating,
having both simultaneously in existence needs the cap to comfortably clear 2 — at cap=0
(P<5) it's structurally impossible; at cap=1–3 (P=5–19) it's technically possible but the
spawner fills each vacated slot with an independent uniformly-random type draw among 3, and
because rare instances essentially never get destroyed while under cap (they just re-anchor
on bleed, same instance, same type — see `engine.py:_bleed_item`), whichever mix fills the
cap early **tends to stick for the rest of a run**. That's a coverage-probability problem,
not a smoothly-improving-with-P one, which is why P=2 through P=15 are uniformly at 100%
rather than gradually declining — and why P=30's seed spread (2.4%–19.2%) is wider than
P=20's (2.8%–3.7%): individual seeds can still get unlucky mid-range, they just don't get
unlucky at the same rate the low-P regime is *guaranteed* to.

**Rule of thumb for OPS-1** (given this tuning): the floor is where `int(k_r·P)` first
gives comfortable multi-type coverage margin over the gating-type count, empirically
≈ 4× the gating-type count here (`2 gating types × k_r=0.2` → `P≈20` gives cap=4). If E-4
(`k_c`/`k_r`/unique_count) or the gating-type count changes, recompute against this ratio
rather than treating P=20 as a fixed constant.

**Recommendation for `15-server-ops.md` §3's "fewer, fuller shards" bias:** P=20 is a hard
floor below which the shard is *provably* uncompletable (not just under-supplied — the
gating item cannot exist), so it should be treated as a strict minimum, not a target;
target shard population meaningfully above it (the data suggests ≥50 for headroom against
the mid-range noise band at P=20–30).

---

## Q4 — Chain-key consumption / unique drain

Added `chain_key_enabled` / `chain_key_mode` / `chain_key_crossings_required` to
`SimConfig`, and consumption logic to the pickup path (`engine.py:_consume_chain_key`):
when enabled, a unique picked up by an agent still short of
`chain_key_crossings_required` (2, per "archetypes 1–2 each consume a held unique to cross")
is spent immediately rather than following the normal held-bleed timer, in one of two modes:

- **`destroy`** — the instance is permanently removed. The literal reading of "sent onward
  into a pool that never respawns" (`07` §2).
- **`transfer`** — the instance is sent onward immediately (an instant bleed-land), staying
  in circulation. This is the mode the design docs **already lock**: `12-tears.md` §3a
  states chain-tear key semantics "match an item-locked door exactly," and
  `10-time-and-progression.md` §3 spells it out directly — *"Using a unique to open a lock
  sends the instance onward to another player... The item circulates; the knowledge stays."*

Simulated 3 weeks (30,240 ticks, 1 tick = 1 min) with a steadily growing population
(`initial_population=20`, `join_rate=0.05`, `quit_rate=0.001` → equilibrates around P≈50–55),
`unique_count=5` (default), seed 42:

| Mode | Final unique count | Exhausted at | Fraction of run at zero | Total crossings completed |
|---|---|---|---|---|
| **destroy** | **0 / 5** | **tick 60 (~1 hour)** | **100%** | **5** |
| **transfer** | 5 / 5 (unchanged) | never | 0% | **2,032** |

**Does the pool drain? Under `destroy` semantics: catastrophically and immediately — within
about one simulated hour, all 5 seeded uniques are permanently gone, and the pool stays at
zero for the rest of the 3-week run (and forever after — nothing respawns them, `07` §2).**
Total chain-crossings completed over the whole 3 weeks: exactly 5 — one per unique, ever.
Under `transfer` semantics, the pool never drops below its seeded count, and the same
population sustains over 2,000 successful chain-crossings across the same 3 weeks — four
orders of magnitude more completions from the same fixed 5 instances, because the physical
item keeps circulating instead of being spent once.

The `destroy` collapse is this fast because of a cold-start effect worth flagging on its own:
at tick 0 the world contains *only* the 5 seeded uniques (commons/rares haven't started
spawning yet — `spawn_rate_common`/`spawn_rate_rare` need time to fill from an empty pool),
so with 20 agents independently rolling pickup attempts, the very first successful pickups
in the run are disproportionately likely to land on a unique, and under `destroy` mode each
one is gone the instant it's touched.

**Implication for the chain-key-cost design decision:** this settles the destroy-vs-transfer
reading decisively — `destroy` is not a viable interpretation under any realistic population,
it breaks the exit condition within the first hour of a shard's life and never recovers.
The design docs' already-locked `transfer` semantics is not just "the more elegant reading,"
it's **load-bearing** — the game is uncompletable without it.

**"Per-run vs. per-week" persistence — not answered by this round, flagged as blocked.**
The round's Agent abstraction treats one agent lifetime as one universe/run (quit/collapse
is terminal; join_rate spawns a fresh agent with `chain_progress` reset to 0) — it has no
concept of one identity persisting across multiple sequential universes, so it cannot
distinguish "the chain-key unlock is scoped to this run" from "it persists across runs on
the T-2 (~1 week) clock." The docs already state two adjacent but distinct facts that look
relevant: `12-tears.md` §3a says the *tear itself* "stays open for the rest of the run" once
first crossed (per-run, already locked), while `10-time-and-progression.md` §3 states
unlocks are identity-scoped and decay on the T-2 clock independent of collapse ("collapse
ends the universe, not the identity"). If the open question is whether chain-key-crossing
*specifically* follows the tear's per-run scoping or the general per-identity T-2 clock,
that's a genuine design decision the docs don't fully resolve, and testing it empirically
would require extending this sim's agent model to a multi-universe identity — out of scope
for this round.

---

## Method summary

- **Determinism:** every sweep function takes an explicit `seed`; `run_round2.py`'s
  exports use `SEED = 42`. Population sweep additionally runs seeds 42/43/44 per point and
  averages, because whether the two rare gating types end up simultaneously covered is
  largely decided once (at spawner cap-fill time) and then sticks for the rest of a run —
  single-seed results were visibly noisy in an earlier pass (see git history on this branch).
- **Population sweep:** 15 points (P=2…200), 20,000 ticks each, `join_rate=quit_rate=0`
  (fixed P per run, isolating population as the sole independent variable, matching Round
  1's E-1/T-1/T-2 methodology).
- **DM-5 sweep:** P=20 fixed, 6,000 ticks, deliberately scarce config
  (`k_c=0.2`, `k_r=0.05`, `unique_count=2`) so pickup contention is real.
- **Chain-key sweep:** 3 weeks (30,240 ticks), growing population
  (`join_rate=0.05`, `quit_rate=0.001`), `unique_count=5` (default), sampled hourly.
- **Limitations carried from Round 1:** unlock decay (T-2) still isn't read by any
  invariant. INV-8's held-vs-extinct conflation inflates its fail-rate at every P tested
  here (see Q1) — a fix would need INV-8 to distinguish "held, not currently anchored" from
  "truly extinct," which is still a follow-up, not built in this round.

## Artifacts

- [`round2_population.json`](round2_population.json) / [`.csv`](round2_population.csv) — Q1/Q3
- [`round2_dm5.json`](round2_dm5.json) / [`.csv`](round2_dm5.csv) — Q2
- [`round2_chainkey.json`](round2_chainkey.json) (series + summary) /
  [`round2_chainkey_series.csv`](round2_chainkey_series.csv) /
  [`round2_chainkey_summary.csv`](round2_chainkey_summary.csv) — Q4
- Runner: `tools/sim/src/sim/run_round2.py` (`python -m sim.run_round2`), tests:
  `tools/sim/tests/test_run_round2.py`, plus `TestRecipientPolicy` /
  `TestChainKeyConsumption` in `tools/sim/tests/test_engine.py`
