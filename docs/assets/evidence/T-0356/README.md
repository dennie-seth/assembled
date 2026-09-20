## Finding

**Stop and report -- the pre-registered alternative outcome, and this is a decisive result. All 4
attempts are spent; no compliant six-panel master sheet was produced, and the pattern across all
4 attempts is unambiguous enough to call.** Panels 1, 2, and 5 (front T-pose, back T-pose,
side-neutral) reproduced T-0351 attempt 19's clean result on most seeds, confirming "reuse the
recipe unchanged" holds (`attempt_1_panel1_front_tpose.png`, `attempt_1_panel2_back_tpose.png`,
`attempt_1_panel5_side_neutral.png`, `attempt_2_panel1_front_tpose.png`,
`attempt_2_panel2_back_tpose.png`, `attempt_2_panel5_side_neutral.png`), though not perfectly
seed-invariant -- attempt 3's side_neutral (`attempt_3_panel5_side_neutral.png`) drifted to a
non-flat, shadowed background. Panel 6 (legs) achieved its acceptance goal at least once --
`attempt_1_panel6_legs_clean.png` shows fully unobstructed thighs and lower legs with no coat
flap, the specific regression this card exists to fix -- but the fix is not stable across seeds:
`attempt_2_panel6_legs_REGRESSED.png` shows the coat draping back over the hips, and
`attempt_3_panel6_legs.png`/`attempt_4_panel6_legs.png` unobstruct the thighs but drift toward an
armor-plated trouser material and a holstered prop respectively.

**Panels 3 and 4 (side_left_forward / side_right_forward), the panels this card exists to fix by
conditioning on the forward-limb reference (`assets/src/concept/player_profile_forward_limb_reference_controlnet.png`),
never converged across all 4 attempts -- and failed in a different way on every single attempt:**

- Attempt 1: `attempt_1_panel3_side_left_forward_MALFORMED.png` -- warped/melted geometry, no
  legible limb extension. `attempt_1_panel4_side_right_forward_MALFORMED.png` -- two-tone
  green/white cape (coat-identity drift), blank-void head (no eye lenses).
- Attempt 2: `attempt_2_panel3_side_left_forward_MALFORMED.png` -- held weapon-shaped object
  (explicitly banned), coat drifted to grey. `attempt_2_panel4_side_right_forward_MALFORMED.png`
  -- near leg lifted into a mid-kick/running stride (explicitly banned).
- Attempt 3: `attempt_3_panel3_side_left_forward_MALFORMED.png` -- background text/glyphs
  (explicitly banned), trailing leg hidden, unusual mask-grille identity drift.
  `attempt_3_panel4_side_right_forward_MALFORMED.png` -- mid-kick stride again, dramatic non-flat
  background with a visible cast shadow (explicitly banned).
- Attempt 4: `attempt_4_panel3_side_left_forward_MALFORMED.png` -- a second ghost/overlapping
  figure behind the main one (explicitly banned), coat-identity drift to white/grey.
  `attempt_4_panel4_side_right_forward_MALFORMED.png` -- a visible human face (explicitly banned;
  every other panel's mask requirement is violated), arm raised rather than extended forward.

**Conclusion:** the forward-limb reference conditioning this card's hypothesis rests on does not
reliably steer either side panel toward "single-figure true side view, near arm and near leg
extended, matched identity, flat background" -- across 4 seeds it produced 8 distinct and
unrelated failure modes (malformed geometry, coat-color drift x2, held weapon, blank-void head,
mid-kick stride x2, background text, hidden limb, mask-identity drift, ghost/second figure,
visible face), never converging on a common near-miss to iterate from. Per the card's own "do not
tune weights to rescue a panel" rule, no prompt weight was changed between attempts -- only the
base seed varied, which is the only lever this pre-registered experiment was scoped to test.
**The finding: the forward-limb reference itself is likely insufficient, not merely
under-weighted** -- per its own T-0394 promotion commit, `player_profile_forward_limb_reference_controlnet.png`
depicts a *resting leg* with only a single forward *arm*, not the forward-leg geometry panels 3/4
need to condition on. A future card should source or generate a reference that actually shows a
forward-extended leg before re-attempting this recipe. Panel 6's fix is also not yet seed-stable
and would benefit from the same scrutiny. No further attempts remain under this card's cap of 4.

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

### Attempt 3 -- seed 519384726

Same recipe again, byte-identical prompts/weights, third seed only. Full provenance:
`attempt_3_provenance.json`. Composited sheet: `attempt_3_master_sheet.png`.

Per-panel result:

- **Panel 1 (front T-pose)** -- `attempt_3_panel1_front_tpose.png` -- clean (not pictured in
  detail above; T-pose and single figure held).
- **Panel 2 (back T-pose)** -- `attempt_3_panel2_back_tpose.png` -- clean.
- **Panel 3 (side, left-forward)** -- `attempt_3_panel3_side_left_forward_MALFORMED.png` --
  **non-compliant, a third distinct failure mode**: legible single green-coated figure, but
  gibberish text/glyphs render in the background (the negative prompt explicitly bans
  text/watermark), the extended arm/leg relationship is unclear (only one boot is visible, the
  trailing leg is hidden under the floor-length coat), and the mask/head design shows an unusual
  speaker-grille-like detail not seen on any other clean panel (identity drift).
- **Panel 4 (side, right-forward)** -- `attempt_3_panel4_side_right_forward_MALFORMED.png` --
  **non-compliant, a third distinct failure mode**: arm extends forward correctly, but the near
  leg lifts and bends backward into a running/kicking stride (the same banned "kicking, mid-kick,
  running" failure attempt 2's side_right_forward showed), and the background is a dramatic
  green-glow vignette with a visible cast shadow -- violating "flat uniform neutral grey
  background, flat even lighting, no cast shadow, no perspective", which every clean panel on
  every prior attempt has held.
- **Panel 5 (side, neutral)** -- `attempt_3_panel5_side_neutral.png` -- **partially regressed**:
  the pose itself is a true profile, but the background is a moody blue-grey gradient with a
  visible cast shadow, not the flat neutral grey every attempt 1/2 side_neutral render held --
  the "reuse the recipe unchanged" panels are not fully seed-invariant either.
- **Panel 6 (legs)** -- `attempt_3_panel6_legs.png` -- **ambiguous**: thighs and lower legs are
  unobstructed by any coat (the panel's core requirement is met), but the trouser material renders
  with a plated/segmented look closer to the negative prompt's banned "armor plating" than cloth
  trousers -- a new failure mode distinct from attempt 2's coat-drape regression.

Three attempts in, panels 3 and 4 have failed in three entirely distinct ways each
(malformed/blob geometry + held-fabric confusion; held weapon + grey-coat drift + mid-kick;
background text glyphs + hidden trailing leg vs. mid-kick + dramatic non-flat background) with
zero convergence toward "single-figure true side view, near arm and near leg extended, matched
identity, flat background" on any of the three seeds tried. No prompt weight was tuned at any
point -- only the base seed varied, per the card's own "do not tune weights to rescue a panel"
rule. This is the same qualitative outcome T-0351 reported after 21 attempts under the
predecessor architecture: forward-limb reference conditioning does not reliably converge for this
character/pose combination regardless of which single seed is drawn.

### Attempt 4 -- seed 802463951 (final, card cap)

Same recipe again, byte-identical prompts/weights, fourth and final seed under this card's
`ATTEMPT_CAP_BY_CARD["T-0356"] = 4`. Full provenance: `attempt_4_provenance.json`. Composited
sheet: `attempt_4_master_sheet.png`.

Per-panel result:

- **Panel 1 (front T-pose)** -- `attempt_4_panel1_front_tpose.png` -- clean-ish: T-pose held,
  single figure, green coat, though the head shows dark sunglasses-like eye markings rather than
  the blank/hooded mask other clean attempts show (minor identity variant).
- **Panel 2 (back T-pose)** -- `attempt_4_panel2_back_tpose.png` -- clean.
- **Panel 3 (side, left-forward)** -- `attempt_4_panel3_side_left_forward_MALFORMED.png` --
  **non-compliant, a fourth distinct failure mode**: a second green-cloaked shape appears behind
  the main white/grey-robed figure -- exactly the "ghost figure ... second figure behind,
  overlapping figures" the negative prompt explicitly bans -- and the coat has drifted to a
  white/grey robe rather than institutional green. No legible limb extension either.
- **Panel 4 (side, right-forward)** -- `attempt_4_panel4_side_right_forward_MALFORMED.png` --
  **non-compliant, a fourth distinct failure mode**: a visible human face (eye and mouth clearly
  rendered) -- a direct violation of the hooded-mask/no-visible-face requirement every other
  panel is judged against -- and the arm raises up and out rather than extending forward; the
  background is solid black, not flat grey.
- **Panel 5 (side, neutral)** -- `attempt_4_panel5_side_neutral.png` -- clean.
- **Panel 6 (legs)** -- `attempt_4_panel6_legs.png` -- unobstructed thighs and lower legs (core
  requirement met), cargo-style trousers, though a holstered tool/prop hangs from the belt, a
  minor prop-adjacent identity detail not seen on attempt 1's cleanest result.

Fourth and final attempt: panels 3 and 4 fail a fourth time, in two more failure modes never seen
before (ghost/second-figure overlap; visible human face) -- eight total distinct failure modes
across 4 attempts on 2 panels, with no near-miss common enough to suggest one more seed would
converge. This concludes the card's attempt budget.
