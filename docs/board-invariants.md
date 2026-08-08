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

## 6. Deploy propagation (pull-on-done)

This area is different in kind from §1–5: it's not about what renders on a
card, but about whether merged code on `origin/develop` ever reaches the
live board process at all. It's the headline finding of this PR — a real,
already-shipped regression, not just a coverage gap discovered by
enumeration.

| ID | Invariant | Why it matters | Status |
|----|-----------|-----------------|--------|
| PULL-1 | Marking a card `done` triggers a pull of `origin/develop` into `repoRoot`, **independent of task-store mode** (fs or db). | This is the live board's *only* auto-deploy mechanism — there is no timer or other trigger (confirmed: `systemctl --user list-timers` on the live host shows only asset-sync/backup/integrity-check timers, nothing pull-related). `handlePatchTask` (`httpApi.js`) gated the pull with `taskStoreKind !== "db"`, reasoning that "card writes never touch git in db mode" — true, but irrelevant to this invariant: `repoRoot` is still a real, live checkout of `develop` in db mode (Phase 2 keeps `tasks/` git-tracked alongside the DB), and *other* merged PRs still need to reach it. When the live board was cut over to `BOARD_TASK_STORE=db` on 2026-08-07, this gate silently killed the only auto-deploy path — merged code stopped reaching the live tree with no error, no log line, nothing. First noticed 2026-08-08 when the user reported merged code wasn't showing up live. | ❌ **Was NOT covered, and shipped broken for a day.** Fixed in this PR: the `taskStoreKind !== "db"` condition is dropped from the gate. New regression tests in `httpApi.dbMode.test.js` (`PULL-1: ...`), confirmed failing against the pre-fix code before the fix landed. |
| PULL-2 | The pull never blocks or delays the PATCH response — it's fire-and-forget, and a failed pull (network down, no `develop` ref, merge conflict) still returns 200 with the card's updated status. | A flaky/offline git remote must not make marking a card done appear to fail. | ✅ Covered — `httpApi.done.test.js` "still returns 200 even when pullDevelop rejects". |
| PULL-3 | The pull itself is never gated on whether a card run is active, but a **service restart** triggered by the pull (`restartCoordinator.notifyPulled`) *is* deferred while `orchestrator.hasActiveRuns()` is true. | These are deliberately different gates on different risks. `pullDevelop` runs `git pull` against `repoRoot` only; a card's live run happens in its own `git worktree` (`gitOps.addWorktree`, on a `feature/T-XXXX` branch) — a separate working tree and HEAD that a pull into `repoRoot`'s `develop` checkout cannot touch or interrupt. What *would* interrupt a live run is restarting the board's Node process out from under the in-process `RunOrchestrator` — that's the actual risk, and it's the thing already deferred. Gating the pull itself on "no live run" (rather than just the restart) would be over-broad and would reintroduce a version of this same bug: a long-running card would indefinitely block *all* deploys, not just its own restart. | ✅ Covered — `httpApi.done.test.js` "restart-on-pull coordination" (fs mode, 4 tests) and the new `httpApi.dbMode.test.js` "PULL-1: defers the restart-on-pull coordinator... in db mode too" (confirms the same deferral holds in db mode, not just fs mode). |

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

---

## Summary

| Area | Covered | Partially covered | Not covered (fixed this PR) | Not covered (deferred) |
|------|---------|--------------------|------------------------------|--------------------------|
| Dependency dots | DOT-1..5 | — | DOT-6 | — |
| Status lifecycle | LC-1..4, LC-6 | — | LC-5 | LC-7 |
| Create/update | CR-2, CR-3 | CR-1 | — | — |
| WS event application | WS-1..4 | — | WS-5, WS-6, WS-7, WS-8 | — |
| Run gating | RUN-1, RUN-2 | — | RUN-3 (= LC-5) | — |
| Deploy propagation | PULL-2, PULL-3 | — | **PULL-1 (headline)** | — |
| Detail panel live-update safety | — | — | DP-1, DP-2 | — |

**Deferred, not silently dropped:** LC-7 (no guard against a manual card edit
racing an active orchestrator run) is a real, confirmed gap found while
building this list, but fixing it requires a product decision (which fields,
if any, should be editable mid-run?) rather than a mechanical test-then-fix
like LC-5/RUN-3. Flagged for a follow-up card rather than fixed here.
