# Board Tool — Functional Invariants

> Scope: `tools/board` (the Kanban board that drives Claude Code agents against
> `tasks/*.md`), not the game design invariants in
> [`docs/design/08-invariants.md`](design/08-invariants.md).
>
> **Why this doc exists:** PR #120 fixed a card rendering both a red
> ("blocked") and a green ("ready") dependency dot at once. The existing
> ~1348-test suite did not catch it before it shipped. See
> [§0 Coverage-gap analysis](#0-coverage-gap-analysis) for why, and the table
> below for the full sweep this triggered: every user-facing rule the board
> depends on, whether it's tested today, and what's left.
>
> **Headline finding in this PR: [PULL-1](#6-deploy-propagation-pull-on-done)**
> — the live board's *only* auto-deploy path (pull `origin/develop` when a
> card is marked done) silently went dead on the 2026-08-07 db-mode cutover,
> and nothing caught it. Fixed here, with a regression test that fails
> against the pre-fix code.
>
> Status legend: ✅ Covered · ⚠️ Partially covered · ❌ NOT covered

---

## 0. Coverage-gap analysis: why tests missed the dual-dot bug

Before the fix (commit `c3466e5`), the board computed two badges from two
functions that were each individually well unit-tested, but never tested
*together*:

- `computeUnblockedIds(tasks)` (green dot) — checked a card's **own**
  `depends_on`: are they all done/retired?
- `computeBlockerCounts(tasks)` (red stop-sign ⛔, "Blocks N tasks") — checked
  **other** cards' `depends_on` arrays for entries pointing at this card:
  downstream impact, unrelated to this card's own dependency state.

Both had thorough per-function unit tests (`board.test.js`) and thorough
per-badge rendering tests (`boardView.test.js`) — checking presence, absence,
accessible labels, edge cases like empty `depends_on`. What none of those
tests ever did was **construct a task graph where both conditions were true
for the same card at once** (own dependency done *and* listed as another
card's dependency — e.g. T-0045: depends on T-0044 [done], and T-0063 depends
on T-0045). That's not a rare edge case — it's the normal shape of the
middle of any dependency chain. No test ever rendered that shape and asserted
on how many status badges came out.

**The concrete coverage-shape gap:** every existing test was a per-function or
per-condition happy-path unit test (`computeUnblockedIds` in isolation,
`computeBlockerCounts` in isolation, one badge asserted present/absent at a
time). There was no **cross-condition / invariant test** — nothing that took
two independently-true conditions and asserted a property that must hold
*across* them (here: "exactly one status badge renders per card, ever").
Property/invariant-style assertions ("never both", "always exactly one",
"idempotent under X") structurally can't be caught by single-function unit tests,
no matter how many of them exist or how high the line-coverage number is —
they require a test built around the invariant itself, spanning whichever
functions/state happen to be involved. No amount of per-function unit tests,
however thorough, will find them.

PR #120's own fix already added the missing cross-condition tests for this
one case (`board.test.js`: "assigns every task exactly one of blocked/ready,
never both, never neither"; `boardView.test.js`: "never renders both the
blocked badge and the ready badge on the same card" + the direct T-0045
regression). This document generalizes that lesson: it enumerates every other
place in the board where a similar "two independently-correct pieces of state
combine into a user-visible guarantee" pattern exists, and states whether that
combination — not just its ingredients — is actually under test.

---

## 1. Dependency / status dots

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| DOT-1 | A card renders **exactly one** of the ready (🟢) / blocked (🔴) dependency badges — never both, never neither. | This is the PR #120 bug itself. Two badges at once reads as contradictory board state to the user. | ✅ Covered — `board.test.js` ("assigns every task exactly one of 'blocked' or 'ready'"), `boardView.test.js` ("never renders both... always renders exactly one", T-0045 regression). |
| DOT-2 | A card with no dependencies is always **ready**. | Pre-#120 regression: `computeUnblockedIds` explicitly excluded the empty-`depends_on` case, so a no-deps card showed *neither* badge. | ✅ Covered — `board.test.js` "marks a task with no dependencies as ready", `boardView.test.js` no-deps case. |
| DOT-3 | A dependency in status `done` **or** `retired` counts as satisfied. | Retired tasks are a legitimate terminal state (cut scope, superseded) and must not permanently block downstream cards. | ✅ Covered — `board.test.js` "marks a task ready when all its dependencies are retired" / "mix done and retired". |
| DOT-4 | A `depends_on` id that doesn't resolve to any known task counts as **unmet** (blocked), not silently ignored. | A dangling reference (typo, deleted card) must fail closed, not fail open into a false "ready". | ✅ Covered — `board.test.js` "marks a task blocked when a dependency id is missing". |
| DOT-5 | The downstream "Blocks N tasks" 🔗 badge is independent of DOT-1–4 and may co-occur with the **ready** badge. | This is the other half of the #120 root cause: a card can legitimately be both ready-to-run and something else depends on it. | ✅ Covered — `boardView.test.js` T-0045 regression (ready + 🔗 together, no ⛔ text). |
| DOT-6 | The 🔗 badge may also co-occur with the **blocked** badge (a blocked card that other cards also depend on). | Same independence claim as DOT-5, but the "blocked ⨯ blocked-by-others" combination was never actually exercised — DOT-5's regression test only covers the ready side. | ❌ **Not covered before this PR.** New test added (`boardView.test.js`). |
| DOT-7 | Dependency/blocker badges always reflect current cross-card state after any edit — a card's own dot AND every other card's 🔗 "blocks N" badge — without a manual refresh, whether the edit arrives as a WS `changed` event or via the local Save path. | Field report (2026-08-09): T-0096 appeared to still show a "blocks" mark after all its dependencies were removed. Investigation traced it to `render()` (`app.js`) always rebuilding the whole board from the live `tasks` array on every call — `computeBlockerCounts`/`computeDependencyStatus` (`board.js`) are recomputed fresh each time rather than cached, so a change to *any* card's `depends_on` updates *every* affected card's badges on the very next render. No stale-render bug was found; the actual T-0096 case was a genuine dangling reverse-reference (T-0095 still listed T-0096 in its own `depends_on`) — real data, correctly rendered. This invariant pins the "always correct after any edit" property down as a regression test so a future change (e.g. an optimization that re-renders only the edited card) can't silently reintroduce staleness. | ✅ Covered — `app.test.js` "createApp dependency badge propagation across cards" (WS event on the *other* card, local Save path, and the card's own dot). |

## 2. Card status lifecycle

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| LC-1 | The only valid card statuses are the 8 in `STATUSES` (`board.js`): `backlog, ready, in-progress, validation, review, done, blocked, retired`. `taskParser.js` rejects any other value when reading a card file. | A stray/typo'd status would silently vanish from every board column (nothing renders it) instead of erroring. | ✅ Covered — `taskParser.test.js` rejects invalid status; `board.test.js` groups by the fixed list. |
| LC-2 | Automated run transitions follow `RunnerLifecycle`'s explicit table: `ready→in-progress→validation→review`, with `fail`/`fail_validation` branches to `blocked`/back to `in-progress`, and `blocked→ready` only via `requeue`. Illegal transitions throw. | This is the state machine the orchestrator drives during a run; `review→done` is deliberately **not** in the table — only a human can do that. | ✅ Covered — dedicated `runner/lifecycle.test.js`. |
| LC-3 | A run failure (post-202, e.g. crashed worktree) moves the card to `blocked` and appends the error message to the card body (T-0165), rather than failing silently in a server log. | Without this, a dead run looks identical to "still running" from the board's perspective — the user has no signal to act on. | ✅ Covered — `httpApi.runFailure.test.js` (4 tests: 202 still returned, status→blocked, body has error text, WS broadcast fires). |
| LC-4 | Moving a card to `in-progress` (drag, detail-panel save, or the Run/Re-run button hitting `PATCH .../status`) is rejected with 409 if its own dependencies aren't all done/retired, or if its dependency graph has a cycle. | The one place a manual status edit is guarded — prevents starting work whose prerequisites don't exist yet. | ✅ Covered — `httpApi.test.js` "PATCH /api/tasks/:id dependency guard" (4 tests), plus `dependencyGuard.test.js` unit tests for the guard logic itself. |
| LC-5 | **The `POST /api/tasks/:id/run` endpoint (the actual Run/Re-run button target) does *not* re-run the dependency guard** — it only checks `RUNNABLE_STATUSES = {ready, review, blocked}`. A card sitting in `ready` with unmet `depends_on` (i.e. showing the 🔴 blocked dot) can still be started via Run. | This is a real gap, not just a missing test: LC-4's guard only fires on a *direct* `PATCH {status: "in-progress"}`. The Run button's route (`handleRunTask`) never calls `assertCanMoveToInProgress`, so the dependency dot and the Run affordance can disagree — the UI shows red, the button still works. Found while enumerating this list; a small, well-scoped fix using the exact same guard LC-4 already relies on. | ❌ **Was NOT covered, and the underlying behavior was wrong.** Fixed in this PR: `handleRunTask` now calls `assertCanMoveToInProgress` before starting a run, returning 409 with the same error shape as LC-4. New tests in `httpApi.test.js`. |
| LC-6 | Deleting a card is rejected (409) while it has an active run (`in-progress`/`validation`), both server-side (`handleDeleteTask`) and client-side (delete button disabled). | Prevents losing a card's history mid-run; two independent layers so a stale client can't bypass the server check. | ✅ Covered — server: inline in `httpApi.test.js`; client: `detailPanel.test.js` "disables the delete button for a task with an active run" (both statuses) + "enabled" counterpart. |
| LC-7 | A manual `PATCH` (edit title/body/agent/etc., or a status change other than →in-progress) on a card that currently has an **active orchestrator run** is not guarded — nothing stops a concurrent edit racing the run. | Unlike LC-6 (delete), there's no equivalent check in `handlePatchTask` for `orchestrator.isRunning(id)`. Whether this *should* be blocked (and for which fields) is a product decision, not a pure bug — flagging rather than fixing. | ❌ **Not covered — deferred.** No test added in this PR; see PR description. |

## 3. Card create / update

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| CR-1 | Card ids are unique and monotonically allocated (`IdAllocator`: max of persisted state, working-tree scan, and `git log --all` scan across every ref/branch). | Two cards with the same id would corrupt every id-keyed lookup (board state, WS events, dependency graphs). | ✅ Covered — `idAllocator.test.js`. ⚠️ Known gap (already documented, not new): the allocator only sees refs visible to its own git checkout, so two *separate clones* allocating concurrently can still collide — out of scope here. |
| CR-2 | Creating a card and receiving the server's WS `"added"` broadcast for that same card (which can arrive **before or after** the create POST resolves) never produces two cards in the client's task list or two rendered DOM cards (T-0170 / PR #117). | The classic optimistic-update-vs-realtime-echo race. Before #117's fix, the POST handler unconditionally appended, so a fast WS echo produced a duplicate until the next full refresh. | ✅ Covered — `app.test.js`: both orderings explicitly tested ("...arrives before the create POST resolves (race)" and "...arrives after"). |
| CR-3 | `PATCH` cannot change a card's `id`. | Id is the join key for dependencies, WS events, and file/DB storage; changing it out from under those would silently orphan references. | ✅ Covered — `httpApi.test.js` "returns 400 when the body tries to change the id" (or equivalent). |

## 4. WebSocket event application

`applyTaskEvent(tasks, event)` (`board.js`) is the single function every
realtime update — from the file watcher in fs mode, or direct broadcasts in
db mode — flows through before touching rendered state.

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| WS-1 | A `"changed"` event replaces the existing task with matching id. | Basic update path. | ✅ Covered — `board.test.js`. |
| WS-2 | An `"added"` event for an id **not** currently in the list appends it. | Basic create path. | ✅ Covered — `board.test.js`. |
| WS-3 | A `"removed"` event filters the matching id out. | Basic delete path. | ✅ Covered — `board.test.js`. |
| WS-4 | `applyTaskEvent` never mutates its input array (returns a new array). | The app's render loop assumes `tasks` is only ever replaced by assignment, not mutated in place — a mutation would break change detection / re-render timing elsewhere. | ✅ Covered — `board.test.js` "does not mutate the input array". |
| WS-5 | An `"added"` event for an id that **already exists** in the list upserts (replaces) rather than appending a duplicate. | This is the server-side mirror of CR-2/T-0170: a duplicate or replayed `"added"` broadcast (e.g. two tabs, a reconnect replaying a backlog of events) must not double a card. The code already does this correctly (same index-based branch as `"changed"`) — but no test asserted it. | ❌ **Was NOT covered.** New test added. |
| WS-6 | Applying the same `"changed"` event twice in a row is idempotent — the second application is a no-op relative to the first. | Realtime transports can redeliver; idempotent apply is what makes at-least-once delivery safe. | ❌ **Was NOT covered.** New test added. |
| WS-7 | A `"removed"` event for an id that is **not** in the current list is a safe no-op (doesn't throw, list unchanged). | A remove can arrive after a local delete already removed it optimistically, or for a card this client never loaded (paginated/filtered view). Must not crash the render loop. | ❌ **Was NOT covered.** New test added. |
| WS-8 | An out-of-order `"changed"` for an id not yet in the list (i.e. its `"added"` hasn't arrived/applied yet) still lands the task, rather than being dropped. | `applyTaskEvent` doesn't distinguish `"added"` from `"changed"` once past the `type === "removed"` check — both fall through to the same "replace if present, else append" logic. That's what makes it order-tolerant, but nothing tested the out-of-order case directly. | ❌ **Was NOT covered.** New test added. |

## 5. Run gating

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| RUN-1 | A card can only be run (`POST .../run`) from `ready`, `review`, or `blocked` status. | Prevents starting a run on `backlog`/`done`/`retired`/already-`in-progress` cards. | ✅ Covered — `httpApi.test.js` (409 for `backlog`, `retired`; 202 for `ready`/`review`/`blocked`). |
| RUN-2 | A card already running cannot be run again concurrently. | Two orchestrator runs on the same card/worktree would race each other's git state. | ✅ Covered — `httpApi.test.js` "returns 409 when running a card that already has an active run". |
| RUN-3 | The Run affordance must reflect actual readiness: a card whose own dependencies are unmet (DOT-1 shows 🔴) cannot be started via Run, matching LC-4's guard on manual `PATCH →in-progress`. | Same rule as LC-5 above — listed here too since "Run gating" was called out as its own area. The client doesn't hide the Run button based on the dependency dot (`boardView.js`'s Run button is gated only on `task.status === "ready"`), so the server-side check is the only enforcement point. | ❌ **Was NOT covered, and the code violated it.** Fixed in this PR (see LC-5). |
| RUN-4 | Every automated card launch goes through the same guarded path as the Run button. `cardLaunch.js`'s `launchCardRun` is the single implementation of that path (runnable status, the `dispatch` sentinel, the already-running check, `assertCanMoveToInProgress`, then `orchestrator.runCard` with its acceptance/capability preflights); `POST .../run` and the auto-launch poller both call it. | RUN-3 above was a guard that existed on one entry point and not another. A second automated entry point (the poller) re-deriving those guards is the same failure waiting to recur -- so there is one function, not two agreeing implementations. | ✅ Covered — `cardLaunch.test.js` (each guard refuses with the endpoint's own status code; a card with an unmet dependency or a cycle never reaches `runCard`), `httpApi.test.js` (unchanged endpoint behaviour through the extracted path) and `autoLaunchPoller.test.js` ("does NOT start a card with an unmet dependency even if selection mistakenly offers it"). |
| RUN-5 | The auto-launch poller (`autoLaunchPoller.js`, `AUTO_LAUNCH_ENABLED`, **default OFF**; `AUTO_LAUNCH_INTERVAL_MS`, default 5 hours — one tick per Anthropic usage window) starts at most **one** card per tick, and only when: usage telemetry reports a utilization strictly below `AUTO_LAUNCH_USAGE_MAX`; `orchestrator.hasActiveRuns()` is false **and** no card sits at `in-progress`/`validation`; and the card's status is exactly `ready` with every `depends_on` at `done`/`retired`. Any uncertainty — unreadable telemetry, an unreadable store, a refused launch — skips the tick. | An unattended loop that starts real agent runs has to fail toward doing nothing. A skipped tick costs one interval; a wrongly-launched card burns usage, may collide with a live run, and can start work whose dependencies aren't resolved. The idle gate deliberately uses two independent signals because the in-process orchestrator alone cannot see a run stranded by a previous board process. | ✅ Covered — `autoLaunchPoller.test.js` (enabled/disabled, over-threshold skip, rejected-status skip, undetermined-usage skip, unreadable-telemetry skip, orchestrator-busy skip, in-progress/validation skip, unreadable-store skip, no-eligible skip, priority selection with numeric-id tie-break, one launch per tick, refusal is not routed around, start/stop wiring, tick-failure isolation), `usageWindow.test.js` (status→utilization mapping, elapsed-window reset, tail reads, malformed/zero-byte logs) and `boardServer.test.js` "auto-launch poller wiring" (construction, OFF by default, `close()` stops it, enabled-end-to-end tick skips on a fresh board). |

## 6. Deploy propagation (pull-on-done, pull-on-timer)

This area is different in kind from §1–5: it's not about what renders on a
card, but about whether merged code on `origin/develop` ever reaches the
live board process at all. PULL-1 below was the headline finding of the PR
that introduced this section — a real, already-shipped regression, not just
a coverage gap discovered by enumeration.

PULL-1's Done-triggered pull has one structural gap of its own: it only
fires from a card's `PATCH .../status → done` handler, so a board sitting
idle — no card reaching Done — never re-checks `origin/develop` no matter
how long a merged PR has been sitting there (confirmed live: PR #210 sat
un-pulled for hours with no card completing after it merged). PULL-4 closes
that gap with a periodic timer that reuses the same `pullDevelop` +
`restartCoordinator` machinery on an interval instead of a card event. The
"no timer or other trigger" observation in PULL-1's own description below is
what PULL-4 changes going forward — see PULL-4 for the new mechanism.

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| PULL-1 | Marking a card `done` triggers a pull of `origin/develop` into `repoRoot`, **independent of task-store mode** (fs or db). | This is the live board's *only* auto-deploy mechanism — there is no timer or other trigger (confirmed: `systemctl --user list-timers` on the live host shows only asset-sync/backup/integrity-check timers, nothing pull-related). `handlePatchTask` (`httpApi.js`) gated the pull with `taskStoreKind !== "db"`, reasoning that "card writes never touch git in db mode" — true, but irrelevant to this invariant: `repoRoot` is still a real, live checkout of `develop` in db mode (Phase 2 keeps `tasks/` git-tracked alongside the DB), and *other* merged PRs still need to reach it. When the live board was cut over to `BOARD_TASK_STORE=db` on 2026-08-07, this gate silently killed the only auto-deploy path — merged code stopped reaching the live tree with no error, no log line, nothing. First noticed 2026-08-08 when the user reported merged code wasn't showing up live. | ❌ **Was NOT covered, and shipped broken for a day.** Fixed in this PR: the `taskStoreKind !== "db"` condition is dropped from the gate. New regression tests in `httpApi.dbMode.test.js` (`PULL-1: ...`), confirmed failing against the pre-fix code before the fix landed. |
| PULL-2 | The pull never blocks or delays the PATCH response — it's fire-and-forget, and a failed pull (network down, no `develop` ref, merge conflict) still returns 200 with the card's updated status. | A flaky/offline git remote must not make marking a card done appear to fail. | ✅ Covered — `httpApi.done.test.js` "still returns 200 even when pullDevelop rejects". |
| PULL-3 | The pull itself is never gated on whether a card run is active, but a **service restart** triggered by the pull (`restartCoordinator.notifyPulled`) *is* deferred while `orchestrator.hasActiveRuns()` is true. | These are deliberately different gates on different risks. `pullDevelop` runs `git pull` against `repoRoot` only; a card's live run happens in its own `git worktree` (`gitOps.addWorktree`, on a `feature/T-XXXX` branch) — a separate working tree and HEAD that a pull into `repoRoot`'s `develop` checkout cannot touch or interrupt. What *would* interrupt a live run is restarting the board's Node process out from under the in-process `RunOrchestrator` — that's the actual risk, and it's the thing already deferred. Gating the pull itself on "no live run" (rather than just the restart) would be over-broad and would reintroduce a version of this same bug: a long-running card would indefinitely block *all* deploys, not just its own restart. | ✅ Covered — `httpApi.done.test.js` "restart-on-pull coordination" (fs mode, 4 tests) and the new `httpApi.dbMode.test.js` "PULL-1: defers the restart-on-pull coordinator... in db mode too" (confirms the same deferral holds in db mode, not just fs mode). |
| PULL-4 | Independent of any card event, `autoPullPoller.js` runs a periodic timer (`BOARD_AUTOPULL_INTERVAL_MS`, default 5 minutes; `BOARD_AUTOPULL` / an interval of `0` disables it) that fetches `origin/develop` and, only if it's actually ahead of `repoRoot`'s HEAD, runs the same `pullDevelop` + `restartCoordinator.notifyPulled` pair the Done path uses. Unlike PULL-3, a tick with an active card run is skipped **entirely** — no fetch, no pull, not just a deferred restart — and the next tick (or the run's own eventual idle notification) picks it back up. | This is the fix for the structural gap called out in this section's intro: PULL-1 only fires from a Done transition, so an idle board can sit arbitrarily far behind a merged `origin/develop` with nothing to trigger a catch-up. The timer is deliberately more conservative than PULL-3 about skipping ticks outright (rather than always pulling and only deferring the restart) because, unlike a card reaching Done, no external event is forcing this particular tick to happen right now — waiting for the next one is free. | ✅ Covered — `gitOps.test.js` (`isBehindOrigin`: up-to-date, origin-ahead, local-only-ahead, diverged) and `autoPullPoller.test.js` (pulls+restarts when behind+idle, skips the entire tick when a run is live, no-ops when already up to date, respects `enabled`/`intervalMs: 0`, start/stop interval wiring, tick-failure isolation) plus `boardServer.test.js` "auto-pull poller wiring" (construction, `close()` stops it, env-disabled end-to-end). |

## 7. Detail panel live-update safety

`renderDetailPanel` (`detailPanel.js`) is called on every render tick,
including the ones triggered by a board-socket `"changed"`/`"added"` event for
*any* card while the detail panel happens to be open on the still-selected
one (`app.js`'s `handleSocketMessage` → `render()` → `renderDetailPanel` for
whichever task is currently selected). It unconditionally tears the panel
down (`root.replaceChildren()`) and rebuilds every field from `task`.

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| DP-1 | An unsaved, in-progress edit to any detail-panel field (title, priority, status, agent, phase, dependencies, body, or an in-progress comment draft) survives a live re-render of the same still-open card, and is only discarded by clicking Save or closing/switching cards. | Reported live (T-0151): "when I'm trying to add a dependency and scroll down to save the task, the dependency gets removed before I even have a chance to save it." A card under active agent work (`in-progress`/`validation`) re-broadcasts `"changed"` (e.g. its `attempts` counter) often enough to land in that exact scroll-to-Save window. An earlier fix (T-0137) covered this only for whichever single field currently has DOM focus (comment/title/body/attachment inputs tagged `data-detail-field`); it explicitly left the priority/status/agent `<select>`s and the deps picker (a compound `<select>`-plus-chips widget, not a plain input) unprotected, and even for the fields it did cover, an edit was lost the moment focus moved to another field before the next re-render (e.g. typing a title, then clicking into the deps picker) — the mechanism keyed off `document.activeElement`, not "has this field been edited". | ❌ **Was NOT covered, and the code was wrong.** Fixed in this PR: `captureDirtyFields` diffs each field's live DOM value against the task object the panel was last built from, and carries forward only the fields that drifted. New tests in `detailPanel.test.js` ("unsaved edits survive live re-renders (T-0151)": deps add/remove, priority/status/agent/phase, title surviving a focus change, dirty state cleared after Save, no bleed-over to a different card) plus two `app.test.js` socket-level integration tests exercising the real `handleSocketMessage` path, all confirmed failing against the pre-fix code before the fix landed. |
| DP-2 | A live re-render that does *not* touch a field the user hasn't edited still applies the server's latest value for that field (e.g. another user's comment appearing, or an unrelated field changing elsewhere). | The fix for DP-1 must not regress into "live updates never reach an open card" — that would hide real information (another reviewer's status change, a new comment) behind a stale local view. | ✅ Covered — same `detailPanel.test.js` describe block, "still applies a legitimate incoming change to a field the user did not touch"; also the pre-existing "keeps the detail panel in sync when the selected task changes over the socket" (`app.test.js`) and the T-0137 comment-list tests. |

## 8. Worktree artifact preservation

`git worktree remove --force` — which the runner issues on every reclaim
(`gitOps.js`'s `reclaimOrDetectExisting`) and on every teardown
(`removeWorktree`, called by the orchestrator on a PASS and on a cancel) —
deletes the *entire* worktree directory, untracked and gitignored files
included. Anything a run generated but never committed was therefore destroyed
on the next run. T-0248 lost ~86 minutes of GPU LoRA training to this: its
per-epoch sd-scripts `--save_state` checkpoints under `assets/final/lora/` were
wiped by the reclaim, so the re-run's `find_resume_state` found nothing to
resume from and retrained from step 0.

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| WT-1 | A card's allowlisted untracked/ignored artifacts are captured **before** every `git worktree remove --force` and restored **after** the fresh `git worktree add`, so a re-run finds its previous run's checkpoints in place and can resume. | This is the T-0248 bug itself. Resumable work (training state, generated GPU output) is expensive to recompute — hours, not seconds — and nothing about the worktree lifecycle needed it destroyed. | ✅ Covered — `gitOps.test.js` §"untracked artifacts survive the worktree reset" (re-run finds the checkpoints; the `removeWorktree` PASS/cancel door too), `artifactPreservation.test.js` (`preserveArtifacts`/`restoreArtifacts` round-trip). |
| WT-2 | The fresh checkout's **tracked** files always win: a preserved path that git tracks in the new tree is never restored over it, and is left in the cache rather than deleted. | Restoring a stale on-disk copy over a file git just materialized from the branch would silently shadow committed source — a much worse failure than losing a checkpoint. Leaving it cached means the decision not to restore never destroys data either. | ✅ Covered — `gitOps.test.js` "never overwrites a tracked file in the fresh checkout with a preserved stale copy" (with an untracked sibling still restored), `artifactPreservation.test.js` tracked-wins + `skippedTracked` cases. |
| WT-3 | Preservation is scoped to an **allowlist** of artifact paths (`assets/final/lora`, `assets/src/lora/refs`, `assets/out`, plus anything added via `BOARD_PRESERVED_ARTIFACT_PATHS`), never "everything untracked". | A worktree's non-tracked set is dominated by `__pycache__/`, `.pytest_cache/`, build output, `.venv/` and the `tools/board/node_modules` symlink. Those are expensive to move and *harmful* to restore into a fresh checkout — the same stale-shadows-fresh failure as WT-2, one level below git's visibility. | ✅ Covered — `gitOps.test.js` "does not carry across untracked files outside the artifact allowlist", `artifactPreservation.test.js` (`listPreservableFiles` collects only allowlisted paths; never lists a tracked file). |
| WT-4 | A fresh card — no prior worktree, or a worktree holding no allowlisted artifacts — is a clean no-op: no cache directory is created and worktree creation is unchanged. | The overwhelming majority of cards generate nothing worth preserving. The mechanism must be invisible to them, including leaving no empty directories behind for the reaper or the integrity checker to puzzle over. | ✅ Covered — `gitOps.test.js` "leaves a fresh card with no prior worktree completely unaffected", `artifactPreservation.test.js` (absent worktree, and a worktree with no allowlisted artifacts). |
| WT-5 | The cache cannot grow without bound: it is purged for a card that reaches `done`/`retired`, each capture replaces that card's previous snapshot rather than accumulating, and an LRU bound caps how many cards' caches can coexist. A capture that finds *nothing* leaves an existing cache untouched. | Checkpoint sets run to gigabytes; an unbounded cache would quietly fill the disk the board and the GPU pipeline share. The "empty capture never clears" rule is the counterpart safety property: a reclaim that moved artifacts out and then crashed must not have its cache wiped by the next run's empty capture — that would destroy exactly what this exists to save. | ✅ Covered — `httpApi.artifactCache.test.js` (purge on `done`/`retired`, kept for in-flight statuses, other cards untouched), `artifactPreservation.test.js` (`pruneArtifactCache` LRU, one-generation replacement, empty-capture-keeps-existing-cache). |

## 9. Character-generation quality reference (asset pipeline)

Unlike §§1–8, this section is not about the board tool — it pins a standing rule about the
**asset pipeline's** character-generation outputs, recorded here because this file is where
this project keeps machine-checkable invariants. Its permanent home is
`docs/design/13-asset-pipeline.md` §3.5 / HANDOFF §24, which is a design-pass edit deferred by
DL-22, DL-24 and DL-25 — noted so the duplication is deliberate and temporary, not a fork.

Source: **DL-25** (`docs/decision-log.md`), the round-2 character decision, recording
@DennieSeth's standing guidance: *"Arm-C benchmark will never probably be beaten, but we should
always verify against it."*

| ID | Invariant | Why | Coverage |
|----|-----------|-----|----------|
| CHR-1 | Every character-generation output records **both** its own frame-delta range **and** its comparison against the Arm-C benchmark (0.072–0.112) in its committed provenance sidecar — `frame_delta_range`, `beats_arm_c_benchmark` and the `arm_c_benchmark` bounds it was compared against. The comparison is **recorded, not deciding**. | The benchmark's value is diagnostic, not gating. Arm C (T-0230, deterministic seeded script) is the tightest frame-delta this pipeline has ever produced, and a generative sheet drifting far from the winner's ~0.16 is a signal something broke — but only if the number is on every sheet. DL-25 chose §24-e (0.1576–0.1816) knowing it does **not** beat the benchmark; the number is kept as a permanent quality reference precisely because it is no longer a pass/fail bar and would otherwise quietly stop being written. | ✅ **Enforced in code (T-0258).** `ARM_C_BENCHMARK = (0.072, 0.112)` now lives in exactly one place, `tools/comfy-client/src/comfy_client/provenance_sidecar.py`, imported everywhere it's needed (`gen_pose_authority_idle_T0249.py` and `gen_hybrid_idle_T0252.py` import it directly; `gen_chained_idle_T0250.py` re-exports `pose_authority.ARM_C_BENCHMARK` as before) — a grep-based test (`tools/asset-gate/tests/test_arm_c_benchmark_constant_T0258.py`, deliberately homed in `tools/asset-gate` rather than alongside the generators it greps in `assets/src/character/` because that package has no CI job of its own — `ci-asset-gate.yml`'s `lint-test` job already runs `pytest -q` on every PR touching `assets/**`) fails CI if the literal is ever copy-pasted again. The same module's `apply_arm_c_benchmark_fields(record, ratios)` is the single write helper that derives and owns `frame_delta_range`/`arm_c_benchmark`/`beats_arm_c_benchmark` (a caller cannot supply its own value for any of the three); all three generators' per-generator computation of these fields is replaced by calls to it. `asset_gate.character.check_character_arm_c_provenance` / `sweep_character_arm_c_provenance` is the read-side gate (mirrors `asset_gate.generator`'s shape), wired into CI as the `character-arm-c-sweep` job, scoped to the `character` asset class only (props/tiles/concept/entity sheets never fail it) and never failing on `beats_arm_c_benchmark: false` (CHR-2). The 15 sidecars that predate CHR-1 are **not backfilled** (a frame-delta that was never measured must not be invented) — they're listed in `tools/asset-gate/src/asset_gate/character_arm_c_baseline.txt`, the same baseline-exemption idiom `generator_baseline.txt`/`provenance_baseline.txt`/`transparency_baseline.txt` already use, and that list is expected to **shrink to zero** as each sheet is regenerated or genuinely backfilled by a dedicated follow-up card, never by adding a new exemption. |
| CHR-2 | Arm C (T-0230) is retained permanently as the **shipping fallback** and quality reference: its script, committed sheet (`assets/final/character/player_idle_sheet_arm_c_T0230.png`) and gate results stay committed and passing, and are never regressed by a generative arm's work. It is **not** a gate the chosen generative approach must clear. | DL-23 retained Arm C as benchmark *and* fallback when it created round 2; DL-25 kept that standing after choosing §24-e on authorship grounds. The fallback only works if it stays green — and stating "not a gate" explicitly prevents the opposite failure, where a future run reads CHR-1's recorded comparison as a bar and rejects a sheet the project has already accepted. | ✅ Held — Arm C's sheet, provenance, generator and `tests/test_player_idle_arm_c_gate.py` are committed on `develop` and unmodified by any round-2 card (T-0249/T-0250/T-0251/T-0252 add files; none touch Arm C's). Not enforced by a dedicated test — it is a "do not delete/regress" property, covered in practice by Arm C's own gate test staying in CI. |
## 10. Human direction approval

Some cards do not produce *code*, they produce a **direction**: concept art, a
style sheet, a reference the rest of a track is then generated against. Such a
card is not finished when the artifact exists — it is finished when a human has
looked at the artifact and said yes. Before PR #288 the board had no way to say
that. A reviewer PASS settled every card into `review`
(`runOrchestrator._handlePass`), and the `review → done` flip was one unlabelled
drag that recorded nothing about *why* it happened. Since
[`dependencyGuard`](../tools/board/src/lib/dependencyGuard.js) counts `done` (and
`retired`) as a satisfied dependency, that flip — made for any reason, including
"the artifact looks produced" — released every downstream card.

**The incident.** T-0239 produced a *synthetic* Signal Tower props concept sheet
(labelled silhouettes composited by `_composite_props_v2.py` over an SDXL
background — drawn by script, not generated geometry). It reached `review` on a
reviewer PASS at 11:15 on 2026-08-29 and was `done` at 11:19. T-0243 duly
unblocked and generated `archive_shelving_v1` against a reference no human had
approved; the room card later caught it and reverted, but only because DL-5
happened to be checked downstream. Nothing in the board was wrong by its own
rules. Approval simply was not modelled anywhere — not as a field, not as a
state, not as a recorded act.

**The fix, in one line:** production parks at `review`; approval moves to `done`.
`dependencyGuard` is deliberately **unchanged** — it is already exactly the right
rule. What changed is *who* may write `done` on a gated card, and that the act is
recorded.

The signal is an explicit field, `requires_approval: true`, not a body-prose
marker. Body detection was considered and rejected: which cards are gated has to
be answerable without parsing English, and a card whose prose merely *mentions*
approval must not become un-completable by accident. The record of the verdict is
the pair `approved_by` / `approved_at`, written **only** by the server's own
approval paths — never accepted from a request body, never writable by a planner
run.

**How a human approves** (either is enough, both are recorded):

- **Comment** `APPROVED` (or `/approve`) on the parked card — the marker must be
  the *first non-empty line*, case-insensitive, with any explanation below it.
  This is the preferred route: it is an explicit, logged, attributed act, and the
  reasoning ends up on the card next to the verdict.
- **Drag the card to Done** in the board UI — the existing gesture, now stamped
  with who made it.

**On enforcement strength.** The actor check is a **guardrail, not a sandbox** —
the same stance [`agentCurlPolicy.js`](../tools/board/src/lib/agentCurlPolicy.js)
documents for itself. Three layers, in descending order of load-bearing-ness:
(1) no agent holds an unscoped HTTP grant at all — only `assets`/`audio` get
`agentCurl.js`, whose policy already refuses every mutating board route except
attachment upload; (2) `assertRunnerMayApply`, wired into the orchestrator's
single write chokepoint, makes it *impossible* for any automated run path to
complete an unapproved gated card, whatever an agent talks it into; (3) the
`X-Board-Actor` header and the reserved-identity list, which catch a future agent
that gains comment or PATCH rights.

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| AP-1 | A card carries an explicit `requires_approval` boolean. It defaults to `false` everywhere (parser, both stores, create endpoint), so every pre-existing card behaves exactly as it did before. The record fields `approved_by`/`approved_at` default to `null` and are part of the schema in both fs and db mode (migration `0003_add_approval_gate.sql`). | An implicit signal (body prose, `deliverable_type`, agent name) would make "is this card gated?" a guess. It has to be a fact a human sets and a machine reads. Defaulting to off is what makes this change safe to deploy against 200 live cards. | ✅ Covered — `taskParser.test.js` (round-trip, validation), `taskStoreContract.js` (both stores, identical shape), `dbMigrate.test.js`, `httpApi.approval.test.js` §AP-1. |
| AP-2 | A reviewer **PASS** on a gated card settles it in `review` — the parked state — and posts a `PARKED FOR HUMAN APPROVAL` comment naming both exits (approve → Done or `APPROVED`; reject → comment the changes and re-run). Branch, commit and PR are recorded exactly as on any other PASS. | `review` is already where a PASS lands, so the status alone cannot distinguish "parked on a human verdict" from "waiting on a PR merge". The comment is that distinction, and it means a human never has to know the ritual in advance. Keeping the PASS metadata intact means approving later needs no re-run. | ✅ Covered — `runOrchestrator.approval.test.js` §AP-2 (parked + metadata, comment content, notice is not itself a marker, ungated card unaffected, no re-post once approved). |
| AP-2b | No automated write can move a gated, unapproved card to `done`. `assertRunnerMayApply` is called from `RunOrchestrator._updateAndBroadcast`, the single chokepoint every orchestrator write passes through. | Today no run path writes `done` at all, so this never fires — which is exactly why it belongs at the chokepoint rather than at a call site. A future run path, a reviewer shortcut, or an auto-complete added in good faith inherits the guard instead of having to remember it. | ✅ Covered — `runOrchestrator.approval.test.js` §AP-2b (refuses on a gated card; allows once approved; allows on an ungated card), `approvalGate.test.js` (`assertRunnerMayApply` unit cases). |
| AP-3 | A **human** `PATCH {status: "done"}` on a gated card is the approval: it succeeds and stamps `approved_by`/`approved_at` in the same write as the status. A non-gated card's `review → done` flip is untouched and records nothing. | The drag-to-Done gesture already exists and is already a human act; forcing a separate "approve" step first would be ceremony. Stamping it in the same write means a card can never be `done` with no recorded approver. | ✅ Covered — `httpApi.approval.test.js` §AP-3. |
| AP-4 | A **human** comment whose first non-empty line is exactly `APPROVED` or `/approve` (case-insensitive) on a **parked** gated card flips it to `done`, stamps the record, and logs an `APPROVAL RECORDED` confirmation. The marker does nothing on an ungated card, a card that is not parked, or an already-approved card. | Dennie's own framing: "some way to record my approval on review, like a comment". A comment is explicit, attributed and logged, and it carries the reasoning next to the verdict. The "first line, exactly" rule is what keeps *discussion* of approval ("not approved yet", "the sheet says APPROVED in the corner") from acting as one. The not-parked exclusion stops an `APPROVED` from silently completing a card out from under its own live run. | ✅ Covered — `httpApi.approval.test.js` §AP-4 (9 cases incl. every negative), `approvalGate.test.js` §isApprovalMarker. |
| AP-5 | **An agent can never approve.** An agent-stamped request (`X-Board-Actor: agent`, which `agentCurl.js` sets on everything it forwards) is refused with 409 on `PATCH →done` and on any attempt to clear `requires_approval`, and its `APPROVED` comment is stored as an ordinary comment with no effect. A comment authored under a reserved agent identity (`assembled-board`, `reviewer`, an agent name…) never approves either, whatever the request header says. Nobody — human or agent — may write `approved_by`/`approved_at` directly; that is a 400. | This is the whole point: an agent marking its own work approved is exactly the failure the gate exists to prevent, and removing the gate is the same act as approving through it. The author check is independent of the actor check because the board writes its own comments in-process (the parked notice itself contains the word "APPROVE"). | ✅ Covered — `httpApi.approval.test.js` §AP-5 (6 cases), `agentCurlGrant.test.js` ("stamps `X-Board-Actor: agent`", asserted against a real listening server), `approvalGate.test.js` §actor identity. |
| AP-6 | While a gated card is parked, its dependents stay blocked; the approval — by either route — unblocks them. Nothing in `dependencyGuard` changed. | This is the invariant the whole mechanism exists to produce, and the one T-0239/T-0243 violated. Asserting it end-to-end (rather than trusting that `done` implies unblocked) is what makes the two halves provably connected. | ✅ Covered — `httpApi.approval.test.js` §AP-6 (dependent blocked while parked and unblocked after, for both approval routes; still blocked after an agent tries both). |
| AP-7 | A planner run may **add** `requires_approval` to a card — flagging a direction card is spec work — but may never write, alter or erase an approval record. Enforced twice: `checkPlannerDiffGuard` fails the run in fs mode, and `plannerFileView`'s `MUTABLE_FIELDS` allowlist (whose `diffPlannerFileView` runs that same guard) fails it in db mode. | The planner is the one agent that legitimately rewrites card frontmatter wholesale, so it is the one agent that could forge an approval as a side effect of ordinary work. Treated exactly like the existing "planner never touches status" rule. | ✅ Covered — `plannerDiffGuard.test.js` (forge, erase, and the legitimate add), `plannerFileView.test.js` (db-mode add applied, db-mode forge rejected). |
| AP-8 | An approval-by-comment fires the same terminal-status side effects a drag to Done does — artifact-cache purge and the `origin/develop` deploy pull. | Two routes to `done` that do *different* amounts of follow-through is precisely the shape of divergence that produced PULL-1, where one mode silently stopped deploying. Both routes now go through one `applyTerminalStatusEffects`. | ✅ Covered — `httpApi.approval.test.js` ("triggers the same deploy pull…", and not for an ordinary comment). |
| AP-9 | Cards already `done` before this gate existed are **not** retroactively re-parked. | A migration that reopened settled cards would rewrite history the board has already acted on, and would unblock/reblock downstream work with no human in the loop. The one card this actually matters for (T-0239's synthetic sheet) was already superseded by T-0257 through the normal card flow, which is the right mechanism: a new card carrying the gate, not a retro-edit of an old one. | ✅ By construction — the migration defaults every existing row to `requires_approval = 0`; no code path re-parks a `done` card. |
| AP-10 | A card's approval verdict has exactly one authoritative *read* path: `approvalVerdict(task)` in `approvalGate.js`, exposed as `GET /api/tasks/:id/approval`. It resolves `requires_approval`/`approved_by`/`approved_at` off the board record only. It is a pure read with no path to set `approved_by`/`approved_at` — it can forward an existing human stamp, never mint one. `ASSET_PROVENANCE.md`'s prose is a second, existing consumer of that same verdict (the `assets` package's own pytest gates check it directly, offline, outside board reach) — it is kept truthful by a write-through (`approvalProvenanceSync.js`'s `refreshApprovalProvenanceFile`) that forwards the same already-recorded human stamp into the one row `findApprovalDrift` flags as stale, and never mints an approval either. | T-0257 was approved on the board 2026-08-30 while `ASSET_PROVENANCE.md`'s row for its concept sheet still read "Not yet approved" — a second, hand-maintained mirror of the same verdict that nothing kept in sync, blocking T-0243/T-0244/T-0245/T-0246 for days on a decision already made (PR #307 fixed that one row by hand; `docs/decision-log.md` DL-27 records the class fix, the Option A vs Option B trade, and the run-4 addendum explaining why a narrow write-through was added on top of Option A). | ✅ Covered — `approvalGate.test.js` (`approvalVerdict`, incl. the T-0257/T-0243 drift scenario reproduced and resolved), `httpApi.approval.test.js` §AP-10 (end-to-end over the real endpoint, incl. the 404 and agent-cannot-approve cases), `approvalProvenanceSync.test.js` + `httpApi.approvalProvenanceNotice.test.js` (write-through, incl. the exact stale-row scenario, both approval routes, and the never-mints-an-approval guard). |

**The general pattern for direction cards.** Every future concept-art,
style-direction or reference-producing card sets `requires_approval: true` at
authoring time. The card's Acceptance must describe *producing and parking* —
never "get it approved", which is not a criterion an agent can satisfy and is
what made T-0233 unsatisfiable across five attempts. T-0257 (the real Signal
Tower prop concept sheet gating T-0243–T-0246) is the first card to carry it.

**The second record (T-0286, DL-27).** AP-1..AP-9 above cover the board's own
state faithfully, but say nothing about *other* readers of a card's approval
verdict. `ASSET_PROVENANCE.md` keeps a prose note per curated asset, and
until AP-10 nothing kept it in sync with the board — see AP-10 above for the
incident and the fix. `ASSET_PROVENANCE.md`'s note stays human-readable
documentation for a reader with no board access, but it **is** consulted for
the verdict by at least one real, existing, mechanical gate: each of
`assets/src/concept/tests/test_{power_substation,equipment_floor,antenna_shaft}_room_manifest.py`
defines `test_t0257_concept_sheet_is_approved()`, a plain pytest assertion
that does `"APPROVED" in row` against the file on disk. An earlier draft of
this line claimed the opposite ("not consulted for the verdict"); that was
wrong, and is corrected here (`docs/decision-log.md` DL-27's run-4 addendum
has the full account). No existing row is retroactively rewritten by any of
this — only a row `findApprovalDrift` flags as `stale-unapproved-claim` for a
card the board has since approved is ever touched, and only the matched
stale phrase within it.

**AP-10's mechanical backstop, and the instruction edit still owed.**
`findApprovalDrift` (`tools/board/src/lib/approvalProvenanceDrift.js`) plus
`ci-approval-provenance-drift.yml` cross-check every provenance row naming a
card against that card's real `approvalVerdict` on every PR touching
`ASSET_PROVENANCE.md` or `tasks/**` — a code-only, git-diff-level catch for
exactly the T-0257/T-0243 drift shape, independent of any agent's own tool
grants. The live board process goes one step further:
`approvalProvenanceSync.js`'s `refreshApprovalProvenanceFile`, wired into
both of `httpApi.js`'s approval write paths, rewrites the specific stale row
the moment a human's AP-3/AP-4 gesture stamps an approval — forwarding only
the `approved_by`/`approved_at` that gesture just wrote, never minting one —
which is what makes the three pytest gates above self-heal without their own
code changing. What did **not** land in this pass: instructing the `assets`
agent itself (`.claude/rules/assets.md`) to resolve approval from
`GET /api/tasks/:id/approval` rather than from `ASSET_PROVENANCE.md`'s prose
*before it generates* — the write-through above fixes the existing mechanical
gates, but does not stop an agent from reading stale prose in the moment
before an approval lands. Editing anything under `.claude/**` was refused at
the session level while T-0286 was in progress; see
`docs/T-0286-claude-instruction-edit-blocked-attempt-log.md` for the exact
refusals and the exact text to apply once a session with `.claude/**` write
access is available.

---

## Summary

| Area | Covered | Partially covered | Not covered (fixed this PR) | Not covered (deferred) |
|------|---------|--------------------|------------------------------|--------------------------|
| Dependency dots | DOT-1..5, DOT-7 | — | DOT-6 | — |
| Status lifecycle | LC-1..4, LC-6 | — | LC-5 | LC-7 |
| Create/update | CR-2, CR-3 | CR-1 | — | — |
| WS event application | WS-1..4 | — | WS-5, WS-6, WS-7, WS-8 | — |
| Run gating | RUN-1, RUN-2 | — | RUN-3 (= LC-5) | — |
| Deploy propagation | PULL-2, PULL-3, PULL-4 | — | **PULL-1 (headline)** | — |
| Detail panel live-update safety | — | — | DP-1, DP-2 | — |
| Worktree artifact preservation | WT-1..WT-5 | — | — | — |
| Character-generation quality reference (§9, DL-25) | CHR-2 | CHR-1 | — | CHR-1 (see §9) |
| Human direction approval | AP-9 | — | AP-1..AP-8 (new mechanism) | — |

**Deferred, not silently dropped:** LC-7 (no guard against a manual card edit
racing an active orchestrator run) is a real, confirmed gap found while
building this list, but fixing it requires a product decision (which fields,
if any, should be editable mid-run?) rather than a mechanical test-then-fix
like LC-5/RUN-3. Flagged for a follow-up card rather than fixed here.
