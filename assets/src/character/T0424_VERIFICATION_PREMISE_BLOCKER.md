# T-0424 verification premise blocker — stop and report (card's own edge case)

**Status: no production change made.** This card's own acceptance criteria say so
explicitly: *"Before/after `[FAIL]` counts are recorded: 14 before, 2 after. If the
before-count is not 14, stop and report rather than proceeding on a different
baseline than this card assumes."* That is exactly the situation found below, so
this run stops at the design/verification step rather than archiving the six
sheets against a baseline the card does not actually describe.

## What was checked

Ran the card's own verification command, unmodified, on `feature/T-0424` as cut
(branch tip `f7628133`, identical to `origin/develop` — confirmed via
`git merge-base HEAD origin/develop` == `git rev-parse HEAD` == `git rev-parse
origin/develop`, no drift):

```
cd tools/asset-gate && .venv/bin/python -m asset_gate.cli character-gate ../../assets/final --repo-root ../../
```

Result: **0 `[FAIL]` lines, 100% `[PASS]`.** Every character sidecar — including
all six sheets this card targets and `player_walk_sheet_hybrid` itself — passes
today, before any file is moved. `grep -c '^\[FAIL\]'` on the full output is `0`,
not `14`.

Confirmed why: none of the seven relevant provenance sidecars
(`player_crouch_hide_sheet_{v1,v2}`, `player_die_sheet_{v1,v2}`,
`player_move_sheet_{v1,v2}`, `player_walk_sheet_hybrid`) currently has a
`motion_class` key at all on this branch:

```
grep -H "motion_class" assets/final/character/player_{crouch_hide,die,move}_sheet_v{1,2}.provenance.json assets/final/character/player_walk_sheet_hybrid.provenance.json
# (no output — no matches in any of the seven files)
```

All seven are still listed, untouched, in
`tools/asset-gate/src/asset_gate/character_motion_class_baseline.txt`, so
`character_motion_class_declared` exempts them (baseline-exempt, PASS) and
`character_motion_fidelity` / `character_part_identity` / the motion-score-binding
check all report "motion_class=None is not locomotion/transition/loop -- the gate
does not apply" (PASS, not-applicable) rather than FAIL.

## Root cause: the "14" state lives on a different, unmerged branch

`feature/T-0359` (PR #422 — this card's own "Related" section: *"held on the 14
failures"*) is the branch that actually produces the 14-failure state this card's
acceptance assumes as its starting point. On that branch (not merged to
`develop`, not an ancestor of `feature/T-0424`):

- `34c3b58f` / `0362aa55` label `player_walk_sheet_hybrid.provenance.json`
  `motion_class: "locomotion"`.
- `207ad454` ("label the 6 remaining classifiable sidecars, don't leave them
  baselined") sets `motion_class` on exactly this card's six target sidecars
  (`transition` for crouch-hide/die, `locomotion` for move — e.g.
  `player_move_sheet_v2.provenance.json` gets `"motion_class": "locomotion"`,
  confirmed via `git show feature/T-0359:...`) **and removes all seven entries
  from `character_motion_class_baseline.txt`.**

That labeling is what makes `character_motion_fidelity` / `character_part_identity`
actually engage (rather than skip as not-applicable) and FAIL on the six sheets
(measured on merit — the pose-IoU/identity numbers this card's own "Why these six,
on merit" section quotes) and on the walk (the two expected post-archive
failures, `character_motion_fidelity` + `character_motion_score_binding`).
`git diff f7628133..feature/T-0359 --stat -- tools/asset-gate/src/` shows exactly
one file touched, `character_motion_class_baseline.txt` (102 insertions / 24
deletions) — confirming the "14 before" state is produced entirely by that
branch's baseline edit + sidecar relabeling, neither of which exists on
`feature/T-0424` or `develop` today.

`feature/T-0424` was cut from `develop` at `f7628133` (merge of PR #425,
T-0422) — the same commit `origin/develop` is on right now. `feature/T-0359` is
not an ancestor of that commit; it is a sibling branch, still open, not merged.

## Why this wasn't "fixed" by improvising

Two ways to make the numbers match were considered and rejected as out of this
card's scope:

1. **Merge `feature/T-0359` into `feature/T-0424` first.** Rejected: T-0359's
   own diff touches `tools/asset-gate/src/asset_gate/character_motion_class_baseline.txt`
   (shown above), which would make this card's own hard requirement —
   `git diff develop...HEAD -- tools/asset-gate/src/` must be **empty** — fail by
   construction. The two cards' acceptance criteria are only simultaneously
   satisfiable if T-0359 lands on `develop` *first* and T-0424 is cut (or
   rebased) *after*, so T-0424's own diff against that `develop` never touches
   `tools/asset-gate/src/` at all.
2. **Hand-label the six sidecars' `motion_class` fields directly in this card,
   without touching the baseline file.** This would reproduce something close to
   the 14-failure state without touching `tools/asset-gate/src/` (the
   `character_motion_fidelity` / `character_part_identity` checks key off the
   declared `motion_class` value, not off baseline membership). Rejected: that
   labeling judgement call (which prompt text justifies which motion_class) is
   T-0359's own explicit scope and authorship (`207ad454`'s commit message), not
   this card's. Silently redoing another open card's classification work inside
   an unrelated archive-move card would blur authorship and risk disagreeing
   with T-0359's own reasoning without review.

## What this means for sequencing

This card (T-0424) and T-0359/PR #422 are circularly described relative to each
other: T-0424's "Related" section says T-0359 "should hold on the walk's 2 only"
*after* this card lands, implying T-0424 fixes T-0359's blocker — but T-0424's
own verification can only reproduce the 14-before/2-after numbers it asks for
if T-0359's sidecar-labeling + baseline-trim commits are already present in the
branch T-0424 is evaluated against. As written, neither card can go first on its
own branch and still match its own pasted-verbatim verification section.

**Needs a human call**, not an agent improvisation:
- land `feature/T-0359` on `develop` first, then re-cut/rebase `feature/T-0424`
  on top (the six sidecars would already be labeled and failing on merit, and
  archiving them would be a true 14→2 drop with zero `tools/asset-gate/src/`
  diff), or
- explicitly fold T-0359's six-sidecar relabeling commit into this card's scope
  (with the baseline-file edit, accepting that this card's own
  "`tools/asset-gate/src/` diff empty" criterion would then need to be
  reworded), or
- confirm the "14 before" figure in this card was simply measured against
  `feature/T-0359` by mistake and should be corrected to whatever this card's
  actual starting branch shows (0 before, per this run).

No files were moved, no tests were changed, no decision-log entry was written —
this report is the only change in this run, committed per `.claude/rules/assets.md`'s
"a blocked run must be written down before the run ends" convention (extended
here from a GPU-generation blocker to a verification-premise blocker, since the
same rule — don't stop silently — applies).
