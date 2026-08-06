# Deploying assembled-board

The live board runs under a systemd user unit (`assembled-board.service`) whose dev server
uses `node --watch`. Two real outages taught us that a naive `git pull && systemctl restart`
is not safe here:

1. **`node --watch` auto-relaunches mid-merge.** If code is pulled/merged into the working
   tree while the service is still *up*, `node --watch` sees the filesystem change and
   restarts the server in the middle of the merge -- including mid-conflict-resolution, with
   conflict markers sitting in a source file. This really happened: it reset a live card run
   and then crashed on the conflict-markered file, taking the board down 20+ minutes.
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
   `node --watch` cannot observe or react to the merge at all. Every step after this point
   operates on a tree nothing is watching.
3. **Fetch + merge**: `git fetch origin develop` then `git merge --no-ff --no-edit
   origin/develop`. Deliberately `merge --no-ff`, not `pull --ff-only` -- `develop` carries
   local runtime commits (see above), so a fast-forward is often not even possible, and this
   script must never leave the tree mid-merge. On conflict, it runs `git merge --abort`
   immediately (restoring the pre-merge tree, no conflict markers left on disk), restarts the
   service on that last-known-good tree, and exits non-zero with instructions.
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
  module then reconciles with one `git fetch` + `merge --no-ff` (`gitOps.js`'s `mergeNoFF`)
  and retries the push exactly once. Never uses `--force`/`--force-with-lease`.
  It never has to shell out to the deploy script's merge logic -- `mergeNoFF` is the one
  shared implementation both use.
- **Failure is non-fatal:** any other failure (unreachable origin, protected branch, a
  persistent conflict the retry couldn't clear) is logged as a warning and swallowed. The
  local commit always stands either way -- only whether it's reached origin yet is in
  question, and the next runtime commit will try pushing again.
- **Disabling it:** set `AUTO_PUSH_ON_COMMIT=0` (also accepts `false`/`off`/`no`, any case) in
  the service's environment.
