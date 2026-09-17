# T-0355 evidence -- forward-limb green side reference

Full attempt log: `assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_ATTEMPT_LOG_T0355.md`.
Hard cap: 4 attempts total.

- **Attempt 1** (2026-09-11, prior session): "reference sheet"-framed prompt, forward-limb
  pose clause + explicit past-the-knee coat constraint, seed 31700. Not promoted (centred-crop
  green px 826, far below the 6,000-6,900 band). Output not preserved -- it lived only under
  the gitignored `assets/out/` and this session's own untracked attempt log, neither of which
  survives a fresh worktree; the row above is backfilled from the card's own recorded notes.
- **Attempt 2** (`attempt_2_main_1024.png`, this evidence dir), seed 84213, same recipe as
  attempt 1. Confirms the failure mechanism: the model renders a 3-panel front/side/back
  turnaround despite the "one reference panel" clause -- the same layout drift T-0317's own
  generator hit -- but every panel (main front figure, side and back thumbnails) holds a
  neutral standing pose. The forward-limb pose clause was entirely ignored across all three
  panels; low centred-crop green px reflects the small, off-centre side thumbnail, not a
  coat-colour failure. Not promoted.

- **Attempt 3** (`attempt_3_main_1024.png`), seed 52091, reworked prompt that drops
  "reference sheet"/"concept sheet" framing (the trigger for the neutral multi-view
  convention) in favour of a single dynamic action-pose illustration, with negative-prompt
  terms added against turnaround/sheet/swatch layouts. This worked: single isolated figure,
  genuine side-on mid-stride pose, near arm and near leg both clearly extended forward at
  roughly the requested angle, no multi-panel drift, coat correctly full-length past the
  knee. Centred-crop green px 26,617, comfortably clearing the 6,000-6,900 benchmark band.
  Not promoted because the identity is wrong: no hooded mask / eye lenses (the card's own
  acceptance criterion needs "a single visible goggle lens"), bare green head/hands/feet
  instead of the canonical hooded mask + white gloves + boots (`gen_master_sheet_T0336.py`'s
  own `build_single_pose_positive_prompt` head clause) -- this generator's prompt had never
  carried that clause at all, on any attempt.
- **Attempt 4** (final attempt under the hard cap): reuses attempt 3's winning pose/framing
  verbatim and adds the canonical hooded-mask/eye-lens clause, white gloves, and boots, plus
  negative-prompt terms against bare head/hands/feet and against two visible eye lenses or
  two visible arms (a three-quarter-view tell). See the attempt log for the outcome.
