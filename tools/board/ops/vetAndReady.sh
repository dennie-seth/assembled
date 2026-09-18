#!/usr/bin/env bash
# Nightly wrapper for `npm run vet:ready -- --apply` (tools/board/ops/vetAndReady.js, T-0384): the
# WSL-native replacement for the external `nightly-infra-prep` scheduled task, which runs in a
# cloud sandbox with no WSL and so cannot reach this repo checkout or the board API directly.
#
# Deliberately does NOT redirect stdout/stderr into the log file below -- systemd (Type=oneshot)
# captures a unit's own stdout/stderr into the journal automatically, so leaving it alone is what
# makes `journalctl --user -u board-vet-and-ready.service` show the run. The script itself
# (vetAndReady.js) additionally writes its own summary file under BOARD_VET_LOG_DIR
# (~/.local/state/board-vet-and-ready/latest.md by default) -- that's "a file the operator can
# read later" from the card's acceptance criteria, produced by the script's own fs writes, not by
# shell redirection here.
#
# vetAndReady.js's own default is a dry run that writes nothing; --apply here is what turns this
# nightly run into the one that actually PATCHes status: ready on vetted cards.
set -uo pipefail

LOCKFILE="/tmp/board-vet-and-ready.lock"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "$(date -Is) already running, skipping"; exit 0; }

BOARD_REPO_ROOT="${BOARD_REPO_ROOT:-$HOME/dev/assembled-board}"
BOARD_TOOL_DIR="$BOARD_REPO_ROOT/tools/board"

npm --prefix "$BOARD_TOOL_DIR" run vet:ready -- --apply
exit $?
