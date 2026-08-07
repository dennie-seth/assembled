#!/usr/bin/env bash
# Runs the board's existing WAL-safe online backup (tools/board/scripts/backupDb.js via
# `npm run backup:db`, which opens the live db read-only through better-sqlite3's backup
# API) and prunes old backups under <dataDir>/backups/, keeping the most recent N. Never
# touches the live db itself -- this script only ever deletes files under backups/.
set -uo pipefail

LOCKFILE="/tmp/board-db-backup.lock"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "$(date -Is) already running, skipping"; exit 0; }

BOARD_REPO_ROOT="${BOARD_REPO_ROOT:-$HOME/dev/assembled-board}"
BOARD_TOOL_DIR="$BOARD_REPO_ROOT/tools/board"
DATA_DIR="${BOARD_DATA_DIR:-$HOME/.local/share/assembled-board}"
BACKUPS_DIR="$DATA_DIR/backups"
RETENTION_COUNT="${BOARD_DB_BACKUP_RETENTION:-14}"

LOG_DIR="$HOME/.local/state/board-db-backup"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/backup.log"

{
  echo "=== run $(date -Is) ==="

  echo "--- backup ---"
  if ! npm --prefix "$BOARD_TOOL_DIR" run backup:db; then
    echo "backup:db failed, aborting before prune"
    echo "=== run $(date -Is) done (backup failed) ==="
    exit 1
  fi

  echo "--- prune (keep last $RETENTION_COUNT) ---"
  mapfile -t backups < <(ls -1t "$BACKUPS_DIR"/board-*.db 2>/dev/null)
  count=${#backups[@]}
  if (( count > RETENTION_COUNT )); then
    for ((i = RETENTION_COUNT; i < count; i++)); do
      echo "deleting old backup: ${backups[$i]}"
      rm -f -- "${backups[$i]}"
    done
  else
    echo "no pruning needed ($count backups <= retention $RETENTION_COUNT)"
  fi

  echo "=== run $(date -Is) done ==="
} >> "$LOG" 2>&1
