## Finding

(No claims until the run concludes -- either a compliant sheet is promoted, or all 4 attempts are
spent and this section is replaced with a decisive per-panel finding.)

## Attempts

### Attempt 1 -- seed 246813579

Recipe: panels 1/2/5/6 reuse T-0351 attempt 19's builders byte-identical (see
`test_resolve_pose_prompts_reuses_t0351_recipe_unchanged_for_solved_panels`). Panels 3/4
(`side_left_forward`/`side_right_forward`) condition on
`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` (the T-0394-promoted
forward-limb reference) instead of the old T-0317 neutral profile. Panel 6 negative prompt carries
the new coat-flap/hem/drape ban terms.

Full provenance: `attempt_1_provenance.json`. Composited sheet: `attempt_1_master_sheet.png`.

Per-panel result:

- **Panel 1 (front T-pose)** -- `attempt_1_panel1_front_tpose.png` -- **clean**: genuine T-pose,
  single figure, canonical long green coat, arms held straight out clear of the torso.
- **Panel 2 (back T-pose)** -- `attempt_1_panel2_back_tpose.png` -- **clean**: real back-of-hood
  view, no front-facing mask, single figure, T-pose held.
- **Panel 3 (side, left-forward)** -- `attempt_1_panel3_side_left_forward_MALFORMED.png` --
  **non-compliant**: the figure is warped/melted rather than a coherent single-figure profile --
  no clearly extended near-arm or near-leg, an ambiguous cloth/limb shape reads as the figure
  gripping its own coat rather than reaching forward, and the silhouette does not resolve to a
  legible side profile at all.
- **Panel 4 (side, right-forward)** -- `attempt_1_panel4_side_right_forward_MALFORMED.png` --
  **non-compliant**: single figure and a true side profile, and the right arm does extend forward,
  but the coat renders as a two-tone green/white cape (not the solid institutional green coat every
  other panel holds), the near leg shows no clear forward extension, and the head is a blank void
  with no visible eye lenses (violates the hooded-mask-with-visible-lenses requirement every other
  panel meets).
- **Panel 5 (side, neutral)** -- `attempt_1_panel5_side_neutral.png` -- **clean**: true 90-degree
  side profile, arms down, legs together, reproduced again as in T-0351 attempts 19/20/21.
- **Panel 6 (legs)** -- `attempt_1_panel6_legs_clean.png` -- **clean, and this is new**: both
  thighs and lower legs are fully unobstructed by any coat, cloak, or drape -- trousers and boots
  only, exactly the panel's purpose. The coat-flap regression T-0351 attempt 19 showed is fixed.

4/6 panels compliant. Panels 3 and 4 remain non-compliant -- same failure family as T-0351's own
21 attempts (never-compliant forward-limb side panels), even against the new dedicated reference.
The forward-limb reference is itself a resting/neutral-leg profile with (per its own T-0394
promotion commit) only a single forward *arm*, not a forward leg -- see
`assets/src/concept/player_profile_forward_limb_reference_controlnet.png`. No prompt weights were
changed for this attempt; recipe is exactly what the branch head (`7ba10cb`) already carries.

### Attempt 2 -- seed 837291046

Same recipe as attempt 1, byte-identical prompts/weights -- only the base seed changed, to test
whether panels 3/4's non-compliance is seed-sensitive rather than a structural conditioning
problem. Full provenance: `attempt_2_provenance.json`. Composited sheet:
`attempt_2_master_sheet.png`.

Per-panel result:

- **Panel 1 (front T-pose)** -- `attempt_2_panel1_front_tpose.png` -- **clean**: T-pose held,
  single figure, green coat (open, inner white layer visible, but still a single coherent
  institutional-green-coated figure).
- **Panel 2 (back T-pose)** -- `attempt_2_panel2_back_tpose.png` -- **clean**: back-of-hood view
  held, single figure.
- **Panel 3 (side, left-forward)** -- `attempt_2_panel3_side_left_forward_MALFORMED.png` --
  **non-compliant, different failure mode from attempt 1**: single figure and a legible side
  silhouette this time, but the extended arm now holds a gun-shaped object (the negative prompt
  explicitly bans held objects/weapons and it appears anyway), the coat has drifted to grey rather
  than institutional green (identity drift), and the trailing leg's pose is ambiguous rather than a
  clear held-back stance.
- **Panel 4 (side, right-forward)** -- `attempt_2_panel4_side_right_forward_MALFORMED.png` --
  **non-compliant, different failure mode from attempt 1**: single figure, true side profile, right
  arm does extend forward this time, coat colour holds green -- but the near leg is lifted and
  bent backward into what reads as a mid-kick/running stride (exactly what the negative prompt's
  "kicking, mid-kick, running" clause exists to prevent), not "extended forward", and the coat
  shortens to mid-thigh rather than past-the-knee.
- **Panel 5 (side, neutral)** -- `attempt_2_panel5_side_neutral.png` -- **clean**: true profile
  held again, third consecutive card/attempt series it converges cleanly.
- **Panel 6 (legs)** -- `attempt_2_panel6_legs_REGRESSED.png` -- **regressed from attempt 1**: the
  coat is visible again, draping to the hip with short shorts underneath rather than the
  trousers-only, fully-unobstructed-thigh result attempt 1 achieved; a face/hair also renders in
  frame, which the panel's own crop is supposed to exclude. Same recipe, same weights as attempt 1
  -- this is seed variance on an unstable panel, not a prompt regression.

2/6 panels compliant this attempt (down from 4/6 in attempt 1) -- panels 3 and 4 fail again, in
two more distinct ways (held weapon + identity drift vs. kicking-pose + coat-length drift), and
panel 6 shows the recipe is not yet reliably stable across seeds even where it converged once.
This is consistent with T-0351's own attempts 19-21: the forward-limb panels do not converge
under this architecture regardless of which specific failure mode a given seed produces, and nor
is the legs panel's fix seed-independent yet. No prompt weights changed between attempt 1 and 2.
