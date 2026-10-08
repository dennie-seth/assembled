# Board ops scripts

Operational scripts for the assembled board that run on the WSL box outside
the board application itself: asset export/backup to Google Drive, and a
daily integrity checker. These are copied here from `~/.local/bin` and
`~/.config/systemd/user` for version control and backup — they are **not**
imported or built as part of the app. See "Deploying changes" below.

This directory also holds `comfyui-regime.json` and `comfyui/` (T-0322): the
declared ComfyUI determinism regime and a version-controlled reconstruction
of its launcher, checked by `tools/board/scripts/checkComfyUiRegime.js`
(part of the JS/Vitest-tested board tooling, not this Python integrity
checker — see that script's own header and
[`docs/comfyui-setup.md#determinism`](../../../docs/comfyui-setup.md#determinism)
for why it's a separate check rather than a new function in
`board-integrity-check.py`: this agent's toolchain can run and TDD Node/
Vitest, not Python/pytest, and TDD is non-negotiable for either).

## Data flow

```
board API (GET /api/tasks, GET /api/tasks/:id/attachments/:filename)
        |
        v
board-assets-stage.py   -- re-derives $BOARD_ASSETS_EXPORT_ROOT/<task-id>/
        |                  (MANIFEST.md + attachment files) from each card's
        |                  `attachments` metadata; writes index.json.
        |                  Read-only against the board. Pinned (hand-curated)
        |                  task dirs are left untouched. Staging (which tasks
        |                  get a directory) is attachment-driven; the
        |                  *counts* in index.json are not (T-0320) -- each
        |                  task carries both `committedAssetCount` (files
        |                  actually committed under assets/final/ at the
        |                  card's branch/develop, via `git ls-tree` +
        |                  provenance-sidecar attribution, shelled out to
        |                  `node tools/board/scripts/countCommittedAssets.js`)
        |                  and `attachmentCount` (the old, attachment-derived
        |                  count -- review material, not shipped output).
        v
board-assets-drivemap.py -- ensures a Drive subfolder exists per staged task
        |                   dir under a fixed parent folder, writing/updating
        |                   $BOARD_ASSETS_EXPORT_ROOT/.drive-folders.json
        |                   (task-id -> Drive folder ID).
        v
board-assets-copy.py    -- `rclone copy` (idempotent) of each staged task dir
        |                  to its mapped Drive folder.
        v
   Google Drive

board-assets-sync.sh  -- wraps stage -> drivemap -> copy under a single
                          flock, logs to ~/.local/state/board-assets-sync/sync.log.
                          Aborts before drivemap/copy if stage fails.

board-integrity-check.py -- separate, read-only daily check: cross-checks the
                             board DB against the live API, on-disk attachment
                             files, SQLite health (PRAGMA integrity_check),
                             backup freshness/size delta, and staged-export
                             freshness. Logs findings; does not modify
                             anything.

board-db-backup.sh -- separate, daily: runs the app's own `npm run backup:db`
                       (tools/board/scripts/backupDb.js, a WAL-safe online
                       backup via better-sqlite3, read-only against the live
                       db), then prunes old files under
                       <dataDir>/backups/ to a retention count. Runs at 03:00,
                       ahead of board-integrity-check.py's 03:20 backup-
                       restorability check, so a fresh backup always exists
                       for it to validate. After the local prune, it also
                       uploads the newest local snapshot to a dedicated Drive
                       folder (same `gdrive:` remote as the asset pipeline)
                       and prunes that Drive folder down to a small retention
                       count, so the DB survives a machine reload/wipe even
                       though local retention stays at 14.
```

The Notion reconcile step (syncing staged/Drive-pushed assets into Notion)
runs as a separate Claude scheduled task, not on this box, and is out of
scope for these scripts.

`board-vet-and-ready.sh` (T-0384) is a separate, independent job -- it does
not participate in the asset/backup/integrity pipeline above. See its own
section below.

`board-ledger-export.sh` (T-0434) is also separate and independent -- see
"Scheduled approval-ledger export (T-0434)" below.

## Scripts

| Script | Purpose |
|---|---|
| `board-assets-stage.py` | Re-derive the staged export tree from the live board (read-only against the board; writes only under `EXPORT_ROOT`). |
| `board-assets-drivemap.py` | Resolve/create one Google Drive subfolder per staged task dir; persists the id map. |
| `board-assets-copy.py` | Idempotent `rclone copy` of each staged, mapped task dir to its Drive folder. |
| `board-assets-sync.sh` | Orchestrates stage -> drivemap -> copy under a single `flock`; used by the hourly timer. |
| `board-integrity-check.py` | Read-only daily health check (DB integrity, DB<->API<->attachments consistency, backup freshness, staged-export freshness). |
| `board-db-backup.sh` | Runs the app's `npm run backup:db` (WAL-safe online backup) then prunes old backups under `<dataDir>/backups/` to a retention count; used by the daily timer. Also uploads the newest backup to Drive and prunes the Drive folder to a small retention count. |
| `check-comfyui-regime.sh` (T-0322) | Wrapper for `npm run check:comfyui-regime` (`../scripts/checkComfyUiRegime.js`, part of the ordinary `tools/board` npm/Vitest project, **not** copied to `~/.local/bin` itself), following the same `flock` + timestamped-log pattern as `board-db-backup.sh`. Read-only against ComfyUI (`GET /system_stats` only). Fails loudly if the live server's `argv` has drifted from the regime declared in `comfyui-regime.json`, in either direction. See `docs/comfyui-setup.md#determinism`. Also invocable directly (ad hoc or from an asset-generation preflight) without this wrapper. |
| `vetAndReady.sh` (T-0384) | `flock`-guarded wrapper for `npm run vet:ready -- --apply` (`../ops/vetAndReady.js`, part of the ordinary `tools/board` npm/Vitest project, **not** copied to `~/.local/bin` itself). See "Nightly vet-and-ready (T-0384)" below. |
| `board-ledger-export.sh` (T-0434) | `flock`-guarded wrapper for `npm run export:ledger:scheduled` (`../ops/exportApprovalLedgerScheduled.js`, part of the ordinary `tools/board` npm/Vitest project, **not** copied to `~/.local/bin` itself). See "Scheduled approval-ledger export (T-0434)" below. |

## Install locations on the box

- Scripts: `~/.local/bin/` (executable, on `$PATH`)
- systemd user units: `~/.config/systemd/user/`

## Environment variables

| Variable | Used by | Default |
|---|---|---|
| `BOARD_API_BASE` | stage, integrity-check | `http://127.0.0.1:4173` |
| `BOARD_ASSETS_API_TIMEOUT` | stage | `15` (seconds) |
| `BOARD_API_TIMEOUT` | integrity-check | `15` (seconds) |
| `BOARD_ASSETS_EXPORT_ROOT` | stage, drivemap, copy, integrity-check | `/mnt/f/PetProjects/board-assets-export` |
| `BOARD_REPO_ROOT` | stage | `~/dev/assembled-board` (repo checkout, to locate `countCommittedAssets.js` and resolve git refs against -- this script itself is deployed standalone to `~/.local/bin`, see "Deploying changes" below) |
| `BOARD_ASSETS_BASE_BRANCH` | stage | `develop` (ref a card's committed-asset count resolves against when the card has no recorded `branch`) |
| `BOARD_ASSETS_COUNT_TIMEOUT` | stage | `30` (seconds, per-card `countCommittedAssets.js` subprocess) |
| `BOARD_NODE_BIN` | stage | `node` (override to an absolute path if `node` isn't on systemd `--user`'s PATH, e.g. an nvm install -- same reasoning as `~/.local/bin/rclone` below) |
| `BOARD_DB_PATH` | integrity-check | `~/.local/share/assembled-board/board.db` |
| `BOARD_ATTACHMENTS_DIR` | integrity-check | `<dirname of BOARD_DB_PATH>/attachments` |
| `BOARD_BACKUPS_DIR` | integrity-check | `<dirname of BOARD_DB_PATH>/backups` |
| `INTEGRITY_SAMPLE_SIZE` | integrity-check | `15` |
| `INTEGRITY_FRESHNESS_MAX_AGE_HOURS` | integrity-check | `2` |
| `INTEGRITY_BACKUP_DELTA_MIN` | integrity-check | `10` |
| `INTEGRITY_BACKUP_DELTA_PCT` | integrity-check | `0.1` |
| `INTEGRITY_LOG_DIR` | integrity-check | `~/.local/state/board-integrity-check` |
| `BOARD_REPO_ROOT` | db-backup | `~/dev/assembled-board` |
| `BOARD_DATA_DIR` | db-backup | `~/.local/share/assembled-board` |
| `BOARD_DB_BACKUP_RETENTION` | db-backup | `14` (local backups kept before pruning) |
| `BOARD_DB_BACKUP_RCLONE_REMOTE` | db-backup | `gdrive:` |
| `BOARD_DB_BACKUP_DRIVE_DIR` | db-backup | `Assembled — DB Backups` (Drive folder, created if missing) |
| `BOARD_DB_BACKUP_DRIVE_RETENTION` | db-backup | `2` (Drive copies kept before pruning) |
| `BOARD_REPO_ROOT` | ledger-export | `~/dev/assembled-board` (repo checkout; the job commits+pushes directly on this checkout's current branch) |
| `BOARD_LEDGER_EXPORT_BRANCH` | ledger-export | `develop` (the only branch this job will ever commit to -- see "Scheduled approval-ledger export (T-0434)" below) |
| `BOARD_LEDGER_EXPORT_REMOTE` | ledger-export | `origin` |
| `BOARD_LEDGER_REFRESH_THRESHOLD_HOURS` | ledger-export | `12` (well under the CI gate's `BOARD_APPROVAL_LEDGER_STALE_HOURS`, 24h) |
| `BOARD_LEDGER_EXPORT_LOG_DIR` | ledger-export | `~/.local/state/board-ledger-export` |

`board-assets-drivemap.py` and `board-assets-copy.py` also depend on an
`rclone` remote named `gdrive:` (configured separately via `rclone config`,
not read from these scripts) and call the `rclone` binary at
`~/.local/bin/rclone`. The Drive parent folder ID is hardcoded in
`board-assets-drivemap.py` (`PARENT_FOLDER_ID`) — it is a folder identifier,
not a credential; the actual Drive auth lives in rclone's own config.
`board-db-backup.sh` reuses the same `gdrive:` remote but uploads to a plain
named folder off the Drive root (`BOARD_DB_BACKUP_DRIVE_DIR`) rather than a
folder-ID lookup, since it only ever needs the one destination.

## systemd timers

| Timer | Schedule | Runs |
|---|---|---|
| `board-assets-sync.timer` | hourly (`OnCalendar=hourly`, ±120s random delay) | `board-assets-sync.sh` |
| `board-db-backup.timer` | daily at 03:00 (±120s random delay) | `board-db-backup.sh` |
| `board-integrity-check.timer` | daily at 03:20 (±300s random delay) | `board-integrity-check.py` |
| `check-comfyui-regime.timer` (T-0322) | hourly (±120s random delay) | `check-comfyui-regime.sh` |
| `board-vet-and-ready.timer` (T-0384) | daily at ~01:00 (±300s random delay) | `board-vet-and-ready.sh` |
| `board-ledger-export.timer` (T-0434) | every 4 hours (`OnCalendar=*-*-* 0/4:00:00`, ±120s random delay) | `board-ledger-export.sh` |

All timers are `Persistent=true` (catch up on a missed run after the box was
off) and installed under `~/.config/systemd/user/`, enabled with
`systemctl --user enable --now <timer>`.

`check-comfyui-regime.timer`'s unit files are new as of T-0322
(`tools/board/ops/systemd/check-comfyui-regime.{service,timer}`) and, unlike
every other file in this table, have not yet been deployed to the live box --
no agent working T-0322 has had shell access to the WSL box outside this
repo checkout's own Node/npm/git tools, so `cp` to `~/.local/bin` /
`~/.config/systemd/user` and `systemctl --user enable --now
check-comfyui-regime.timer` (the same "Deploying changes" step below) are
still an open step for whoever next has that access. Until then, the only
live check is the manual `npm run check:comfyui-regime` invocation.

`board-vet-and-ready.timer`'s unit files are new as of T-0384 and are
**deliberately not installed or enabled** -- see "Nightly vet-and-ready
(T-0384)" below for why this one is different from every other row in this
table (not just "nobody has had the access yet").

## Nightly vet-and-ready (T-0384)

`vetAndReady.js` (`tools/board/ops/vetAndReady.js`) is a WSL-native
replacement for the external `nightly-infra-prep` scheduled task, which runs
in a cloud sandbox with no WSL and so cannot reach `~/dev/assembled-board` or
`127.0.0.1:4173` directly -- it either fails outright or coin-flips on a
browser-JS fallback. Run natively here instead, it has full git and board API
access, so it implements every vetting rule for real:

1. Every dependency of a candidate card is `done` or `retired` (mirrors the
   auto-launch poller's own satisfied-dependency test,
   `autoLaunchPoller.js`'s `SATISFIED_DEP_STATUSES`).
2. The card is not already satisfied by merged work. Checked two ways on the
   base branch, both mechanical (no path content is ever read, no acceptance
   prose is interpreted): a message `git log <base-branch> --grep=<card-id>`,
   and -- for every path-looking token named in the card's own `## Acceptance`
   section (`extractAcceptancePaths`) -- a path-scoped `git log <base-branch>
   -- <path>` (does that path have *any* history on the base branch at all).
   Either kind of hit is treated as "possibly already satisfied" and skips
   the card; a `git` error on either check does too. A **missing** hit on
   both is what clears a card -- absence of a card-id mention alone is never
   sufficient on its own (Codex review 2026-09-18, finding 2: a commit can
   implement a card's whole acceptance without ever mentioning the card id).
   Reviewer FAIL round, 2026-09-18 (AC 10): an absent card-id hit alone is
   *still* not clearance -- if the acceptance section names no checkable
   path at all, there is no mechanical evidence in either direction, so the
   card is skipped as uncertain rather than cleared. There are exactly three
   outcomes: mechanical acceptance evidence (a named path with no history on
   the base branch), an explicit recorded vetting decision (none exists in
   this corpus today), or skip-as-uncertain. See `src/lib/vetAndReady.js`'s
   `mergedWorkCheck` for the documented limit of what a mechanical check can
   safely claim beyond this.
3. The card's body carries none of a fixed set of superseding/held marker
   rules (`HELD`, `RE-SCOPED`/`RESCOPED`, `SUPERSEDED`, "This section
   governs", "stop and report"/"stop-and-report", a `## Finding` heading),
   matched case-insensitively and tolerant of real punctuation/spacing
   variants (Codex review 2026-09-18, finding 1) -- see
   `SUPERSEDED_MARKER_RULES` in `src/lib/vetAndReady.js`.
4. DAG order is respected -- enforced by rule 1 itself, since `ready` is
   never a satisfied dependency status, so a dependent card whose
   prerequisite is only being readied this same run still fails rule 1.
5. At most 4 cards are readied per run, highest priority first then lowest
   numeric id. This is a hard ceiling: `BOARD_VET_READY_CAP` can lower it,
   never raise it, and the ceiling is enforced twice -- once in config
   parsing (`resolveConfig`) and again inside `vetAndReady()` itself at the
   selection boundary (Codex review 2026-09-18, finding 4).

It **only ever** writes `status: "ready"` via `PATCH /api/tasks/:id` on
cards that pass every rule -- never `POST /api/tasks/:id/run`, never a
merge, never a deploy, never a body edit. **Dry run is the default**;
`--apply` is required to write anything. It also reads `GET /api/poller`
(T-0383) for the auto-launch poller's own state and degrades gracefully --
never throwing -- to a documented "poller state unavailable" summary line on
any board deployment that predates T-0383.

**Apply mode revalidates every candidate immediately before its write**
(Codex review 2026-09-18, finding 3): the poller fetch and the per-candidate
`git log` calls earlier in the same run are enough time for a card to change
underneath it. Right before each write, `applyReadiedCards` re-fetches the
full task list fresh and re-runs `revalidateCandidate` (status, eligibility
scope, approval flag, body markers, dependencies -- everything except the
git-based merged-work check, which doesn't go stale within a run) against
that fresh snapshot; a candidate that no longer passes is skipped and
reported, never written. `findChangedVettedFields` (T-0384 FIX ROUND 4,
Codex P2 #1) additionally compares that fresh snapshot against the
candidate's ORIGINAL, selection-time snapshot -- what every rule actually
vetted -- so a body/acceptance change to a DIFFERENT but still eligible-
looking value (no Held marker, still eligible, deps still fine) is caught
too; `revalidateCandidate` alone only re-checks the fresh snapshot against
itself and has nothing to compare it against. The write itself carries the
ORIGINAL snapshot's status as an `X-Board-Expected-Status` header AND a full
field fingerprint (`X-Board-Expected-Fields` -- status, agent,
deliverable_type, requires_approval, depends_on, and a hash of body, built
by `buildExpectedFields`), which `PATCH /api/tasks/:id` enforces as a
server-side precondition (`StaleWriteError` -> 409) so a card whose body,
agent, deliverable_type, or depends_on changes in the small remaining gap
between that re-check and the write landing -- not just its status -- is
refused, not silently overwritten, instead of racing (T-0384 FIX ROUND 2,
Codex P2 #1). `FsTaskStore` additionally serializes every mutating call for
a given id through a per-instance async lock so this precondition check and
the write it guards can't be interleaved by a second call on the same id
within this same store instance/process (Codex P2 #2) -- see the guarantee
each store actually makes, spelled out precisely in `fsTaskStore.js`'s
constructor comment and `dbTaskStore.js`'s `update` comment (neither claims
cross-process safety).

**Dependency status is enforced INSIDE the atomic write itself, not just in
a preceding GET** (T-0384 FIX ROUND 4, Codex P2 #2): the write also carries
`X-Board-Require-Dependencies-Satisfied: true`, which `DbTaskStore.update`
re-checks by re-reading each dependency's status from inside the same
synchronous transaction as the write, and `FsTaskStore.update` re-checks
inside its existing per-id lock -- both refuse the transition
(`DependencyNotSatisfiedError` -> 409, naming the dependency and its current
status) if a dependency regressed out of `done`/`retired` in the gap between
this job's own pre-write re-fetch and the PATCH actually landing.

**The FS lock now also covers dependency ids, not just the candidate's own
id** (T-0384 FIX ROUND 5, Codex round-2 review): `DbTaskStore`'s guarantee
above was already airtight, because its whole `requireDependenciesSatisfied`
check plus the write run inside one synchronous `better-sqlite3` transaction
-- nothing else sharing that connection can interleave partway through.
`FsTaskStore`'s per-id lock, though, keyed the guard purely off the
candidate's id; a dependency has a *different* id and therefore a different
lock entry, so a direct write to that dependency through the same store
instance could still land between the guarded read and the candidate's
write. Of the two options the card allowed -- (a) lock the dependency ids
too, in one consistent order, or (b) refuse `requireDependenciesSatisfied`
outright on this backend -- **(a) was chosen**: `FsTaskStore`'s per-id lock
generalizes cleanly to a set of ids (`_withLocks`, in `fsTaskStore.js`),
and refusing the option would have broken the FS-backed contract tests
that already exercise `requireDependenciesSatisfied` successfully
(`test/taskStoreContract.js`). `update()` now locks the candidate id
together with every id in its `depends_on` list (deduped and sorted) before
running its guarded read-check-write; two concurrent guarded writes whose
dependency sets overlap in opposite orders both still complete, since
`_withLocks` captures and replaces every id's queue tail in a single
synchronous step rather than acquiring ids one at a time -- there is no
partial "hold one, wait on another" state for a deadlock to form in. See
`test/fsTaskStore.test.js`'s "FIX ROUND 5" describe block for both
regressions.

**The FS guard re-validates its own lock set before trusting it** (T-0384
FIX ROUND 6, Chat round-3 review): FIX ROUND 5's lock set was still chosen
from an UNLOCKED peek of `depends_on`, taken before any lock is acquired --
if `depends_on` itself changed between that peek and the lock actually
landing, the guard could lock yesterday's dependency and evaluate today's
real one without ever holding its lock. `FsTaskStore.update` now re-reads
`depends_on` fresh from INSIDE the lock it just acquired and compares it
against the ids it actually locked (`sameIdSet`); a mismatch drops the lock
and retries with the corrected set, bounded by `MAX_DEPENDENCY_LOCK_ATTEMPTS`
(5) -- a depends_on that changes on every single re-read is refused with a
new `DependencyLockSetUnstableError` rather than retried forever. This does
**not** depend on a caller-supplied `expected.depends_on`: the comparison is
always against a fresh read `update` takes itself, so
`requireDependenciesSatisfied: true` is safe on its own with no `expected`
at all -- the option chosen was (a) retry, not (b) refuse-on-this-backend,
since retrying converges in the ordinary case and the bound keeps the
pathological case from hanging. `DbTaskStore` needed no change: its whole
`requireDependenciesSatisfied` check plus the write already run inside one
synchronous transaction, so there is no separate "peek" step to go stale.
See `test/fsTaskStore.test.js`'s "FIX ROUND 6" describe block for the
interleaving regression (encoding Chat's exact reproduction), the
bounded-retry-exhaustion regression, and a no-deadlock regression for two
concurrent guarded writes whose dependency sets change mid-flight.

**A write-time refusal changes the run's exit code, not just its report**
(T-0384 FIX ROUND 3). `vetAndReady.js` exports three named exit codes:

| Code | Constant | When |
|---|---|---|
| `0` | `EXIT_CODE_OK` | A dry run, or an apply run where every candidate either wrote cleanly or was skipped at *selection* time (dependency, merged-work, held/superseded, approval, GPU/asset, cap) |
| `1` | `EXIT_CODE_BOARD_UNREACHABLE` | The board API could not be reached at all |
| `2` | `EXIT_CODE_WRITE_REFUSED` | (`--apply` only) at least one candidate was refused *at write time* -- its vetted fields changed after selection, or the server rejected a stale write |

Before this, every run that reached the task fetch returned `0`, including
an apply run where every single candidate was refused at write time -- the
same "reports success and exits 0" shape Codex's P2 #1 objected to on the
write path itself, just moved to the exit code. A dry run and an ordinary
selection-time skip are not write-time events and always exit `0`, so the
live nightly dry run (which currently skips every eligible card) stays a
green systemd unit; see `board-vet-and-ready.service`'s own comment and
`vetAndReady.sh`'s header comment for the same table.

Every run prints its full decision table to stdout (captured by
`journalctl --user -u board-vet-and-ready.service` once installed, since
systemd captures a oneshot unit's own stdout automatically -- `vetAndReady.sh`
does not redirect it away) and also writes it to
`$BOARD_VET_LOG_DIR/latest.md` (default
`~/.local/state/board-vet-and-ready/latest.md`), plus a one-line-per-run
`history.log` in the same directory, so an operator can read the last run
without needing `journalctl` at all.

### Environment variables (`vetAndReady.js`)

| Variable | Default |
|---|---|
| `BOARD_BASE_URL` | `http://127.0.0.1:${BOARD_PORT:-4173}` |
| `BOARD_PORT` | `4173` |
| `BOARD_REPO_ROOT` | the repo checkout `ops/vetAndReady.js` itself resolves from |
| `BOARD_VET_BASE_BRANCH` | `develop` (the branch rule 2's `git log --grep` runs against) |
| `BOARD_VET_READY_CAP` | `4` (may only lower this; a larger value clamps back down to 4) |
| `BOARD_VET_LOG_DIR` | `~/.local/state/board-vet-and-ready` |

### Live dry run (T-0384 acceptance evidence)

`node ops/vetAndReady.js` (no `--apply`) against the actual live board at
`127.0.0.1:4173`, re-run after FIX ROUND 4, 2026-09-19T09:52:12.351Z:

```
# Board vet-and-ready run -- 2026-09-19T09:52:12.351Z

Poller state: enabled=true, interval=30m, usageMax=0.8

Eligible-at-all: 3 card(s) (status=backlog, agent=infra, deliverable_type=code, requires_approval=false)
Readied: 0 (cap 4)
Skipped: 3

## Skipped
- T-0362 "Freeze the motion-gate thresholds against the first approved compositor walk and the negative-control battery (DL-31)" [P1] skipped -- 1-dependency: unmet dependency: T-0338 is backlog ([{"id":"T-0338","status":"backlog"}])
- T-0371 "WIP gate T-E: one shared GPU lease across every audited GPU submission path, with owner + crash reconciliation" [P2] skipped -- 3-superseded: acceptance may be self-contradicted or superseded -- body contains marker(s): HELD (HELD)
- T-0372 "WIP gate T-F: drain mode with oversized-card detection and bounded, aged waiting" [P2] skipped -- 3-superseded: acceptance may be self-contradicted or superseded -- body contains marker(s): HELD (HELD)

## Apply
Dry run (default) -- nothing was written. Pass --apply to PATCH status: ready on the readied cards above.
```

Confirmed it wrote nothing: `GET /api/tasks/T-0362`, `GET /api/tasks/T-0371`
and `GET /api/tasks/T-0372` all still read `status: "backlog"` immediately
after this run, and `git status --porcelain` was unchanged.

This table differs from the AC10/AC13 fix-round evidence only in that
T-0385 (a card that has since left backlog) no longer appears -- T-0362 and
T-0371/T-0372 are unchanged, skipped for the same reasons (rule 1's unmet
T-0338 dependency, rule 3's `HELD` markers respectively). Nothing in FIX
ROUND 4 changes selection-time behaviour on any of these three cards; its
two fixes (comparing against the original vetted snapshot, enforcing
dependency status atomically) only ever bite at write time, and this run
never reaches a write.

#### Fix round (Codex review 2026-09-18, PR #396) -- re-verification status

The four original findings (case-insensitive markers, mechanical
merged-work path evidence, pre-write revalidation + a server-enforced write
condition, a hard 4-card cap) were fixed with failing-test-first commits and
verified against Codex's own `vetting-probes.mjs` and `merged-work-probe.mjs`,
repointed at this worktree and re-run directly: all three body-marker
variants skip, the concurrent-status-change probe performs zero writes, and
the merged-work probe (develop already has `feature.js` implementing the
card's whole acceptance, committed without the card id) skips instead of
readying. The `BOARD_VET_READY_CAP=10` cap override reports an effective cap
of 4 with exactly 4 readied when run against candidates that carry
mechanical acceptance evidence (a checkable, unmerged path) -- Codex's own
probe fixture uses a path-less prose body, which the AC10 fix below now
correctly skips as uncertain before it ever reaches the cap step; re-run
with a checkable path (`## Acceptance\n\n- [ ] Add \`src/lib/pollerEndpoint.js\`.`)
it selects exactly 4 of 6 candidates, confirming the cap itself is intact.

#### AC10/AC13 fix round (reviewer FAIL round, 2026-09-18)

Two criteria failed in the prior validation: (1) `mergedWorkCheck` still
returned `ok: true` whenever a card's acceptance section named no checkable
path at all, clearing it on nothing but an absent card-id git hit -- fixed
so that case now returns skip-as-uncertain instead (see `mergedWorkCheck`
in `src/lib/vetAndReady.js`, and the rule-2 description above). Fixing this
surfaced a second, real bug: `ACCEPTANCE_SECTION_RE`'s `m`-flag `$` anchor
matched at the first blank line after the `## Acceptance` heading -- this
repo's own house style -- so `extractAcceptancePaths` silently returned `[]`
for virtually every real card regardless of content; also fixed, with its
own failing-test-first regression. (2) This "Live dry run" evidence block
above was stale from a session where the board was unreachable; it is now
the fresh 2026-09-18T13:05:13.271Z run captured above, confirmed to have
written nothing.

The full board suite (`npx vitest run`, 200 files / 3825 tests) and
`npm run lint` are green on the head that includes both fixes.

#### FIX ROUND 4 (Codex review 2026-09-19, head 8e44e923)

Two new P2 write-safety gaps, both closed with failing-test-first regressions
against a real HTTP server + a real (in-memory) `DbTaskStore`, not mocks:

1. A candidate's acceptance/body changing to a DIFFERENT, still eligible-
   looking value (no Held marker) between selection and its own pre-write
   re-fetch previously sailed through untouched -- `revalidateCandidate`
   only ever re-checked the fresh snapshot against itself. Closed by
   `findChangedVettedFields`, and by anchoring the server-side
   `X-Board-Expected-Fields` precondition to the ORIGINAL vetted snapshot
   instead of the fresh one.
2. A dependency regressing out of `done`/`retired` immediately before the
   PATCH landed was invisible to both the client-side re-check (a plain GET,
   already completed by then) and the server-side fingerprint (which only
   ever carried dependency *ids*, not their statuses). Closed by
   `DependencyNotSatisfiedError` / `findUnsatisfiedDependencies`
   (`src/lib/taskStore.js`) and a new opt-in `requireDependenciesSatisfied`
   store option, checked inside `DbTaskStore`'s transaction and
   `FsTaskStore`'s per-id lock, surfaced via a new
   `X-Board-Require-Dependencies-Satisfied` header this job always sends.

Codex's `vetting-probe.mjs` for this round is mirrored at
`/home/dennieseth/codex-2026-09-19/`, which is outside this worktree and not
reachable from this sandbox (a hard filesystem boundary, not a permission
prompt -- confirmed via `ls`). Per the card's own fallback, the four new real-HTTP-server + real-`DbTaskStore`
regressions in `test/ops/vetAndReady.test.js` stand in for it: P2 #1
reproduced both as a single candidate and as a later candidate changing
while an earlier one's write is in flight; P2 #2 reproduced as a dependency
regressing immediately before the PATCH, plus its "still satisfied"
complement.
Board suite: 203 files / 3906 tests passing (one flake unrelated to this
diff, see the FIX ROUND 4 fix commit message); `npm run lint` clean.

#### FIX ROUND 5 (Codex round-2 review 2026-09-19, head 6677455)

One remaining P2, FS-only: `FsTaskStore.update`'s `requireDependenciesSatisfied`
check ran under a lock keyed only to the candidate's own id, so a direct
write to a dependency id (a different lock entry) through the same store
instance could still interleave with the guarded read-check-write. The DB
path was already closed (see the "FS lock now also covers dependency ids"
paragraph above for the full writeup and the chosen fix -- option (a), lock
ordering, over (b), refusing the option on this backend).

Codex's `fs-dependency-probe.mjs` and `vetting-probe.mjs` for this round are
mirrored at `/home/dennieseth/codex-2026-09-19-r2/`, which is outside this
worktree and not reachable from this sandbox (a hard filesystem boundary,
not a permission prompt -- confirmed via `ls` refusal). Per the card's own
fallback, the two new regressions in `test/fsTaskStore.test.js`'s "FIX ROUND
5" describe block stand in for them: a concurrent write to a locked
dependency now blocks until the guarded ready update lands, and two
concurrent guarded writes with opposite-order dependency sets both complete
without deadlock.

Board suite: 203 files / 3908 tests passing (the same one load-dependent
flake as FIX ROUND 4, `test/runner/cardLaunch.test.js:915`, unrelated to
this diff -- 72/72 green when that file runs alone); `npm run lint` clean.

#### FIX ROUND 6 (Chat round-3 review 2026-09-19, head bf4449c)

One remaining P2: FIX ROUND 5's dependency-lock fix chose which ids to lock
from an UNLOCKED peek of `depends_on`, taken before `_withLocks` is even
called. If `depends_on` itself changed in the gap between that peek and lock
acquisition, the guard could lock the WRONG dependency (yesterday's) and
evaluate the real one (today's) without ever holding its lock -- a narrower,
same-instance version of the FIX ROUND 5 gap, not the accepted
cross-process/per-instance limitation. See the "FS guard re-validates its
own lock set" paragraph above for the full writeup and the chosen fix
(option (a): re-read `depends_on` inside the lock and retry with a corrected
set, bounded).

Chat's `fs-changed-dependency-probe.mjs`, mirrored at
`/home/dennieseth/codex-2026-09-19-r3/`, is outside this worktree and not
reachable from this sandbox (a hard filesystem boundary, not a permission
prompt -- `ls` on that path is refused: "may only list files in the allowed
working directories for this session"). Per the card's own fallback, the
new "FIX ROUND 6" describe block in `test/fsTaskStore.test.js` stands in for
it: the exact 5-step interleaving Chat described (stale peek locks T-9002,
a competing write retargets `depends_on` to T-9003, the guard must not
evaluate/write against T-9003 without holding its lock -- the competing
write to T-9003 is proven to queue behind the guard's corrected lock
instead of racing it), plus a bounded-retry-exhaustion regression
(`depends_on` changing on every re-read refuses with
`DependencyLockSetUnstableError` rather than hanging) and a no-deadlock
regression for two concurrent guarded writes whose dependency sets change
mid-flight.

Board suite: 203 files / 3916 tests passing, no flake this run; `npm run
lint` clean.

### Installing (not done by this card, on purpose)

This card's acceptance is the script, its tests, and these committed unit
files -- **not** a live, enabled timer. The external `nightly-infra-prep`
scheduled task stays enabled until this WSL timer is proven; installing this
one is a separate, later, human step:

```sh
cp tools/board/ops/vetAndReady.sh ~/.local/bin/board-vet-and-ready.sh
chmod +x ~/.local/bin/board-vet-and-ready.sh
cp tools/board/ops/systemd/board-vet-and-ready.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now board-vet-and-ready.timer
```

Check the last run with `systemctl --user status board-vet-and-ready.service`,
`journalctl --user -u board-vet-and-ready.service`, or by reading
`~/.local/state/board-vet-and-ready/latest.md` directly.

## Scheduled approval-ledger export (T-0434)

### The incident

`tools/board/approval-ledger.json` is the committed snapshot
`checkApprovalProvenanceDrift.js` falls back to in CI, where `tasks/*.md`
stops at T-0365 and the live DB is unreachable. It was regenerated only by
hand, or incidentally by `approvalLedgerRegen.js` inside `_handlePass` --
and that regeneration runs only on a PASS, writes into THAT card's own
worktree, and (correctly, for its own purpose) skips the write whenever the
regenerated `cards` are byte-identical to what's committed, so an unrelated
PR never carries a `generated_at`-only diff. A quiet stretch on `develop`
with no approval-bearing PASS means nothing ever refreshes the ledger
`develop` itself carries, and `checkApprovalProvenanceDrift.js` fails any PR
sitting more than `BOARD_APPROVAL_LEDGER_STALE_HOURS` (24h) past the last
refresh -- which is exactly what blocked PR #440 (46h old) and PR #439
(62.9h old) on 2026-10-07/08, neither PR touching approvals at all.

### The decision

Two naive fixes both fail (see the card and
`src/lib/approvalLedgerScheduleDecision.js`'s own docstring):

- **Commit every scheduled run.** `generated_at` changes on every export, so
  this commits a no-op diff every single run -- daily churn in the repo
  history for nothing.
- **Commit only when the cards changed.** A quiet week never refreshes
  `generated_at`, so the ledger ages past 24h anyway -- the exact #440/#439
  incident, just moved from "nobody ran the exporter" to "the exporter ran
  but had nothing new to say."

**Chosen: "refresh-before-it-bites."** `decideLedgerExport` (same module)
commits when the exported cards changed, **or** when the currently
committed ledger is already older than `BOARD_LEDGER_REFRESH_THRESHOLD_HOURS`
(default 12h -- well under the gate's 24h). `exportApprovalLedgerScheduled.js`
runs this every 4 hours against the real `develop` checkout (see "Why this,
not the integrity checker" below for why that cadence, not something
coarser).

**The cost, stated and measured, not asserted:** during a totally quiet
period (no card's approval fields ever change), this commits roughly once
per threshold window, not once per run.
`test/lib/approvalLedgerScheduleDecision.test.js`'s
`simulateWorstCaseAgeHours` spec ("does not commit on every run during a
quiet period") proves this directly: over a simulated 240h (10-day) quiet
stretch at a 4h cadence, that's 60 scheduled runs but fewer than 30 commits
-- bounded churn, not the every-run failure mode, and nowhere near zero
either. That's the price of the guarantee below.

### Proof it refreshes before the gate bites

The same module's `simulateWorstCaseAgeHours` is the worked timeline the
card's acceptance criteria ask for, not a comment asserting it:

- **Normal operation** (interval 4h, threshold 12h, no run ever missed):
  worst-case ledger age never exceeds `threshold + interval` = 16h,
  comfortably under the gate's 24h. Spec: "never lets the ledger's age
  exceed threshold + interval over a long quiet period, on schedule."
- **One scheduled run silently missed** (the box was off for one tick):
  worst case rises to 20h -- still under 24h. Spec: "stays under the 24h
  gate even when a single scheduled run is missed entirely."
- **Two consecutive missed runs**: worst case is 20h -- `Persistent=true`
  only needs to catch the schedule up by the NEXT tick, not instantly, so
  two misses in a row still land inside the bound. Spec: "two consecutive
  missed runs still stay under the 24h gate."
- **The actual limit, named rather than hidden**: four consecutive missed
  runs (a 16h+ outage) pushes the worst case to 28h, past the gate. Spec:
  "names the actual limit of this design." An outage that long already
  means every OTHER timer in this ops suite (`board-db-backup`,
  `board-integrity-check`, `board-assets-sync`) has been silent for the
  same stretch -- this job's own skip/run log is one more place that shows
  it, not the only place an operator would notice.

### No partial writes

`exportApprovalLedgerScheduled.js` always exports to a temp file first
(`<ledger path>.tmp-<timestamp>`) via the existing, unmodified
`scripts/exportApprovalLedger.js`. The real committed `approval-ledger.json`
is only ever touched by an atomic `fs.rename` over it, and only after the
subprocess exits 0 AND the temp file parses as JSON with a non-empty
`cards` array. A failed export (commonly: the task store/DB was
unreachable -- the underlying exporter already refuses to write an empty
ledger and exits 1) or an empty/invalid result both return
`EXIT_CODE_EXPORT_FAILED` with the renamed real file never touched --
pinned by `test/ops/exportApprovalLedgerScheduled.test.js`'s "reports
export failure and never commits..." and "refuses an empty/invalid exported
ledger..." specs, both asserting `renameFn` was never called.

### Safe against a live board / a run in progress

Before doing anything else, the job requires:

1. **The checkout is on `develop`** (`BOARD_LEDGER_EXPORT_BRANCH`). Any
   other branch is a deliberate no-op skip (`reason: "wrong-branch"`) --
   this job commits to exactly one branch and never to whatever a human or
   another process happens to have checked out.
2. **Nothing is dirty except possibly the ledger file itself.** Any other
   uncommitted change in the working tree is read as "a run or other work
   may be in progress here" and the whole run skips without writing
   anything (`reason: "working-tree-dirty"`). Since every card's actual
   implementation work happens in its own worktree under `worktrees/`, not
   in this shared checkout, a dirty tree here is already unusual -- this
   job treats "unusual" as "don't touch it" rather than guessing.
3. **Local `develop` matches `origin/develop` exactly**, re-checked via a
   fresh `git fetch` immediately before the comparison. A mismatch skips
   (`reason: "not-in-sync-with-remote"`) rather than running `git pull` or
   any other automatic merge -- this job never resolves a divergence by
   itself, only by a human fixing the checkout (the next run re-checks).

### Branch target and pushing

**It pushes.** A local-only commit never reaches CI -- GitHub Actions
clones from the remote, not from this box's disk -- so a commit that stays
local defeats the entire point of this card. After the commit, the job runs
`git push origin develop` (never `--force`). If the push fails (e.g. a race
against a human push landing in the small gap between the sync check above
and this push), that's reported as its own distinct exit code
(`EXIT_CODE_GIT_FAILED`, `reason: "push-failed"`) -- the commit stays local,
and the NEXT run's sync check (step 3 above) will keep skipping until a
human resolves the divergence by hand. This is deliberately not retried or
auto-merged.

### A feature branch cut before the refresh

Accepted, not addressed. A fresh ledger landing on `develop` does not
retroactively reach a branch that was cut earlier -- that branch keeps
whatever copy of the ledger it had at cut time until `develop` is merged
into it (exactly how PR #439 was actually unstuck). This job only ever
touches `develop`'s own copy; it has no mechanism to reach into every open
feature branch, and inventing one (force-pushing into other people's
branches) would be a far more dangerous fix for a narrower problem. A
feature branch open long enough to go stale on its OWN copy still needs a
`develop` merge or rebase, same as before this card.

### DB / exporter unreachable

Surfaced loudly, not silently: the exporter subprocess failing returns
`EXIT_CODE_EXPORT_FAILED`, which makes the systemd oneshot unit report as
failed. An operator sees this via `systemctl --user status
board-ledger-export.service`, `journalctl --user -u
board-ledger-export.service`, or `~/.local/state/board-ledger-export/latest.log`
(every run writes a summary there, success or not) -- the same three places
`board-vet-and-ready.sh` is already checked.

### Two writers at once

`board-ledger-export.sh` takes an exclusive, non-blocking `flock` on
`/tmp/board-ledger-export.lock` before doing anything, the same pattern
every other `.sh` wrapper in this directory uses -- a second run that starts
while one is still in flight exits `0` immediately with a "already
running, skipping" log line rather than racing it. Beyond self-collision,
this is the FIRST job in this ops suite to commit+push to the git repo at
all (every other job here either only reads, or writes to Drive/SQLite, or
-- `vetAndReady.sh` -- only ever PATCHes the board's own HTTP API, never
git); its own step-3 sync-with-remote check (above) is what protects it
against a concurrent HUMAN push to `develop`, which `flock` alone wouldn't
catch.

### Why this, not the integrity checker

The card's acceptance asks for early warning as the ledger approaches the
threshold, OR a stated reason that's unnecessary given the chosen fix.
Chosen: **unnecessary, for two reasons.**

First, structurally: under normal operation (fewer than four consecutive
missed 4-hourly runs -- see "Proof it refreshes before the gate bites"
above), the committed ledger cannot reach anywhere near the 24h gate at
all, so a once-a-day 03:20 check (`board-integrity-check.py`'s own cadence)
reporting "age approaching threshold" would almost never fire, and on the
rare day a 16h+ outage made it fire, every other timer in this same suite
would already be silent for the same stretch -- that silence is the
earlier, broader signal.

Second, practically: this job's own per-run log (`latest.log`/`history.log`,
written every 4 hours regardless of outcome) already reports the ledger's
age at 4h granularity -- finer than `board-integrity-check.py`'s once-daily
check could ever provide. Adding a second, coarser copy of the same
observation to a Python script this agent cannot execute or test
(`board-integrity-check.py` has no pytest coverage, and the `infra` persona
has no Python grant at all -- editing it without being able to run it would
itself violate this repo's non-negotiable TDD rule) would trade a real
test for an untested one, for strictly less information than the log this
job already writes.

### No gate weakened

`checkApprovalProvenanceDrift.js` and `BOARD_APPROVAL_LEDGER_STALE_HOURS`
are untouched by this card -- nothing here edits the gate itself, only what
feeds it. The gate's own existing suite
(`test/checkApprovalProvenanceDrift.e2e.test.js`,
`test/approvalProvenanceDrift.test.js`) still exercises the
stale-and-load-bearing failure path unchanged and green; a genuinely stale,
genuinely load-bearing ledger still fails the gate exactly as before.

### Installing (not done by this card, on purpose)

Same posture as `board-vet-and-ready.timer`: this card's acceptance is the
script, its tests, and these committed unit files -- not a live, enabled
timer on the actual box. Installing is a separate, later, human step:

```sh
cp tools/board/ops/board-ledger-export.sh ~/.local/bin/board-ledger-export.sh
chmod +x ~/.local/bin/board-ledger-export.sh
cp tools/board/ops/systemd/board-ledger-export.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now board-ledger-export.timer
```

Check the last run with `systemctl --user status
board-ledger-export.service`, `journalctl --user -u
board-ledger-export.service`, or by reading
`~/.local/state/board-ledger-export/latest.log` directly.

## Deploying changes

The copies under this directory are byte-identical snapshots of what is
currently live on the box (verified at commit time). Going forward, treat
this repo copy as the source of truth: make edits here, then copy the
changed file(s) out to `~/.local/bin/` or `~/.config/systemd/user/` and
`systemctl --user daemon-reload` (for unit changes) to deploy — don't edit
the on-box copies in place and let them drift from what's committed.
