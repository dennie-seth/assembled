# T-0387 evidence -- forward-limb reference retry, denoise held at 0.87

## Proposed finding (for the card's own Finding section)

Decisive falsification of this card's pre-registered hypothesis, within the 3-attempt cap: holding
denoise at 0.87 and moving only the skeleton and/or the prompt did not produce a strict-profile
forward-limb green reference passing every acceptance check, and the attempt sequence itself
surfaced a new, decisive constraint the pre-registered hypothesis did not anticipate -- the near-leg
raise and the eye-separation fix cannot currently be tried together at this denoise without
reopening the second-hand defect T-0382's own far-arm collapse had already fixed.

Attempt 1 (`docs/assets/evidence/T-0387/attempt_1_main_1024.png`, seed 380002, denoise 0.87,
skeleton with both the near-knee/ankle excursion enlarged and the eye pair separated, prompt
heavily rewritten with `:1.4`-weighted lens/leg clauses plus an added background-reinforcement
clause) broke composition outright: the figure rendered zoomed in far past the frame, the hood
cropped off the top edge entirely (`docs/assets/evidence/T-0387/attempt_1_head_cropped_off_top_crop.png`),
both boots cut off at the bottom edge, still standing together and not raised
(`docs/assets/evidence/T-0387/attempt_1_legs_cropped_not_raised_crop.png`), and the near hand
rendered as a warped, fingerless mitt bleeding toward the frame edge
(`docs/assets/evidence/T-0387/attempt_1_arm_warped_crop.png`). Border max channel measured 202,
far over the 16 ceiling and worse than any of T-0382's own three attempts.

Attempt 2 (`docs/assets/evidence/T-0387/attempt_2_main_1024.png`, same seed and skeleton as attempt
1, prompt reverted to near-verbatim T-0382 wording with only the lens/leg clauses lightly touched)
recovered normal composition -- the whole figure fit in frame again -- but reopened exactly the
defect T-0380/T-0382's far-arm collapse was built to prevent: a second, unrequested gloved hand
hanging at the hip, clearly separate from the single extended arm at the shoulder
(`docs/assets/evidence/T-0387/attempt_2_torso_second_hand_crop.png`). The head still showed no
goggle lens, just a smooth pointed hood (`docs/assets/evidence/T-0387/attempt_2_head_no_lens_crop.png`),
and the legs showed no raise, only an ambiguous striped texture at the shin with both feet
effectively together (`docs/assets/evidence/T-0387/attempt_2_legs_no_raise_crop.png`). Border max
channel measured 118, still far over the 16 ceiling.

Attempt 3 (`docs/assets/evidence/T-0387/attempt_3_main_1024.png`, same seed, near-knee/ankle and
leg prompt clause reverted verbatim to T-0382's own values to isolate the one change least
implicated in attempt 2's regression -- the wider eye separation -- alongside the lightly-touched
lens wording) restored a clean single extended arm at the shoulder, but a second, glove-textured
shape is still visible folded at the near hip, ambiguous but suspicious for the same second-hand
defect (`docs/assets/evidence/T-0387/attempt_3_torso_second_hand_like_crop.png`). The head still
showed no visible lens, only a fully wrapped, featureless hood
(`docs/assets/evidence/T-0387/attempt_3_head_no_lens_crop.png`) -- the eye-separation change alone
did not produce a legible lens. The legs showed both feet planted together on an unrequested
scenery element (a platform/plinth shape neither prompt nor skeleton asked for), no raise at all
(`docs/assets/evidence/T-0387/attempt_3_legs_no_raise_crop.png`). Border max channel measured 146,
again far over the 16 ceiling. Green band (centred 187x200 crop) cleared the 6,000 floor in all
three attempts (19,064 / 18,205 / 22,989 px) -- green content was never the limiting check.

The decisive result across the three attempts: the goggle lens did not become visible in any
attempt, including the one (attempt 3) that isolated the eye-separation change specifically to test
it -- a skeleton joint change to two head keypoints was not sufficient on its own to make a
texture-level feature (a lens set into the hood) legible at this denoise, at least not without
reopening other defects when combined with other changes. The near-leg raise was not achieved in
any attempt either; the one attempt that tried a substantially larger knee/ankle excursion (attempt
1) also broke composition outright, so the raised-leg fix remains untested in isolation within this
card's 3-attempt cap. And the single-arm result T-0382 attempt 1 already had at this exact
seed/denoise/prompt baseline proved fragile: it broke under a combined skeleton+prompt change
(attempt 1), reappeared as a defect under a partial revert (attempt 2), and remained ambiguous even
under the most conservative, most isolated change tried (attempt 3). Per this card's own
pre-registered alternative outcome, this is a valid PASS: stop and report, not spend a fourth
attempt. No reference is promoted -- `assets/src/concept/player_profile_forward_limb_reference_controlnet.png`
does not exist on this branch.

## Status: FALSIFIED, stop-and-report at the 3-attempt cap (the pre-registered alternative outcome)

## Attempt 1 (seed 380002, denoise 0.87, ControlNet strength/end 1.5/1.0): FAIL

Skeleton: near-knee/ankle excursion enlarged (thigh angle 5.2 -> 15.0 degrees on a much bigger
dx/dy) plus eye pair separated ~4x (0.02 -> 0.075 apart), both applied together. Prompt: heavier
`:1.4`-weighted rewrites of the lens and leg clauses plus an added background-reinforcement clause.
Full frame: `attempt_1_main_1024.png`.

- Composition: **FAIL** -- the figure rendered zoomed in far past the 1024 canvas; the hood is
  cropped off the top edge entirely.
- Single visible goggle lens: **FAIL** -- no head is visible in frame to check
  (`attempt_1_head_cropped_off_top_crop.png`).
- Near leg visibly raised: **FAIL** -- both boots are visible at the very bottom edge, cropped,
  standing together, not raised (`attempt_1_legs_cropped_not_raised_crop.png`).
- Single visible arm and hand: **FAIL (ambiguous)** -- the one visible arm's hand rendered as a
  warped, fingerless mitt bleeding toward the frame edge, not "fingers visible" as the prompt
  requires (`attempt_1_arm_warped_crop.png`).
- Solid black background: **FAIL** -- measured border max channel 202 against the 16 ceiling, the
  worst of any attempt across T-0382 or this card.
- Green band (centred 187x200 crop): 19,064 px, above the 6,000 floor.

## Attempt 2 (seed 380002, denoise 0.87, ControlNet strength/end 1.5/1.0): FAIL

Skeleton unchanged from attempt 1 (enlarged knee/ankle, separated eyes). Prompt reverted to
near-verbatim T-0382 wording, keeping only light additions to the lens and leg clauses at T-0382's
original weight. Full frame: `attempt_2_main_1024.png`.

- Composition: pass -- the whole figure fits in frame, proportions restored to normal.
- Single visible arm and hand: **FAIL** -- a second, unrequested gloved hand is visible hanging at
  the hip, clearly separate from the single extended arm at the shoulder
  (`attempt_2_torso_second_hand_crop.png`) -- the exact defect T-0380/T-0382's far-arm collapse was
  built to prevent, reopened here.
- Single visible goggle lens: **FAIL** -- `attempt_2_head_no_lens_crop.png` shows a smooth pointed
  hood, no lens, no face.
- Near leg visibly raised: **FAIL** -- `attempt_2_legs_no_raise_crop.png` shows an ambiguous striped
  texture at the shin, both feet effectively together, no clear raise.
- Solid black background: **FAIL** -- measured border max channel 118 against the 16 ceiling.
- Green band (centred 187x200 crop): 18,205 px, above the 6,000 floor.

## Attempt 3 (seed 380002, denoise 0.87, ControlNet strength/end 1.5/1.0): FAIL

Skeleton: near-knee/ankle reverted verbatim to T-0380/T-0382's own rig (isolating the eye
separation as the only skeleton change from T-0382's baseline). Prompt: leg clause reverted
verbatim to T-0382's own wording; lens clause kept at the same light touch as attempt 2. This is
the 3rd and final attempt under this card's pre-registered hard cap. Full frame:
`attempt_3_main_1024.png`.

- Composition: pass -- whole figure in frame, single extended arm cleanly visible at the shoulder.
- Single visible arm and hand: **FAIL (ambiguous)** -- a second, glove-textured shape is visible
  folded at the near hip, distinct from the single extended arm and suspicious for the same
  second-hand defect attempt 2 showed clearly (`attempt_3_torso_second_hand_like_crop.png`).
- Single visible goggle lens: **FAIL** -- `attempt_3_head_no_lens_crop.png` shows a fully wrapped,
  featureless hood; the eye-separation change alone did not produce a legible lens.
- Near leg visibly raised: **FAIL** -- `attempt_3_legs_no_raise_crop.png` shows both feet planted
  together on an unrequested scenery element (a platform/plinth shape neither the prompt nor the
  skeleton asked for), no raise, no lifted hem.
- Solid black background: **FAIL** -- measured border max channel 146 against the 16 ceiling.
- Green band (centred 187x200 crop): 22,989 px, above the 6,000 floor.

This is the 3rd and final attempt under this card's pre-registered hard cap. No image produced by
any of the three attempts passes every acceptance check.

## Deliverable

None. Per this card's own pre-registered alternative outcome ("if 3 attempts produce no image
passing every check ... stop and report ... that is a valid PASS; a fourth attempt is not"), no
reference is promoted. `assets/src/concept/player_profile_forward_limb_reference_controlnet.png`
and its provenance sidecar do not exist on this branch.

Full per-attempt weights and measurements are in
`assets/src/concept/ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0387.md`. The authored
skeleton for attempts 1-2 (`pose_rig_forward_limb_controlnet_T0387` with both the knee/ankle and eye
overrides) is committed at `assets/src/concept/player_profile_forward_limb_skeleton_T0387.png` with
keypoints at `assets/src/concept/player_profile_forward_limb_skeleton_T0387.json`, sha256
`57231fdee964c4c90e2b45aabbb7dfdad3bc0ad04f28e00e4c104d72e8a2b60c` for attempts 1-2; attempt 3's
revised skeleton (eye override only, leg reverted) re-rendered the same committed path in place
with sha256 `871b1e8fad7deea4fd22aed8ebea07e0720f5998c07abd8f1f9ca2f2d755be7c`, both hashes recorded
per-attempt in the log above and both differing from T-0380 attempts 1-2's un-collapsed skeleton
(sha256 `1fe2df9f771633291ea68298e48e37c23630c3353daeb333704b0439ed728069`).

This is for @DennieSeth's design approval of the finding itself -- not promoted to `assets/final/`,
not wired into T-0356, no other views batched, per this card's own "Do not" list. A follow-up card
would need either a new attempt budget or a different structural approach than moving skeleton
joints and prompt text alone -- e.g. the two-stage or inpainting approaches T-0382's own evidence
already proposed, or reconsidering whether OpenPose ControlNet can encode a texture-level feature
like a goggle lens at all (this card's evidence suggests it cannot, independent of joint placement)
-- rather than a fourth attempt at the same lever.
