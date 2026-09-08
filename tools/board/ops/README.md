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

## Deploying changes

The copies under this directory are byte-identical snapshots of what is
currently live on the box (verified at commit time). Going forward, treat
this repo copy as the source of truth: make edits here, then copy the
changed file(s) out to `~/.local/bin/` or `~/.config/systemd/user/` and
`systemctl --user daemon-reload` (for unit changes) to deploy — don't edit
the on-box copies in place and let them drift from what's committed.
