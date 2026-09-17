# T-0380 evidence -- forward-limb reference via ControlNet/OpenPose img2img

## Proposed finding (for the card's own Finding section)

Decisive confirmation of the pose-follows-the-skeleton hypothesis: conditioning img2img on an
OpenPose ControlNet skeleton, rather than prompt wording, produced a strict-profile forward-limb
green reference passing every acceptance check on attempt 2 of the 4-attempt cap, committed as
`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` with provenance at
`assets/src/concept/player_profile_forward_limb_reference_controlnet.provenance.json`. Attempt 1
(`docs/assets/evidence/T-0380/attempt_1_main_1024.png`) proved the skeleton reliably drives strict
profile framing and single-arm/single-lens silhouette on the very first try, but at denoise 0.78
the base image's own straight coat silhouette survived unchanged and concealed the raised leg
entirely (`docs/assets/evidence/T-0380/attempt_1_torso_leg_crop_no_leg_visible.png`); raising
denoise to 0.87 and adding a coat-drape prompt clause for attempt 2 resolved it decisively
(`docs/assets/evidence/T-0380/attempt_2_raised_leg_crop.png`).

## Status: PASS, attempt 2 of a 4-attempt cap

T-0355's stop-and-report decisively falsified the prompt-only route for this exact pose (near
arm + near leg extended ~90 degrees, strict profile): even its best attempt (4), which got coat
and identity right, twisted to three-quarter once the pose clause competed with the identity
clause for the same attention budget (both eye lenses and the far fist visible). This card's
structural bet -- pose imposed by an OpenPose ControlNet skeleton, img2img from T-0317's own
green side profile, rather than prompt wording alone -- held on attempt 2, well inside the
4-attempt cap.

## Attempt 1 (seed 380001, denoise 0.78, ControlNet strength/end 1.4/1.0): FAIL

Strict profile, single visible arm, single visible goggle lens, and a solid black background all
came out correctly on the first try -- the ControlNet skeleton reliably drives the strict-profile
pose and the single-arm/single-lens silhouette, exactly as intended. But denoise 0.78 kept too
much of the base image's own straight, floor-length coat silhouette unchanged: the raised near
leg is completely invisible under a coat that hangs exactly as it does when the figure is
standing still. See `attempt_1_main_1024.png` and the decisive crop
`attempt_1_torso_leg_crop_no_leg_visible.png` -- flat, unbroken vertical coat folds, no bulge, no
lifted hem, no boot. This fails the acceptance check "front leg raised ~90 degrees at the hip in
the generated figure ... shown in a committed crop": no crop can show a leg pose that was never
drawn.

Fix applied for attempt 2: raised denoise to 0.87 (more of the frame is genuinely resampled
against the skeleton, rather than inherited from the base) and added an explicit prompt clause
describing the coat's own drape reacting to the raised leg ("the coat hem swept up and forward by
the forward motion of the raised knee, a visible boot beneath the lifted hem"), plus sharpened the
goggle-lens and glove wording. See the generator's own git history for the exact prompt diff
between attempts.

## Attempt 2 (seed 380002, denoise 0.87, ControlNet strength/end 1.5/1.0): PASS

All acceptance checks hold. Full frame: `attempt_2_main_1024.png`.

- **Strict profile, single visible arm silhouette and single visible goggle lens**:
  `attempt_2_head_single_lens_crop.png` shows one large, unambiguous round goggle lens on the
  hood and no second eye/lens anywhere; `attempt_2_single_arm_glove_crop.png` shows exactly one
  arm, extended forward, with a visible gloved hand -- no second arm or fist visible anywhere in
  the full frame.
- **Faces right**, same direction as the T-0317 base (visible in the full frame: the extended arm
  and raised leg both reach toward the right edge of the canvas).
- **Solid black background**: measured border-band max channel is **4** (16px border, all four
  edges), well under the 16 ceiling -- see
  `player_profile_forward_limb_reference_controlnet.provenance.json`'s own `border_max_channel`
  field.
- **Front leg raised ~90 degrees at the hip, not a lunge**: `attempt_2_raised_leg_crop.png` shows
  the near foot clearly lifted clear of the ground, forward of the body, with the coat hem swept
  up around it -- a raised/kicking gesture, not a lunge (the foot is airborne, not planted forward
  on the ground). The coat conceals the exact hip-to-knee line (as the "coat reaching past the
  knee" identity requirement itself implies it must), so the thigh angle is not independently
  visible in the rendered pixels; the skeleton that drove this pose has its own committed,
  independently tested `thigh_angle_degrees_from_horizontal` of ~5.2 degrees (see
  `assets/src/concept/player_profile_forward_limb_skeleton_T0380.json` and
  `assets/src/concept/tests/test_pose_rig_forward_limb_controlnet_T0380.py::
  test_near_thigh_is_within_20_degrees_of_horizontal`), which is what the ControlNet conditioning
  actually asked the sampler to reproduce.
- **Identity present**: hood and mask fully cover the head with a single visible goggle lens
  (`attempt_2_head_single_lens_crop.png`); a gloved hand is visible on the extended arm
  (`attempt_2_single_arm_glove_crop.png` -- rendered in a coat-matching green rather than the
  prompt's requested pale grey, a colour miss but the glove itself, as a garment, is clearly
  present); both boots are visible, one on the raised near foot and one on the planted far/support
  foot (`attempt_2_raised_leg_crop.png`); the coat reaches well past the knee (to roughly mid-shin)
  in every frame region.
- **Green band**: centred 187x200 crop measures **13,180** green pixels (whole-frame: 70,230),
  comfortably above the 6,000 floor -- see the provenance sidecar's own `green_content` field.
  (Above the 6,000-6,900 calibration band's upper end, same as T-0355's own attempts 3-4, which
  the card's own acceptance text names as an accepted outcome: "T-0355's review applied the band
  as a floor.")

## Deliverable

Promoted to `assets/src/concept/player_profile_forward_limb_reference_controlnet.png` with
provenance at
`assets/src/concept/player_profile_forward_limb_reference_controlnet.provenance.json`. Full
per-attempt weights and measurements are in
`assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0380.md`. The authored
skeleton (reused verbatim from the committed T-0351 `side_right_forward` rig) is committed at
`assets/src/concept/player_profile_forward_limb_skeleton_T0380.png` with its keypoints at
`assets/src/concept/player_profile_forward_limb_skeleton_T0380.json`.

This is for @DennieSeth's design approval -- not promoted to `assets/final/`, not wired into
T-0356, no other views batched, per this card's own "Do not" list.
