# Board ops scripts

Operational scripts for the assembled board that run on the WSL box outside
the board application itself: asset export/backup to Google Drive, and a
daily integrity checker. These are copied here from `~/.local/bin` and
`~/.config/systemd/user` for version control and backup — they are **not**
imported or built as part of the app. See "Deploying changes" below.

## Data flow

```
board API (GET /api/tasks, GET /api/tasks/:id/attachments/:filename)
        |
        v
board-assets-stage.py   -- re-derives $BOARD_ASSETS_EXPORT_ROOT/<task-id>/
        |                  (MANIFEST.md + attachment files) from each card's
        |                  `attachments` metadata; writes index.json.
        |                  Read-only against the board. Pinned (hand-curated)
        |                  task dirs are left untouched.
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
                       for it to validate.
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
| `board-db-backup.sh` | Runs the app's `npm run backup:db` (WAL-safe online backup) then prunes old backups under `<dataDir>/backups/` to a retention count; used by the daily timer. |

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
| `BOARD_DB_BACKUP_RETENTION` | db-backup | `14` (backups kept before pruning) |

`board-assets-drivemap.py` and `board-assets-copy.py` also depend on an
`rclone` remote named `gdrive:` (configured separately via `rclone config`,
not read from these scripts) and call the `rclone` binary at
`~/.local/bin/rclone`. The Drive parent folder ID is hardcoded in
`board-assets-drivemap.py` (`PARENT_FOLDER_ID`) — it is a folder identifier,
not a credential; the actual Drive auth lives in rclone's own config.

## systemd timers

| Timer | Schedule | Runs |
|---|---|---|
| `board-assets-sync.timer` | hourly (`OnCalendar=hourly`, ±120s random delay) | `board-assets-sync.sh` |
| `board-db-backup.timer` | daily at 03:00 (±120s random delay) | `board-db-backup.sh` |
| `board-integrity-check.timer` | daily at 03:20 (±300s random delay) | `board-integrity-check.py` |

Both timers are `Persistent=true` (catch up on a missed run after the box was
off) and installed under `~/.config/systemd/user/`, enabled with
`systemctl --user enable --now <timer>`.

## Deploying changes

The copies under this directory are byte-identical snapshots of what is
currently live on the box (verified at commit time). Going forward, treat
this repo copy as the source of truth: make edits here, then copy the
changed file(s) out to `~/.local/bin/` or `~/.config/systemd/user/` and
`systemctl --user daemon-reload` (for unit changes) to deploy — don't edit
the on-box copies in place and let them drift from what's committed.
