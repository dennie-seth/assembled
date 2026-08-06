#!/usr/bin/env bash
set -euo pipefail

# assembled-board deploy: syncs this checkout with origin/develop and restarts the systemd
# user service that runs it -- safely. Two real outages are why this script exists instead
# of a plain `git pull && systemctl restart`:
#
#   1. The service runs the dev server under `node --watch`. Merging code into the working
#      tree while the service is UP makes `node --watch` auto-relaunch mid-merge -- this
#      really happened: it reset a live card, then crashed on a conflict-markered file mid-
#      resolution, taking the board down 20+ minutes. Fix: the service is STOPPED before the
#      working tree is touched, every time, no exceptions -- see the "stop" step below.
#   2. The board commits its own runtime data (attachments, card status writes) straight to
#      `develop` locally and never used to push it, so `develop` steadily diverged from
#      origin and a plain `git pull --ff-only` broke on every deploy. Fix: `fetch` + `merge
#      --no-ff` instead of `pull --ff-only` (this script), and the board now auto-pushes its
#      own runtime commits (see src/runner/autoPush.js) so the divergence mostly shouldn't
#      happen in the first place -- this script's merge step is the backstop for whatever
#      still slips through (a stretch where auto-push was disabled, origin briefly
#      unreachable, etc).
#
# Idempotent: re-running this with nothing new to pull, or right after a successful deploy,
# is a normal no-op path (merge is a no-op, npm install is skipped, health check passes).
# Safe to abort: every failure branch below either restarts the service on the last known-
# good tree, or explains exactly why it didn't and what to do next -- never silently leaves
# the board down with no explanation.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BOARD_DIR="$REPO_ROOT/tools/board"
SERVICE_NAME="assembled-board.service"
BRANCH="develop"
HEALTH_URL="http://127.0.0.1:${BOARD_PORT:-4173}/api/tasks"
HEALTH_RETRIES="${DEPLOY_HEALTH_RETRIES:-10}"
HEALTH_RETRY_DELAY="${DEPLOY_HEALTH_RETRY_DELAY:-2}"

log() { echo "[deploy] $*"; }
die() {
  echo "[deploy] ERROR: $*" >&2
  exit 1
}

# Used by the failure branches below once the service has actually been stopped, to restart
# it on the tree as it stands (last known-good) instead of leaving the board down.
restart_on_failure_and_die() {
  log "restarting $SERVICE_NAME on the current tree so the board doesn't stay down..."
  if systemctl --user start "$SERVICE_NAME"; then
    log "restarted."
  else
    log "WARNING: restart-on-failure itself failed -- the board is down. Manual fix: systemctl --user start $SERVICE_NAME"
  fi
  die "$1"
}

log "repo root: $REPO_ROOT"

log "checking for a live card run (pgrep -af claude + tasks/.runs/*.jsonl recency)..."
if ! node "$BOARD_DIR/scripts/checkLiveRun.js" "$REPO_ROOT"; then
  die "refusing to deploy while a card run looks live (see message above). Retry once it finishes."
fi

log "stopping $SERVICE_NAME -- this MUST happen before the working tree is touched, or node --watch can auto-relaunch mid-merge"
if ! systemctl --user stop "$SERVICE_NAME"; then
  die "systemctl --user stop $SERVICE_NAME failed -- refusing to touch the working tree while the service's state is unknown. Check: systemctl --user status $SERVICE_NAME"
fi

BEFORE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

log "fetching origin/$BRANCH..."
if ! git -C "$REPO_ROOT" fetch origin "$BRANCH"; then
  restart_on_failure_and_die "fetch of origin/$BRANCH failed (network/auth?). Working tree is untouched."
fi

log "merging origin/$BRANCH with --no-ff (develop carries the board's own local runtime commits, so this is deliberately never a bare fast-forward)..."
if ! git -C "$REPO_ROOT" merge --no-ff --no-edit "origin/$BRANCH"; then
  log "merge conflicted -- aborting the merge so no conflict markers are left on disk"
  git -C "$REPO_ROOT" merge --abort || log "WARNING: 'git merge --abort' itself failed; inspect $REPO_ROOT's git status by hand"
  restart_on_failure_and_die "merge of origin/$BRANCH conflicted. Resolve manually (or find out why local/origin diverged that badly), then re-run. Tree was rolled back to its pre-merge state."
fi

AFTER_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

PKG_CHANGED=0
if [[ "$BEFORE_SHA" != "$AFTER_SHA" ]] &&
  git -C "$REPO_ROOT" diff --name-only "$BEFORE_SHA" "$AFTER_SHA" -- tools/board/package.json | grep -q .; then
  PKG_CHANGED=1
fi

if [[ "$PKG_CHANGED" -eq 1 ]]; then
  log "tools/board/package.json changed ($BEFORE_SHA -> $AFTER_SHA) -- running npm install"
  if ! (cd "$BOARD_DIR" && npm install); then
    die "npm install failed after merging new code. NOT auto-restarting the service -- dependencies may be inconsistent. Inspect $BOARD_DIR by hand, then run 'systemctl --user start $SERVICE_NAME' once it's fixed."
  fi
else
  log "tools/board/package.json unchanged -- skipping npm install"
fi

log "starting $SERVICE_NAME..."
if ! systemctl --user start "$SERVICE_NAME"; then
  die "systemctl --user start $SERVICE_NAME failed. Check: systemctl --user status $SERVICE_NAME / journalctl --user -u $SERVICE_NAME -n 100"
fi

log "health-checking $HEALTH_URL..."
attempt=0
until curl -fsS -o /dev/null "$HEALTH_URL" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [[ "$attempt" -ge "$HEALTH_RETRIES" ]]; then
    die "service started but $HEALTH_URL never became healthy after $HEALTH_RETRIES attempts. It's left running (restarting it again wouldn't help) -- check: journalctl --user -u $SERVICE_NAME -n 100"
  fi
  sleep "$HEALTH_RETRY_DELAY"
done

log "deploy complete -- $SERVICE_NAME is up at $AFTER_SHA and healthy."
