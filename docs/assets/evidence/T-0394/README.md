# T-0394 evidence -- resting-leg skeleton + head-masked detail pass

## Status: IN PROGRESS (attempt 1 of 3)

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
