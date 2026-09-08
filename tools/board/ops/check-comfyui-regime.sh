#!/usr/bin/env bash
# Periodic wrapper for `npm run check:comfyui-regime` (tools/board/scripts/checkComfyUiRegime.js,
# T-0322): fails loudly -- nonzero exit, visible via `systemctl --user status
# check-comfyui-regime.service` and journalctl, the same way board-integrity-check.service already
# surfaces its own failures -- if the live ComfyUI server's determinism regime has drifted from
# tools/board/ops/comfyui-regime.json, in either direction. Read-only against ComfyUI: it only ever
# GETs /system_stats, never restarts or reconfigures the server. See
# docs/comfyui-setup.md#determinism for why "drift in either direction" (not "must be
# --deterministic") is the right check.
set -uo pipefail

LOCKFILE="/tmp/check-comfyui-regime.lock"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "$(date -Is) already running, skipping"; exit 0; }

BOARD_REPO_ROOT="${BOARD_REPO_ROOT:-$HOME/dev/assembled-board}"
BOARD_TOOL_DIR="$BOARD_REPO_ROOT/tools/board"

LOG_DIR="$HOME/.local/state/check-comfyui-regime"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/check.log"

{
  echo "=== run $(date -Is) ==="
  npm --prefix "$BOARD_TOOL_DIR" run check:comfyui-regime
  status=$?
  echo "=== run $(date -Is) done (exit $status) ==="
} >> "$LOG" 2>&1

exit "$status"
