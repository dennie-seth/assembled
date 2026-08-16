# Escalation workflow

**Status:** implemented. **Owning code:** `tools/board/src/runner/usageLimitDetector.js`,
`tools/board/src/runner/blockerReport.js`, `tools/board/src/lib/escalationRemediation.js`,
`tools/board/src/runner/runOrchestrator.js` (`_escalateIfGenuineBlocker` and friends),
`tools/board/src/lib/taskParser.js` (`ASSIGNABLE_AGENT_NAMES`'s `"dispatch"` entry),
`tools/board/src/server/httpApi.js` (`handleRunTask`'s mirrored guard). See
[[agent-runner.md]] for the base lifecycle and the `MAX_AUTO_RETRY_ATTEMPTS` auto-retry loop this
extends, and [[flow-stats-self-improvement.md]] for the sibling deterministic-card-creation
pattern this reuses.

## Problem

When a card's bounded auto-retry loop exhausts (`MAX_AUTO_RETRY_ATTEMPTS = 5`), it lands at
`status: "blocked"` with FAIL notes on the body -- and stops there. Nothing summarizes *why* it's
stuck, and nothing surfaces a concrete next step for a human. A human has to open the card, read
five FAIL notes, and manually figure out whether this is a missing grant, a flaky external
dependency, or a genuine code bug, then manually create a follow-up card if the fix isn't a quick
re-run.

## Trigger

Fires once, at the exhaustion boundary already present in `RunOrchestrator._runCardInWorktree`'s
attempt loop -- the 5th consecutive FAIL that sets `status: "blocked"`. The existing cap itself is
untouched; escalation is an additive step called right after `_handleFailValidation` marks the
card blocked on the final attempt. It never fires on an earlier FAIL (still retrying) or on a
runner crash (implementer/reviewer process failure blocks the card immediately via `_blocked`,
outside the attempt loop entirely -- that path was never a "genuine blocker" candidate to begin
with, and adding escalation there was out of scope).

## Exclusion: token/usage/rate-limit exhaustion never escalates

A run that failed because the `claude` CLI hit an Anthropic usage/weekly/rate limit is a
transient environmental stop, not evidence of a real blocker -- escalating it would create a
misleading permanent-looking card for a problem that resolves itself once the limit resets.
`usageLimitDetector.js`'s `eventsContainUsageLimitSignature` scans every attempt's raw NDJSON
events (not just the reviewer's verdict notes) for a broad set of phrasings ("usage limit", "rate
limit(ed)", "quota exceeded", `429`, "weekly limit", "limit will reset", ...), deliberately
excluding a bare "limit" so ordinary text doesn't false-positive. If any of the five attempts
carries the signature, `_escalateIfGenuineBlocker` is a no-op: no report, no remediation card --
the card is simply left `blocked`, same as today, for a normal later re-run once headroom returns.

**Judgment call:** the exact field a live `claude` CLI surfaces a limit-hit on isn't pinned down by
any confirmed live behavior (see `project_assembled_agent_runner` memory's confirmed-flags note,
which doesn't cover this case) -- the detector serializes and scans the whole event payload rather
than one specific field, and the pattern list should be revisited against a real limit-hit's raw
NDJSON output the first time one is actually observed live.

## Blocker report: deterministic, not a 6th `claude` call

`blockerReport.js`'s `buildBlockerReport` assembles the report from the reviewer FAIL verdicts the
card *already* produced across its five real attempts -- no extra agent invocation. This mirrors
`flow-stats-self-improvement.md`'s "dedicated deterministic component, not a new LLM agent"
decision for the same reasons: the categorization is closed-form (six categories, keyword
patterns), the notes text is already genuine agent output describing what was attempted and why it
failed, and a deterministic function is directly TDD-able without a mocked-CLI harness. Concretely
it's the same test the existing "caps auto-retry" test already enforces
(`runner.start` called exactly `MAX_AUTO_RETRY_ATTEMPTS * 2` times, never more) -- an LLM-authored
report would have broken that invariant.

The report has three parts:
- **Attempted:** what was attempted (task id/title, attempt count, branch).
- **Failure signature across attempts:** each attempt's FAIL note, labeled `Run N of 5`.
- **Lacks:** a category (`permission-grant | tool | env-dependency | external-service |
  design-ambiguity | code-test-bug`, `blockerReport.js`'s `BLOCKER_CATEGORIES`) picked by
  keyword-matching the combined FAIL-note text, defaulting to `code-test-bug`, plus a detail
  excerpt (the last attempt's note).

This is appended to the blocked card as a comment (`author: "assembled-board"`, matching the
existing `BOARD_COMMIT_AUTHOR` convention for board-authored content), not a body note -- it's
addressed to a human reader, not another transition in the status-change log.

## Remediation card: create-direct, not a live planner agent run

`escalationRemediation.js`'s `draftRemediationCard` turns the blocker report into card fields:
`status: "ready"`, `agent: "dispatch"`, `depends_on: []`, a body carrying the dedupe marker and
the full report, plus an `## Acceptance` section. `RunOrchestrator` creates it via
`cardCreation.js`'s `createCard` -- the exact same non-HTTP, direct-to-store path
`selfImprovementTrigger.js` already uses for auto-proposed flow-health cards -- rather than
spawning a live `planner` agent run.

**Judgment call, and why:** the brief's "the planner consumes the blocker report and creates a new
card" reads naturally as "invoke the planner agent," but every existing planner invocation
(`_planUnassignedCard`, or a card directly assigned `agent: "planner"`) runs *inside* the
originating card's own per-card worktree/branch and only lands its edits once that branch's PR is
reviewed and merged -- there is no existing path for a live planner run to write a card directly
onto the live board. Reusing that machinery here would mean the remediation card doesn't actually
exist in `ready` status until a human merges a PR to create it, which defeats the point of
surfacing it immediately for Dispatch to grab, and would recursively spin up a second full
agent-run cycle from inside a run that's already terminal. `createCard`'s direct-to-store path is
the mechanism this codebase already uses (`flow-stats-self-improvement.md`) whenever a card needs
to appear on the board immediately without a human-reviewed PR in between.

**De-dupe:** `findExistingRemediationCard` scans `store.list()` for a task whose body carries
`<!-- escalation-remediation-for: <id> -->` for this card's id. If one already exists, no second
card is created -- but the dependency link (below) is still (idempotently) ensured, since a prior
escalation could have created the card but not gotten as far as wiring the edge (or the original
card exhausted its retries again after a manual re-run).

**Dependency wiring:** the original blocked card's `depends_on` is patched to include the
remediation card's id (append-if-absent, so re-running this step is a no-op once wired). This
means `assertCanMoveToInProgress` (`dependencyGuard.js`) blocks a manual re-run of the original
card with `UnmetDependencyError` until the remediation card reaches `done`/`retired` -- the
existing dependency gate does the "can't auto-re-run until the blocker is cleared" enforcement for
free, no new guard needed.

## The `agent: "dispatch"` sentinel and the runner's pick-up-loop skip

`"dispatch"` was added to `taskParser.js`'s `ASSIGNABLE_AGENT_NAMES` (so `validateTask`/
`serializeTask` accept it) but has no `.claude/agents/dispatch.md` definition file --
`agentCatalog.js`'s `listAssignableAgents` intersects `ASSIGNABLE_AGENT_NAMES` with actual files
present in `agentsDir`, so it's automatically excluded from the New Card dropdown (`GET
/api/agents`) without any UI-specific code.

**Judgment call:** this codebase has no separate automatic "pick up a ready card and run it" loop
today -- every run is either a human clicking Run (`POST /api/tasks/:id/run` ->
`handleRunTask`) or the in-process auto-retry loop already inside a live run. `RunOrchestrator.
runCard()` is the single chokepoint every run (manual today, or automated in the future) must pass
through, so that's where the skip is enforced: `runCard()` throws immediately if `task.agent ===
"dispatch"`, before touching a worktree or spawning anything. `handleRunTask` mirrors the same
check for a clean `409` instead of letting the fire-and-forget fallback turn it into a "Run
Failed" note, exactly matching how it already duplicates the status-guard check for the same
reason.

## End-to-end flow

1. A card's implementer/reviewer cycle FAILs five times in a row (`MAX_AUTO_RETRY_ATTEMPTS`,
   unchanged). The card is set to `blocked`, same as before this feature.
2. `_escalateIfGenuineBlocker` checks all five attempts' raw output for a usage-limit signature.
   If found, it stops here -- the card stays `blocked`, nothing else happens.
3. Otherwise, it builds a structured blocker report from the five FAIL notes and appends it as a
   comment on the blocked card.
4. It de-dupes against any already-open remediation card for this id; if none exists, it creates
   one directly (`status: "ready"`, `agent: "dispatch"`), carrying the report and a dedupe marker.
5. It wires the original card's `depends_on` to the remediation card, so the existing dependency
   guard prevents an automatic/manual re-run until the remediation card is resolved.
6. The remediation card sits in `ready`, owned by the non-executable `dispatch` sentinel -- the
   runner's pick-up loop (`runCard`) refuses to run it, so it waits for a human/Dispatch to grab
   it, fix the underlying gap, and move it to `done`, which then unblocks the original card.

Every step from 2-5 is best-effort and wrapped in a single try/catch: any failure (a store that
doesn't support `list()`, an allocator error) is logged and swallowed, never rethrown -- the card
is already correctly `blocked` by the time escalation runs, so escalation is additive, not
load-bearing for the card's own terminal state.
