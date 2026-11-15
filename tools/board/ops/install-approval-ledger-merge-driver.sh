#!/usr/bin/env bash
# Installs the local git merge driver for tools/board/approval-ledger.json (T-0464).
#
# Git merge drivers cannot be fully defined from a committed file: .gitattributes can only name a
# driver ("merge=approval-ledger"), the driver's actual command has to live in git config, which
# is never committed. Run this once per clone to wire the two together -- a worktree shares its
# parent checkout's .git directory (and therefore its config), so one run covers every worktree of
# the same clone too.
#
# Usage: tools/board/ops/install-approval-ledger-merge-driver.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
DRIVER_SCRIPT="$REPO_ROOT/tools/board/scripts/mergeApprovalLedgerDriver.js"

git config merge.approval-ledger.name "Regeneration-aware merge for tools/board/approval-ledger.json (T-0464)"
git config merge.approval-ledger.driver "node \"$DRIVER_SCRIPT\" %O %A %B"

echo "Installed git merge driver 'approval-ledger' -> $DRIVER_SCRIPT"
