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

`promoteEvidence` does not parse arbitrary prose. Its selection rule is:
**a frame is "decisive" iff the round's own attempt log cites it via an
inline-code span**, in one of two shapes:

- **Path-relative to the run directory** — e.g. `` `attempt_14/main_384.png` ``
  or, for a conditioning input that sits at the top of the run directory
  rather than inside an `attempt_<N>/` folder, `` `pose_skeleton_384.png` ``.
  Always unambiguous; prefer this shape when convenient.
- **A bare filename** — e.g. `` `main_384.png` `` — the shape T-0272's own
  real attempt log actually uses throughout (verified directly against
  `assets/src/character/ARM_PROFILE_ATTEMPT_LOG_T0272.md`; the tool
  recovers attempt 1/8/31/39/41's cited frames from that log's real text).
  Resolved against whichever attempt names it: a markdown table row's own
  leading attempt-number cell, or the nearest "attempt N" mention in the
  **same sentence** of surrounding prose (paragraphs are reconstituted
  across hard-wrapped source lines first, so line-wrapping alone never
  breaks the pairing). A bare filename with no attempt number anywhere in
  its own sentence is promoted from the top of the run directory directly,
  never guessed at — see `parseCitedEvidencePaths` in
  `tools/board/src/lib/evidencePromotion.js` for the exact rule and its
  test coverage against both a synthetic log and the real T-0272 one.

This is mechanical and bounded by construction: only what the log already
names as significant gets promoted, nothing more. It runs identically
whether the round's outcome is a **promotion** or a **finding** — a
"Not promoted" verdict that names the frame proving why is exactly the
T-0272 case this exists for, and the tool does not distinguish the two.

**This is automatic — no agent has to run the CLI, or remember to.**
`runOrchestrator.js`'s `_handlePass` (the step that runs once a card's
reviewer verdict comes back PASS) calls `promoteEvidenceForCard()` — the
`repoRoot`/`cardId`-only entry point in `evidencePromotion.js` — from
inside the card's own worktree, immediately before it commits and pushes
that worktree's branch and well before it removes the worktree. That call
discovers the card's own attempt log(s) and run directory candidate(s)
itself (`discoverEvidenceSources`: every `ARM_*_ATTEMPT_LOG_<card>.md`
anywhere under `assets/src/`, and every top-level directory under
`assets/out/`), so nothing about invoking it depends on `.claude/**`
wiring, an agent grant, or an agent remembering a step — the same
`git add -A` that stages the round's own commit picks up whatever landed
under `docs/assets/evidence/<card>/` along the way. It is a no-op, at
negligible cost, for the overwhelming majority of cards that never touch
`assets/**` at all: discovery finds neither an attempt log nor an
`assets/out/` tree and returns immediately.

**The citation convention above is still not written into
`.claude/rules/assets.md` or the `assets`/`audio` agent definitions.**
That remains a documentation gap, not an automation gap — an agent
writing a log in a shape this parser doesn't recognize (e.g. a citation
with no attempt-number context anywhere nearby) still gets it promoted
under the wrong name or not at all, even though the promotion step itself
now runs unconditionally. Landing that bullet is still worth doing as a
follow-up so a round's own author writes citations the parser resolves
correctly on the first try, but it is no longer what stands between a
round finishing and its evidence being committed.

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
