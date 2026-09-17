# Forward-limb green-costume side-profile reference attempt log (T-0355)

Every attempt is recorded here whether promoted or not. Hard cap: 4 attempts (T-0355's own pre-registered alternative outcome -- stop and report past this, grinding further is out of scope). Same architecture as T-0317's own generator (plain txt2img + style LoRA, no ControlNet, no IP-Adapter) with the pose clause changed to near-arm/near-leg extended forward ~90 degrees and an explicit canonical coat-length constraint. `green_content` measures both the whole frame and a centred crop the same size as T-0272 round 5's own front-panel calibration crop (187x200), against that round's recorded 6,000-6,900 green-pixel band.

| Attempt | Seed | Style LoRA weight | GPU seconds | Whole-frame green px | Centred-crop green px | Promoted | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 31700 | 0.7 | 48.5 | 205027 | 826 | no | Backfilled from the 2026-09-11 run's card notes (this worktree's own untracked copy of this log did not survive the session's 5-hour-limit exit). Reference-sheet-framed prompt, forward-limb pose clause + explicit past-the-knee coat constraint. Centred-crop green px (826) is far below the 6,000-6,900 band; not promoted. |
| 2 | 84213 | 0.7 | 39.3 | 213697 | 1293 | no | Same recipe as attempt 1, fresh seed to test variance. Visual inspection (main_1024.png) shows the model produced a 3-panel front/side/back turnaround despite the "one reference panel" clause -- exactly T-0317's own known failure mode -- but unlike T-0317, every panel (main front figure, side and back thumbnails) rendered a neutral standing pose, not the requested forward-limb pose. The forward-limb clause was entirely ignored; low centred-crop green px reflects the small side thumbnail's off-centre position, not a coat-colour failure. Not promoted. |
| 3 | 52091 | 0.7 | 24.0 | 213170 | 26617 | no | Reworked prompt drops "reference sheet"/"concept sheet" framing (the likely trigger for the neutral multi-view convention seen in attempts 1-2) in favour of a single dynamic action-pose illustration. This fixed the pose entirely: single isolated figure, genuine mid-stride side-on pose, near arm and near leg both clearly extended forward at roughly the requested angle, no multi-panel drift, coat correctly full-length past the knee. Centred-crop green px 26,617 clears the 6,000-6,900 band. Not promoted: the prompt never carried the canonical hooded-mask/eye-lens/gloves/boots identity clause (`gen_master_sheet_T0336.py`'s own `build_single_pose_positive_prompt` head clause), so the figure rendered a bare green head, hands, and feet -- failing the card's own "single visible goggle lens" acceptance check outright (no goggles/mask present at all to judge). |
| 4 | 52091 | 0.7 | 24.0 | 194789 | 26530 | no | Final attempt under the hard cap. Keeps attempt 3's winning pose/framing verbatim and adds the canonical hooded-mask/eye-lens clause, white gloves, and boots, plus negative-prompt terms against bare skin and against two visible eye lenses/arms. Identity now renders correctly (hooded mask, gloves, boots all present, coat length still correct) and centred-crop green px (26,530) again clears the band. **Still not promoted**: visual inspection (`docs/assets/evidence/T-0355/attempt_4_head_crop.png`) shows the mask renders with both eye-slits visible, not the single lens a strict profile requires, and a second crop (`attempt_4_far_arm_crop.png`) shows a second arm/gloved fist genuinely visible behind the torso at hip height, not hidden as the "near arm and near leg forward, far arm and far leg hidden" clause asked for. The body's overall orientation (hips, legs, boots) is genuinely side-on, but the upper body reads as a three-quarter twist -- both eye lenses and both arms visible -- which is exactly the acceptance criterion's own "single visible arm silhouette and a single visible goggle lens" check, and it fails that check. This is attempt 4 of the 4-attempt hard cap: per the card's own pre-registered alternative outcome, this is a stop-and-report point, not a continue-tuning point. |

## Outcome: stop-and-report (pre-registered alternative, hard cap reached)

Four attempts, three fundamentally different prompt framings within the T-0317 architecture
(plain txt2img + style LoRA, no ControlNet, no IP-Adapter):

1. **Attempts 1-2** (reference-sheet framing): the model's strong prior toward "character
   reference sheet" layout produced a multi-panel front/side/back turnaround with every panel
   rendered in a neutral standing pose -- the forward-limb pose clause was entirely ignored,
   regardless of seed.
2. **Attempt 3** (single action-illustration framing, no identity clause): dropping the
   "reference sheet" wording fixed the pose and single-figure-ness completely -- proving the
   forward-limb pose *is* reachable from this stack once the sheet-layout trigger is removed --
   but the prompt had no hooded-mask/goggle clause at all, so there was nothing to judge the
   "single visible goggle lens" criterion against.
3. **Attempt 4** (same framing + canonical identity clause): adding the hooded mask, eye
   lenses, gloves, and boots rendered the correct costume identity, but shifted the head/upper
   body toward a three-quarter twist -- both eye lenses and a second arm became visible,
   directly violating the "single visible arm silhouette and a single visible goggle lens"
   acceptance check. The identity clause and the strict-profile-head clause appear to compete
   for the same attention budget, the same class of prompt-saturation effect
   `gen_master_sheet_T0336.py`'s own docstring documents repeatedly for this checkpoint/LoRA
   pair (e.g. its attempt 13: "adding a fourth emphasized clause over-saturated the prompt's
   attention budget elsewhere").

**What the generator produced instead of a compliant reference:** a genuine, single-figure,
green-costume, mid-stride forward-limb action pose with correct coat length and correct
hooded-mask/gloves/boots identity (attempt 4, `docs/assets/evidence/T-0355/attempt_4_main_1024.png`),
that nonetheless shows two arms and two eye lenses rather than the strict single-profile
silhouette the acceptance criteria require.

**Which constraint it violated:** the acceptance criterion "genuinely side-facing -- a single
visible arm silhouette and a single visible goggle lens, judged by opening it."

Per the card's own pre-registered alternative outcome, this is where attempts stop. No 5th
attempt was run; no half-compliant image is promoted to `player_profile_forward_limb_reference_T0355.png`
in place of a genuinely compliant one. The gate tests in `tests/test_forward_limb_reference_gate_T0355.py`
are expected to remain RED -- there is no committed deliverable for this card, by design, not
by omission.
