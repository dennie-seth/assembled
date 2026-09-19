# Deploying assembled-board

The live board runs under a systemd user unit (`assembled-board.service`). It does **not** watch
its own source for changes -- see "No file watcher on the deployed service" below for why, and
what that means for how a deploy or a pull actually takes effect. Two real outages taught us that
a naive `git pull && systemctl restart` is not safe here:

1. **An unguarded watch-and-restart auto-relaunches mid-merge, or mid-run.** If code is
   pulled/merged into the working tree while the service is still *up*, a file watcher that
   reacts unconditionally restarts the server in the middle of the merge -- including
   mid-conflict-resolution, with conflict markers sitting in a source file. This really
   happened: it reset a live card run and then crashed on the conflict-markered file, taking
   the board down 20+ minutes. `dev:server` used to run under `node --watch`, which has exactly
   this problem -- it also reappeared in a second, narrower shape (T-0385): even after
   `serviceRestart.js` grew a guard that defers a *pull-triggered* restart while a card run is
   active, `node --watch` still restarted on the pulled files anyway, because it doesn't know the
   guard exists. T-0385 first replaced `node --watch` with a guard-respecting watcher
   (`src/server/watch.js`), but a follow-up review round found that watcher's own liveness check
   couldn't see a run still in worktree setup -- see "No file watcher on the deployed service"
   below for why the fix that landed was removing the watcher outright, not patching that check.
2. **`develop` diverges from origin by design.** The board commits its own runtime data
   (attachments, card status writes) straight to `develop` locally (see `gitOps.js`'s
   `commitPaths`/`commitTaskFile`). A plain `git pull --ff-only` breaks the first time that
   happens, because the local branch has commits origin doesn't have.

## `npm run deploy` (`scripts/deploy.sh`)

```
npm run deploy   # from tools/board
```

Steps, in order:

1. **Live-run check** (`node scripts/checkLiveRun.js`, see below) -- refuses to proceed if a
   card run looks like it's in progress.
2. **Stop the service**: `systemctl --user stop assembled-board.service`. This is the whole
   point of the script -- **the service is stopped before the working tree is touched**, so
   nothing is running to observe or react to the merge at all. Every step after this point
   operates on a tree nothing is watching.
3. **Fetch + merge**: `git fetch origin develop`, then `node scripts/mergeOriginRef.js`
   (wrapping `gitOps.js`'s `mergeOriginRef`, the same decision logic `mergeNoFF` uses):
   fast-forward when repoRoot has nothing local to preserve, falling back to `merge --no-ff
   --no-edit origin/develop` only when it genuinely does (local runtime commits, see above).
   Not a bare `pull --ff-only` -- a fast-forward is often not possible, and this script must
   never leave the tree mid-merge. Before T-0304 this was an unconditional `--no-ff`, which
   manufactured an empty merge commit on every no-op deploy. On conflict (only reachable via
   the `--no-ff` fallback), it runs `git merge --abort` immediately (restoring the pre-merge
   tree, no conflict markers left on disk), restarts the service on that last-known-good tree,
   and exits non-zero with instructions.
4. **`npm install`, conditionally**: only if `tools/board/package.json` actually changed
   between the pre- and post-merge commit (compared via `git diff --name-only`). Skipped
   entirely on a no-op merge -- keeps re-running the script idempotent and fast.
5. **Start the service**: `systemctl --user start assembled-board.service`.
6. **Health check**: polls `GET http://127.0.0.1:${BOARD_PORT:-4173}/api/tasks` (retries with
   a short delay; see `DEPLOY_HEALTH_RETRIES`/`DEPLOY_HEALTH_RETRY_DELAY` env vars) until it
   responds or the retry budget is exhausted.

**Safe to abort / idempotent:** every failure branch either restarts the service on the tree
as it currently stands (fetch failure, merge conflict -- both leave a valid, buildable tree)
or explains explicitly why it didn't (an `npm install` failure leaves the service stopped
rather than risk crash-looping it on inconsistent `node_modules`) and what to run manually.
Re-running the script with nothing new to pull is a normal no-op path, not a special case.

## Live-run guard (`src/runner/liveRunGuard.js`, `scripts/checkLiveRun.js`)

A card run is a `claude -p ...` child process of the board service itself, so stopping the
service mid-run kills it outright, and merging code under it is exactly the scenario that
caused outage #1 above. The guard treats a run as "live" (refuses to deploy) if **either**:

- `pgrep -af claude` finds a process that looks like the real headless invocation (`claude
  -p`/`--print` on the command line, not just anything mentioning "claude"), or
- any `tasks/.runs/*.jsonl` file (the run's audit log, appended to continuously while a run
  is active) was modified in the last 2 minutes.

Either signal alone is enough to refuse -- a false "safe to deploy" here reproduces outage #1;
a false "not safe" just means retrying the deploy shortly after. Run it standalone with `npm
run check:live-run`.

## Auto-push (`src/runner/autoPush.js`)

Outage #2 (steady divergence from origin) is addressed at the source: every board-authored
runtime commit now also pushes `develop` to origin.

- **Where it lives:** wired into `gitOps.js`'s `commitPaths`/`commitTaskFile` -- the single
  choke point every runtime commit already goes through (card create, comments, attachment
  add/remove) -- so every caller gets it automatically with no changes at the call sites.
- **Non-blocking:** `schedulePush()` is fire-and-forget. It's called after the commit lands
  but is never awaited by the HTTP handler that triggered it, so a slow or failing push can
  never delay or fail the API response. Overlapping calls are serialized onto a private
  in-module promise chain (not run concurrently) so two pushes can't race each other over
  git's ref locks -- e.g. two attachment uploads seconds apart each queue their own push
  attempt, and the second one runs only once the first has settled.
- **Non-fast-forward handling:** if origin has moved on, the plain push is rejected. The
  module then reconciles with one `git fetch` + a fast-forward-or-`--no-ff` merge
  (`gitOps.js`'s `mergeNoFF`, wrapping `mergeOriginRef`) and retries the push exactly once.
  Never uses `--force`/`--force-with-lease`. It never has to shell out to the deploy script's
  merge logic -- `mergeOriginRef` is the one shared decision implementation both use.
- **Failure is non-fatal:** any other failure (unreachable origin, protected branch, a
  persistent conflict the retry couldn't clear) is logged as a warning and swallowed. The
  local commit always stands either way -- only whether it's reached origin yet is in
  question, and the next runtime commit will try pushing again.
- **Disabling it:** set `AUTO_PUSH_ON_COMMIT=0` (also accepts `false`/`off`/`no`, any case) in
  the service's environment.

## Periodic auto-pull (`src/runner/autoPullPoller.js`)

Marking a card `done` already triggers a pull of `origin/develop` into `repoRoot`
(`httpApi.js`'s `handlePatchTask`, see `docs/board-invariants.md` §6 PULL-1) -- but that only
fires from a card event. An idle board with no card reaching Done never re-checks
`origin/develop`, so a merged PR can sit un-deployed indefinitely with nothing to trigger a
catch-up (this happened live: PR #210 sat un-pulled for hours). `autoPullPoller.js` closes that
gap with an in-process timer, started/stopped alongside the rest of `boardServer.js`'s
lifecycle -- **not** a separate systemd timer like the asset-sync/db-backup/integrity-check
units, since it needs live access to the same `RunOrchestrator`/`restartCoordinator` instances
the HTTP server already holds.

Every tick: if a card run is active (`orchestrator.hasActiveRuns()`), the tick is skipped
entirely -- no fetch, no pull, no restart -- deferring to the next tick or to the run's own
eventual idle notification. Otherwise it fetches `origin/develop` and, only if `repoRoot`'s HEAD
is actually behind, runs the exact same `pullDevelop` + `restartCoordinator.notifyPulled` pair
the Done path uses -- no separate pull/restart logic to keep in sync with PULL-1..3.

- **`BOARD_AUTOPULL`** -- default ON; set to `0`/`false`/`off`/`no` (any case) to disable,
  mirroring `AUTO_RESTART_ON_PULL`/`AUTO_RECOVER_ORPHANED_RUNS`.
- **`BOARD_AUTOPULL_INTERVAL_MS`** -- default 5 minutes (`300000`). An explicit `0` also
  disables the poller; invalid/negative input falls back to the default rather than silently
  turning it off.
- This is complementary to, not a replacement for, `npm run deploy` above -- the deploy script
  still stops the service before merging so nothing can observe a live-merge race (outage #1).
  The poller pulls into the *running* service's checkout the same way the Done path already
  does, and only ever restarts through the same idle-guarded `restartCoordinator` -- it does
  not add a new restart path or a new way to touch the tree while the service is mid-merge.
  Pulling into a running checkout is exactly what exposed T-0385's narrower version of outage
  #1 (see "No file watcher on the deployed service" below): `restartCoordinator` itself was
  always guarded, but a since-removed file watcher racing it was not.

## Clean shutdown (T-0290)

Every restart this poller (or `npm run deploy`, or a manual `systemctl --user restart`) triggers
used to take the full length of systemd's `TimeoutStopSec` -- 90s by default -- because `npm run
dev`'s process tree is several layers of `sh -c '<cmd>'` deep (`npm -> sh -c "concurrently ..." ->
concurrently -> sh -c "npm run dev:server" -> npm -> sh -c "node src/server/index.js"`, and the
same again for the client). A `sh -c '<cmd>'` layer that doesn't `exec` into `<cmd>` **forks and
waits** instead of replacing itself, so it stays alive in the unit's cgroup as its own process,
separate from the real work process it launched -- exactly the "three bare bash processes ignored
[SIGTERM] entirely" the journal caught still sitting there when the `final-sigterm` timeout
expired and systemd SIGKILLed them. Confirmed on this box with `/proc/<pid>/task/<pid>/children`:
before the fix `npm run dev` has 5 such wrapper shells in its tree; after, none.

**Fixed in this repo:** `dev`, `dev:server`, and `dev:client` in `package.json` now all prefix
their command with `exec`, so every `sh -c` layer replaces itself with the program it runs instead
of parenting it. This is verified by `test/devShutdown.test.js`, which walks the real process tree
after `npm run dev` boots and asserts no `sh`/`bash`/`dash` PID remains anywhere in it. `dev:server`
runs `exec node src/server/index.js` directly -- no watcher, no wrapper child process, one `node`
PID for the whole server lifetime. (T-0385 briefly ran `dev:server` under a guard-respecting
watcher, `src/server/watch.js`, which spawned the real server as its own supervised child process;
that watcher was removed in a later fix round -- see "No file watcher on the deployed service"
below -- so `dev:server` is back to a single, unwrapped `node` process, same shape as before T-0385
started but still `exec`'d.)

**Not fixed here -- needs a human edit to the live unit, which is outside this repo (see
`~/.config/systemd/user/assembled-board.service` and its
`assembled-board.service.d/override.conf` drop-in; **do not** touch `AUTO_LAUNCH_*` or
`BOARD_TASK_STORE` in the drop-in while editing it):**

- Change `ExecStart=/bin/bash -lc 'npm run dev'` to `ExecStart=/bin/bash -lc 'exec npm run dev'`.
  Locally, `bash -lc '<single command>'` already self-optimizes into an `exec` (no separate `bash`
  PID was observed surviving in testing here), so this specific host may already be fine without
  it -- but it's a free, zero-risk hardening against whatever bash build/version is actually
  running there, and it's what closes the loop with the `package.json` fix above end to end.
- Confirm `KillMode` is left at its default (`control-group`) in the unit and the drop-in -- i.e.
  neither sets `KillMode=process` or `KillMode=mixed`. `control-group` is what makes systemd signal
  every process in the unit's cgroup on stop rather than only the tracked main PID; `process`/
  `mixed` would only reach the top process, leaving the rest of the tree to a raw SIGKILL sweep on
  timeout regardless of the `package.json` fix.
- Leave `TimeoutStopSec` as is (or lower it as defense-in-depth only, never as the fix -- see the
  card's acceptance criteria). The point of the change above is a clean stop that finishes in
  seconds on its own, not a faster forced kill.
- After editing: `systemctl --user daemon-reload && systemctl --user restart assembled-board`,
  then `journalctl --user -u assembled-board -n 50` -- a clean stop reports success, not `Failed
  with result 'timeout'`, and shows no `final-sigterm` timeout or `Killing process ... SIGKILL`
  lines. Time the stop (e.g. `time systemctl --user stop assembled-board`) to confirm it's seconds,
  not ~90s. This must be checked against the real unit -- the whole point is observed shutdown
  behavior, not what the unit file says on paper.
- This does not change `restartCoordinator`/PULL-3's idle-deferral behavior at all -- a restart
  while a card run is active still waits for `notifyIdle()` before it ever calls `systemctl
  restart`, same as before.

**Why no agent run ever performs the measurement above itself, confirmed again in the T-0290
implementer/reviewer sessions:** it is not just that neither role is granted `systemctl`/
`journalctl` (`systemctl --user status assembled-board` was attempted directly and came back
"This command requires approval" with no grant to satisfy it) -- even with the grant it would be
unsafe to use from inside a card run. `restartBoardService` in `src/runner/serviceRestart.js`
spells out why: "The card runner (`claude -p`) is a child of this same unit, so a naive restart
from inside a request handler would tear itself down along with any in-flight run." An implementer
or reviewer session *is* exactly such a card run -- issuing `systemctl --user restart
assembled-board` from inside one would SIGTERM its own ancestor unit mid-verification, which is
the identical false-alarm shape this whole card exists to stop (T-0111's failure mode, and the
"the board CRASHED" false alarm this card's own description opens with). The before/after stop
duration and the SIGKILL/timeout-free journal excerpt the acceptance criteria ask for can only be
gathered by a human, running the commands above from a shell that is *not* itself a descendant of
`assembled-board.service`, after this branch lands. Recording that measurement on the card is the
one remaining step; it is not something a future implementer or reviewer run should keep re-trying.

## No file watcher on the deployed service (T-0385)

**The incident.** 2026-09-18, during the merges of #394 and #395: #395's merge pulled into the
running checkout while T-0384's run was still active. `serviceRestart.js`'s guard did exactly
what it's for -- it logged `develop pulled while a card run is active -- restart deferred until
idle` and did not restart. But `dev:server` ran `src/server/index.js` under `node --watch`,
which has no idea that guard exists: it saw the pulled files change on disk and restarted the
server anyway, right through the middle of T-0384's run. `GET /api/health` went to `ECONNREFUSED`
for the rest of that run -- the exact outage #1 at the top of this file, just triggered by a
file-watch reaction instead of the deploy script's own unguarded restart.

**First attempt (superseded).** T-0385 first replaced `node --watch` with a guard-respecting
supervisor (`src/server/watch.js` + `createWatchSupervisor` in `watchSupervisor.js`) that checked
`detectLiveRun` -- the same pgrep-plus-`tasks/.runs/*.jsonl`-recency signal `npm run deploy`'s
live-run check uses (see "Live-run guard" above) -- before ever restarting the child it managed.
A follow-up review round (Codex, 2026-09-19) found a real gap in that check: a card run enters
`orchestrator.activeCardIds` -- the authoritative "is a run in flight" signal `serviceRestart.js`'s
own guard reads via `hasActiveRuns()` -- at the very top of `runCard()`, *before*
`git.addWorktree`. Neither `detectLiveRun` signal exists yet at that point: no `claude -p` process
has spawned, and no `tasks/.runs/*.jsonl` file exists to be recently-modified. A file change
landing in that window -- a run genuinely active, `detectLiveRun` genuinely blind to it -- still
restarted the watched child.

**The fix that landed.** Rather than wiring the watcher up to the real `hasActiveRuns()` signal --
which lives on the in-process `RunOrchestrator` inside the watched *child*, not the supervisor
process watching it, and would need a coordination channel across that process boundary just to
ask "is a run active right now" on every file change -- `dev:server` drops the file watcher
entirely. It runs `exec node src/server/index.js` directly, the same as before T-0385 ever
started, and reacts to nothing on disk. The board's only restart mechanisms are now the two that
were always meant to be authoritative:

- **`npm run deploy`** (see above): stops the service, merges, restarts -- nothing is running to
  observe the merge at all.
- **The guarded restart-on-pull path** (`autoPullPoller.js` + `serviceRestart.js`'s
  `createRestartCoordinator`, see "Periodic auto-pull" below and the Done-triggered pull in
  `httpApi.js`): reads `orchestrator.hasActiveRuns()` directly -- the real, authoritative signal,
  true from the moment a card enters `activeCardIds` through to the run's full cleanup, with no
  process-existence or log-recency heuristic standing in for it.

This removes a second, weaker liveness signal instead of trying to keep it synchronized with the
first. A pulled/merged file with no service restarting to pick it up is exactly the safe state
this card's acceptance requires: it just sits on disk until the next `npm run deploy`, the next
guarded restart-on-pull, or a manual `systemctl --user restart`, at which point the new code takes
effect the normal way. `src/server/watch.js`, `src/server/watchSupervisor.js`, and their tests are
removed rather than left as unused dead code.

**What an operator should expect in the journal:**

- **A file changes on disk with the service running** (an edit outside of a deploy, e.g. from a
  card run committing to `repoRoot`): nothing. No log line, no restart, no reaction of any kind --
  there's nothing watching. The service keeps running the code it started with until the next
  restart from one of the two mechanisms above.
- **A pull lands with no card run active**: `serviceRestart.js` logs `develop pulled, no active
  runs -- restarting service to pick up pulled code` and restarts immediately (`systemctl --user
  restart assembled-board.service`).
- **A pull lands while a card run is active** (the incident's exact scenario, including the
  narrower setup-window gap the follow-up review found): `assembled-board: develop pulled while a
  card run is active -- restart deferred until idle`, and *no* restart -- the running service keeps
  serving `/api/health` for the rest of the run, including through worktree setup, with no window
  where a file change alone can tear it down. Once `RunOrchestrator.activeCardIds` empties,
  `onIdle()` fires `restartCoordinator.notifyIdle()`, which logs `assembled-board: deferred
  restart: active run finished -- restarting service to pick up pulled code` and restarts then.

Regression coverage: `test/runner/pullRestartSetupWindow.test.js` -- a real `RunOrchestrator` with
`git.addWorktree` held pending (so the run sits genuinely inside `activeCardIds`, with no run log
and no process, mirroring Codex's exact repro) proves a pull landing in that window still defers,
and that the deferred restart fires once the run ends; a companion case proves a pull with no
active run restarts immediately; a third proves `autoPullPoller`'s own tick skips fetching and
restarting entirely while a run is in that same setup window, and resumes once idle.

## Auto-launch poller (`src/runner/autoLaunchPoller.js`)

Starts **at most one** `ready` card per tick, from inside the board process, when the board is
idle and Claude usage is below threshold. This replaces an external scheduled task that polled
the board over HTTP and could not reach it from its sandbox: living in-process gives the poller
the same `RunOrchestrator`, task store, and `tasks/.runs/*.jsonl` logs the HTTP server already
holds -- which is what makes the idle and usage gates trustworthy rather than best-guess. Same
lifecycle as the auto-pull poller above: an unref'd `setInterval` started from `boardServer.js`
and stopped by its `close()`, **not** a systemd timer.

Every tick applies four gates in order and stops at the first that fails, logging the reason
under the `assembled-board: auto-launch` prefix (so `journalctl -u assembled-board | grep
auto-launch` tells you what it decided and why):

1. **Enabled** -- `AUTO_LAUNCH_ENABLED` is set and the interval is non-zero (default cadence:
   one tick every 5 hours, see `AUTO_LAUNCH_INTERVAL_MS` below).
2. **Usage below threshold** -- the newest `rate_limit_event` telemetry the runner recorded must
   report a utilization strictly below `AUTO_LAUNCH_USAGE_MAX`. Undetermined usage skips.
3. **Board idle** -- `orchestrator.hasActiveRuns()` (the runner's own liveness, *not* a `pgrep`)
   reports nothing running, **and** no card sits at `in-progress`/`validation` (which also
   catches a run stranded by a previous process that the orphan reaper hasn't reconciled yet).
4. **Eligible card** -- status *exactly* `ready`, every `depends_on` at `done`/`retired`, not
   owned by the non-executable `dispatch` sentinel. Highest priority wins (P0 > P1 > P2 > P3 >
   unset), ties broken by lowest numeric id.

The selected card is started through `cardLaunch.js`'s `launchCardRun` -- the *same* function
`POST /api/tasks/:id/run` calls, extracted so there is one guarded path rather than two. Every
Run-button guard therefore applies to an auto-launch too, including `assertCanMoveToInProgress`
(`docs/board-invariants.md` RUN-3/LC-5) and the acceptance/capability preflights inside
`runCard`. A card the guard refuses is logged as a skip; the poller does **not** fall through to
the next candidate.

Fail-safe throughout: any uncertainty -- unreadable telemetry, an unreadable store, a refused
launch -- skips the tick. It never forces a launch, never starts more than one card per tick,
and never interrupts a running card.

- **`AUTO_LAUNCH_ENABLED`** -- **default OFF**, like `FLOW_STATS_SELFIMPROVE_ENABLED` and unlike
  the `BOARD_AUTOPULL`/`AUTO_RESTART_ON_PULL` family. Those act on work a human or an
  already-running card set in motion; this one starts a brand new card run with nobody having
  asked for that specific one right then, so merging and deploying the code must not be what
  switches it on. Accepts `1`/`true`/`on`/`yes`, case-insensitive.
- **`AUTO_LAUNCH_INTERVAL_MS`** -- default **5 hours** (`18000000`), deliberately matched to the
  Anthropic 5-hour usage window the usage gate reads. At most one card is started per tick, so
  the cadence *is* the throughput policy: roughly one auto-started card per usage window, rather
  than a tight poll that drains a window as fast as cards finish. An explicit `0` also disables
  the poller; invalid/negative input falls back to the default rather than silently disabling.
  **The first tick is one full interval after the board process starts, and a restart (a deploy,
  an auto-restart-on-pull) resets that clock** -- a board restarted more often than every 5 hours
  will rarely reach a tick. Lower this if that is the operating pattern.
- **`AUTO_LAUNCH_USAGE_MAX`** -- default `0.80`. Utilization is compared with `>=`, so `0.80`
  means "launch only while strictly below 80%". Out-of-range or garbage input falls back to the
  default.

### How usage is read (`src/runner/usageWindow.js`)

The `claude` CLI emits a `rate_limit_event` on healthy sessions as well as refused ones. The
poller walks `tasks/.runs/*.jsonl` newest-mtime-first, reads each log's **tail** (256 KB -- a
live log runs to tens of megabytes) and takes the newest `rate_limit_info` payload it finds,
reusing `usageLimitDetector.js`'s parsing rather than re-implementing it.

**The CLI does not currently emit a numeric utilization.** A live payload is exactly
`{status, resetsAt, rateLimitType, overageStatus, overageDisabledReason, isUsingOverage}`, so
`status` is the only usage signal actually available and it is mapped onto the same 0..1 scale a
real utilization would use: `allowed` -> `0`, `allowed_warning` -> `0.9`, `rejected` -> `1`. A
status this code has never seen maps to *undetermined*, which skips. If a future CLI version
starts emitting a real `utilization` number, that is preferred over the status proxy
automatically.

Two consequences worth knowing before enabling it:

- With the current CLI, `AUTO_LAUNCH_USAGE_MAX` only bites at the `allowed_warning` boundary --
  a plain `allowed` reads as `0` regardless of how much of the window has actually been spent.
  Lower the threshold below `0.9` (the default `0.80` already is) to have warnings block
  launches; raise it above `0.9` to launch through them.
- `resetsAt` overrides everything: once that instant has passed, the window the event describes
  is over, so even a `rejected` reading is treated as a fresh window. Without this the poller
  would wedge permanently after any rate-limit stop -- the one state it most needs to recover
  from on its own. The `overageStatus: "rejected"` / `overageDisabledReason: "out_of_credits"`
  fields are **never** read as a refusal; they ride along on healthy events too (the
  false-positive that disabled escalation board-wide on T-0233).

Only `status: "rejected"` on the top-level `rate_limit_info` counts as a refusal.

## Reliable, low-bandwidth access for sandboxed callers (T-0383)

The scheduled **nightly-infra-prep** task runs in a sandbox with no WSL, so it cannot reach
`127.0.0.1:${BOARD_PORT:-4173}` directly -- it only ever touches the board through a Chrome
browser. That path was unreliable on three fronts: `GET /api/tasks` was an unfiltered blob (no
server-side `status=`/`fields=` support at all, even though the query string was already being
sent), the auto-launch poller's own configuration was readable only from the repo or the systemd
drop-in, and the only write path (`PATCH /api/tasks/:id`) needs in-page JS `fetch`, which the
sandbox's browser content filter sometimes blocks silently. This card adds three read/write
surfaces to close those gaps. **What it explicitly does NOT fix:** the sandbox still cannot reach
`127.0.0.1` on its own -- nothing here adds remote reachability or exposes the board beyond
localhost; every route below is still served only from the existing `127.0.0.1`-bound listener,
and reaching it from the sandbox still requires going through the browser (now more reliably).

### `GET /api/tasks?status=` and `?fields=` (`src/server/httpApi.js`)

- **`status=<a>,<b>,...`** -- filters server-side, comma-separated, validated against
  `taskParser.js`'s `STATUSES` (the same list `validateTask` enforces on write). An unknown value
  is a 400 naming the bad value, never a silent full dump.
- **`fields=<a>,<b>,...`** -- projects each surviving task down to only the named fields,
  comma-separated, validated against the stored field set (`taskParser.js`'s new `TASK_FIELDS`
  export) plus two computed fields:
  - **`dependency_status`** -- `{ dependencies: [{id, status}], allSatisfied }`, where
    `allSatisfied` counts `done`/`retired` as satisfied, mirroring
    `dependencyGuard.js`/`autoLaunchPoller.js`'s own rule. A dependency id absent from the corpus
    reports `status: null` and counts as unsatisfied -- the same "unresolvable reference is
    uncertainty, and uncertainty skips" posture `selectNextCard` already uses.
  - **`last_activity_at`** -- the latest of the task's own `created`/`approved_at`/`rescoped_at`/
    comment timestamps/attachment `uploaded_at` values. **This is a best-effort activity signal,
    not a true "last edited" timestamp** -- see "Vetting data and the auto-ready criterion" below
    for exactly what it does and doesn't capture, and why.
  - An unknown field name is a 400, same posture as `status=`.
- **With neither param present, the response is byte-identical to before this card** -- the exact
  same `store.list()` call, untouched. `test/httpApi.taskQuery.test.js` pins this with a raw-text
  comparison, not just a deep-equal, so nothing about this feature can silently reorder or filter
  keys for existing callers (the board UI included).
- **Measured size, the nightly task's own query.** The live board's actual baseline (measured
  2026-09-18): **3,104,158 bytes for 317 cards**, and `?status=backlog` on that board returned all
  317 -- the query string was ignored entirely before this card. That live corpus isn't
  reproducible from this test suite (no network path from here to the deployed board's data), so
  `test/httpApi.taskQuery.test.js`'s synthetic-corpus test measures the same shape of win against
  317 generated cards sized to match the live average (3,104,158 / 317 ≈ 9,791 bytes/card body):

  ```
  unfiltered GET /api/tasks                                                        = 3,230,307 bytes
  GET /api/tasks?status=backlog&fields=id,title,priority,agent,phase,depends_on,
                 dependency_status,last_activity_at                                =    22,329 bytes
  ```

  **99.3% smaller**, on a corpus deliberately sized to the live board's own average card weight.
  Re-measure against the live 317-card corpus once this lands, and update this table with the
  real number -- the synthetic figure is a reproducible stand-in, not a substitute for the actual
  measurement the acceptance criteria ask for.

### Vetting data and the auto-ready criterion

`dependency_status` and `last_activity_at` (above) are what the nightly task needs to assemble a
"is this card worth surfacing" backlog without touching git. They are not enough, on their own,
to answer "has this card's acceptance already been superseded by merged work" -- that question is
inherently about *what changed in the diff since the card was written*, which is git-history
information no API-only signal can reconstruct:

- `last_activity_at` only advances when something already timestamped changes (a comment, an
  attachment, an approval/rescope record). A card whose `title`/`priority`/`agent`/body prose was
  hand-edited with no comment alongside it will not move this value -- there is no `updated_at`
  column anywhere in this schema (fs-mode frontmatter has no such field; db-mode's `card_events`
  table records status-changing transitions, not arbitrary field edits) to capture that instead,
  and adding one is a schema change out of this card's scope.
- Nothing here inspects diff content, so "the acceptance criteria this card lists were already
  satisfied by a since-merged PR" is not detectable from these endpoints at all.

**The minimal safe auto-ready criterion computable from API data alone**, until/unless a real
`updated_at` signal exists: a card is safe to auto-surface as ready-to-vet only if
`dependency_status.allSatisfied` is `true` **and** its status is still `backlog` (i.e. nobody has
already started triaging it). That is a *filter*, not a promotion -- it narrows the set worth a
human or the nightly task's own (git-capable, on-host) logic looking at, it does not by itself
justify writing `ready`. Any check that needs to know whether acceptance criteria were superseded
by merged work must still go through a git-based path (outside this API, and outside what the
nightly sandbox can do directly) -- this card intentionally does not attempt to fake that signal
from data that can't support it.

### `GET /api/poller` (`src/runner/autoLaunchPoller.js`'s `getStatus()`)

Reports the auto-launch poller's own state over plain HTTP, so it no longer has to be inferred
from the repo (`autoLaunchEnabledFromEnv()`/`autoLaunchIntervalMsFromEnv()`/
`autoLaunchUsageMaxFromEnv()`) or the systemd drop-in. Same "answer from already-known process
state, no store/git/filesystem access" posture as `GET /api/health`:

```json
{
  "enabled": true,
  "intervalMs": 18000000,
  "usageMax": 0.8,
  "running": true,
  "lastTickAt": "2026-09-18T05:00:00.000Z",
  "nextTickAt": "2026-09-18T10:00:00.000Z",
  "lastResult": { "kind": "skip", "reason": "usage 0.85 >= max 0.8 ...", "cardId": null },
  "activeRun": false
}
```

`lastResult.kind` is `"skip"`, `"launched"`, or `"error"` (an unexpected failure other than the
run guard's own `CardLaunchError` refusal, which reports as a `"skip"` instead -- see
`autoLaunchPoller.js`'s `tick()`); `nextTickAt` is an estimate (derived from the last
tick, or from when the poller started if it hasn't ticked yet) since `setInterval` firing can
drift and a skipped tick doesn't reschedule anything. If no poller is wired into a given server
instance, the route still answers 200 by falling back to the same env-reading functions the
poller itself would use, with the tick-history fields `null`/`false` -- it never 404s or 500s.

### `POST /api/tasks/:id/ready` -- the reliable write channel

**Auth/CSRF, stated plainly:** guarded by a shared-secret token, `BOARD_READY_TOKEN`. Without one
configured, the route responds `501` -- it is opt-in, not silently open, mirroring
`AUTO_LAUNCH_ENABLED`'s default-off posture. This is a real, separate concern from
`PATCH /api/tasks/:id`: a `fetch`/XHR PATCH with a JSON body is a CORS "non-simple" request and
needs a preflight the browser won't grant cross-origin by default, which today gives PATCH
*incidental* CSRF protection. A plain `<form method="post" enctype="application/
x-www-form-urlencoded">` -- the whole point of this route, since it's exactly what still works
when in-page `fetch` is blocked -- is a CORS "simple request" with **no** preflight, so *any* page
a browser on this host loads could auto-submit one blind. The token is what closes that gap: an
attacker page cannot know it, so a blind cross-origin form-POST fails closed. This is a
shared-secret guard scoped to one action, not full authentication -- consistent with this API's
existing trust model (single operator, `127.0.0.1`-only bind, no other route requires a token
either). The token travels, checked in this order, **before the task store is ever touched**:

1. `Authorization: Bearer <token>` header (direct HTTP callers reaching the host);
2. a `token` field in the request body (a hidden `<input>` in an HTML form).

Deliberately **not** accepted as a query param: a query string routinely ends up in server/proxy
access logs, browser history, and an outbound `Referer` header, any of which would leak the very
secret this token exists to keep private -- and a hidden form field already gives the "no JS
needed" property a query param would have been for, without that exposure.

The request body is either `application/x-www-form-urlencoded` (what a plain form submits, no JS)
or `application/json` (direct callers); anything else is a 400. The route is deliberately narrow:
it only ever writes `status: "ready"`. A `status` field in the body is accepted for the form's own
clarity (`<input type=hidden name=status value=ready>`) but must equal `"ready"` -- any other
value is a 400, "this route only accepts ready". `PATCH /api/tasks/:id` is completely unchanged
and remains the general-purpose write path for every other field/status.

**Which channel the nightly task should use:** this route (`POST .../ready`, form-encoded, with
`BOARD_READY_TOKEN` configured), submitted as a real `<form>` navigation from the sandbox's
browser -- not a `fetch` call, since that is the exact path the content filter has been observed
to block. Configure `BOARD_READY_TOKEN` in the service environment (same place as
`AUTO_LAUNCH_ENABLED` et al.) and give the nightly task's generated page the token as a hidden
form field -- never in the form's `action` URL, which this route does not accept it from.

## Worktree artifact preservation (`src/runner/artifactPreservation.js`)

Re-running a card reclaims its worktree with `git worktree remove --force`, which deletes the
**entire** directory -- untracked and gitignored files included. Everything a run generated but
never committed therefore died on every re-run. T-0248 hit this for real: its per-epoch
sd-scripts `--save_state` checkpoints under `assets/final/lora/` were wiped, so the re-run's
`find_resume_state` found nothing and retrained from step 0, costing ~86 minutes of GPU.

`gitOps.js` now moves a card's allowlisted untracked/ignored files into
`worktrees/.artifact-cache/<card-id>/` immediately **before** every force-removal (both the
`addWorktree` reclaim and `removeWorktree`, which the orchestrator calls on a PASS and on a
cancel), and moves them back into the fresh checkout immediately **after** `git worktree add`.
It is a `rename`, not a copy: the cache is a sibling of the worktrees on the same filesystem, so
a multi-GB checkpoint set moves in milliseconds and peak disk never doubles.

Two rules keep it safe:

- **The fresh checkout always wins.** A preserved path that is a *tracked* file in the new tree
  is never restored over it -- git has just materialized the committed version, and the cached
  copy is stale by definition. Such paths are logged and left in the cache rather than deleted.
- **Allowlist, not everything.** A worktree's non-tracked set is mostly `__pycache__/`,
  `.pytest_cache/`, build output, `.venv/` and the `tools/board/node_modules` symlink -- costly
  to move and actively harmful to restore into a fresh checkout.

Disk is bounded from both ends: a card's cache is purged when it reaches `done`/`retired`
(`httpApi.js`'s `handlePatchTask`), each capture replaces that card's previous snapshot rather
than accumulating, and an LRU bound caps how many cards' caches can exist at once.

- **`BOARD_PRESERVE_ARTIFACTS`** -- default ON; set to `0`/`false`/`off`/`no` (any case) to
  restore the old wipe-on-reclaim behaviour, mirroring the `BOARD_AUTOPULL` family.
- **`BOARD_PRESERVED_ARTIFACT_PATHS`** -- comma- or colon-separated worktree-relative paths
  **added to** the built-in allowlist (`assets/final/lora`, `assets/src/lora/refs`,
  `assets/out`), so a new kind of artifact can be rescued without a deploy. Absolute paths and
  anything containing `..` are ignored.

## Database backups (`scripts/backupDb.js`, `npm run backup:db`)

Phase 1 of `docs/design/cards-to-database.md` moves card state into a SQLite file
(`BOARD_DB_PATH`, default `~/.local/share/assembled-board/board.db`) that lives outside git --
losing git's free "every edit is a recoverable commit" property is a real regression the design
doc calls out explicitly (see its "Backup strategy" section), and this script plus the
`card_events` audit table are the two mitigations. **Not wired into the live board in this
phase** -- `BOARD_TASK_STORE` still defaults to `fs`, so this only matters once/if a later phase
flips that flag.

```
npm run backup:db -- [--db-path <path>] [--out-dir <dir>]
# defaults: --db-path = $BOARD_DB_PATH or ~/.local/share/assembled-board/board.db
#           --out-dir = <dirname of db-path>/backups
```

Writes a timestamped, standalone copy (`board-<ISO-timestamp>.db`) via SQLite's online backup
API (`better-sqlite3`'s `Database#backup`, wrapping `sqlite3_backup_init`/`step`/`finish`) --
safe to run against a live, concurrently-written WAL-mode database, unlike a raw `cp` which can
copy a torn set of pages mid-write. The source connection is opened `readonly` and is never
mutated. A backup file is a complete, independent SQLite database: restoring is "stop the
service (or point `BOARD_DB_PATH` at it for a throwaway check), copy the `.bak` file over the
live path, start the service" -- no special tooling needed, verified in
`test/dbBackup.test.js` by opening a produced backup directly with `DbTaskStore` and confirming
it reads back identically to the source.

**Recommended cadence: daily, retained 14 days**, piggybacking on the same
flock-guarded-systemd-`--user`-timer pattern `board-assets-sync.timer` already uses on this
machine (see project memory `project_assembled_gdrive_asset_sync`) -- a new sibling unit, not a
new mechanism:

```ini
# ~/.config/systemd/user/board-db-backup.service
[Unit]
Description=assembled-board SQLite backup

[Service]
Type=oneshot
WorkingDirectory=%h/dev/assembled-board/tools/board
ExecStart=/usr/bin/npm run backup:db
ExecStartPost=/usr/bin/find %h/.local/share/assembled-board/backups -name 'board-*.db' -mtime +14 -delete
```

```ini
# ~/.config/systemd/user/board-db-backup.timer
[Unit]
Description=Daily assembled-board SQLite backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl --user enable --now board-db-backup.timer`. This is a deploy/install
step, not something CI or this repo's test suite can verify -- flag it on the rollout checklist
for whichever phase first makes the DB the live store.
