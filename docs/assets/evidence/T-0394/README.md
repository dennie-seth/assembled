# T-0394 evidence -- resting-leg skeleton + head-masked detail pass

## Proposed finding (for the card's own Finding section)

Decisive falsification of this card's pre-registered hypothesis, within the 3-attempt cap: holding
the full-frame pose pass at denoise 0.87 on the resting-leg skeleton, and producing the goggle lens
via a head-masked second pass instead of a skeleton or prompt move, did not produce a strict-profile
forward-limb green reference passing every acceptance check -- and the attempt sequence surfaced a
decisive, previously-unmeasured trade-off this card's own hypothesis did not anticipate: the
full-frame composite's `frame_scale` (the headroom fix for the solid-black-background requirement)
and the single-arm result trade against each other in a dose-dependent way, at the exact same seed
that has produced a clean single arm at `frame_scale=1.0` in every prior sighting across this whole
line (T-0382 attempt 1, T-0387 attempts 2-3, this card's own attempt 1).

Both of this card's two structural changes worked in isolation. The resting leg
(`pose_rig_forward_limb_controlnet_T0394`, near knee/ankle sourced verbatim from
`pose_rig_master_sheet_T0351.SIDE_NEUTRAL_KEYPOINTS_NORM`) produced a clean, flat, single resting
leg in every one of the 3 attempts (`attempt_1_main_1024.png`, `attempt_2_main_1024.png`,
`attempt_3_legs_resting_crop.png`) -- the leg is confirmed solved, exactly as this card's own source
material predicted. And the single-arm result held at `frame_scale=1.0` (attempt 1) and was
partially recovered at `frame_scale=0.95` (attempt 3, `attempt_3_torso_no_second_hand_crop.png`
shows the extended arm with no second hand), so the far-arm collapse
(`pose_rig_forward_limb_controlnet_T0380`) also continued to hold across every attempt -- no attempt
in this card ever showed a second hand or glove.

What did not resolve within the 3-attempt cap is the interaction between the two remaining
acceptance checks this card's own hypothesis bet on being independent levers: the border/background
fix and the goggle lens. Attempt 1 (`frame_scale=1.0`, the untouched baseline) measured border max
channel 124, far over the 16 ceiling -- the hood apex rendered only ~14px from the canvas top edge
(`attempt_1_top_border_violation_crop.png`), confirming the border defect is real and structural at
denoise 0.87, not attempt-specific noise. Attempt 2 (`frame_scale=0.88`) fixed the border decisively
(max channel 4) but lost the near-arm extension entirely (`attempt_2_torso_no_arm_extension_crop.png`
shows both arms down at rest, and the pose pass's own pre-detail-pass output already shows this,
ruling out the detail pass as the cause). Attempt 3 (`frame_scale=0.95`, a deliberately gentler
value chosen specifically to preserve more of the untouched baseline's geometry) partially recovered
the arm but only partially recovered the border fix too: max channel 67, worse than attempt 2's 4,
better than attempt 1's 124 -- consistent with a real, monotonic, dose-dependent trade-off between
`frame_scale` and the single-arm result at this seed, not two independent defects each fixable on
its own lever.

The goggle lens also never became legible across all 3 attempts, regardless of the detail pass's own
denoise (0.55 in attempt 1, 0.35 in attempts 2-3): attempt 1 and attempt 3 both show the
head-masked detail pass redesigning the hood into an ornate, multi-faceted armour-plate helmet
(`attempt_1_head_mecha_helmet_crop.png`, `attempt_3_head_mecha_helmet_crop.png`) rather than
clarifying a single circular lens on the pose pass's own hood silhouette, and attempt 3 in
particular shows no lens-like highlight at all. Attempt 2's head crop
(`attempt_2_head_crop.png`) is the closest of the three -- a clean, legible pale mask shape is
visible -- but it reads as a stylised full mask/face, not "a single dark round goggle lens," so it
does not clear this card's own specific acceptance wording either. Across three attempts at two
different detail-pass denoise values, the mechanism did not reliably produce a legible single
circular lens on demand.

No image produced by any of the three attempts passes every acceptance check simultaneously. Per
this card's own pre-registered alternative outcome, this is a valid PASS: stop and report, not spend
a fourth attempt. No reference is promoted --
`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` does not exist on this
branch.

## Status: FALSIFIED, stop-and-report at the 3-attempt cap (the pre-registered alternative outcome)

## Attempt 1 (seed 380002, pose denoise 0.87, detail denoise 0.55, frame_scale 1.0, ControlNet strength/end 1.5/1.0): FAIL

Full frame: `attempt_1_main_1024.png`.

- Single visible arm and hand: **pass** -- one extended near arm, no second hand/glove visible at
  the hip or anywhere else in frame (`attempt_1_torso_no_second_hand_crop.png`).
- Resting near leg: **pass** -- no raise, no lifted hem; the leg reads as a clean, flat single
  leg in profile.
- Faces right: **pass**.
- Solid black background: **FAIL** -- measured border max channel 124 against the 16 ceiling. The
  violating pixel sits in the top border band, 14px from the canvas edge: the hood apex rendered
  well above the T-0317 base image's own headroom at the required denoise 0.87
  (`attempt_1_top_border_violation_crop.png`).
- Goggle lens: **FAIL (ambiguous, over-designed)** -- the head-masked detail pass at denoise 0.55
  redesigned the hood into an ornate multi-faceted helmet rather than clarifying a single legible
  lens on the pose pass's own hood silhouette (`attempt_1_head_mecha_helmet_crop.png`). A
  greenish/teal highlight is visible on the near side but is not a clean, legible circular lens,
  and the added geometric detail reads as a stylistic departure from the "Soviet brutalist hood"
  identity, not a texture refinement of it.
- Green band (centred 187x200 crop): 17,099 px, above the 6,000 floor.

Fix applied for attempt 2: a uniform `frame_scale` (see
`gen_player_profile_forward_limb_reference_T0394.scale_keypoints_about_center`) shrinks the whole
composite (base image + skeleton) about the canvas centre, buying headroom on every side without
touching any relative pose or proportion, to address the border violation. The detail-pass denoise
is lowered from 0.55 toward the pose pass's own hood shape (still a value distinct from and
independent of the 0.87 full-frame floor, per this card's own "that is not lowering denoise;
lowering the full-frame pass is") to keep the sampler closer to the already-correct hood silhouette
while sharpening the existing highlight into a legible lens, rather than re-designing the whole
head.

## Attempt 2 (seed 380002, pose denoise 0.87, detail denoise 0.35, frame_scale 0.88, ControlNet strength/end 1.5/1.0): FAIL

Full frame: `attempt_2_main_1024.png`. Both fixes landed cleanly: border max channel measured 4
(against the 16 ceiling, down from attempt 1's 124), and green band cleared the floor at 9,538 px
(centred crop). But the pose pass itself (`attempt_2_torso_no_arm_extension_crop.png`) lost the
near-arm extension entirely -- the same seed and the same near-arm prompt clause that produced a
clean single extended arm at `frame_scale=1.0` (attempt 1, and every prior attempt across
T-0382/T-0387 that got a clean arm) rendered both arms held down at rest under `frame_scale=0.88`.
This is not a detail-pass side effect: `composite_head_detail`'s own mask is scoped to the head
bounding box only and cannot touch pixels at the torso/arm, and the pose pass's own
`pose_pass_1024.png` (before the detail pass ever runs) already shows the arm down. The regression
is attributable to the frame-scale change alone.
- Goggle lens: **FAIL (ambiguous, not a lens)** -- `attempt_2_head_crop.png` is the cleanest head
  render of the three attempts, a legible pale mask/face shape, but it reads as a stylised full
  mask, not "a single dark round goggle lens" this card's own acceptance text requires.

Since ComfyUI sampling is deterministic given an unchanged seed, re-running this exact
seed/scale/denoise combination would reproduce the identical broken arm, not fix it. Attempt 3
holds the border fix's mechanism (`frame_scale`) but uses a much gentler value (0.95 instead of
0.88) -- enough remaining headroom margin to keep the border fix's benefit while disturbing the
ControlNet-conditioned figure's absolute scale far less, on the reasoning that a smaller
perturbation from the known-good `frame_scale=1.0` geometry is less likely to destabilise the
already-fragile single-arm result than a large one. This is this card's third and final
pre-registered attempt.

## Attempt 3 (seed 380002, pose denoise 0.87, detail denoise 0.35, frame_scale 0.95, ControlNet strength/end 1.5/1.0): FAIL

Full frame: `attempt_3_main_1024.png`.

- Single visible arm and hand: **pass** -- the near arm is extended and visible again
  (`attempt_3_torso_no_second_hand_crop.png` shows no second hand/glove anywhere in the torso/hip
  region), confirming the gentler `frame_scale` at least partially recovers the arm attempt 2 lost.
- Resting near leg: **pass** -- `attempt_3_legs_resting_crop.png` shows both feet together at rest,
  no raise.
- Faces right: **pass**.
- Solid black background: **FAIL** -- measured border max channel 67 against the 16 ceiling
  (`attempt_3_top_border_violation_crop.png`). Better than attempt 1's 124, worse than attempt 2's
  4 -- the dose-dependent trade-off this attempt was designed to probe.
- Goggle lens: **FAIL** -- `attempt_3_head_mecha_helmet_crop.png` shows the same over-designed,
  multi-faceted armour-plate hood as attempt 1, with no legible lens or highlight at all this time.
- Green band (centred 187x200 crop): 11,822 px, above the 6,000 floor.

This is the 3rd and final attempt under this card's pre-registered hard cap. No image produced by
any of the three attempts passes every acceptance check.

## Deliverable

None. Per this card's own pre-registered alternative outcome ("if 3 attempts produce no image
passing every check ... stop and report ... that is a valid PASS; a fourth attempt is not"), no
reference is promoted. `assets/src/concept/player_profile_forward_limb_reference_controlnet.png`
and its provenance sidecar do not exist on this branch.

Full per-attempt weights and measurements are in
`assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0394.md`. The skeleton
rendered per attempt (`pose_rig_forward_limb_controlnet_T0394`, resting near leg, far arm collapsed,
scaled about the canvas centre by that attempt's own `frame_scale`) is committed at
`assets/src/concept/player_profile_forward_limb_skeleton_T0394.png` with keypoints at
`assets/src/concept/player_profile_forward_limb_skeleton_T0394.json` -- the file is overwritten per
attempt (same convention as T-0380/T-0382/T-0387's own skeleton files), with each attempt's own
sha256 recorded in the attempt log above. The head mask used by each attempt's detail pass is
committed per attempt: `assets/src/concept/player_profile_forward_limb_head_mask_T0394_attempt_1.png`,
`..._attempt_2.png`, `..._attempt_3.png`.

This is for @DennieSeth's design approval of the finding itself -- not promoted to `assets/final/`,
not wired into T-0356, no other views batched, per this card's own "Do not" list. A follow-up card
would need either a new attempt budget or a different lever than `frame_scale` for the border fix --
e.g. a border-only post-process that never touches the sampled content (not attempted here, since a
pixel-level border clamp would clip the hood's own silhouette rather than fix the composition), or a
different base-image headroom baked in ahead of compositing -- and a different mechanism than a
masked img2img re-sample for the lens, since three attempts across two denoise values (0.55, 0.35)
never reliably produced a legible single circular lens on demand.
