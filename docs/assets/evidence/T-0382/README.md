# T-0382 evidence -- forward-limb reference re-run on the corrected skeleton

## Proposed finding (for the card's own Finding section)

Decisive falsification of this card's pre-registered hypothesis, within the 3-attempt cap: no
attempt produced a strict-profile forward-limb green reference passing every acceptance check.
Attempt 1 (`docs/assets/evidence/T-0382/attempt_1_main_1024.png`, seed 380002, denoise 0.87 --
T-0380 attempt 2's recipe verbatim against the corrected far-arm-collapsed skeleton) rendered a
back/three-quarter view with no visible goggle lens
(`docs/assets/evidence/T-0382/attempt_1_head_no_lens_crop.png`) and both boots planted on the
ground under an unmoved coat, no raised leg
(`docs/assets/evidence/T-0382/attempt_1_legs_not_raised_crop.png`); border max channel measured
45, also over the 16 ceiling. Attempt 2 (`docs/assets/evidence/T-0382/attempt_2_main_1024.png`,
seed 382002, only the seed varied) was worse, not better: a near-total sampler collapse into an
abstract green/grid shape bearing no resemblance to the requested figure, the same failure mode
T-0380's own attempt 4 hit on its first real test of this same far-arm-collapsed skeleton; border
max channel measured 22
(`docs/assets/evidence/T-0382/attempt_2_non_black_corner_crop.png`), also over the 16 ceiling.
Attempt 3 (`docs/assets/evidence/T-0382/attempt_3_main_1024.png`, seed reverted to 380002, denoise
lowered 0.87 -> 0.80, the single parameter varied) fixed profile-facing-right, background (border
max channel 4, measured on the full frame
`docs/assets/evidence/T-0382/attempt_3_main_1024.png`) and landed the centred green-crop count
at 7,411, above the required 6,000 floor -- but at the cost of the pose extension
itself: neither the near arm nor the near leg break the coat's silhouette at all
(`docs/assets/evidence/T-0382/attempt_3_torso_no_arm_crop.png` shows an unbroken coat column with
no arm silhouette anywhere; `docs/assets/evidence/T-0382/attempt_3_hem_no_raised_leg_crop.png`
shows both feet together at rest, no lifted hem, no boot clear of the ground). The single visible
goggle lens is also not clearly legible in attempt 3's head crop -- a dark strap-like shape across
the face reads more like a visor line than a round lens.

Across all three attempts, denoise traded one failure for another: 0.87 let the sampler diverge
far enough from the base image to draw the requested arm extension (attempt 1) but also let it
drift off the correct facing direction, lose the goggle lens, and (combined with a different seed
in attempt 2) collapse outright; 0.80 anchored the output back to the base's correct profile,
identity and background but anchored it so closely that the base's own resting-arm, resting-leg
silhouette survived untouched, and the ControlNet skeleton's forward-limb signal never broke the
coat's silhouette. Per this card's own pre-registered alternative outcome, this is a valid PASS:
stop and report, not grind past the cap. No reference is promoted --
`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` does not exist on this
branch.

## Status: FALSIFIED, stop-and-report at the 3-attempt cap (the pre-registered alternative outcome)

## Attempt 1 (seed 380002, denoise 0.87, ControlNet strength/end 1.5/1.0): FAIL

T-0380 attempt 2's recipe verbatim, run against the corrected (far-arm-collapsed) skeleton for the
first time under this card. Full frame: `attempt_1_main_1024.png`.

- Faces right: **FAIL** -- the figure reads as a back/three-quarter view, not a strict right-facing
  profile.
- Single visible goggle lens: **FAIL** -- `attempt_1_head_no_lens_crop.png` shows a fully wrapped,
  blank hood; no lens, no face.
- Near leg visibly raised: **FAIL** -- `attempt_1_legs_not_raised_crop.png` shows both boots flat
  on the ground under an undisturbed coat hem.
- Solid black background: **FAIL** -- measured border max channel 45 against the 16 ceiling.
- Single visible arm and hand: pass by inspection -- one extended arm/hand is visible, no second
  hand anywhere in frame.
- Green band (centred 187x200 crop): 20,434 px, above the 6,000 floor.

## Attempt 2 (seed 382002, denoise 0.87, ControlNet strength/end 1.5/1.0): FAIL

Single parameter varied from attempt 1: seed only (382002), per this card's own "vary one thing at
a time (seed first)" instruction. Full frame: `attempt_2_main_1024.png`.

- Result is a near-total sampler collapse: an abstract dark-green shape crossed by a light grid,
  no recognizable figure, no head, no limbs, no coat silhouette. This is the same failure mode
  T-0380's own attempt 4 hit on its first real test of the identical far-arm-collapsed skeleton
  (`docs/assets/evidence/T-0380/README.md`'s attempt 4 section: "total sampler collapse...bears no
  resemblance to the requested figure").
- Solid black background: **FAIL** -- measured border max channel 22 against the 16 ceiling
  (`attempt_2_non_black_corner_crop.png`).
- Green band (centred 187x200 crop): 19,157 px, above the 6,000 floor, but meaningless as a
  measurement of the requested figure -- it is measuring the abstract collapse artifact, not a
  green costumed figure (same caveat T-0380's attempt 4 recorded for its own green counts).
- Every other check: not assessable -- there is no figure to check for facing direction, lens,
  raised leg, or identity elements.

Reverting the seed change for attempt 3 (back to 380002) and varying denoise instead was chosen
over a third untested seed, since seed-only variation had now been tried once with a clearly worse
result, and attempt 1's own failures (facing direction, lens, background) were plausibly explained
by too much sampler freedom at denoise 0.87 diverging from the base's own correct profile.

## Attempt 3 (seed 380002, denoise 0.80, ControlNet strength/end 1.5/1.0): FAIL

Single parameter varied from attempt 1: denoise only (0.87 -> 0.80), seed reverted to attempt 1's
380002. Full frame: `attempt_3_main_1024.png`.

- Faces right: pass -- strict right-facing profile.
- Solid black background: pass -- border max channel 4 against the 16 ceiling, measured on the
  full frame `attempt_3_main_1024.png`.
- Green band (centred 187x200 crop): 7,411 px, above the required 6,000 floor.
- Identity present (hood, mask, long coat past the knee): pass by inspection.
- Single visible goggle lens: **FAIL** (marginal) -- `attempt_3_head_lens_crop.png` shows a dark
  strap-like band across the face rather than a legible round lens.
- Single visible arm and hand: **FAIL** -- `attempt_3_torso_no_arm_crop.png` shows an unbroken
  coat column from shoulder to hem; no arm silhouette, no glove, no hand anywhere in frame. The
  near arm the skeleton specifies extended to the right never breaks the coat's outline.
- Near leg visibly raised: **FAIL** -- `attempt_3_hem_no_raised_leg_crop.png` shows both feet
  together at rest, coat hem undisturbed, no lifted hem, no boot clear of the ground.

This is the 3rd and final attempt under this card's pre-registered hard cap. No image produced by
any of the three attempts passes every acceptance check.

## Deliverable

None. Per this card's own pre-registered alternative outcome ("if 3 attempts produce no image
passing every check ... stop and report ... that is a valid PASS; a fourth attempt is not"), no
reference is promoted. `assets/src/concept/player_profile_forward_limb_reference_controlnet.png`
and its provenance sidecar do not exist on this branch.

Full per-attempt weights and measurements are in
`assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0382.md`. The authored
skeleton (T-0380's `pose_rig_forward_limb_controlnet_T0380`, far arm collapsed onto the far
shoulder) is committed at `assets/src/concept/player_profile_forward_limb_skeleton_T0380.png` with
keypoints at `assets/src/concept/player_profile_forward_limb_skeleton_T0380.json`; every attempt
this card ran uploaded that same skeleton (sha256
`13ce712c626657738881cd6f43cc681ecb0fb01e1e5a942181337af40d31ae10`), which already differs from
T-0380 attempts 1-2's un-collapsed skeleton (sha256
`1fe2df9f771633291ea68298e48e37c23630c3353daeb333704b0439ed728069`).

This is for @DennieSeth's design approval of the finding itself -- not promoted to `assets/final/`,
not wired into T-0356, no other views batched, per this card's own "Do not" list. A follow-up card
would need either a new attempt budget or a different structural approach -- e.g. a two-stage
generation (denoise 0.87 for pose extension, then a lower-denoise touch-up pass constrained to the
head/background regions only) or inpainting the arm/leg region directly -- rather than one single
denoise value trying to satisfy both "correct global identity/orientation" and "correct pose
extension" at once.
