# `complexity_points`: the scoring convention

**T-0440.** Writes down who scores a card and when, and names the one deliberate exemption. No
behaviour changes.

## Who sets it, and when

Whoever authors a card sets `complexity_points` in its frontmatter at authoring time, using the
Fibonacci rubric already defined at `tools/board/src/runner/promptBuilder.js`'s
`PLANNER_EXPANSION_WORKFLOW`, step 7. That is the rubric's one copy — see it there rather than
restating the point definitions here, so the two can't drift apart.

The planner agent sets it too, but only on the card-expansion path: a card with `agent === null`
(`runOrchestrator.js`'s dispatch to `buildPlannerPrompt`). In practice this path runs rarely — the
board's usage ledger records it happening once in the board's entire history, against 200
implementer runs and 181 reviewer runs — so for almost every scored card today, a human author set
the value, not the planner.

## The auto-generated-stub exemption

Two card-creating code paths generate cards automatically and never set `complexity_points`, and
that is intentional, not an omission:

- **`escalationRemediation.js`'s `dispatch` cards** — the escalation stubs it drafts (agent:
  `dispatch`) exist only to surface a blocker to a human for a root-cause fix. There is no feature
  being sized; the card's entire content is "go look at this."
- **`flowImprovementCard.js`'s `generic` flow-health cards** — self-improvement proposals drafted
  from flow-health stats (agent: `generic`, status: `backlog`), also unscored at creation.

Sizing either kind at creation is meaningless: there is no scope to estimate until a human reads
the stub and decides what, if anything, to do about it. If you see one of these sitting unscored,
that is the intended, by-design state — not a card somebody forgot to size.

This exemption covers only the auto-generated stub itself. Once a human picks up a flow-health
card and scopes it into real work, it is ordinary work like any other card and gets
`complexity_points` set the same way everything else does — the exemption is not "generic cards
are never scored."

## What `complexity_points` does NOT do

It is a human planning signal only. It is never read by any launch, admission, auto-launch, or
cost-accounting path — `tools/board/test/complexityPointsLaunchIsolation.test.js` scans
`src/runner/**` plus `dependencyGuard.js`/`roundCap.js` and fails if any of them ever reference the
field. The WIP gate sizes a card by a USD cost estimate instead
(`tools/board/src/runner/costEstimator.js`'s `estimateCost`, consumed by `admissionDecision.js`) —
that estimate, not `complexity_points`, is what paces anything resembling a budget.

`null` means "not yet scored," a displayed state (see `0008_add_complexity_points.sql`), not a
fallback to zero. Nothing in this doc introduces a default value or any validation that would
block an unscored card from running.
