# T-0351 evidence -- Tier-1 master sheet REGEN in limb-separating poses

## Status: run 3 -- root cause identified, fix is out of this card's authorized scope, nothing promoted

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
