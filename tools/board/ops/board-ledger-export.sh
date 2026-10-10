#!/usr/bin/env bash
# Scheduled wrapper for `npm run export:ledger:scheduled` (tools/board/ops/exportApprovalLedgerScheduled.js,
# T-0434): re-runs the existing, unchanged tools/board/scripts/exportApprovalLedger.js (with
# BOARD_TASK_STORE=db, the live board's own mode) against the live board's
# task store and, following the "refresh-before-it-bites" policy
# (src/lib/approvalLedgerScheduleDecision.js), commits + pushes a refreshed
# tools/board/approval-ledger.json to `develop` whenever the exported cards changed OR the
# committed ledger is already older than BOARD_LEDGER_REFRESH_THRESHOLD_HOURS (default 12h, well
# under the CI gate's own BOARD_APPROVAL_LEDGER_STALE_HOURS of 24h).
#
# This fixes the incident class that blocked PR #440 (ledger 46h old) and PR #439 (62.9h old) on
# two consecutive days (2026-10-07/08): nothing previously regenerated the ledger ON `develop`
# except a human remembering to, or a PASS landing on some OTHER card's branch
# (approvalLedgerRegen.js, which only ever writes into that card's own worktree and skips the
# write when the cards are unchanged -- correct for its own purpose, but it cannot refresh
# `generated_at` on `develop` during a quiet week).
#
# Deliberately does NOT redirect stdout/stderr into the log file below -- systemd (Type=oneshot)
# captures a unit's own stdout/stderr into the journal automatically, so leaving it alone is what
# makes `journalctl --user -u board-ledger-export.service` show the run. The script itself
# additionally writes `$BOARD_LEDGER_EXPORT_LOG_DIR/latest.log` (default
# ~/.local/state/board-ledger-export) plus a one-line-per-run `history.log` in the same directory.
#
# Exit codes (named constants in ops/exportApprovalLedgerScheduled.js):
#   0 (EXIT_CODE_OK)            -- a clean commit+push, OR a deliberate skip: wrong branch, a
#                                   dirty working tree outside the ledger file, local develop not
#                                   in sync with origin/develop, or the ledger is still fresh.
#                                   None of these are failures; a systemd unit that only ever
#                                   skips should stay green, the same posture
#                                   board-vet-and-ready.sh takes for an all-skipped dry run.
#   1 (EXIT_CODE_EXPORT_FAILED) -- the exporter subprocess itself failed (commonly: the task
#                                   store/DB was unreachable) or produced an empty/invalid ledger.
#                                   Never writes over the real committed file.
#   2 (EXIT_CODE_GIT_FAILED)    -- a git operation this job needed failed: the fetch, or -- after
#                                   a commit already landed locally -- the push (e.g. a race
#                                   against a human push in the gap between the sync check and
#                                   this job's own push; the commit stays local and the next run's
#                                   sync check will keep skipping until a human resolves it).
set -uo pipefail

LOCKFILE="/tmp/board-ledger-export.lock"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "$(date -Is) already running, skipping"; exit 0; }

BOARD_REPO_ROOT="${BOARD_REPO_ROOT:-$HOME/dev/assembled-board}"
BOARD_TOOL_DIR="$BOARD_REPO_ROOT/tools/board"

npm --prefix "$BOARD_TOOL_DIR" run export:ledger:scheduled
exit $?
