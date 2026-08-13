#!/usr/bin/env bash
# Hourly self-driving board-assets pipeline: STAGE (re-derive the staged tree
# from the live board, read-only) -> MAP (resolve/create per-task Drive
# folders) -> COPY (idempotent rclone push). Single flock guard covers the
# whole run so stage and copy never overlap with each other or themselves.
set -uo pipefail

LOCKFILE="/tmp/board-assets-sync.lock"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "$(date -Is) already running, skipping"; exit 0; }

BIN_DIR="$HOME/.local/bin"
LOG_DIR="$HOME/.local/state/board-assets-sync"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/sync.log"

{
  echo "=== run $(date -Is) ==="

  echo "--- stage ---"
  if ! python3 "$BIN_DIR/board-assets-stage.py"; then
    echo "stage step failed, aborting before drive-map/copy"
    echo "=== run $(date -Is) done (stage failed) ==="
    exit 1
  fi

  echo "--- drive folder mapping ---"
  python3 "$BIN_DIR/board-assets-drivemap.py"

  echo "--- copy ---"
  python3 "$BIN_DIR/board-assets-copy.py"

  echo "=== run $(date -Is) done ==="
} >> "$LOG" 2>&1
