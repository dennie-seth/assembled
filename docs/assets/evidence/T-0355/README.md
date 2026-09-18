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
- **Attempt 4** (`attempt_4_main_1024.png`, final attempt under the hard cap), seed 52091 (same
  seed as attempt 3, identity clause added). Reuses attempt 3's winning pose/framing verbatim
  and adds the canonical hooded-mask/eye-lens clause, white gloves, and boots, plus
  negative-prompt terms against bare head/hands/feet and against two visible eye lenses or
  two visible arms (a three-quarter-view tell). Identity now renders correctly -- hooded mask,
  gloves, boots, coat length all present and correct -- but close-up crops show it did not fix
  strict-profile framing: `attempt_4_head_crop.png` shows both eye-slits of the mask visible
  (not one), and `attempt_4_far_arm_crop.png` shows a second gloved fist genuinely visible
  behind the torso at hip height (not hidden, as the "far arm hidden behind the body" clause
  asked for). The body's hips/legs/boots read as genuinely side-on, but the upper body twists
  toward three-quarter. **Not promoted.**

## Outcome: stop-and-report (pre-registered alternative, hard cap reached)

All 4 attempts under the card's hard cap are spent. None produced a reference passing the
acceptance criterion "genuinely side-facing -- a single visible arm silhouette and a single
visible goggle lens." Attempt 4 is the closest result -- correct pose, correct coat length,
correct identity (mask/gloves/boots) -- but its upper body shows two arms and two eye lenses,
a three-quarter twist rather than a strict profile. Full reasoning and a per-attempt breakdown
is in `assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_ATTEMPT_LOG_T0355.md`'s own "Outcome"
section. No 5th attempt was run and nothing is promoted to
`assets/src/concept/player_profile_forward_limb_reference_T0355.png` -- per the card's own
"grinding past 4 attempts is not [a valid outcome]," this stop, with evidence, is the
deliverable. `tests/test_forward_limb_reference_gate_T0355.py` remains RED by design.
