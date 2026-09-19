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

## Deploying changes

The copies under this directory are byte-identical snapshots of what is
currently live on the box (verified at commit time). Going forward, treat
this repo copy as the source of truth: make edits here, then copy the
changed file(s) out to `~/.local/bin/` or `~/.config/systemd/user/` and
`systemctl --user daemon-reload` (for unit changes) to deploy — don't edit
the on-box copies in place and let them drift from what's committed.
