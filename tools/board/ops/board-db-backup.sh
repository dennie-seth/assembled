#!/usr/bin/env bash
# Runs the board's existing WAL-safe online backup (tools/board/scripts/backupDb.js via
# `npm run backup:db`, which opens the live db read-only through better-sqlite3's backup
# API) and prunes old backups under <dataDir>/backups/, keeping the most recent N. Never
# touches the live db itself -- this script only ever deletes files under backups/.
#
# After the local backup + prune, uploads the newest local snapshot to a dedicated
# Google Drive folder (via the same rclone remote the asset pipeline uses) and prunes
# that Drive folder to keep only the most recent N copies, so the DB survives a
# machine reload/wipe even though local retention stays much longer.
set -uo pipefail

LOCKFILE="/tmp/board-db-backup.lock"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "$(date -Is) already running, skipping"; exit 0; }

BOARD_REPO_ROOT="${BOARD_REPO_ROOT:-$HOME/dev/assembled-board}"
BOARD_TOOL_DIR="$BOARD_REPO_ROOT/tools/board"
DATA_DIR="${BOARD_DATA_DIR:-$HOME/.local/share/assembled-board}"
BACKUPS_DIR="$DATA_DIR/backups"
RETENTION_COUNT="${BOARD_DB_BACKUP_RETENTION:-14}"

RCLONE="$HOME/.local/bin/rclone"
RCLONE_REMOTE="${BOARD_DB_BACKUP_RCLONE_REMOTE:-gdrive:}"
DRIVE_BACKUP_DIR="${BOARD_DB_BACKUP_DRIVE_DIR:-Assembled — DB Backups}"
DRIVE_RETENTION_COUNT="${BOARD_DB_BACKUP_DRIVE_RETENTION:-2}"

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

  echo "--- offsite upload (Drive, keep last $DRIVE_RETENTION_COUNT) ---"
  newest="$(ls -1t "$BACKUPS_DIR"/board-*.db 2>/dev/null | head -n1)"
  if [[ -z "$newest" ]]; then
    echo "no local backup found to upload, skipping offsite step"
  elif [[ ! -x "$RCLONE" ]]; then
    echo "rclone not found at $RCLONE, skipping offsite step"
  else
    if ! "$RCLONE" mkdir "${RCLONE_REMOTE}${DRIVE_BACKUP_DIR}" 2>&1; then
      echo "WARNING: failed to ensure Drive folder ${RCLONE_REMOTE}${DRIVE_BACKUP_DIR} exists"
    fi

    if "$RCLONE" copyto "$newest" "${RCLONE_REMOTE}${DRIVE_BACKUP_DIR}/$(basename "$newest")" 2>&1; then
      echo "uploaded $(basename "$newest") -> ${RCLONE_REMOTE}${DRIVE_BACKUP_DIR}/"
    else
      echo "WARNING: upload of $newest to Drive failed"
    fi

    echo "--- Drive prune ---"
    mapfile -t drive_files < <("$RCLONE" lsf "${RCLONE_REMOTE}${DRIVE_BACKUP_DIR}" --files-only | grep '^board-.*\.db$' | sort -r)
    drive_count=${#drive_files[@]}
    if (( drive_count > DRIVE_RETENTION_COUNT )); then
      for ((i = DRIVE_RETENTION_COUNT; i < drive_count; i++)); do
        echo "deleting old Drive backup: ${drive_files[$i]}"
        "$RCLONE" deletefile "${RCLONE_REMOTE}${DRIVE_BACKUP_DIR}/${drive_files[$i]}" 2>&1
      done
    else
      echo "no Drive pruning needed ($drive_count backups <= retention $DRIVE_RETENTION_COUNT)"
    fi
  fi

  echo "=== run $(date -Is) done ==="
} >> "$LOG" 2>&1
