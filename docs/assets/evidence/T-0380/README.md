# T-0380 evidence -- forward-limb reference via ControlNet/OpenPose img2img

## Proposed finding (for the card's own Finding section)

Decisive falsification of this card's pre-registered hypothesis, within the 4-attempt cap: no
attempt produced a strict-profile forward-limb green reference passing every acceptance check.
Attempt 1 (`docs/assets/evidence/T-0380/attempt_1_main_1024.png`) got profile, single-arm/single-
lens silhouette and background right but concealed the raised leg entirely under an unmoved coat
(`docs/assets/evidence/T-0380/attempt_1_torso_leg_crop_no_leg_visible.png`). Attempt 2
(`docs/assets/evidence/T-0380/attempt_2_main_1024.png`) was initially misread as a full pass and
briefly promoted, but decisive re-inspection found a second, unrequested gloved hand clearly
visible at the hip (`docs/assets/evidence/T-0380/attempt_2_second_hand_at_hip_crop.png`) -- the
same "far fist visible" defect that already falsified T-0355's prompt-only route, now reproduced
under the skeleton-driven route too, via the far arm's elbow/wrist (reused verbatim from T-0351's
`side_right_forward` rig) still projecting past the torso in a single strict-profile frame. Attempt
3 was invalidated by an implementation bug (`render_skeleton()` silently discarded the far-arm-
collapse fix -- see `assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0380.md`
attempt 3's row) rather than testing the hypothesis at all. Attempt 4
(`docs/assets/evidence/T-0380/attempt_4_main_1024.png`), the first real test of the corrected
(far-arm-collapsed) skeleton, produced a total sampler collapse bearing no resemblance to the
requested figure, on a non-black background
(`docs/assets/evidence/T-0380/attempt_4_black_background_corner_crop.png`, measured border max
channel 166 against the 16 ceiling). Per this card's own pre-registered alternative outcome, this
is a valid PASS: stop and report, not grind past the cap. The earlier incorrect promotion
(`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` and its provenance
sidecar) has been reverted -- no compliant reference exists to promote.

## Status: FALSIFIED, stop-and-report at the 4-attempt cap (the pre-registered alternative outcome)

T-0355's stop-and-report decisively falsified the prompt-only route for this exact pose (near
arm + near leg extended ~90 degrees, strict profile): even its best attempt (4), which got coat
and identity right, twisted to three-quarter once the pose clause competed with the identity
clause for the same attention budget (both eye lenses and the far fist visible). This card's
structural bet -- pose imposed by an OpenPose ControlNet skeleton, img2img from T-0317's own
green side profile, rather than prompt wording alone -- got closer (attempts 1-2 nailed profile,
orientation, background and, in attempt 1, silhouette) but never cleared every acceptance check
inside the 4-attempt cap. The single-visible-arm requirement in particular proved decisive: the
same far-arm-visible defect that falsified the prompt-only route reappeared under the skeleton-
driven route in attempt 2, and the structural fix for it (collapsing the far arm onto the far
shoulder) was only tested once, in attempt 4, where an unrelated total sampler collapse pre-empted
any read on whether the fix itself would have worked.

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

## Attempt 2 (seed 380002, denoise 0.87, ControlNet strength/end 1.5/1.0): FAIL (revised)

Initially misread and briefly promoted as a full pass. Decisive re-inspection reversed that: full
frame `attempt_2_main_1024.png`.

- **Faces right**, correct: extended arm and raised leg both reach toward the right edge of the
  canvas.
- **Solid black background**: measured border-band max channel is **4** (16px border, all four
  edges), well under the 16 ceiling.
- **Front leg raised, not a lunge**: `attempt_2_raised_leg_crop.png` shows the near foot clearly
  lifted clear of the ground, forward of the body, coat hem swept up around it. The coat conceals
  the exact hip-to-knee line, so the thigh angle is not independently verifiable from the rendered
  pixels; the skeleton that drove this pose has its own committed `thigh_angle_degrees_from_horizontal`
  of ~5.2 degrees, which is what the ControlNet conditioning asked the sampler to reproduce, but
  the requirement that this be "shown in a committed crop" of the *generated figure* -- not merely
  asserted from the input skeleton -- is not actually satisfiable from this attempt's pixels.
- **Green band**: centred 187x200 crop measures **13,180** green pixels, above the 6,000 floor.
- **Identity mostly present**: hood/mask/single-lens, boots, and coat-past-knee all visible; the
  glove is rendered in a coat-matching green rather than the requested pale grey (a colour miss).
- **FAILS "a single visible arm silhouette"**: `attempt_2_second_hand_at_hip_crop.png` shows a
  second, clearly rendered gloved hand -- fingers visible, distinct silhouette -- resting at the
  hip, separate from the extended near arm's own hand. This is the exact "far fist visible" defect
  T-0355's stop-and-report already falsified the prompt-only route over, now reproduced under the
  skeleton-driven route: the far arm's elbow/wrist, reused verbatim from T-0351's
  `side_right_forward` rig ("held back close to the body," tuned for a multi-panel walk-cycle
  sheet), still projects far enough past the torso in a single strict-profile frame to read as a
  second hand rather than staying hidden.

Fix applied for the next real test (attempt 4, after an intervening bug -- see below): collapse
the far elbow/wrist keypoints onto the far shoulder in this card's own skeleton (a zero-length
limb, occluded), the same "collapsed onto the view axis" principle the rig already applies to the
shoulders/hips in a true profile.

## Attempt 3 (seed 380003, denoise 0.87, ControlNet strength/end 1.5/1.0): INVALIDATED (tooling bug, not a real test)

Intended to test the far-arm-collapse fix above. Instead, `render_skeleton()` still delegated to
`pose_rig_master_sheet_T0351.render_pose_skeleton`, which re-derives keypoints straight from
T-0351's own module and silently discarded this card's collapse override -- the ControlNet
skeleton actually uploaded for this attempt was byte-identical to attempt 2's un-collapsed one
(confirmed: the committed skeleton PNG did not change between attempts 2 and 3, only its keypoints
JSON sidecar did). Combined with a newly strengthened prompt/negative-prompt, the sampler produced
an unrelated failure mode: pale/blue costume (not green), no forward-limb extension at all, a
detached floating green artifact, border max channel 40. See `attempt_3_main_1024.png`. This
attempt is logged per this card's own rule that every attempt is recorded whether promoted or not,
but does not count as evidence about the far-arm-collapse hypothesis either way.

Fixed before attempt 4: `render_skeleton()` now draws this module's own `keypoints()` directly via
`gen_arm_a_idle_T0228.draw_pose_skeleton_cell`, pinned by a new bit-for-bit regression test. Local
re-render confirmed the far arm visibly collapses to a point at the far shoulder.

## Attempt 4 (seed 380004, denoise 0.87, ControlNet strength/end 1.5/1.0): FAIL (4th and final attempt)

The first real test of the far-arm-collapsed skeleton, with the render_skeleton bug fixed. Result:
total sampler collapse. The image (`attempt_4_main_1024.png`) bears no resemblance to the
requested figure at all -- a close-up abstraction resembling guitar tuning-peg hardware against a
dark, textured background, no coat, no pose, no green figure. The background also fails outright:
measured border max channel **166** against the 16 ceiling, visibly non-black (see the decisive
corner crop `attempt_4_black_background_corner_crop.png` -- grey haze and scattered green flecks,
not solid black). Whole-frame green pixel count (60,279) and even the centred-crop count (6,293,
inside the 6,000-6,900 band) are artifacts of the hallucinated content, not a green costumed
figure, and are not meaningful measurements of this card's actual subject.

This is the 4th and final attempt under this card's pre-registered hard cap. No image produced by
any of the four attempts passes every acceptance check.

## Deliverable

None. Per this card's own pre-registered alternative outcome ("if 4 attempts produce no image that
passes every check above, stop and report with committed evidence ... that is a valid PASS;
grinding past 4 is not"), no reference is promoted. The earlier promotion of attempt 2's image to
`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` (plus its provenance
sidecar) was made in error, before the second-hand defect was caught, and has been reverted in this
same branch's history.

Full per-attempt weights and measurements are in
`assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0380.md`. The authored
skeleton (T-0351's `side_right_forward` rig, with the far arm collapsed onto the far shoulder for
this card -- see `assets/src/concept/pose_rig_forward_limb_controlnet_T0380.py`) is committed at
`assets/src/concept/player_profile_forward_limb_skeleton_T0380.png` with its keypoints at
`assets/src/concept/player_profile_forward_limb_skeleton_T0380.json`.

This is for @DennieSeth's design approval of the finding itself -- not promoted to `assets/final/`,
not wired into T-0356, no other views batched, per this card's own "Do not" list. A follow-up card
would need either a new attempt budget or a different structural approach (e.g. inpainting a mask
over the far-hip region instead of relying on the ControlNet joint alone) to actually clear the
single-visible-arm check the skeleton-collapse fix was designed for but never got a clean test of.
