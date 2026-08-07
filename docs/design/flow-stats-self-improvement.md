# Flow stats + periodic self-improvement loop

**Status:** implemented, off by default. **Owning code:** `tools/board/src/lib/flowStats.js`,
`tools/board/src/lib/flowImprovementCard.js`, `tools/board/src/runner/selfImprovementTrigger.js`,
`tools/board/src/runner/cardCreation.js`. See [[agent-runner.md]] for the base lifecycle this
extends.

## Problem

The board already tracks everything needed to tell whether the
`in-progress -> validation -> review -> done` pipeline is healthy: current `status`, the `attempts`
auto-retry counter (#74), and a timestamped `## <heading> (<ts>)` note on every `Validation: PASS`,
`Validation: FAIL`, `Blocked`, `Recovered`, and `Cancelled` transition (`runOrchestrator.js`'s
`appendNote`). Nobody looks at it in aggregate. A card that keeps failing the same lint rule for
five auto-retries, or a wave of orphan-reaper recoveries, or a rising rework rate, are all visible
one card at a time but invisible as a trend — the "flow-stats-round-2"-style investigations in
project memory (grant-string bugs, `:*` vs bare `*`, `&&`-segment matching) have all been triggered
manually, after the fact, by a human noticing something was wrong.

## Design decision: dedicated deterministic component, not a new LLM agent

The metrics/trigger/card-drafting logic is **plain in-process JS**, structurally identical to
`orphanReaper.js`/`autoPush.js`/`liveRunGuard.js` — a periodic sweep with an env-flag gate, not a
`claude` CLI invocation with an `.claude/agents/*.md` grant string.

**Why, given the prompt explicitly left "planner vs. dedicated component" and "if it runs as an
agent" open:**

1. **Cheapest correct trigger.** Comparing counts and rates against thresholds needs no free-form
   reasoning. It is exactly the class of thing this codebase already runs as a background sweep.
2. **Minimum tools, mechanically, not just by grant-string discipline.** An LLM agent's tool
   surface is only as narrow as its `tools:` frontmatter, and this repo has twice shipped a grant
   that looked right and wasn't (`project_assembled_reviewer_grant_gaps`: `:*` vs bare `*`,
   independent `&&`-segment matching). A plain JS module has no such gap — its capability surface
   *is* its code, which here is "read the task list" and "call the one shared card-creation
   helper." There is no allowlist string that could be subtly wrong.
3. **TDD-ability.** The failing-first tests this task requires (trigger fires on threshold and not
   otherwise, well-formed card emitted) need to run in milliseconds with no mocked CLI/NDJSON
   stack. A deterministic function is directly testable; an LLM call is not, without building out
   a parallel mocking harness for a feature whose job is arithmetic.
4. **It doesn't need to diagnose root cause.** The emitted card's job is to surface the *signal*
   (which numbers crossed which threshold, with concrete card ids) with enough specificity for a
   human or the normal `infra` implementer to investigate — not to pre-solve it. Root-causing is
   exactly the kind of work a normal implementer card + human review is already good at.

**Open question, not blocking:** if rule-based proposals turn out too shallow in practice (e.g.
they keep pointing at "rework rate is high" without ever narrowing to "it's always the same grant
bug"), the natural upgrade is to route the *drafting* step (not the trigger) through the `planner`
agent, handing it the computed stats as context instead of writing the card text from a template.
That would need a new, narrow grant (`tasks/**` write only, no `docs/**`, no Bash) — deliberately
not built now since the deterministic version is the smallest defensible thing that satisfies the
brief.

## Metrics tracked (`flowStats.js`, `computeFlowStats(tasks)`)

Derived entirely from `store.list()` — no new persisted transition log, no schema change:

| Metric | Source |
|---|---|
| `byStatus` | current `task.status` per `STATUSES` value |
| `reworkTotal` | count of `## Validation: FAIL (` note headings across all card bodies |
| `passTotal` | count of `## Validation: PASS (` note headings |
| `reworkRate` | `reworkTotal / (reworkTotal + passTotal)`, `0` when there's no sample yet |
| `reworkSample` | `reworkTotal + passTotal` — gates the rate off tiny samples |
| `recoveredTotal` | count of `## Recovered (` notes (orphan-reaper interventions, #74-adjacent infra-hiccup signal, distinct from implementer mistakes) |
| `retryCapBlockedCount` | blocked cards whose body contains the auto-retry cap's "Auto-retry limit reached" text (#74) — flow-failure blocks, not reaper/manual blocks |
| `avgReworkPerDoneCard` | FAIL-note count on cards currently `done`, averaged — how much rework a card typically survives before landing clean |

Pure function, no I/O — the sweep (below) is the only I/O boundary.

## Trigger cadence

**Revised 2026-08-07** (T-0147): the original interval/rework-rate design fired far too often in
practice — see "Post-launch revision" below for what went wrong and why. **Concrete rule, evaluated
on every sweep tick:**

Two gates apply before any threshold is even considered:

- **De-dupe.** If the most recent auto-proposed card is still open (`backlog`/`ready`/`in-progress`/
  `validation`/`review`/`blocked` — anything short of `done`/`retired`), the sweep does not propose
  another one, regardless of what the numbers say. One open proposal at a time.
- **Weekly cadence.** Even once the previous proposal is closed, the sweep will not propose again
  until at least `FLOW_STATS_SELFIMPROVE_MIN_INTERVAL_DAYS` (default **7**) have elapsed since the
  previous proposal's `proposed-at` marker, regardless of what the numbers say. This is the direct
  fix for "don't spam the board with the same task" — a persistently bad metric now produces at
  most one proposal per week instead of one every time the dedup guard clears.

Only past both gates does the sweep look for a genuinely evidenced, actionable signal — there is
**no pure-volume/interval trigger anymore** (see "Post-launch revision"):

- **rework-rate**: `reworkRate >= FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD` (default 0.3) **and**
  `reworkSample >= FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE` (default **10**, raised from 5).
- **retry-cap-blocked**: `retryCapBlockedCount >= FLOW_STATS_SELFIMPROVE_MIN_RETRY_CAP_BLOCKED`
  (default 3) — repeated auto-retry-cap exhaustion across multiple cards, not a one-off.
- **orphan-recovery**: `recoveredTotal >= FLOW_STATS_SELFIMPROVE_MIN_RECOVERED` (default 3) —
  repeated orphan-reaper interventions, not a single blip.

If none of the three cross their floor, the sweep proposes nothing — a quiet week produces no
card, deliberately, so "no news" never becomes filler.

**No separate state file.** The "baseline" and "proposed-at" timestamp aren't persisted anywhere
new — both are read back out of the most recent auto-proposed card's own body, which carries a
fixed marker: `<!-- flow-stats-self-improve: baseline-done=<N> proposed-at=<ISO-8601> -->`. This
means the trigger's memory can never drift out of sync with reality (there's nothing to desync —
it's the same `store.list()` scan already in hand), and it costs zero new persistence machinery.
Cards written by the pre-revision code carry a marker with no `proposed-at` field; `extractProposedAt`
returns `null` for those, and the cadence gate treats a `null` timestamp as "no cadence info, don't
block" (back-compat, not a special case to remove later — this is on the same code path forever).

Sweep interval itself (how often the cheap `store.list()` + threshold check runs, not how often it
fires): `FLOW_STATS_SELFIMPROVE_SWEEP_INTERVAL_MS`, default 10 minutes — cheap enough to run this
often (same cost as `orphanReaper`'s 30s sweep, just spaced out since there's no urgency). The
10-minute sweep and the 7-day propose cadence are deliberately different numbers: the sweep cost is
negligible, so there's no reason to slow it down just because proposals are rare.

All env helpers are read at construction time, same pattern as every other `*FromEnv()` helper in
this codebase (`orphanRecoveryEnabledFromEnv`, `autoPushOnCommitFromEnv`, etc.).

## Post-launch revision (T-0147, 2026-08-07)

Within a day of shipping, the loop produced three near-identical proposal cards (T-0143, T-0145,
T-0146: "rework rate 62%/65%/67% over 60/65/70 validations") in under 24 hours, each auto-retried
five times by the normal implementer pipeline before being blocked/retired for human review — real
board churn for no new information each time. Root cause: `reworkRate` is a **cumulative** stat
over the entire card corpus, not a rolling window, so once it crosses 0.3 it tends to *stay*
crossed; the only thing that had been preventing re-fire was the open-card dedup guard, and each
of those cards got auto-retried to exhaustion and closed (`retired`) within hours — clearing the
guard and letting the next sweep fire again immediately with a marginally different percentage.
The card bodies also carried no signal beyond the aggregate numbers already in `## Context` — no
specific card ids, no time window, nothing pointing at what to actually go fix — so even a human
looking at three of these in a row had no way to tell whether card #2 was "the same problem as #1,
still unfixed" or "a new problem."

Two changes, both in this revision:

1. **Weekly cadence gate** (above) — the primary fix for spam. A cumulative metric that stays
   elevated for weeks will now produce at most one card a week about it, not one every time the
   previous card gets auto-retried into `retired`.
2. **Evidence-carrying drafts.** `evaluateTrigger` now collects up to 5 concrete card ids (with
   timestamps) backing whichever signal fired — the most recent `## Validation: FAIL (` notes for
   rework-rate, the actually-blocked cards for retry-cap, the actually-recovered cards for
   orphan-recovery — and `draftImprovementCard` renders them under a new `## Evidence` section with
   the time window they span, plus a `Suggested direction` line tailored to the trigger reason
   (still phrased as an investigation prompt, not a diagnosis — deterministic code cites patterns,
   it doesn't claim to know root cause). The pure-volume "10 cards completed" trigger was dropped
   entirely, since raw throughput is not itself a problem signal and was the clearest source of
   filler proposals on an otherwise healthy week.

**Planner-routed drafting, considered and not taken.** This design's original "open question" noted
that if rule-based drafting proved too shallow, the natural upgrade was to route the drafting step
through the `planner` agent instead of a template. Evaluated for this revision and set aside for
now: `runOrchestrator.js`'s agent invocations have no timeout and run for unbounded real minutes,
and `selfImprovementTrigger.js`'s sweep is a bare `setInterval` with no in-flight guard — an
unbounded planner call inside `sweepOnce` risks stalling or overlapping sweeps in a way that could
itself undermine the cadence guarantee this revision just added, and would need a new narrow grant
plus a way to bound its runtime, neither of which exist yet. The deterministic evidence-citation
above (concrete card ids + timestamps + reason-specific direction) was judged to close most of the
"too shallow" gap on its own, without that new risk surface. If proposals are still too generic
after this ships, planner-routed drafting remains the documented next step — this paragraph is
where to pick that back up.

## From stats to a card (`flowImprovementCard.js`, `draftImprovementCard`)

Pure function: `{ stats, trigger } -> { title, body, agent, priority, phase, deliverable_type, depends_on, status }`.

- `status: "backlog"` — always, regardless of the env flag. See "auto-run" below.
- `agent: null` — matches `httpApi.js`'s own `DEFAULTS.agent`; the analyst doesn't know which
  implementer's domain the eventual fix belongs to (could be an infra grant bug, a client lint
  mistake, anything), so it leaves triage to a human/planner rather than guessing.
- `priority: "P2"`, `phase: 0` — `phase: 0` matches the existing convention of process/meta cards
  (docs, backlog upkeep) that aren't part of the numbered gameplay phases.
- `deliverable_type: "code"` — the eventual fix is a code/config change, not an artifact.
- Body: the `baseline-done` marker (above), a `## Context` section with the concrete numbers and
  which threshold fired, and a `## Acceptance` checklist that names the artifact of the
  investigation (root cause identified + a concrete fix + a following flow-stats snapshot showing
  the number moved), not just "flow health improved" — same acceptance-criteria discipline as
  `project_assembled_reviewer_verifies_acceptance`.

## Card creation path (`cardCreation.js`)

`createCard({ store, idAllocator, repoRoot, tasksDir, fields })` wraps exactly the same three
primitives `httpApi.js`'s `handleCreateTask` already uses, in the same order: `idAllocator.allocate()`
-> `store.create(task)` -> (if `autoCommitCardsOnCreateFromEnv()`) `commitTaskFile(...)`, with the
same "a commit failure must never fail card creation, just warn" behavior. It is a standalone
function rather than a refactor of `handleCreateTask` itself — extracting the HTTP handler's
non-HTTP core was judged higher-risk (touches a heavily-tested request path) than adding one small
shared function both call the same underlying store/allocator/gitOps primitives through. Every
field this analyst can set (`title`, `status`, `priority`, `phase`, `agent`, `depends_on`, `body`,
`deliverable_type`) is a real, validated `taskParser.js` field — the emitted card is not a special
case the schema doesn't know about; it's an ordinary card indistinguishable from one a human typed
into the New Card form, and it goes through the same `validate:backlog`/reviewer/runner pipeline as
any other.

## The periodic sweep (`selfImprovementTrigger.js`)

Structurally mirrors `orphanReaper.js`: `createSelfImprovementLoop({ store, idAllocator, repoRoot,
tasksDir, ... })` returns `{ sweepOnce, start, stop, enabled }`; `start()` sets an `unref()`'d
`setInterval`, `stop()` clears it. Wired into `boardServer.js` next to the orphan reaper and closed
the same way.

## Strict design rules — how each is honored

**Minimum tools.** Not an LLM agent, so there is no `.claude/agents/*.md` grant string to get
wrong — see "dedicated deterministic component" above. Its entire capability surface, in code, is:
read the task corpus (`store.list()`) and create one new card through the existing shared
create-card primitives. It cannot edit or delete an existing card (`cardCreation.js` only calls
`store.create`, never `store.update`/`store.remove`), cannot touch source, run Bash, or reach the
network beyond the identical git commit every other card-create already performs.

**Minimum responsibilities.** Three single-purpose files: `flowStats.js` only computes numbers from
tasks it's handed (no I/O). `flowImprovementCard.js` only turns `{stats, trigger}` into card fields
(no I/O). `selfImprovementTrigger.js` only decides cadence and calls the shared `createCard` — it
never implements a fix itself; the emitted card's `agent`/Acceptance section hand that to the
normal implementer + reviewer + human-review pipeline, identical to every other backlog card. It
touches nothing outside `tasks/**` (reads the whole corpus, writes exactly one new card file).

**Error handling.** `store.list()` failing is the one locally-retryable case (a transient FS read,
same class `writeRunState`/`readRunState` already treat as best-effort) — one bounded retry, then
`logger.error(...)` and the tick no-ops; never unbounded. Card-creation failure (git/commit/store
write) is not retried — it isn't a transient-read situation, and the de-dupe guard means the next
sweep tick naturally reconsiders since nothing was marked handled — it is logged via
`logger.error(...)`, never silently swallowed. `start()`'s interval callback wraps `sweepOnce()` in
one more `.catch(logger.error)` as a last-resort net, matching `orphanReaper.start()` exactly.

## Auto-run: off, always; the loop itself: off by default

`FLOW_STATS_SELFIMPROVE_ENABLED` gates the entire loop (stats sweep + trigger + card emission) and
defaults to **off** — deliberately the reverse of every existing `AUTO_*` flag in this codebase
(`AUTO_RECOVER_ORPHANED_RUNS`, `AUTO_PUSH_ON_COMMIT`, `AUTO_COMMIT_CARDS_ON_CREATE`, all default
*on*, disabled by `0`/`false`/`off`/`no`). Those flags all act on cards/commits a human or an
already-running card already created; this is the first piece of board infra that can originate a
new card with nobody having asked for that specific card, so it needs an opt-in, not an opt-out.
Enable with `FLOW_STATS_SELFIMPROVE_ENABLED=1` (also accepts `true`/`on`/`yes`, case-insensitive).

Independent of that flag, **emitted cards always land at `status: "backlog"`, never `"ready"`** —
nothing in this feature ever moves a card into the runnable pipeline. Running one still requires
the same human action (drag to Ready, click Run) any hand-authored card requires. This is not
configurable: there is no env flag that makes this loop auto-run anything, on purpose, per the
brief's "surface proposals rather than silently spawning runs unless explicitly enabled" — enabling
the loop only enables *proposing*.

## Schema impact

None. No new `taskParser.js` field. The `baseline-done` marker lives in the card body as an HTML
comment, which every card's body already supports as free-form markdown — zero migration, all
existing cards keep validating unchanged.
