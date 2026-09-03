# Architectural review — board run-lifecycle and state management

**Date:** 2026-09-03 · **Scope:** read-only · **Repo:** `~/dev/assembled-board` @ `develop` `2960b9a`
**Method:** code reading + live evidence from the running board (journal, card bodies, runstate files, run logs, a read-only probe of the board's own liveness code). No code changed, no run touched, nothing merged.

---

## 0. What the evidence overturned

Two premises that framed this investigation — including in the card I filed this morning as **T-0296** — turned out to be **wrong**, and the real root cause is different from both. Stating this up front because the fix plan depends on it.

**Overturned #1 — "the stale heartbeat drives the false reaps."** It does not. `updatedAt` is *never read by any liveness decision*; `runState.js:28-35` documents this deliberately, and `runState.test.js` has a suite pinning it. The `hb264s` / `hb437s` figures I reported earlier are real but **diagnostic-only** (`orphanReaper.js:204-207`). They are a red herring. The de facto heartbeat is the **run log's mtime** (`runState.js:145-153`).

**Overturned #2 — "`isPidAlive` returns false negatives in WSL2."** This is T-0289's surviving candidate #1, recorded in `runState.js:106-113` as "plausible-but-unconfirmed." I tested it directly, read-only, by importing the board's own `runState.js` and evaluating the live runstate:

```
T-0290 pid=1287082 pidAlive=true live=true wedged=false => VERDICT alive
T-0273 state=NULL freshestLogAgeMs=577690 => verdict dead
```

`isPidAlive` is **correct** in this environment. The predicate is not broken. **T-0289's root-cause analysis pursued the wrong candidate**, which is why #314 did not fix the problem.

---

## 1. Consolidated root cause

> **Card status has two independent writers. The authoritative one holds run state in memory; the other infers it from filesystem artifacts that go stale during normal operation — and writes anyway, without consulting the authority sitting in the same process.**

Everything below is a consequence of that one flaw.

### 1.1 The two writers

| Writer | Source of truth | Writes status | Location |
|---|---|---|---|
| `RunOrchestrator` | `this.activeCardIds` — **in-memory, exact, authoritative** | `in-progress`, `validation`, `review`, `blocked`, `done` | `runOrchestrator.js:334` `_updateAndBroadcast` |
| `orphanReaper` | `{pid, runLogPath}` on disk + log mtime — **inferred, lossy** | `blocked` only | `orphanReaper.js:60-68` `reapCard` |

Both call `store.update()` directly. There is **no ownership token, no generation counter, no compare-and-swap, no "who is allowed to write this card right now"**. It is last-writer-wins on a shared mutable field. `_updateAndBroadcast` has exactly one guard (`runOrchestrator.js:340-342`, the human-approval check for `status: "done"`) and no concept of "another authority may have moved this card since I read it."

The two are wired to the *same* Set by reference — `boardServer.js:85`, `activeCardIds: orchestrator.activeCardIds` — so the reaper *can* see the truth. It consults it only as a coarse skip-list (`orphanReaper.js:290`), never as the authority for the write itself.

### 1.2 Proof the reaper is the sole author of every false `blocked`

`reapCard` is the **only** writer of the string `run did not complete (board restarted or process ended before a verdict)` — verified: `grep -rn "run did not complete" --include=*.js src/ scripts/` returns exactly one hit, `orphanReaper.js:25`. The orchestrator's own block path (`_blocked`, `runOrchestrator.js:999`) writes a `## Blocked` note instead. So the note kind is a perfect discriminator.

T-0290's card body, live, at 17:27Z:

```
status=blocked attempts=4
Recovered notes (reaper-only): 8
    ... 2026-09-03T17:18:36.387Z
    ... 2026-09-03T17:20:17.071Z
    ... 2026-09-03T17:25:34.070Z
    ... 2026-09-03T17:27:03.151Z
Blocked notes (orchestrator): 0
all note kinds: Recovered | Validation: FAIL
```

**Eight reaper reaps, zero orchestrator blocks.** Every `blocked` T-0290 showed today was written by the reaper against a run that was alive and writing. The full series: `16:56:16`, `17:03:41`, `17:12:06`, `17:14:03`, `17:18:36`, `17:20:17`, `17:25:34`, `17:27:03` — a reap roughly every 90-150s, matching the observed flapping exactly.

T-0273 was reaped once, at `17:14:03.830Z` — **48 milliseconds** before T-0290's `17:14:03.878Z` reap. Same sweep tick, both live.

### 1.3 Why liveness is wrong in *both* directions

**Direction A — live run judged dead (the false `blocked`).** `checkRunStatus` (`orphanReaper.js:163-188`) can only return `alive` if `isPidAliveFn(state.pid)` is true *for the pid currently recorded on disk*. But the recorded pid is only refreshed **once per phase**, at `runOrchestrator.js:838`, at spawn time. Between phases — implementer child exits, then `verifyRouter`, git sync, PR-open, worktree work, then the reviewer child spawns — the runstate holds a **since-exited pid**, and nothing appends to the `.jsonl`, so the log mtime ages past `DEFAULT_HEARTBEAT_STALE_MS` (60s, `runState.js:16`). Both branches of `isRunLive` (`runState.js:138-142`) then return false → verdict `dead` → reap.

That window is **not an edge case; it is the normal shape of a run.** The code already knows: `orphanReaper.js:318-323` describes "the normal quiet window between runOrchestrator.js's per-phase writeRunState calls (e.g. mid PR-open, which can legitimately run past DEFAULT_HEARTBEAT_STALE_MS) when the runstate on disk can transiently hold a since-exited child's pid alongside a stale-looking log." **The mechanism was correctly identified in #314 and only partially defended against.** With a 30s sweep (`orphanReaper.js:21`) against a 60s staleness window, any inter-phase gap over ~75s is a reap.

**Direction B — dead/absent run judged live, and live run shown as not-running.** Two sub-cases, both observed:

- `T-0273` displayed `ready` while its pid was alive and its log growing. `ready` is not in `ORPHANABLE_STATUSES` (`orphanReaper.js:19`), so the reaper never corrects it — the reaper can only ever write `blocked`. **Nothing in the system reconciles a card that is running but displayed as not-running.** The status writer is fire-and-forget; there is no reconciliation loop, only a destructive one.
- `runCard` adds to `activeCardIds` at `runOrchestrator.js:391` but does not write `status: "in-progress"` until `:408`, **after** `addWorktree` and `linkBoardNodeModules`. On a cold worktree that is a multi-second-to-minutes window in which the run is fully active and the card still reads `ready`.

**The unifying statement:** the reaper's verdict is a *guess about another component's state*, made from artifacts that component updates only at phase boundaries. It is wrong in direction A during every long phase gap and blind in direction B by construction.

### 1.4 The self-sustaining oscillation

A reap does not stop the run — it only rewrites the card. `reapCard` writes `blocked`; the still-live orchestrator writes `validation` at its next transition (`runOrchestrator.js:619`); the next sweep reaps again. Neither writer ever notices the other. This is the ping-pong recorded verbatim in `runState.js:95-99` and reproduced live today across eight cycles.

Worse, the backstop at `orphanReaper.js:324` does **`activeCardIds.delete(task.id)`** — the reaper mutating the orchestrator's own in-flight registry for a card it does not own. Any time that path fires on a live run it makes the card invisible to `hasActiveRuns()`, converting a display bug into a **double-launch hazard** (§1.5).

### 1.5 How this produced the day's other symptoms

- **T-0243's lost verdict.** A reap during a quiet window rewrote the card mid-run; the run's own PASS then had no card left in a state that could receive it. Note that a reap alone is *survivable* — T-0273 was reaped at 17:14 and still reached `review` — so verdict loss needs the reap to coincide with the `activeCardIds.delete` path or a run end. This is the one causal chain in this review I rate **probable, not proven**.
- **Phantom idle → double-launch.** `hasActiveRuns()` is the *only* condition still holding. The poller's second condition, "no in-progress/validation card" (`autoLaunchPoller.js:113`), is defeated whenever the reaper has rewritten a live card to `blocked` or the card is still at `ready`. Confirmed live: `auto-launch: skipped -- the orchestrator reports an active run` is firing on condition 1 alone.
- **`POST /run` is unguarded.** `httpApi.js:515` calls `assertCanMoveToInProgress` — a dependency/status check. It does **not** consult `hasActiveRuns()`; only the poller does. The re-entrancy guard that saved us today is `runOrchestrator.js:384` (`Task X already has an active run`), which is per-card, not board-wide. **This is why Dennie's second T-0273 click was correctly refused — that guard, not the status field, is what is actually protecting the board.**
- **Stale runstate records.** `clearRunState` runs only in `runCard`'s `finally` (`runOrchestrator.js:422`). A hard kill or restart leaves the file behind, and the next process reads a dead pid as gospel.

### 1.6 Adjacent items — judged NOT the same root cause

- **`spawn E2BIG` in `_handlePass → _syncBranchWithDevelop`** (`runOrchestrator.js:1158, 1238`; `gitOps.js:1-17` uses `execFile`): an argv-length limit on a git invocation with too many/too-long arguments. Unrelated to state management. **Separate bug** (already carded, T-0291).
- **~90s SIGTERM shutdown.** Shutdown does not await in-flight children; detached `claude` children (`claudeCliRunner.js`) outlive the unit and systemd waits out its timeout. Related only in that it *creates* orphans for the reaper to mishandle. **Separate bug** (T-0290 itself).

---

## 2. Recommended architecture

**Principle: card status becomes a projection of run state, with exactly one writer. Liveness is *known*, not inferred, whenever the owning process is alive.**

### 2.1 One authority for "is this run live" (the core change)

Introduce an explicit **run registry** owned by `RunOrchestrator` — the existing `activeCardIds`, promoted from a bare `Set` to a record per card: `{taskId, phase, pid, runLogPath, startedAt, lastTransitionAt, epoch}`. Then:

- **The reaper never decides liveness for a card the registry knows about.** Today it skips such cards (`orphanReaper.js:290`) but retains two escape hatches that write status anyway. Both must go: the wedged-kill may keep killing the *process* (that is legitimate and is T-0185's fix) but must **never** write card status, and the `readoptedCardIds` backstop must never `activeCardIds.delete` a card it does not own.
- **The reaper's remit narrows to exactly what it is good at:** cards the in-memory registry has *no* record of — i.e. survivors of a restart. That is the only situation where filesystem inference is the best available evidence, and it is the job the reaper was built for.

### 2.2 A real heartbeat, or none at all

Today's `updatedAt` is a field that looks like a heartbeat, is written once per phase, and is *deliberately never read* — `runState.js:28-35` even calls this out as "exactly the trap T-0289 flagged," then keeps the trap and documents it instead of removing it. Pick one:

- **Preferred:** the owning process writes a genuine heartbeat on a timer (every ~10s) for the whole `runCard` span, *independent of phase boundaries*, and liveness reads it. This survives restarts (the file persists) and closes the inter-phase window at its source.
- **Or:** delete `updatedAt` entirely and stop shipping a field that invites exactly this misdiagnosis. (I lost time to it today; so did T-0296 as originally written.)

### 2.3 Make the status write a state machine, not a field assignment

`store.update(id, {status})` should reject illegal transitions. A live run's card must not be settable to `blocked` by a non-owner; a `ready` card must not stay `ready` once a run owns it. Enforce at the store boundary so **both** writers are covered — this is the invariant that would have prevented every false `blocked` today regardless of how the liveness check behaved.

### 2.4 Close the display gap in the other direction

Move `status: "in-progress"` to immediately after `activeCardIds.add` (`runOrchestrator.js:391`), before worktree setup, so a tracked run is never displayed as `ready`. Cheap, independent, and it restores the poller's second gate condition.

---

## 3. Prioritized fix plan

Ordered by risk-reduction per unit of change. **Load-bearing warning: `hasActiveRuns()` is currently the board's *only* working protection against double-launch (§1.5). Nothing below may weaken it, and no change to it should land in the same PR as anything else.**

| # | Fix | Card | Risk | Notes |
|---|---|---|---|---|
| **1** | **Reaper must not write status for a registry-tracked card.** Remove the `activeCardIds.delete` at `orphanReaper.js:324`; wedged path kills the process only. | **extend T-0296** | Low | Highest value, smallest diff. Stops all 8 of today's reaps. |
| **2** | **Emit the reap diagnostics.** See §4.1 — reaps are currently *silent*. | **T-0296** | None | Do this **first in the same PR**; without it #1 cannot be verified in production. |
| **3** | Real heartbeat for the whole run span (§2.2) | new card | Low | Closes the inter-phase window at source. |
| **4** | `in-progress` before worktree setup (§2.4) | new card | Low | Restores the poller's 2nd gate. Independent. |
| **5** | Transition validation at the store boundary (§2.3) | new card | **Medium** | Touches every writer. Needs its own PR. |
| **6** | `POST /run` consults `hasActiveRuns()` | new card | **HIGH — load-bearing** | Currently the only protection. Change alone, with tests, deployed deliberately. |
| **7** | `clearRunState` on abnormal termination | new card | Low | Kills the stale-record class. |
| **8** | **Push the branch before a FAIL verdict is recorded** (§4.0a) | new card | **Medium** | Real data loss, twice today. Independent of the state model. |
| **9** | **Acceptance criteria must be agent-satisfiable** (§4.0b) | new card | Low | Card-authoring guard, not runner code. Has blocked 4 cards. |

**On T-0289/#314:** do not treat it as a working baseline. Its analysis (`runState.js:80-127`) eliminated candidates #2, #3 and #4 by sound reasoning and settled on #1, `isPidAlive` false negatives — which §0 disproves by direct measurement. The confirmed/deferred split it added is *harmless and mildly useful*, but it defends the wrong window. The mechanism that is actually firing is described accurately in its own comment at `orphanReaper.js:318-323` and was left only partially defended.

**T-0296 should be rewritten** — its premise (stale heartbeat + broken pid check) is now disproven. Keep the symptom evidence, replace the causal claim.

---

## 4. Other latent bugs found

**4.0a UNPUSHED WORK IS LOST ON A FAIL VERDICT — real data loss, twice today.** When a run ends in FAIL, the card's branch is not pushed before the verdict is recorded, so committed-but-unpushed work is stranded in a worktree that the next re-run may replace. Established firsthand today across two cards: **T-0288 (1047 lines)** and **T-0290 (253 lines)**, both recovered only by manual intervention. The T-0288 figure is independently corroborated here — `git diff --stat origin/develop...origin/feature/T-0288` measured during this review reports exactly `7 files changed, 1047 insertions(+)`.

This is **not** part of the state-model flaw in section 1 and must not be folded into T-0296; it is an independent defect in the FAIL path with a worse consequence (lost work, not a wrong label). It interacts with the worktree-artifact-preservation work (PR #277) and should be carded on its own. Note the ordering requirement: the push must happen **before** the verdict is recorded, so a FAIL can never be the event that orphans the work.

**4.0b THE UNSATISFIABLE-ACCEPTANCE-CRITERION CLASS — four cards blocked by it.** An acceptance criterion that demands evidence no agent in this repo can gather causes every retry to reproduce an identical failure signature, which the no-progress guard then correctly aborts. The guard is working; the cards are unsatisfiable. Confirmed on **T-0258**, **T-0259**, **T-0288** (criterion #7: real-browser observation, impossible because `tools/board` ships only `happy-dom`, which performs no layout) and **T-0290** (reviewer's closing line: *"fully covered by tests — the only gap left is evidence no agent can gather"*).

Two recurring shapes, both card-authoring defects rather than runner defects:
1. **Capability-impossible** — requires a tool or observation the agent environment does not have (a real browser, a human's eyes).
2. **PR-precondition** — requires an open PR with green CI, which the orchestrator only does *after* a PASS, so the criterion can never be true at verdict time.

The durable fix is a card-authoring guard (a planner self-check, or a preflight that rejects known-impossible phrasings), plus retro-wording the affected cards. **T-0290's own AC still needs rewording the way T-0288's was** before it is re-run — otherwise it will exhaust five more attempts. Worth carding as a class, not fixing card-by-card.

**4.1 Reaps are completely silent — the highest-value finding after the root cause.** `reapCard` is followed by `logger.log(...)` at `orphanReaper.js:275/330/368/376`, `logger` defaults to `console` (`:110`), and the server's stdout **does** reach the journal (auto-pull/auto-launch lines appear normally). Yet: 8 reaps on T-0290 today, and `journalctl --user -u assembled-board --since today | grep -c "recovered orphaned card"` returns **0**. No `orphan sweep failed` line either. So either the sweep throws between the status write and the log, or the reaper's logging is misconfigured in a way I could not determine read-only. **Either way the operator gets no signal, which is why this survived all day and cost T-0289 an incorrect root cause.** Instrument before fixing anything else.

**4.1b THE ESCALATION WORKFLOW IS DEAD IN db MODE — new, and severe.** `taskParser.js:26` declares `ASSIGNABLE_AGENT_NAMES = [... "generic", "planner", "dispatch"]`, and `runCard` (`runOrchestrator.js`) relies on `"dispatch"` as its non-executable sentinel so a remediation card surfaces for a human instead of being auto-run. But the SQLite schema's CHECK constraint does **not** include it:

```
Escalation failed: CHECK constraint failed:
  agent IN ('infra','server','client','assets','audio','planner','generic') OR agent IS NULL
```

**11 real occurrences in today's run logs.** Every escalation in db mode fails at the DB write. Observed end-to-end on T-0290: it exhausted all 5 attempts, the retry loop aborted, and the remediation card it tried to dispatch **was never created** — the failure is caught and logged into the run log only, so the card simply stops. The escalation workflow has been non-functional since the db cutover; nothing surfaced it because the error never leaves the `.jsonl`.

Fix is a one-line migration adding `'dispatch'` to the constraint, plus a test asserting `ASSIGNABLE_AGENT_NAMES` and the schema constraint agree — they are two hard-coded lists that must match and currently do not. **Own card, independent of everything else in this review.**

**4.1c Escalation failures are swallowed into the run log.** `_logEscalation` (`runOrchestrator.js:1128`) writes the failure to the `.jsonl` and `.catch(() => {})`s it. Same silent-failure family as §4.1: a whole workflow was dead for weeks with no operator-visible signal.

**4.2 `if (!runsDir) return { verdict: "dead" }`** (`orphanReaper.js:164`) — a missing config silently degrades to "reap everything." Should refuse to sweep instead.

**4.3 The reaper mutates another component's private state** (`activeCardIds.delete`, `:324`). An architectural violation independent of whether it currently misfires.

**4.4 `readoptedCardIds` has no eviction on normal completion** — entries accumulate for the process lifetime.

**4.5 Best-effort writes hide real failures.** `writeRunState` (`runState.js:37-45`) and the commit path in `_updateAndBroadcast` swallow all errors silently. A runstate that fails to write leaves a run invisible to restart recovery with no trace.

**4.6 `DEFAULT_SWEEP_INTERVAL_MS` (30s) vs `DEFAULT_HEARTBEAT_STALE_MS` (60s)** are set independently with no documented relationship, guaranteeing ~2 sweeps inside every staleness window.

**4.7 No test covers a live run across a phase boundary.** Today's failure is the single most common shape of a real run, and the suite (130 files, 2479 tests, all green) does not reproduce it. That is the coverage gap that let #314 ship believing it was fixed.

---

## 5. Concurrency result (the good news)

Two different-agent runs — **T-0290 (infra)** and **T-0273 (assets)** — ran simultaneously for ~11 minutes with **no interference**: separate pids, separate worktrees (`worktrees/T-0290`, `worktrees/T-0273`), separate runstate files, both logs progressing (T-0273 wrote 1.38 MB in one 90s sample), no db write collisions, no cross-contamination.

**Both runs reached real verdicts — no phantom blocks.**

- **T-0273 (assets): genuine PASS.** `status=review`, `branch=feature/T-0273`, `attempts=0`, and it opened **PR #319** (OPEN / CLEAN). It reached that verdict *despite* being falsely reaped mid-run at 17:14:03Z — the reap was survivable because the orchestrator simply overwrote the card at its next transition. Its agent also correctly declined to self-approve: *"I wrote no approval record and moved nothing to done."*
- **T-0290 (infra): legitimate failure, not a phantom.** It exhausted all 5 auto-retry attempts (`att2 -> att5` across the observation) and ended `blocked` via a real *"Blocker report (no progress — retry loop aborted)"* comment. Its reviewer's closing line — *"fully covered by tests — the only gap left is evidence no agent can gather"* — is the **same unsatisfiable-acceptance-criterion signature as T-0288's criterion #7**: the card asks for evidence no agent in this repo can produce, so every attempt reproduced an identical failure signature. That is a card-authoring defect, not a runner defect, and T-0290's AC should be reworded the way T-0288's was.

The 18-tick status trace shows the oscillation clearly — `in-progress -> blocked -> validation -> blocked` on T-0290 while its pid was alive and its log grew every single sample — and shows it resolving at each phase boundary, exactly as §1.4 predicts.

**Concurrent different-agent runs work.** The blocker to parallelising is not the runner — it is the single-writer status corruption above, plus the fact that `POST /run` has no board-wide guard (§1.5, fix #6). Fix those two and parallel dispatch is a reasonable next step.

---

## 6. Method and limits

Read-only throughout. Live evidence: `journalctl --user -u assembled-board`; card bodies via `GET /api/tasks/{id}`; `tasks/.runs/*.runstate.json` and `*.jsonl` mtimes/sizes; `ps`/`ss`/`systemctl` for process topology (confirmed **one** board process, pid 1164054 on 4173, no duplicate-instance effect); and a throwaway node probe importing the board's own `runState.js`.

**Explicitly not proven:** the exact micro-timing of each of the 8 reaps — which of `checkRunStatus`'s branches returned `dead` on each occasion. Establishing that requires the reap diagnostics that §4.1 shows are not being emitted, which is why instrumentation is fix #2 and not an afterthought. The mechanism in §1.3 is strongly supported by the code, the note timestamps and the sweep/staleness arithmetic, but the per-reap branch attribution is inference.
