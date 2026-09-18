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
   See `src/lib/vetAndReady.js`'s `mergedWorkCheck` for the documented limit
   of what a mechanical check can safely claim beyond this.
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
reported, never written. The write itself also carries the freshly-observed
status as an `X-Board-Expected-Status` header, which `PATCH /api/tasks/:id`
enforces as a server-side precondition (`StaleWriteError` -> 409) so a card
that changes in the small remaining gap between that re-check and the write
landing is refused, not silently overwritten, instead of racing.

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
`127.0.0.1:4173`, 2026-09-18T09:51:34.590Z:

```
# Board vet-and-ready run -- 2026-09-18T09:51:34.590Z

Poller state: unavailable -- GET /api/poller returned 404 Not Found -- likely a board deployment that predates T-0383

Eligible-at-all: 3 card(s) (status=backlog, agent=infra, deliverable_type=code, requires_approval=false)
Readied: 2 (cap 4)
Skipped: 1

## Readied
- T-0371 "WIP gate T-E: one shared GPU lease across every audited GPU submission path, with owner + crash reconciliation" [P2] READIED -- 5-cap-ok: every rule passed; readied (priority P2, within the cap of 4)
- T-0372 "WIP gate T-F: drain mode with oversized-card detection and bounded, aged waiting" [P2] READIED -- 5-cap-ok: every rule passed; readied (priority P2, within the cap of 4)

## Skipped
- T-0362 "Freeze the motion-gate thresholds against the first approved compositor walk and the negative-control battery (DL-31)" [P1] skipped -- 1-dependency: unmet dependency: T-0338 is backlog ([{"id":"T-0338","status":"backlog"}])

## Apply
Dry run (default) -- nothing was written. Pass --apply to PATCH status: ready on the readied cards above.
```

Confirmed it wrote nothing: `GET /api/tasks/T-0371` and `GET
/api/tasks/T-0372` both still read `status: "backlog"` immediately after
this run, and `git status --porcelain` was unchanged. The `Poller state:
unavailable` line is the documented T-0383 degrade path working as intended
-- this board deployment (built from `develop` before T-0383 merged) has no
`GET /api/poller` route yet.

#### Fix round (Codex review 2026-09-18, PR #396) -- re-verification status

The four findings above (case-insensitive markers, mechanical merged-work
path evidence, pre-write revalidation + a server-enforced write condition,
a hard 4-card cap) were fixed with failing-test-first commits and verified
against Codex's own `vetting-probes.mjs` and `merged-work-probe.mjs`,
repointed at this worktree and re-run directly: all three body-marker
variants skip, the `BOARD_VET_READY_CAP=10` cap override reports an
effective cap of 4 with exactly 4 readied, the concurrent-status-change
probe performs zero writes, and the merged-work probe (develop already has
`feature.js` implementing the card's whole acceptance, committed without
the card id) now skips instead of readying. The full board suite
(`npx vitest run`, 3746 tests) and `npm run lint` are green.

The live board at `127.0.0.1:4173` was **not reachable from this session**
(`ECONNREFUSED` on `GET /api/health`) -- the box this normally runs against
wasn't up during this fix-round session, so the dry-run decision table
above is unrefreshed. None of the four fixes change the *outcome* for the
three cards it lists (T-0371/T-0372 have no held/superseded body markers
and no acceptance-path git hits either way; T-0362 is skipped purely on
its unmet T-0338 dependency, rule 1, untouched by this fix round), but
that has not been re-confirmed live. Re-running `node ops/vetAndReady.js`
(no `--apply`) once the board is reachable and replacing this block with
fresh output is the next step before this evidence is current again.

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
