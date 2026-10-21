# `tools/board/approval-ledger.json` merge driver (T-0464)

## What it does

`tools/board/approval-ledger.json` is a generated snapshot of the board's approval record
(`tools/board/scripts/exportApprovalLedger.js`), regenerated on every reviewer PASS
(`src/runner/approvalLedgerRegen.js`) and on a 4h schedule
(`ops/board-ledger-export.sh` / `ops/exportApprovalLedgerScheduled.js`). Because it is regenerated
rather than hand-edited, both sides of nearly every merge touch it, and git's default 3-way text
merge treats every one of those as a content conflict — even though the right answer is almost
always "keep every card id from both sides, and never let `generated_at` go backwards."

A `.gitattributes` entry routes this one path through a custom git merge driver named
`approval-ledger`:

```
tools/board/approval-ledger.json merge=approval-ledger
```

The driver itself is `tools/board/scripts/mergeApprovalLedgerDriver.js`, a thin CLI wrapper around
the pure, unit-tested merge function in `tools/board/src/lib/approvalLedgerMerge.js`. It:

- Unions `cards` by `id` — a card present on only one side is kept as-is; a card present on both
  sides is merged field-by-field against the common ancestor (a real 3-way merge per field), so
  one side adding a new card and the other flipping an existing card's `requires_approval` both
  survive in the result.
- Sets the merged `generated_at` to whichever side's timestamp is later, so the result is never
  older than either input — the one property `checkApprovalProvenanceDrift.js`'s staleness gate
  actually depends on.
- Refuses (reports a conflict, same as the default text merge it replaces) rather than guessing
  whenever it can't resolve something with certainty: unparseable/truncated JSON on either side, a
  missing or non-array `cards` field, a suspiciously empty `cards` array on either side, or the
  same field on the same card changed to two different values by both sides with no way to tell
  which one is "right." A silently-wrong merge of the file CI treats as authoritative for
  unresolvable card ids is worse than a conflict a human resolves by hand.

## Why the ledger needs this

`checkApprovalProvenanceDrift.js` reads this file as a fail-closed CI gate (it resolves card ids
the live task store can't, and fails if the ledger is older than
`BOARD_APPROVAL_LEDGER_STALE_HOURS`). A naive merge strategy can break that gate in exactly the
ways this driver is built to avoid: dropping a card record (manufacturing
`unverifiable-approval-claim`), moving `generated_at` backwards (manufacturing staleness), or
emitting text that isn't valid JSON. See the T-0464 card for the incident history — a single
scheduled ledger refresh landing on `develop` put four open branches into a conflicted state at
once, every one of them hand-resolved as "take the generated copy."

## Installing on a fresh clone

Git merge drivers can't be fully defined in a committed file — `.gitattributes` can only name a
driver (`merge=approval-ledger`); the driver's actual command has to live in git config, which is
never committed. Run the installer once per clone:

```sh
tools/board/ops/install-approval-ledger-merge-driver.sh
```

This sets `merge.approval-ledger.driver` in the local repo's git config to invoke
`mergeApprovalLedgerDriver.js` by absolute path. It's idempotent — running it again just
overwrites the same config value, never duplicates it. A worktree shares its parent checkout's
`.git` directory (and therefore its config), so one run of the installer covers every worktree of
the same clone.

**Without running the installer**, the `.gitattributes` entry has no driver to invoke, and git
silently falls back to its default text merge for this file — which conflicts on it exactly as
before this card, never silently produces a wrong result. This degraded path is intentional: see
`tools/board/test/approvalLedgerMergeDriver.e2e.test.js`'s "still reports a conflict... when the
local merge-driver config was never installed" case.
