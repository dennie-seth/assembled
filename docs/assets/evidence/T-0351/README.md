# T-0351 evidence -- Tier-1 master sheet REGEN in limb-separating poses

## Status (2026-09-10, run 6): RE-SCOPE (PER-PANEL REFERENCE CONDITIONING), attempts 19-21 --
## 3-attempt hard cap spent, STOP AND REPORT per the card's own pre-registered escape hatch

The card's RE-SCOPE section (2026-09-10) replaced the single shared front-view concept-sheet crop
every panel had conditioned on through attempt 18 with a per-panel reference: front_tpose/back_tpose/
legs keep concept-sheet crops (back_tpose gets its own, a genuine back view measured off the sheet),
and side_left_forward/side_right_forward/side_neutral condition on the committed T-0317 green
side-profile reference instead. The section authorised exactly three internal attempts, then a
mandatory stop-and-report -- not further grinding. All three ran to completion against live ComfyUI
(172.18.192.1:8188), no denials, no timeouts. **Three attempts spent, still not a clean six-panel
sheet. Per the card's own pre-registered escape hatch this is a valid PASS for the card, not a
failure -- reported here with full evidence.**

### What worked, and held across all three attempts

- **side_neutral converged on attempt 19 and stayed clean on 20 and 21** -- a genuine true
  90-degree side profile, single figure, hooded mask, canonical long coat, every time. This is the
  first panel on this card to be reliably reproducible across multiple attempts, not a one-off.
  The T-0317 reference's own pose (neutral, arms straight down) matches this panel's target pose
  exactly, which is almost certainly why it is the one T-0317-conditioned panel that never needed
  troubleshooting.
- **front_tpose and back_tpose both converged cleanly on attempt 19** -- genuine T-poses, single
  figure, back_tpose showing an actual back-of-hood view (no front-facing mask), canonical long
  coat. (Both regressed on attempt 21, see below -- but the recipe and the new back-view concept
  crop are proven to work; attempt 19's panels are the ones to build forward from.)

### What did not converge, across all three attempts

**side_left_forward and side_right_forward have now never once been compliant across 21 total
attempts on this card**, under three fundamentally different architectures (prompt-only,
single-shared-crop ControlNet-conditioned, and now per-panel-reference-conditioned):

| Attempt | side_left_forward | side_right_forward |
|---|---|---|
| 19 | Malformed: split brown/green costume, dynamic kick pose, holding a strap-like object, teal background | Malformed: unrecognisable dark/melted shape, no clear silhouette |
| 20 (ipadapter end_at narrowed to 0.5) | Worse: coat drifted white/grey, invented flowing green "hair"/tendrils, still reaching/grasping pose | Worse: unrecognisable green/tan blob, holding a dark object |
| 21 (T-0317 reference square-padded) | Improved composition (single coherent green-coated figure, no more blob) but a visible face (violates the hood/mask-only requirement) and an odd draped cloth in the extended hand | Still broken: badly mis-framed as an extreme close-up crop, no assessable pose at all |

**legs regressed across the three attempts, not improved**: attempt 19 exposed the thighs (the
panel's entire purpose) with a coat flap still draped over them; attempt 20 held that same
partial result (unaffected by that attempt's change); attempt 21 mis-framed the panel entirely,
rendering the torso/upper body instead of the lower body.

**front_tpose/back_tpose regressed from attempt 19 to attempt 21**: both held a clean T-pose
throughout, but the coat length shortened to mid-thigh by attempt 21 (canonical is "reaching past
the knee") -- a defect neither attempt 19 nor the card's own acceptance criteria show on the
attempt-19 baseline. No code change between attempts 19 and 21 touched coat-length wording; this
reads as seed/sampling variance on an unconstrained clause, not a regression this card's own
changes caused.

### Two levers tried against the side-panel defect, in order, with results

1. **Narrow `IPAdapterAdvanced`'s own `end_at`** (attempt 20, `ipadapter_end_at=0.5` on the two
   forward panels only, `weight` untouched at 0.35) on the theory that the T-0317 reference's own
   neutral (arms-down) pose was fighting ControlNet's forward-extended-limb skeleton for the whole
   sampling range. **Disproved**: reducing IP-Adapter's influence in the later steps made both
   panels worse, not better -- less identity/structure guidance let the base model and style LoRA
   invent more (the white/grey coat, the green tendrils, the blob), not less. Reverted for attempt
   21.
2. **Square-pad the T-0317 reference before upload** (attempt 21, `pad_image_to_square`/
   `prepare_reference_for_upload`, 891x891 neutral-grey-padded from the native 175x891 file) on the
   theory that the reference's extreme aspect ratio was losing the head and feet to IP-Adapter's own
   CLIP-vision centre-crop preprocessing, leaving the model to invent whatever fell outside a
   roughly-224px-tall middle band. **Partial improvement**: side_left_forward went from an
   unrecognisable split-costume blob to a single coherent green-coated figure -- real progress -- but
   introduced two new defects (a visible face, a draped cloth prop) neither attempt showed before.
   side_right_forward did not improve at all -- a framing failure (extreme close-up crop) unrelated
   to either lever tried.

### What T-0351 still lacks: a genuine reference for a FORWARD-EXTENDED green-costume side pose

Both T-0317 (this card's own side reference) and the concept sheet's own side/profile figures (the
tan/tactical tier, per the earlier 18-attempt HELD finding) show **static, non-forward-extended**
poses. **No committed reference anywhere in this repo shows the green institutional costume with a
limb thrust forward at a walking/striding angle.** ControlNet supplies the skeleton geometry, but
IP-Adapter's identity/structure guidance for that specific silhouette (an extended sleeve cuff, an
extended trouser leg, a raised boot) has nothing real to draw from on these two panels specifically
-- which is the most likely explanation for why they are the only two panels across 21 attempts, three
architectures, and two additional levers this run tried, that have never once converged.

### Recommended next step, for whoever picks this card up

Generate (or source) a dedicated green-costume forward-stride reference -- the same kind of
targeted-reference move that fixed side_neutral (T-0317) and #365's headless/armour-drift defect
(`concept_crop_box`) before it -- rather than trying a third lever against the existing T-0317
reference. The legs panel's mis-framing (attempt 21) and the coat-length drift on front_tpose/
back_tpose look like ordinary seed variance rather than a structural defect, and do not need a new
architecture -- re-running attempt 19's exact recipe with a new seed is the indicated next step for
those two once the side-panel reference gap above is addressed.

### Evidence committed alongside this README

- `attempt_19_first_per_panel_reference_run_front_back_neutral_clean_sides_malformed.png` -- full six-panel sheet, RE-SCOPE attempt 1/3
- `attempt_20_ipadapter_end_at_narrowed_forward_sides_regressed_reverted.png` -- full six-panel sheet, RE-SCOPE attempt 2/3
- `attempt_21_square_padded_t0317_reference_side_neutral_holds_legs_framing_broken.png` -- full six-panel sheet, RE-SCOPE attempt 3/3 (final)
- `t0317_reference_square_padded_for_ipadapter_upload.png` -- the actual 891x891 padded file IP-Adapter was given on attempt 21, for direct inspection

## Status (superseded, 2026-09-10, run 5): attempts 15-16 -- first real six-panel executions since the
## dedicated-legs-panel amendment; real progress, still not compliant, nothing promoted

Three prior implementer/reviewer cycles ended with code committed, tests green, and **zero new
generations** (the T-0136 gap) -- the six-panel spec and crop boxes were correctly implemented in
code across those runs, but the generator was never actually invoked against ComfyUI. This run
breaks that streak: the generator ran twice, both times to completion against the live host
(172.18.192.1:8188), with no denial, no timeout, and no error.

**Attempt 15** (seed 264575131, 474.6 total GPU-seconds, all 6 ComfyUI calls succeeded --
`attempt_15_first_real_six_panel_execution_back_shows_front_mask_side_panels_noncompliant.png`,
`assets/out/master_sheet_T0351/player/attempt_15/provenance_candidate.json`) is this card's first
real execution of the six-panel/dedicated-legs-panel spec. Per-panel:

| Panel | Result |
|---|---|
| front_tpose | **PASS** -- genuine T-pose, arms clear of torso, legs apart, hooded mask with visible eye lenses, canonical long coat |
| back_tpose | **FAIL** -- rendered the mask facing the camera, not the back of the hood. Root cause found by opening `pose_back_tpose_skeleton.png` and `pose_front_tpose_skeleton.png` side by side: they are visually identical. `mirror_keypoints_lr` (`pose_rig_master_sheet_T0351.py`) is a left-right mirror, which is a no-op on a bilaterally symmetric T-pose -- the ControlNet skeleton carries no facing-direction signal at all for this pose, and `build_single_pose_positive_prompt` was interpolating the same emphasized visible-eye-lenses clause into every panel including this one, directly fighting its own "back view" text |
| side_left_forward | **FAIL** -- rendered a dynamic kick with a pistol in hand, not a static side profile with the left arm/leg extended forward. Neither a weapon nor a kicking motion was ever named in the negative prompt |
| side_right_forward | **FAIL** -- malformed/ghosted, coat flaring oddly, silhouette unclear |
| side_neutral | **FAIL** -- front-facing, not a true 90-degree profile, on a non-flat wooden-platform background (perspective present) |
| legs | **FAIL** -- still shows a short hooded cape covering both thighs; the existing "no cloak" ban does not cover a cape's distinct silhouette |

**Attempt 16** (seed 282842712, 537.6 total GPU-seconds, all 6 calls succeeded --
`attempt_16_back_view_fixed_side_neutral_true_profile_legs_regressed_to_armor_cape.png`) applied
three targeted, test-first fixes for the attempt-15 defects (see
`gen_master_sheet_T0336.py`'s `PoseSpec.head_clause`/`negative_extra`, and
`ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md`'s attempt-16 row for the full diff). Per-panel:

| Panel | Result |
|---|---|
| front_tpose | **PARTIAL** -- T-pose held, but the eye lenses rendered mismatched colours (one red, one green) -- a minor identity wobble, not present in attempt 15 |
| back_tpose | **PARTIAL, new failure mode** -- no longer shows a front-facing mask (the head_clause fix worked), but the coat rendered short with bare legs visible, more like a skirt than the canonical full-length coat -- a different compliance failure, not the one that was fixed |
| side_left_forward | **FAIL** -- ornate oversized coat with a feather collar, front-facing, not a side profile, no forward limb extension visible |
| side_right_forward | **FAIL, regressed** -- two figures, one visibly wearing high heels despite the heel ban |
| side_neutral | **PASS -- first genuine true-90-degree side profile this card has produced.** Hooded mask shown in profile, standing, canonical long coat. Minor identity wobble: visible hair strands under the hood and a white lower-face covering that reads more like a surgical mask than the hooded-mask/eye-lens design |
| legs | **FAIL, regressed** -- an elaborate armoured cape now fully obscures the lower body; worse than attempt 15's partial cape leak. The 1.8 CLIP-emphasis bump on the no-coat clause is the suspected cause: this card's own history (attempts 4, 9, 12, 13 -- see `build_single_pose_positive_prompt`'s docstring) repeatedly shows higher emphasis destabilising rather than fixing. **Do not raise this weight further next attempt** -- try naming "cape" without raising weight past attempt 15's 1.5, or drop back to 1.5 and rely on the new explicit "cape" term alone |

**Net effect across the two attempts**: two real defects fixed (back-facing mask, non-profile
side_neutral), one new defect introduced (legs panel regression, likely the emphasis bump), and
side_left_forward/side_right_forward remain unresolved across both attempts -- these two panels
have never once produced a compliant true-profile single-figure result across 16 attempts on this
card. **Nothing is promoted.** Both attempts' full sheets, panels, and skeletons are under
`assets/out/master_sheet_T0351/player/attempt_{15,16}/` (gitignored, reproducible from the
provenance JSON); the composited sheets are committed here as evidence.

**Recommended next lever, in order**: (1) revert the legs panel's emphasis to 1.5 (keep the new
"cape" term) and re-run just to confirm the regression was emphasis-driven, not seed noise; (2) for
side_left_forward/side_right_forward, this card has now spent 16 attempts across three
fundamentally different levers (prompt-only, per-pose single-shot, ControlNet-conditioned) without
ever producing a compliant result on these two panels specifically, while front_tpose/back_tpose/
side_neutral have each been achieved cleanly at least once -- the persistent, panel-specific nature
of this failure (not a general instability) continues to point at the `concept_crop_box`
multi-panel-grid finding (`root_cause_concept_crop_box_is_itself_a_multi_panel_grid.png`, this
directory) as the more fundamental fix, still unauthorized pending a human decision on whether the
card's "cropped clean concept block" wording covers the crop coordinates or only the numeric
weights.

## Status (superseded): run 4 -- ControlNet amendment, attempt 11 (first real execution), attempt 12 in progress

**@DennieSeth's 2026-09-10 amendment lifted the no-ControlNet restriction, scoped narrowly to pose
conditioning only** (see the amendment text appended to the card body) -- the "Root cause" section
below, which reported the `concept_crop_box` multi-panel-grid finding as an unresolvable blocker
under the old prompt-only-pose constraint, is superseded by that amendment, not retracted: the
finding itself (IP-Adapter conditions directly on the crop's pixel structure) still explains why
prompt-only levers never worked, but ControlNet gives this card a way around it without touching
the frozen crop box.

**Attempt 11** (seed 356237921, 444.7 total GPU-seconds, all 5 ComfyUI calls succeeded -- see
`attempt_11_controlnet_first_real_run_tpose_and_neutral_clean_sides_ghosted_coat_long.png` and
`attempt_11_provenance.json`) is this card's first real execution of the ControlNet-conditioned
recipe (attempts 8-10 changed the recipe in code across three commits but were never run to
completion through the CLI's logged path -- see `ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md`, which has
no rows for 8-10). Real progress: **front_tpose, back_tpose, and side_neutral are genuine, clean,
single-figure, correctly-posed panels** -- ControlNet reliably forces the skeleton's pose and
figure count on 3 of 5 panels, a first for this card. Two defects persist:

1. **Coat still runs past mid-hip on every panel** (to the knee on front_tpose, past the knee on
   back_tpose and side_neutral) even at 1.5 CLIP emphasis -- worse than attempts 3/5's plain-1.3
   prompt-only result. `back_tpose` also shows a literal "COAT" text-glyph artifact on the head,
   consistent with the root-cause finding that the IP-Adapter reference crop itself contains
   garment-callout label text bleeding through as pixel content CLIP-emphasis cannot suppress.
2. **side_left_forward and side_right_forward both show a faded, translucent ghost figure**
   overlapping the main one -- a different defect from attempt 8's opaque three-figure regression,
   and one no existing negative-prompt term named.

**Attempt 12** (in progress) raises the coat-length weight 1.5 -> 1.8 and the multi-figure negative
weight 1.3 -> 1.6, adding explicit ghosting/afterimage/double-exposure terms. See
`ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md` for the full per-attempt table.

## Status (superseded): run 3 -- root cause identified, fix is out of this card's authorized scope, nothing promoted

**Root cause found and verified (see "Root cause" section below): the `concept_crop_box`
`(0, 0, 615, 615)` this card is required to keep unchanged is itself a multi-panel grid, not an
isolated single figure -- IP-Adapter conditions on that pixel structure directly, and no
prompt-only intervention (two different generation strategies, 7 attempts, CLIP emphasis,
front-loading, per-pose isolation, targeted negative-prompt bans) ever overcame it.** The fix
this points to -- narrowing `concept_crop_box` to a genuinely isolated single-figure region --
conflicts with this card's own acceptance criterion ("IP-Adapter 0.35 on the cropped clean
concept block" listed as an unchanged recipe element) and its "Do not... pose is the only
variable" instruction. This is reported as a blocker for a human decision, not promoted, and not
silently stopped.

**Correction to this file's earlier wording** (flagged by the run-2 reviewer verdict):
attempts 1-5 below stopped at 5 not because of a cap this card imposes -- `check_attempt_cap`
inherited T-0336's own ~25-50 GPU-second, 5-attempt budget unmodified, and this card's own text
states no attempt cap of its own. That inherited cap is now scoped per-card
(`ATTEMPT_CAP_BY_CARD`); T-0351 falls back to a generic `DEFAULT_ATTEMPT_CAP=20` runaway
backstop, not a 5-attempt limit.

## Attempt 6 (lever 2 first execution) -- new finding: IP-Adapter dominates composition even
## with a single-pose-per-generation prompt

Run 2's reviewer traced attempts 1-5's failure to `MAIN_NEGATIVE` forbidding
"grid, panels, contact sheet, multiple frames" and "two figures, duplicate figure" -- the exact
thing a five-panels-in-one-image prompt needs -- and proposed lever 2: generate each pose as its
own independent 1024x1024 IP-Adapter-conditioned txt2img call (no panel/grid language in the
prompt at all), then composite the five results into one row by script. `run_five_pose_attempt` /
`build_single_pose_positive_prompt` implement exactly that (see
`gen_master_sheet_T0336.py`'s own docstrings), and attempt 6 (seed 223606797, 174.2 total
GPU-seconds across the five calls) is the first time it actually ran against ComfyUI.

**Result: still non-compliant, in a new way.** All five panels -- see
`attempt_6_five_generations_all_reproduce_reference_sheet_composition.png` and
`attempt_6_provenance.json` alongside this README -- came back as a multi-inset **fashion
tech-pack / reference-sheet composition** (a hero figure plus several small callout panels
showing garment pieces, alternate views, or accessories), not the single isolated full-body
figure the prompt explicitly asked for ("single full-body figure alone in frame ... centred").
Arms are down in every panel (no T-pose, no forward-extended limb), the coat runs
knee-length-or-longer in most panels (well past mid-hip), and several panels render illegible
pseudo-text/UI-style labels despite the positive prompt's own "no text, no UI, no watermark"
clause.

This is a materially different, and more informative, failure than attempts 1-5: it rules out
the reviewer's diagnosed negative-prompt conflict as the *sole* cause, since this generation had
no panel/grid words anywhere in its prompt and still produced a paneled composition. The
remaining, still-untried explanation is that IP-Adapter conditioning on the concept-sheet crop
(unchanged, 0.35 weight, per this card's frozen recipe) is asserting compositional structure
directly, not just style/identity -- and that a purely affirmative, unemphasized "single figure"
instruction does not outcompete it. Two prompt-only levers remain untried within this card's own
constraints (no ControlNet, no LoRA/IP-Adapter weight change): (1) CLIP-emphasis-weighting the
isolation and pose clauses, the one technique that reliably moved *something* across attempts 1-5
(the mid-hip coat clause); and (2) removing the redundant "no text/no UI/no watermark" negation
from the *positive* prompt (already covered by `MAIN_NEGATIVE`'s own "text, watermark" terms, and
negating a concept in the positive prompt is a known anti-pattern that can reinforce rather than
suppress it), replaced with affirmative "reference sheet / multi-view" bans moved into the
negative prompt where they belong. Attempt 7 tries both. See `ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md`
for the full attempt-6 provenance row.

## Attempt 7 (lever 2 + CLIP emphasis + negation fix) -- still non-compliant, but with a genuine
## partial win that pointed at the real root cause

Attempt 7 (seed 244948974, 231.3 total GPU-seconds) applied both attempt-6 fixes: CLIP emphasis
on the isolation and pose clauses (`build_single_pose_positive_prompt`), and moved the
"no text/no UI/no watermark" negation out of the positive prompt into targeted negative-prompt
terms naming the exact "reference sheet / tech pack" composition genre attempt 6 produced. See
`attempt_7_still_non_compliant_multi_figure_reference_sheet.png` and
`attempt_7_provenance.json` alongside this README.

**Still non-compliant** -- every one of the five panels again shows multiple figures/views per
image, arms down (no T-pose or forward-extended limb achieved in any of the 35 individual
generations across attempts 1-7), and most coats still run past mid-hip. **But the `side_neutral`
panel showed the clearest partial win of this entire card**: three figures, side profile,
genuinely bare thigh visible below a coat hem sitting well above mid-hip -- the CLIP-emphasized
mid-hip clause is, again, the one thing that reliably moves. Pose and single-figure isolation
did not move at all, in either lever, across 7 systematically varied attempts.

## Root cause (verified by opening the file, not inferred): `concept_crop_box` is itself a
## multi-panel grid, not an isolated figure

Seven attempts across two fundamentally different generation strategies (one KSampler call asked
for five panels; five independent KSampler calls each asked for exactly one isolated figure) never
achieved pose compliance or single-figure isolation even once. That pattern -- the *identical*
failure mode surviving a complete change of generation strategy -- is what prompted checking the
one shared input neither lever ever touched: the **conditioning image itself**.

`assets/src/concept/player_character_concept_sheet_v1.png` is a large multi-row grid sheet (jacket
panels, colour swatches, whole-figure turnarounds, armoured-variant studies). #365 restricted
`EntitySpec.concept_crop_box` to `(0, 0, 615, 615)` -- the sheet's own clean, single-costume
top-left block -- specifically to stop IP-Adapter picking up the sheet's *other* costume line
(see `build_positive_prompt`'s own docstring, round 5). **That crop was never checked for whether
it is itself a single isolated view.** Cropping and opening it directly
(`root_cause_concept_crop_box_is_itself_a_multi_panel_grid.png` alongside this README, at the
exact `(0, 0, 615, 615)` box `build_graph`'s `ImageCrop` node uses) shows it is not: it contains
**three jacket panels in its top row, colour/material swatches in its second row, and the start of
a row of whole-figure panels in its third row** -- a multi-panel grid in miniature, the same
composition genre every one of this card's 35 generations reproduced regardless of what the
prompt asked for.

This fully explains why no prompt-only lever ever worked: IP-Adapter's `IPAdapterAdvanced` node
conditions on the actual pixel content of whatever image it is given (`weight_type="linear"`,
`embeds_scaling="V only"`, applied across the *entire* sampling range `start_at=0.0`/`end_at=1.0`)
-- and the pixel content it is given is structurally a grid. A CLIP text encoding fighting that
structural signal for all 30 sampling steps was never going to reliably win, which is exactly
what the coat-length clause's partial, inconsistent success (moves *something* under emphasis,
never moves pose) versus pose's total non-response across every attempt shows.

**Why this is reported as a blocker rather than fixed directly:** the obvious next step -- crop a
*different, genuinely single-figure* region of the concept sheet (e.g. one whole-figure panel from
its own third/fourth row) for `concept_crop_box` -- is outside this card's stated scope. This
card's own acceptance criteria list "IP-Adapter 0.35 on the cropped clean concept block" as an
unchanged recipe element alongside the style/identity LoRA weights, and its "Do not" section says
"pose is the only variable." Changing which pixels IP-Adapter conditions on is a conditioning
change, not a pose change, even though the crop box is not literally a "weight." Whether that
guardrail is meant to cover the crop box's coordinates too, or only the numeric LoRA/IP-Adapter
weight scalars, is a genuine open question this card's text does not resolve -- unlike the
mid-hip coat question, which @DennieSeth explicitly closed on 2026-09-10, this one has not been
asked yet. A human decision is needed: either authorize a new, narrower `concept_crop_box` scoped
to this card only (T-0336's own promoted sheet is unaffected, since `ENTITIES["player"]`'s default
crop box is untouched -- only a card-specific override, the same pattern `CROP_BOXES_BY_CARD`
already establishes for limb crop boxes, would change), or decide the pose spec itself needs to
relax given this constraint.

## Attempts 1-5 (lever 1: single-shot five-panel-in-one-image, superseded by lever 2 above)

All 5 attempts permitted by the (since-corrected) inherited T-0336 cap were spent. None met the
acceptance criteria --
no attempt produced five panels in the specified poses (front T-pose, back
T-pose, side-left-forward, side-right-forward, side-neutral) with a
mid-hip-or-shorter coat and a legible hooded-mask head in every panel. Per
this card's own "Do not... promote it and report... as a blocker" wording
(which applies specifically to a coat-concealment-only defect), and per the
`assets.md` rule that a blocked generation must be written down rather than
silently stopped or faked, nothing is promoted to
`assets/src/character/master_sheets/` and this README records what was
tried and why it fell short.

**This is not a host-only blocker** -- ComfyUI, the GPU, and every model/LoRA
file were reachable and working throughout (each attempt completed in
27-33 GPU-seconds with no errors). This is a **generation-capability finding**:
under this card's fixed recipe (IP-Adapter 0.35 on the unchanged
`concept_crop_box`, no ControlNet, style/identity LoRA weights unchanged --
all pinned by the card, pose asked to be a prompt-only lever), five
independent, individually named whole-figure poses in one image did not
reliably follow from text alone across five systematically varied prompt
strategies.

## The five attempts

| # | Seed | Strategy | Result |
|---|---|---|---|
| 1 | 314159265 | Baseline: "character reference turnaround sheet" framing, five panels in prose, plain mid-hip wording | Two near-duplicate standing figures + small floating garment-callout insets (matches the IP-Adapter conditioning crop's own composition almost exactly). No T-pose, no back view, no side profile. Coat well past mid-hip. |
| 2 | 271828182 | Reframed as "pose reference chart", explicit "single horizontal row" + "five independent full-body poses" wording, added a card-specific negative prompt (duplicate poses, accessory insets, long coat) | Six figures in a two-row grid. Still no T-pose/side-profile pose compliance. Coat still past mid-hip. |
| 3 | 161803398 | Moved pose instructions to the front of the prompt (ahead of costume text) and wrapped each panel clause in ComfyUI's native CLIPTextEncode emphasis syntax (`(text:1.3)`) -- ComfyUI's own stock-node feature, not a custom node, not ControlNet, not an IP-Adapter/LoRA weight change | The mid-hip/bare-thigh clause worked -- every panel's coat came out short, a genuine partial win -- but pose still didn't follow, and the emphasis weighting destabilised unrelated regions: blank/cropped heads, high heels instead of boots, legs isolated into their own cropped row apart from the whole figure. |
| 4 | 141421356 | Raised pose-clause emphasis 1.3 -> 1.5, folded head/footwear wording into the emphasised clauses | Worse in a new way: three panels (not five), arms down (not T-pose/profile), and outright costume drift -- no coat at all, orange goggles instead of the hooded mask, robotic knee braces. Confirms higher emphasis destabilises more than it helps. |
| 5 | 173205080 | Dialled pose emphasis back to 1.3, shortened each clause to bare pose keywords, repeated costume wording unweighted to counter attempt 4's drift | Closest attempt: roughly five figures approximate a single row in the top strip, and several panels show a short/mid-thigh coat. But no attempt shows an actual T-pose (arms horizontal, legs apart) or a true 90-degree side profile with one limb extended forward -- all figures stand with arms at their sides, coat lengths are inconsistent panel to panel, and several heads render as blank white ovals rather than the hooded mask. |

Full prompts, negative prompts, and every other recipe field for each
attempt are in `attempt_<N>_provenance.json` alongside this README (and in
`assets/src/character/ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md`, this card's
own attempt log).

## What stayed constant across all 5 (per the card's own scope)

- 1024x1024, no ControlNet
- style LoRA `soviet_brutalism_style_v1.safetensors` @ 0.70
- identity LoRA `player_identity_v2.safetensors` @ 0.5 (chained)
- IP-Adapter `ip-adapter-plus_sdxl_vit-h.safetensors` @ 0.35
- IP-Adapter conditioned on the same `concept_crop_box = (0, 0, 615, 615)`
  #365 established
- Same hooded-mask-with-visible-eye-lenses head wording as #365's promoted
  attempt

Only the prompt text (and, within the prompt, ComfyUI's native emphasis
syntax on specific clauses) varied between attempts -- pose stayed a
prompt-only lever throughout, per this card's explicit "Do not add
ControlNet, and do not change the LoRA or IP-Adapter weights" instruction.

## Observed pattern

Attempts 1-2 (wording-only changes) reproduced the IP-Adapter conditioning
crop's own composition almost verbatim, regardless of what the text asked
for. Attempts 3-4 (increasing emphasis weight) show that *more* aggressive
textual intervention correlates with *more* instability (blank heads, wrong
footwear, costume drift, leg-only crops) rather than more pose compliance.
The one clause that reliably worked at any weight was the mid-hip/bare-thigh
coat-length instruction (attempts 3 and 5) -- garment silhouette detail is
evidently far more prompt-steerable than whole-body pose is, under this
specific IP-Adapter-heavy recipe.

## Recommendation (superseded -- see "Root cause" section above)

This section originally recommended trying five separate single-pose generations composited by
script (lever 2) as the next untried step. That was tried, twice (attempts 6-7, above), and
failed identically -- which is what led to actually opening the IP-Adapter conditioning crop
directly and finding it is itself a multi-panel grid. See "Status" and "Root cause" at the top of
this file for the current, decisive finding and the specific human decision it needs.
