# Asset-run evidence promotion (T-0314)

## The problem this closes

An asset card's decisive visual evidence — the attempt renders that justify
a promotion or a finding — lives under gitignored `assets/out/` scratch
inside the card's own worktree. Once the card settles, the worktree is
reaped and that scratch goes with it. T-0272 lost round 3's best frames
this way on 2026-09-06: attempts 13-15 produced the round's most legible
side profiles, and none of them exist anywhere reviewable today.

T-0272's round 4 fixed this by hand for one card, committing a curated
subset to `docs/assets/evidence/T-0272/` with a captioning README. This
document generalizes that into a mechanism — `promoteEvidence()`
(`tools/board/src/lib/evidencePromotion.js`, CLI wrapper
`tools/board/scripts/promoteEvidence.js`) — so it happens by running one
command, not by an agent remembering to `cp` files.

## The citation convention

`promoteEvidence` does not parse prose. Its entire selection rule is:

> **A frame is "decisive" iff the round's own attempt log cites it via an
> inline-code span containing its path relative to the run directory** —
> e.g. `` `attempt_14/main_384.png` `` or, for a conditioning input that
> sits at the top of the run directory rather than inside an
> `attempt_<N>/` folder, `` `pose_skeleton_384.png` ``.

This is mechanical and bounded by construction: only what the log already
names as significant gets promoted, nothing more. It runs identically
whether the round's outcome is a **promotion** or a **finding** — a
"Not promoted" verdict that names the frame proving why is exactly the
T-0272 case this exists for, and the tool does not distinguish the two.

Asset/audio agents cite decisive frames this way as a matter of course —
see `.claude/rules/assets.md`'s attempt-log conventions. A log that
narrates a verdict in prose without naming the file in this shape simply
promotes nothing for that verdict; the fix is to cite it, not to make the
tool guess.

## What gets promoted, and what doesn't

- **Selection is per-round, not per-card.** Each invocation takes one
  `runDir` (a round's own gitignored output directory) and one attempt-log
  path, and promotes only what that specific log cites out of that specific
  run directory.
- **Bounded by `maxFiles` (default 20) and `maxFileBytes` (default 200KB).**
  Measured against T-0272's own 35 hand-curated evidence files: 76.6KB
  average, 131KB max, comfortably under the default cap. A citation over
  the byte cap is skipped and reported (`skippedTooLarge`), not silently
  downscaled — this tool adds no image-processing dependency to
  `tools/board`. If a round's decisive frame is legitimately large (a raw
  upscaled render, a multi-frame animation sheet), downscale or crop it
  *before* citing it in the log, the same way a human curator would; there
  is no automatic resize path.
- **A citation whose file does not exist is reported (`skippedMissing`),
  never fatal.** Covers a run that crashed before generating anything, a
  typo in the log, or a file already cleaned up — the run this is called
  from must never fail because of it.
- **Never touches `assets/final/**`.** This mechanism is entirely about
  gitignored `assets/out/` scratch; an already-promoted deliverable's own
  commit path is completely unaffected.
- **Idempotent and non-clobbering.** Re-running against byte-identical
  content is a no-op. If a later round's run directory happens to reuse the
  same cited relative path with *different* content, the new frame lands
  beside the original under a numbered suffix (`attempt_1_main_384.png`,
  `attempt_1_main_384__2.png`, ...) rather than overwriting it — no
  earlier round's evidence is ever lost to a later one.

## Repo growth

Per-round bound: at most `maxFiles * maxFileBytes` = 20 × 200KB = 4MB in
the worst case; in practice, far less — T-0272's entire 6-round, 35-file
history (the largest evidence set in the repo as of this writing) totals
2.68MB. A card with an unusually large legitimate evidence need (a video or
animation sheet, an especially high-resolution reference) should say so
explicitly and pass `--max-file-bytes`/`--max-files` deliberately rather
than having the default caps silently reject what it needs — the defaults
are a safety rail against accidentally committing whole `assets/out/`
trees, not a hard ceiling on every card.

## Not a replacement for anything

- **Board attachments still matter.** This is additive — see
  `.claude/rules/assets.md`'s attachment bullet. A human browsing the card
  sees attachments; a human reviewing the PR sees this path. Both exist
  because they serve different readers.
- **The artifact-preservation cache (`tools/board/src/runner/
  artifactPreservation.js`) still matters.** It preserves *resumable* state
  (LoRA checkpoints, training corpora) across a worktree reclaim so a
  re-run doesn't restart from scratch. It is per-worktree-set and invisible
  to a PR reviewer — it does not, and was never meant to, put anything in
  front of a human. This mechanism is for evidence that must be *reviewable*,
  not merely *resumable*.
