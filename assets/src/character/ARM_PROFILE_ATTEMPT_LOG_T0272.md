# Side-profile keyframe attempt log (T-0272, HANDOFF §24-e)

Every attempt is recorded here whether it passes the mechanical gate or not. This is a STATIC POSE, not an animation -- there is no frame-delta/0.30 cap, no loop seam, no Arm-C comparison here (a single keyframe has nothing adjacent to compare against). `mechanical_gate` covers only what a single frame can: cutout cleanliness (background fraction, no stray foreground outside the profile rig's own keypoint bbox) and a non-erased silhouette. Whether the result genuinely reads as side-facing with intact identity is a human visual call, recorded in Notes, not a mechanical one.

Attempts 1-4 (below) ran against `player_identity_v2` only, before `player_identity_profile_v1` (T-0274's pose-only LoRA) existed. Attempts 5-8 ran after T-0274 landed, with the new pose LoRA chained in (see `gen_hybrid_profile_T0272.build_graph`'s `pose_lora_weight` parameter, added this round) -- the first time the profile-topology rig and a profile-trained LoRA have been tried together.

| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | Pose LoRA weight | IP-Adapter weight | GPU seconds | Mechanical gate | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 31416 | 1.0/1.0 | 0.7 | 0.5 | n/a (pre-T-0274) | 0.6 | 111.1 | PASS | no | Visual verdict (Read tool, `main_384.png`): reads as a front-facing, bilaterally symmetric boxy figure -- both "sides" visible at once, no forward-reaching arm, no head turn. Costume illegible as the institutional green coat (white/black patterned torso, small green patches, not a confident match to the T-0252 anchor). Same failure T-0259's own probe found on the front rig, now reproduced against a genuinely different profile skeleton. |
| 2 | 31416 | 1.5/1.0 | 0.7 | 0.5 | n/a (pre-T-0274) | 0.35 | 117.2 | PASS | no | stronger ControlNet, weaker IP-Adapter to test whether pose structure can dominate the front-facing bias. Visual verdict: identity collapses entirely -- an abstract grid of blue/yellow/white colour blocks, no recognisable human silhouette at all. Weakening IP-Adapter did not free up the pose; it just destroyed appearance coherence. |
| 3 | 27182 | 1.0/1.0 | 0.7 | 0.5 | n/a (pre-T-0274) | 0.6 | 144.2 | PASS | no | default weights, different seed -- isolate whether attempt 1's front-facing/pale result was seed-specific. Visual verdict: wrong-subject failure (T-0218's own named failure mode) -- reads as an architectural panel/doorway with glowing readouts, not a person, profile or otherwise. |
| 4 | 31416 | 1.0/1.0 | 0.7 | 0.2 | n/a (pre-T-0274) | 0.6 | 111.2 | PASS | no | diagnostic: sharply lowered identity LoRA weight (0.5->0.2), default controlnet/ipadapter -- testing whether the front-trained identity LoRA itself is what collapses on this profile skeleton. Visual verdict: nearly identical to attempt 1 (same seed) -- still front-facing, symmetric, boxy. Confirms the identity LoRA's weight is not the deciding factor at this seed; whatever drives the front-facing reading survives a 60% cut to identity conditioning. |
| 5 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 54.1 | PASS | no | round 2, post-T-0274: `player_identity_profile_v1` chained after `player_identity_v2`, both trigger tokens in the prompt, same seed as attempt 1 for direct comparison. Visual verdict: the same boxy, front-facing, wrong-facing silhouette as attempt 1 -- green-square head, black/white patterned upper body, olive band, white torso, teal-green legs, inside the same dark rectangular surround. Not a "wrong subject" collapse; stacking the pose LoRA at weight 0.6 did not move the result off round 1's own failure mode. |
| 6 | 27182 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 33.1 | PASS | no | same stack as attempt 5, alternate seed (matches attempt 3's alt-seed choice) to test whether attempt 5's result was seed-specific. Visual verdict: genuinely different -- a control-panel/machine face with coloured LED-like readouts, no person. Same failure class as attempt 3 at this seed (a real "wrong subject" failure, unlike 5/7/8), now reproduced with the pose LoRA stacked in too. |
| 7 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.3 | 0.6 | 45.1 | PASS | no | same seed as attempts 1/5, pose LoRA weight halved (0.6->0.3) to test whether a lighter touch changes the outcome. Visual verdict: near-identical to attempts 1 and 5 -- same boxy, front-facing silhouette (green-square head, patterned upper body, olive band, white torso, teal legs) inside the same dark surround. Halving the pose LoRA's weight did not change the qualitative outcome. |
| 8 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.05 | 0.6 | 42.1 | PASS | no | final attempt, DL-21 cap: same seed as 1/5/7, pose LoRA weight reduced to near-zero (0.05), intended to isolate whether attempts 5/7's outcome is weight-driven or structural. Visual verdict (re-checked this pass, `main_384.png`): in the same cluster as attempts 1, 5, and 7 -- same green-square head, black/white patterned upper body, olive band, white torso and teal-green legs, inside the same dark surround. At seed 31416 the stacked pose LoRA produced the same boxy, front-facing silhouette across weights 0.6, 0.3, and 0.05 alike. Note: the prompt is not a clean isolation from attempt 1 -- `PROFILE_PROMPT` (`gen_hybrid_profile_T0272.py:171-178`) always carries the `sbrutalistprofilepose` token regardless of `pose_lora_weight`, so attempt 8's prompt differs from attempt 1's even though its LoRA weight is near-zero. See Finding below. |

## Finding: not achieved in 8 attempts (DL-21 cap reached) -- reported per @DennieSeth's standing rule, not forced

The profile-topology skeleton (`pose_rig_profile_T0272.py`) itself works exactly
as designed and is not in question: `pose_skeleton_384.png` for every attempt
(including 5-8, re-checked this round) shows the intended topology (legs
collapsed to one fore-aft line, shoulders nearly coincident, one arm reaching
forward, head turned) -- confirmed by direct visual inspection, not just by the
unit tests. Across all 8 attempts spanning the full DL-21 cap, the §24-e stack
never produced a keyframe that reads as a legible, side-facing, identifiable
version of the T-0252 character.

### Round 1 (attempts 1-4, before T-0274's pose LoRA existed)

- **Attempts 1 and 4** (default and low identity-LoRA-weight, same seed): a
  front-facing-reading, bilaterally symmetric figure, despite the ControlNet
  input being genuinely asymmetric. Cutting identity LoRA weight to 40% of
  default (attempt 4) barely changed the result, so the front-facing bias is
  not primarily coming from the identity LoRA's own training data -- something
  upstream of it (the base checkpoint's own learned prior for this character
  class, the style LoRA, or IP-Adapter's image-level conditioning on a
  front-facing concept-sheet crop) is contributing at least as much.
- **Attempt 2** (weaker IP-Adapter, stronger ControlNet): destroyed subject
  coherence entirely -- an abstract colour-block pattern, no human silhouette.
- **Attempt 3** (default weights, different seed): a "wrong subject" failure
  (T-0218's own named failure mode for this checkpoint) -- an architectural
  panel/doorway, not a person at all.

This round's own conclusion (recorded at the time, now superseded by round 2's
new evidence below) was that `player_identity_v2`'s front-facing-only training
data was the likely blocker, and that a profile-trained identity LoRA was the
natural next thing to try -- which is exactly what T-0274 then built.

### Round 2 (attempts 5-8, after T-0274 trained `player_identity_profile_v1`)

T-0274's own smoke check (`smoke_check_profile_lora_T0274.py`) only ever
*swapped* the new pose LoRA in for `player_identity_v2` (isolation), and only
against the *front* rig -- it confirmed a rig was also needed but never tested
the rig and the pose LoRA together. This round closes that gap: attempts 5-8
chain `player_identity_profile_v1` after `player_identity_v2` (both trigger
tokens present in the prompt, per the pose LoRA's own training-config notes:
"meant to be stacked ... via two distinct trigger tokens"), on this card's own
profile-topology rig.

The result is a tighter cluster than two earlier drafts of this log claimed,
not four different outcomes. **Attempts 1, 5, 7, and 8** (pose LoRA absent,
0.6, 0.3, and 0.05 respectively, all at seed 31416) all show the same boxy,
front-facing, wrong-facing silhouette -- a green-square head, black/white
patterned upper body, olive shoulder band, white torso block, and teal-green
legs, framed inside the same dark rectangular surround. Stacking the pose
LoRA at any of the three weights tried did not move the result out of round
1's own front-facing failure mode; it reproduced it. **Attempt 6** (pose LoRA
weight 0.6, seed 27182) is a genuine "wrong subject" failure (T-0218's
failure class) -- a control-panel/machine face with coloured LED-like
readouts, no person -- matching round 1's own attempt 3 at the same seed. So
the seed, not the pose LoRA weight, is what separates the boxy-figure cluster
(1, 5, 7, 8) from the wrong-subject failures (3, 6); pose LoRA weight made no
visible difference at either seed tried.

**Attempt 8 is not a clean isolation of "LoRA weight" from "graph shape,"
and that is worth recording even though 1/5/7/8 are now recognised as one
cluster rather than four different outcomes.** `PROFILE_PROMPT`
(`gen_hybrid_profile_T0272.py:171-178`) unconditionally injects
`POSE_LORA_TRIGGER_TOKEN` ("sbrutalistprofilepose") into the prompt text
whenever the pose LoRA is stacked at all, independent of `pose_lora_weight`
-- confirmed by diffing the `prompt` field of `attempt_1/provenance_candidate.json`
(no pose token; round 1, before T-0274's LoRA existed) against
`attempt_8/provenance_candidate.json` (carries `sbrutalistprofilepose,` as a
second leading token). Since attempts 5, 7, and 8 all land in the same
cluster as attempt 1 regardless of this token or the pose LoRA's weight (0.6,
0.3, 0.05), the confound does not change this round's headline finding -- at
seed 31416 the stacked pose LoRA changed essentially nothing across the three
weights tried, whether or not the trigger token was present. What it does
affect is any conclusion about *why*: this card's data supports only "pose
LoRA weight, across 0.05-0.6, did not move the result off the front-facing
failure mode at this seed" -- it does not support any claim about the LoRA's
learned weights specifically, since the prompt token was never controlled for
independently of the weight. That control -- the same near-zero weight with
`sbrutalistprofilepose` removed from the prompt entirely -- is left for a
follow-up card, not concluded here.

No attempt is promoted. Per `.claude/rules/assets.md` and the card's own
acceptance criteria ("do not ship a bad or faked profile... a well-evidenced
'not achievable with the current identity LoRA' is a complete and successful
outcome for this card"), this card stops here: all 8 of DL-21's attempts are
spent, and the two most plausible levers (identity LoRA weight in round 1,
pose LoRA weight in round 2) have both been swept without producing a
promotable result.

**What this suggests for a follow-up card** (not undertaken here -- out of
this card's scope):

1. **Control for the prompt-token confound before drawing any conclusion about
   the pose LoRA's learned weights.** Run one attempt at seed 31416, pose LoRA
   weight 0.05 (as in attempt 8), but with `sbrutalistprofilepose` stripped
   from the prompt entirely -- isolating whether attempts 5/7/8 landing in the
   same cluster as attempt 1 comes from the prompt token's own CLIP
   re-encoding or is independent of it. Only once that is resolved is it worth
   asking whether merging the pose LoRA's weights into a single LoRA file
   offline (instead of chaining a second `LoraLoader` node at generation time)
   changes anything.
2. `player_identity_profile_v1` was trained on anonymous silhouette/gait
   photographs (T-0273's set), not the game's own concept art -- a domain gap
   from IP-Adapter's T-0209 concept-sheet conditioning that this card has not
   isolated from the graph-structure question above.
3. Round 1's original hypothesis (the base checkpoint's own front-facing prior
   for this character class, or IP-Adapter's front-facing concept-sheet crop,
   both upstream of any identity/pose LoRA) is still untested in isolation --
   e.g. a profile attempt with IP-Adapter disabled entirely.

## Round 3 (attempts 9-16): the three isolations, and a decisive cause -- still not promotable

A fresh 8-attempt DL-21 budget was granted for this round specifically to run
round 2's own three untested follow-ups (prompt-token control, IP-Adapter
disabled, a genuine profile reference) and, if any of them unlocked the
facing, iterate toward promotion. All 8 attempts (9-16) are spent; **no
attempt is promoted**, but unlike rounds 1-2, this round isolates and names a
specific cause rather than reporting "not achieved" with no mechanism.

### Test A (attempt 9): the prompt-token confound is resolved -- it has no effect

Same seed and pose-LoRA weight as attempt 8 (31416, 0.05), but
`sbrutalistprofilepose` stripped from the prompt entirely
(`build_positive_prompt(include_pose_trigger_token=False)`). Visual verdict
(`main_384.png`, opened directly): identical to the attempt 1/5/7/8 cluster --
the same boxy, front-facing, bilaterally symmetric silhouette. **This closes
round 2's own open question**: the pose LoRA's trigger token was never doing
anything, at any weight, at this seed. Round 2's data stands as originally
read.

### Test B (attempt 10): IP-Adapter is not just a facing bias -- it is what makes the output a coherent human at all

Pose LoRA weight 0.6, IP-Adapter and its concept-image node removed from the
graph entirely (`enable_ipadapter=False` -- the sampler's `model` input wired
straight off the end of the LoRA chain, not merely a zero IP-Adapter weight).
Visual verdict: **not** a front-facing human, and **not** a side profile
either -- an incoherent panel-like collage of cyan/yellow/green vertical
stripes on a patterned background, structurally similar to the seed-27182
"wrong subject" failures (round 1's attempt 3, round 2's attempt 6) but now
reproduced at seed 31416, which had never previously produced a wrong-subject
failure. **This is the round's key negative result**: removing IP-Adapter
does not free the pose to go profile -- it removes the thing anchoring
subject coherence in the first place.

### Test C (attempt 11): confirms Test B, not the token

IP-Adapter disabled AND the pose-LoRA trigger token stripped (combining A+B),
pose LoRA weight 0.6. Visual verdict: a different but equally incoherent
collapse -- an abstract creature-like blob (white ear-like shapes, blue/yellow
limbs) on a clean black background. Still not a recognisable human, side-on
or otherwise. Confirms Test A's finding (the token is inert) and Test B's
(IP-Adapter's absence, not the prompt, drives the collapse).

### Test D (attempts 12-16): stacking a genuine profile reference DOES shift the pose -- and breaks something else every time

IP-Adapter re-enabled (front concept sheet, weight 0.6, as every prior
attempt), with a **second** `IPAdapterAdvanced` node chained after it,
conditioned on one of T-0273's approved side-profile references
(`player_profile_reference_3b9ee3bc20.jpg` -- a clean, unambiguous side-on
silhouette walking right, matching this rig's own `FACING`). This
combination -- front sheet for identity, genuine profile photo for pose -- had
never been tried before this card (`gen_hybrid_profile_T0272.py`'s own prior
module comment called it untested).

- **Attempt 12** (secondary weight 0.5, reference used as-is): the first
  attempt all round to visually break out of the front-facing cluster --
  a plausible side-profile-reading silhouette (rounded head, leaning torso,
  olive/white coat-like colouring) unlike anything in rounds 1-2. But the
  reference's own off-white studio background bled into the generation (a
  light grey backdrop instead of the prompt's "solid flat black background"),
  and `cutout_foreground_mask`'s border-connected region growing treated most
  of the frame as background as a result: only 76 fg px survived.
- **Fix attempted**: `invert_reference_for_conditioning` (new this round) --
  a plain RGB channel invert of the committed T-0273 source, done in-code,
  not a new committed reference -- turns the dark-silhouette-on-light-backdrop
  photo into a light-silhouette-on-near-black field, matching this card's own
  target tone.
- **Attempt 13** (secondary weight 0.5, inverted reference): the clearest
  side-profile silhouette of the entire card to date -- an unambiguous human
  side-on stance (head, leaning torso, one leg extended forward), rendered in
  near-monochrome black/white with a faint dark-green fill, on a clean
  near-black background. But the pose shifted far enough from the ControlNet
  skeleton's own keypoint positions that almost none of the figure fell
  inside `cutout_foreground_mask`'s keypoint-bbox+margin region: **0 fg px
  survived** -- the mechanical gate zeroed the entire figure.
- **Attempt 14** (secondary weight 0.5->0.3, to reduce how far the pose
  drifts from the skeleton): still a clear, legible side profile -- head,
  coat with a visible olive-green patch, forward-reaching arm -- on a clean
  black background. The best combination of facing and identity colour this
  round produced. 43 fg px survived, just under the 50px floor.
- **Attempt 15** (secondary weight 0.3->0.4, controlnet strength 1.0->1.3, to
  pull the pose back toward the skeleton): same reading as attempt 14 --
  clear side profile, green torso patch, clean background -- plus an
  unexplained bright blob outside the main silhouette. 45 fg px, still under
  the floor.
- **Attempt 16** (final attempt, DL-21 cap: controlnet strength pushed to
  1.8): the mechanical gate technically **passed** (94 fg px, background
  fraction 0.96) -- but the visual result is no longer a legible human
  silhouette at all: an abstract bird/blob shape with a beak-like spike and
  wing-like white lobes. Forcing enough ControlNet strength to pull the pose
  back inside the keypoint bbox broke subject coherence instead, the same
  failure mode Test B produced by a different route. **Not promoted despite
  the passing mechanical gate** -- per the card's own instruction, "genuinely
  side-facing" is a human visual call made by opening the image, not a
  substitute the mechanical gate can satisfy on its own, and this attempt
  fails that call.

### The isolated cause

Tests A-C establish that **IP-Adapter's front-concept-sheet image
conditioning, not the prompt token and not the pose LoRA, is what the
front-facing bias actually traces to** -- removing it does not produce a
profile, it produces subject collapse, meaning the front image is also
carrying the "this is a coherent human" signal, not just the "facing the
camera" signal. Test D confirms the mechanism by fixing it: stacking a
genuine profile reference through a second IP-Adapter node **does** pull the
pose into a real side-on silhouette (attempts 12-15, consistently, across
four different weight/strength combinations) -- something no attempt in
rounds 1-2 ever achieved. What Test D also shows is that this pipeline's two
supporting mechanisms are not yet compatible with that pose shift:

1. **The cutout's keypoint-bbox gate assumes the rendered figure stays near
   the ControlNet skeleton's own keypoint positions.** A profile-reference
   stack pulls the actual figure far enough from that anchor that the
   mechanical gate either zeroes the whole figure (attempt 13) or comes in
   just under its foreground floor (attempts 14-15) -- and the one attempt
   that pushed ControlNet strength hard enough to force alignment (16)
   destroyed subject coherence instead, converging with Test B's failure
   mode from the opposite direction.
2. **A single anonymous silhouette reference does not carry costume colour.**
   Every Test D attempt reads as black/white/olive at best, never the
   confidently green coat the identity acceptance criterion requires --
   consistent with T-0274's own training-config note that this reference set
   is "explicitly NOT a costume match."

Both are pre-existing constraints of the current cutout and IP-Adapter setup,
not new bugs introduced this round, but this is the first time either has
been exercised against a pose that genuinely deviates from the skeleton's own
footprint.

### Why this round stops here, and what a follow-up should try first

All 8 of this round's attempts are spent (DL-21 cap, attempts 9-16). Per
`.claude/rules/assets.md` and this card's own acceptance criteria, no result
from this round satisfies "genuinely side-facing AND identity legible AND
passing the mechanical gate simultaneously," so nothing is promoted. This is
a different outcome from rounds 1-2's "not achieved, no isolated cause": this
round isolates the cause (IP-Adapter's front-image conditioning) and
demonstrates a working direction (a stacked genuine profile reference), but
closing the remaining gap is out-of-cap work for a follow-up card. In order
of expected leverage, cheapest first:

1. **Widen `BACKGROUND_MASK_MARGIN_FRAC` for a profile-stacked attempt, or
   condition the mechanical gate on a bbox around the profile reference's own
   silhouette rather than the ControlNet skeleton's keypoints.** Attempts 14
   and 15 were visually convincing and only 5-7px under the floor -- the gate
   itself, tuned for a skeleton-anchored pose, may be the binding constraint,
   not the generation.
2. **A costume-bearing profile reference**, not an anonymous gait photograph
   -- either a profile render of T-0209's own concept sheet (if one can be
   produced) or a profile-specific identity LoRA trained on in-costume
   material, so IP-Adapter's second reference carries colour as well as pose.
3. Re-run attempts 14/15's exact recipe at a second seed, to check whether the
   43-45px near-miss is a stable property of this stack or a seed artifact
   before spending a full budget tuning it further.
| 9 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.05 | 0.6 | 42.1 | PASS | no | Test A (prompt-token control): same seed/pose-LoRA-weight as attempt 8 but sbrutalistprofilepose stripped from the prompt. Visual verdict: identical cluster to attempts 1/5/7/8 -- boxy front-facing silhouette, green-square head, white torso. Confirms the prompt token has NO effect; the confound flagged in round 2 is resolved. |
| 10 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | None | 39.1 | PASS | no | Test B: IP-Adapter removed from the graph entirely (not zero-weight), pose LoRA weight 0.6. Visual verdict: NOT a front-facing human and NOT a side profile either -- an incoherent panel-like collage of cyan/yellow/green stripes, similar in kind to the seed-27182 'wrong subject' failures (attempts 3/6) but at seed 31416. Shows IP-Adapter's front concept-sheet conditioning is what anchors coherent human-subject rendering at this seed, not just what biases it toward front-facing. |
| 11 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | None | 30.1 | PASS | no | Test C: IP-Adapter disabled AND pose-trigger token stripped (combine A+B). Visual verdict: a different incoherent collapse -- an abstract creature-like blob (white 'ears', blue/yellow limbs) on a clean black background, still not a recognisable human, side-facing or otherwise. Confirms disabling IP-Adapter is the dominant factor in the collapse (Test A's token removal made no difference here either). |
| 12 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 3.0 | PASS | no | Test D: front concept sheet (weight 0.6) stacked with T-0273's uninverted side-profile silhouette reference (weight 0.5) via a second chained IPAdapterAdvanced node -- untested before this card. Visual verdict: a genuinely different, plausibly side-profile-reading silhouette (rounded head, leaning torso, olive/white coat-like colouring), unlike any prior attempt's front-facing cluster. But the reference's own off-white background bled into the generation (light grey backdrop, not flat black) and defeated cutout: only 76 fg px survived. |
| 13 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 51.1 | FAIL | no | Test D v2: same stack as attempt 12, but the reference is colour-inverted (invert_reference_for_conditioning) before conditioning so its off-white background no longer conflicts with the black-background target. Visual verdict: the clearest side-profile silhouette of the round -- an unambiguous human side-on stance (head, leaning torso, forward leg) rendered in near-monochrome black/white with a faint dark-green fill, on a clean near-black background. But the pose shifted spatially outside the ControlNet skeleton's own keypoint bbox: the mechanical cutout removed the ENTIRE figure (0 fg px). |
| 14 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 51.1 | FAIL | no | Test D v3: secondary reference weight lowered 0.5->0.3 to reduce how far the pose shifts from the skeleton. Visual verdict: still a clear, legible side profile (head, coat with a visible olive-green patch, forward arm) on a clean black background -- the best combination of facing + colour this round. Mechanical gate: 43 fg px, just under the 50px floor -- most of the figure's extent still falls outside the keypoint bbox+margin. |
| 15 | 31416 | 1.3/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 54.1 | FAIL | no | Test D v4: secondary weight 0.3->0.4, controlnet strength 1.0->1.3 to pull the pose back toward the skeleton. Visual verdict: same reading as attempt 14 -- clear side profile, green torso patch, clean black background, plus an unexplained bright blob at bottom-right outside the main silhouette. Mechanical gate: 45 fg px, still under the 50px floor. |
| 16 | 31416 | 1.8/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 51.1 | PASS | no | Test D v5 (final attempt, DL-21 cap): controlnet strength pushed further to 1.8 to force spatial alignment. Mechanical gate technically PASSED (94 fg px, background 0.96) -- but the visual result is no longer a legible human silhouette at all: an abstract bird/blob shape with a beak-like spike and wing-like white lobes. Pushing ControlNet strength enough to fix the bbox-alignment problem broke subject coherence instead. NOT promotable despite the passing mechanical gate -- 'genuinely side-facing with intact identity' is a human visual call this attempt fails. |
| 17 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 75.1 | FAIL | no | round 4: attempt 14 recipe rerun against the new content-aware cutout (char_gen.extract_foreground_mask) |
| 18 | 31416 | 1.2/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 57.1 | FAIL | no | round 4 attempt: controlnet 1.0->1.2 to pull the pose slightly further from the frame edge |
| 19 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.7 | 54.1 | PASS | no | round 4 attempt: controlnet back to 1.0, front ipadapter 0.6->0.7 for costume fidelity, secondary weight 0.3->0.25 |
| 20 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 69.1 | PASS | no | round 4 attempt: replicate round-3 attempt 13's recipe (secondary weight 0.5, the clearest side profile of round 3) against the new content-aware cutout |
| 21 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 66.1 | PASS | no | round 4 attempt: secondary weight 0.4 (between attempts 14/13), CN 1.0, against new cutout |
| 22 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.65 | 51.1 | FAIL | no | round 4 attempt: primary ipadapter 0.6->0.65 for costume colour, secondary 0.4 unchanged, CN 1.0 |
| 23 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.65 | 66.1 | PASS | no | round 4 bootstrap: secondary reference is attempt 21's own clean side-profile silhouette (pre-inverted so the pipeline's auto-invert restores its tone), not the T-0273 photo -- testing whether this project's own art-style pose reference preserves costume colour better than an anonymous gait photo |
| 24 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 63.1 | PASS | no | round 4 bootstrap v2 (final attempt, DL-21 cap): secondary reference is attempt 20's own side-profile output (the one with a genuine olive-green torso band), pre-inverted so the pipeline's auto-invert restores its tone -- testing whether bootstrapping from a colour-bearing in-pipeline frame beats the anonymous T-0273 photo |

## Round 4 (attempts 17-24): the cutout fix is confirmed working -- a sharper, different blocker is isolated: costume colour trades off against pose fidelity

A fresh 8-attempt DL-21 budget was spent generalizing the cutout
(`char_gen.cutout.extract_foreground_mask`, T-0272 round 4's own code change
-- see `assets/src/character/src/char_gen/cutout.py` and its 6 unit tests,
`tests/test_cutout_T0272.py`) and then regenerating around round 3's best
recipe to test it against real ComfyUI output, not just synthetic fixtures.
All 8 attempts (17-24) are spent; **no attempt is promoted**, but this round
resolves round 3's own open question about the cutout and isolates a new,
sharper one about colour.

### The cutout fix is confirmed, with real generation evidence, not just unit tests

Round 3's own diagnosis was that the old `cutout_foreground_mask`'s hard
"outside this frame's own keypoint bbox is background" clip zeroed or
shrank attempts 13-15 below the 50px floor even though they visually read as
legible side profiles. This round's attempts 20, 21, 23, and 24 all **pass
the mechanical gate** (65, 200, 223, and 69 foreground px respectively) while
their own figures sit substantially outside the profile rig's keypoint
bbox+margin -- exactly the case the old algorithm could not recover. Attempt
21 in particular (200 fg px, `background_fraction=0.913`) is visually the
cleanest, most legible side-profile silhouette this entire card has produced
across 21 attempts: a leaning head/hood shape and torso, unambiguously
side-facing, with no front-facing symmetry at all. The generalized cutout
is doing exactly what it was built to do.

One attempt (17, an exact rerun of round 3's attempt 14 recipe) landed
outside that pattern: `background_fraction=1.0`, 0 fg px survived, because
this generation's own figure physically touched the frame's border (the
lower leg ran off the bottom edge, a light patch touched the top-right
corner), so `border_flood_background_mask` -- unchanged by this round,
tolerance-chained by design -- correctly treated it as border-connected and
flooded the whole frame as background. This is not a defect in the new
selection logic (component selection never runs on pixels the flood has
already claimed); it is a pre-existing property of the border-flood detector
that this round did not touch and was not asked to. Attempt 18 (ControlNet
strength raised 1.0->1.2 to pull attempt 17's drifted pose back inward)
partially recovered (35 fg px, still under floor) but also partially
reverted toward the boxy front-ish silhouette rounds 1-2 already named.

### A cleaner isolation than round 3 had: colour and pose fidelity trade off directly against each other in this stack

Round 3 could not get a stacked profile reference to preserve costume colour
at all (every Test D attempt read black/white/olive at best). This round
swept the weight space specifically looking for a point where both hold at
once, and found a consistent, monotonic trade instead of a lucky middle:

- **High front-sheet IP-Adapter weight -> costume colour returns, profile is
  lost.** Attempt 19 (front IP-Adapter weight 0.6->0.7, secondary weight
  0.3->0.25) passed the mechanical gate with 383 fg px and, uniquely this
  round, shows genuinely legible institutional-green costume colour (a clear
  green band, white torso, black coat outline). But the figure is bilaterally
  symmetric and front-facing -- the identical failure class rounds 1-2 named,
  now reproduced with the pose LoRA and profile skeleton both active. Raising
  the front reference's weight re-asserts the same front-facing bias round 3
  isolated to IP-Adapter's image-level conditioning (Test B/C), even with a
  second, profile-conditioning reference stacked in.
- **Moderate front weight + moderate-to-high secondary weight -> profile
  returns, costume colour is lost or reduced to olive/khaki.** Attempts 20
  (secondary 0.5, replicating round 3's attempt 13), 21 (secondary 0.4), and
  23/24 (bootstrap variants, below) all read as genuine side profiles. Only
  20, 23, and 24 carry any colour at all, and it is a muted olive/khaki band
  (quantized palette indices spanning RGB (76,85,58) to (100,98,88) in
  attempt 24's own indexed cell -- confirmed by direct pixel inspection, not
  estimated), never the vivid saturated green the acceptance criterion
  requires. Attempt 21, the single cleanest silhouette of the round, carries
  **no colour at all** -- pure black/white/grey.
- **Attempt 22** (front weight 0.65, secondary 0.4) landed in neither
  regime cleanly: 17 fg px (FAIL), a boxy silhouette with disconnected green
  patches, background not clean enough for the flood to isolate a coherent
  blob. Treated as a data point inside the trade-off, not a third regime.

### The bootstrap idea (this card's own "generate a costume reference through the stack itself") is tested and found insufficient alone

Per this round's own instructions, attempts 23 and 24 tested conditioning
IP-Adapter's secondary input on this pipeline's *own* prior output instead of
the anonymous T-0273 photograph -- pre-inverting attempt 21's (23) and
attempt 20's (24) own `main_384.png` so `invert_reference_for_conditioning`'s
unconditional invert restores the original tone before it reaches
IP-Adapter. Both bootstrap attempts pass the mechanical gate (223 and 69 fg
px) and both are genuine side profiles, matching the shape family attempts
20/21 already established. Attempt 24 (bootstrapped from attempt 20, which
itself carried the most colour of any pre-bootstrap attempt) shows the most
colour recovery of the two bootstraps -- a visible olive-green rectangular
chest patch plus a faint green hem -- but still olive/muted, not vivid
saturated green, and still a small fraction of the 48x48 cell (69px, ~3%).
**Bootstrapping from the pipeline's own output does not manufacture colour
that was never present at sufficient strength in its source**: since colour
in this stack comes overwhelmingly from the front concept-sheet IP-Adapter
weight, and that same weight is what pulls the pose back toward front-facing
(see above), bootstrapping the *pose* reference alone cannot break the
trade-off it inherits from wherever its own colour came from.

### What this round establishes, and what a follow-up should try first

No result from this round satisfies "genuinely side-facing AND identity
(costume colour) legible AND passing the mechanical gate simultaneously," so
nothing is promoted -- consistent with `.claude/rules/assets.md` and this
card's own acceptance criteria. This is a different, more decisive outcome
than round 3's: round 3 could not get a profile-shifted pose to survive
cutout at all; this round proves the cutout is no longer the constraint
(four passing, genuinely side-facing attempts) and narrows the remaining gap
to a single, well-evidenced cause -- **no reference available to this card
carries both genuine side-profile pose AND the institutional green costume
at once**, so any single IP-Adapter weight setting buys one at the cost of
the other. In order of expected leverage, cheapest first:

1. **A profile-specific costume identity LoRA**, trained on in-costume,
   in-profile material (round 3's follow-up #2, now further substantiated:
   neither the anonymous T-0273 photograph nor a bootstrapped in-pipeline
   frame carries enough colour signal for IP-Adapter to preserve at a weight
   that also preserves the profile pose). This is a training-data problem,
   not a graph-shape or cutout problem -- out of scope for this card per
   @DennieSeth's own standing direction ("LoRA must be trained per-pose, per
   character/monster"), and the natural next card.
2. **A genuine side-profile concept sheet** (a flat, side-on elevation of
   the actual costumed character, per `docs/design/13-asset-pipeline.md`
   §6.8-§6.11's concept-sheet conventions), sourced or produced the way
   T-0209's front sheet was, to feed IP-Adapter directly instead of via a
   photograph or a bootstrap -- would remove the domain gap at its root
   rather than compensating for it with LoRA training.
3. Even where the mechanical gate passes, the surviving foreground is a
   small fraction of the 48x48 cell (65-223px, roughly 3-10% of the frame) --
   worth checking, once a colour-preserving reference exists, whether the
   resulting silhouette actually fills a game-ready sprite footprint or
   needs a tighter framing/crop pass.

| 25 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 69.4 | PASS | no | round-4 defect-fix Test: secondary reference is the newly derived same-style side-profile crop (player_profile_style_reference_T0272.png), not inverted (already correct tone), replicating attempt 24's weights otherwise |
| 26 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.75 | 48.1 | PASS | no | round-4 defect-fix Test 2: same style-reference secondary as attempt 25 but weight 0.3 (down from 0.45) and primary IP-Adapter 0.75 (up from 0.6) to push more costume colour through |
| 27 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 63.1 | PASS | no | round-4 defect-fix Test 3: push secondary (pose/style-ref) weight up to 0.6 (matching primary) to see if a stronger profile pull still keeps some costume colour |

## Round 4, continued (attempts 25-28): the reviewer's two FAIL defects, fixed and tested

The round-4 VALIDATION verdict accepted attempts 17-24's data and the
cutout/colour-trade-off finding, but scoped a FAIL on two defects: (1) the
generalized cutout (`extract_foreground_mask`) reduced the foreground to a
single connected component, which regression-tested against the
already-promoted `player_idle_sheet_hybrid_T0252.png` silently dropped up to
161 of 455 real foreground px per cell, since that sheet's own cells are 3-4
components each; and (2) the round's own "costume-bearing side-profile
reference" requirement was never actually tried or declined with reasons --
specifically its cheapest listed option, "crop a profile-ish view from the
concept sheet or T-0252's idle sheet."

### Defect 1: the cutout now keeps every hint-overlapping component, not just the best one

Fixed in `char_gen/cutout.py`'s `extract_foreground_mask`: instead of scoring
every candidate component's overlap with the keypoints hint and keeping only
the single highest-scoring one, it now keeps *every* component that overlaps
the hint at all (the largest-only fallback, for when nothing overlaps the
hint, is unchanged). Verified directly, not just by unit test: re-running the
new selection against all 9 cells of the committed
`player_idle_sheet_hybrid_T0252.png` (a whole-cell hint, the realistic case
for an already-centred, already-cutout figure) now recovers 100% of each
cell's raw foreground -- 474/456/474/455/474/456/474/455/474 px, matching the
border-flood's own raw foreground count exactly, versus the old selection's
460/433/460/294/460/433/460/294/460 (a 35% loss on the worst cells). Two new
tests cover this: a synthetic two-part-figure case
(`test_multi_part_figure_survives_whole_when_every_part_overlaps_hint`) and
the real regression anchor itself
(`test_promoted_front_sheet_cells_survive_the_new_selection_whole`,
`tests/test_cutout_T0272.py`). The gate's own "single connected blob"
assertion is relaxed to a bounded component count (<=6, measured against
that same anchor's 3-4) rather than an exact one, since the anchor sheet
itself never satisfied "exactly one."

### Defect 2: the cheapest reference option was tried, found not literally achievable, and a same-style alternative was derived and tested instead

Direct visual inspection (the Read tool, cropped panel-by-panel, not
assumed): `player_character_concept_sheet_v1.png`'s green-coat panels are
*all* pure front views -- the two jacket-only close-up rows (front + back
pairs) and all three full-body panels in the character row are front-facing,
none profile or even three-quarter. `player_idle_sheet_hybrid_T0252.png` is
this card's own front-facing idle/walk cycle -- also entirely front-facing by
construction. **Neither named source has a profile-ish green panel to crop.**
This is now recorded here rather than only in a code comment.

The concept sheet *does* contain one genuine, unambiguous side-profile panel
(row 3, column 5, pixel box `(819, 256, 1024, 512)`) -- rendered in the
sheet's grey/tan tactical-variant costume tier, not the green cloth-coat
tier, but in the exact same linework/render style as every other panel on
the sheet, and already facing right, matching `pose_rig_profile_T0272.FACING`.
`derive_profile_style_reference_T0272.py` crops it tightly to its own figure,
forces every non-figure pixel (background and the panel's own text-label
artifact) to solid black via the same border-flood + largest-component logic
`char_gen.cutout` already uses, and commits the result as
`assets/src/concept/player_profile_style_reference_T0272.png` with a
provenance sidecar recording the source panel box, the source concept
sheet's own sha256, and an explicit "NOT a costume match" note -- this is a
same-render-style pose/framing reference, exactly like T-0273's anonymous
photographs in that respect, just drawn by the same process as the identity
sheet rather than photographed.

Because this reference already has the correct black-background tone (unlike
T-0273's dark-on-light photographs), `gen_hybrid_profile_T0272.py`'s
unconditional secondary-reference invert would have wrongly flipped it back
to near-white -- `prepare_secondary_reference(..., needs_invert=False)` (new,
covered by `tests/test_gen_hybrid_profile_graph_T0272.py`) makes that choice
explicit instead of assuming every secondary source needs T-0273's own fix.
`check_attempt_cap` was extended to 25..28: a small, explicitly-scoped
continuation of this same round to test the derived reference, not a fresh
8-attempt budget.

### Attempts 25-28: the trade-off persists, and gets one sharper turn -- the reference's own competing costume, not just its render style, is part of the problem

All four attempts replicate attempt 24's baseline (seed 31416, style LoRA
0.7, identity LoRA 0.5, pose LoRA 0.6, ControlNet 1.0/1.0) and vary only the
front (primary) IP-Adapter weight and the new secondary reference's weight:

- **Attempt 25** (primary 0.6, secondary 0.45, matching attempt 24 exactly
  except the reference itself): the single most confidently side-facing
  result this card has produced -- a clean leaning silhouette, hood turned,
  single visible arm and leg, no front-facing symmetry at all -- but almost
  no colour (a faint multicolour rim-light glow, not costume colour) and a
  very small surviving silhouette (101 fg px, ~4% of the cell; the promoted
  48px cell is a barely-legible fragment). Mechanical gate: PASS
  (`background_fraction=0.956`).
- **Attempt 26** (primary raised to 0.75, secondary lowered to 0.3): the
  most colour of the four (a legible dark-green shoulder/waist band, cream
  torso, 564 fg px) -- but the figure is unambiguously front-facing again,
  both arms out to the sides and both legs visible, the exact failure mode
  raising primary weight has produced in every round since round 3. Gate:
  PASS.
- **Attempt 27** (primary 0.6, secondary raised to 0.6, matching primary):
  still front-facing (symmetric legs, centred hood), olive/grey-green colour
  rather than vivid green -- the tactical-variant reference's own costume
  colour, not the coat's. 407 fg px, gate PASS.
- **Attempt 28** (primary 0.6, secondary dropped to a light 0.15 -- the
  control for "is it the render style or the competing costume design that
  fights the green"): at 384px this is the most promising-looking frame of
  the four, a genuine olive-green coat silhouette with a plausible side lean
  -- but it fragments into scattered disconnected debris at the 48x48
  cutout/quantize step (345 fg px scored by the mechanical gate, but visually
  unrecognisable as a figure, not merely "small"). Gate PASS on the numeric
  floor alone; **correctly not promotable on the human visual call the card
  itself requires.**

**What this adds to round 4's own finding, beyond confirming it again:**
swapping the secondary reference for one drawn in the pipeline's own render
style did not break the colour/pose trade-off, and attempts 26-27 show it can
make the front-facing failure mode *more* likely to win, not less -- because
the new reference carries its own complete, different costume design (the
grey/tan tactical tier), which competes with the green coat for "what colour
is this" exactly as much as it helps with "what pose is this." A reference
that carried pose information with *no* competing costume content at all
(T-0273's anonymous silhouettes) was, if anything, a cleaner secondary signal
than this round's own same-style derivation turned out to be. This rules out
"the secondary reference just needs to match the model's render style" as a
fix in its own right, and leaves round 4's original conclusion -- **no
reference available to this card carries both genuine side-profile pose and
the institutional green costume at once, and no combination of two
separately-sourced references (regardless of art style) has produced one
across 20 attempts spanning rounds 3-4 (9-28)** -- not just unrefuted, but
sharpened: the fix has to be a single reference/identity that natively
encodes both traits together, not a better choice of *which* second image to
stack. Nothing is promoted this round either, consistent with
`.claude/rules/assets.md`'s "never ship a faked or unconvincing asset."
Follow-up #1 (a profile-specific costume identity LoRA) and #2 (a genuine
side-profile costume concept sheet) from round 4's own list stand unchanged
and are now the only two paths left untried.

## Budget exhausted -- both remaining paths are out of this card's own scope

`check_attempt_cap` now hard-refuses any attempt above 28
(`gen_hybrid_profile_T0272.py:456-470`); the DL-21 budget spent across four
rounds (1-4, 5-8, 9-16, 17-24, plus the 25-28 defect-fix continuation) is
fully closed. Round 4's own text withdraws the finding escape hatch ("A
finding is not an acceptable outcome now that the cause is isolated and the
direction demonstrated") -- but this card's own "Do not" list simultaneously
forbids the one lever most likely to close the gap: **"Do not retrain any
LoRA in this card."** The two paths this log's own analysis converges on
(follow-up #1: a profile-specific costume identity LoRA; follow-up #2: a
genuine side-profile costume concept sheet, itself a multi-attempt generation
or sourcing effort in its own right) both require work this card is
explicitly barred from doing itself.

That is a scope conflict inside the card's own instructions, not something
an implementer should resolve by quietly promoting an unconvincing frame to
satisfy criterion 8, or by quietly ignoring "do not retrain" to keep
attempting a fix. Twenty-eight real, honestly-reported attempts across three
isolated causes (prompt-token confound, IP-Adapter's front-facing image
conditioning, and now a same-style-but-wrong-costume secondary reference)
converge on the same conclusion every time: no reference or reference
combination available *within this card's scope* carries both the profile
pose and the institutional green costume at once. `assets/final/character/`
correctly carries no T-0272 file. The decision this leaves for @DennieSeth is
which of the two out-of-scope follow-ups to fund as its own card -- not
something this card can decide or work around on its own.

| 29 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 3.1 | PASS | no | round 5 Lever 2: bootstrap from attempt 24's own output (background not off-white, no invert) + green-emphasis prompt lever (attention-weighted costume phrase + explicit anti-olive/khaki negatives), holding attempt 24's other weights, to test whether pushing colour harder breaks the muted-olive plateau |
| 30 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 60.1 | PASS | no | round 5 Lever 2: replicate attempt 21's exact recipe (T-0273 photo secondary, inverted, weight 0.4 -- the cleanest side-facing silhouette this card has produced) but add green-emphasis, to test whether the prompt lever alone can recover costume colour on a recipe already proven to hold the profile pose, without a competing bootstrap chain |
| 31 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 54.1 | PASS | no | round 5 Lever 2 isolation, as configured: primary front concept sheet only (no secondary reference node in the graph at all), green-emphasis on, otherwise matching attempts 21/24's weights -- intended to test whether the prompt lever alone can recover vivid green in a clean render, decoupled from any secondary-reference cutout/style side effects seen in attempt 30. It did not achieve that isolation: `main_384.png` is pixel-identical to attempt 30's despite the two graphs differing structurally (30 routes `KSampler`'s model input through a second `IPAdapterAdvanced` node on the T-0273 photo secondary at weight 0.4; 31 has no such node at all). See the footnote directly below this table for the full comparison -- the honest reading is that this run reproduced attempt 30's exact sample rather than providing an independent isolation. |
| 32 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.65 | 54.1 | PASS | no | round 5 Lever 2: interpolate primary IP-Adapter weight to 0.65 (between attempt 24's 0.6, which kept the profile with a small olive patch, and attempt 26's 0.75, which broke fully front-facing), same attempt-20-bootstrap secondary as attempt 24, no green-emphasis (attempt 30 showed the emphasis phrase pushes toward a flat neon-outlined style, not more saturated colour; attempt 31 is not an independent second confirmation of this, since it reproduced attempt 30's output pixel-for-pixel -- see the footnote below) -- looking for a wider olive/green coat area without losing the pose |

**Footnote -- attempts 30 and 31 are pixel-identical, not two independent data points.** Verified directly with `PIL`/`numpy`: `main_384.png` for attempt 30 and attempt 31 differ by 0 across every RGBA channel at every pixel, despite the two being genuinely separate ComfyUI jobs (`comfyui_prompt_id` `1b6393dc-...` vs `09a0983a-...`, `gpu_seconds` 60.1 vs 54.1, so this is not a duplicate submission or a cache-hit re-run). Decoding each PNG's embedded ComfyUI workflow graph shows *why*: attempt 30's graph has 20 nodes and two `IPAdapterAdvanced` nodes, with `KSampler`'s `model` input sourced from the second one (the T-0273 photo secondary reference at weight 0.4, per row 30's Notes); attempt 31's graph has 18 nodes and one `IPAdapterAdvanced` node, with `KSampler`'s `model` input sourced directly from the primary IP-Adapter node -- no secondary node exists in the graph at all. So in this specific configuration (seed 31416, primary IP-Adapter 0.7, T-0273 photo secondary at 0.4, green-emphasis prompt on), routing the sample through the secondary IP-Adapter node changed nothing detectable in the output. **This does not generalise to "the secondary IP-Adapter is inert"**: attempts 25/27/28 differ from each other only in that same secondary weight (0.45/0.6/0.15 respectively) and their images differ by 32-82 mean-abs over RGB, so the secondary reference clearly does influence output elsewhere in this card's history. The 30/31 identity is a specific, unexplained anomaly at this seed/weight combination, not evidence the lever is dead in general -- see the follow-up list below.
| 33 | 84512 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 69.1 | PASS | no | round 5 Lever 2 seed control: attempt 21's exact recipe (T-0273 photo secondary, inverted, weight 0.4, primary 0.6, no green-emphasis) but a fresh seed (84512, untried) instead of 31416, to check whether the abstract-glow/rainbow collapse seen in attempts 29-32 whenever colour signal is pushed is specific to seed 31416 or structural to this stack |
| 34 | 31416 | 1.0/1.0 | 0.4 | 0.5 | 0.6 | 0.6 | 54.1 | PASS | no | round 5 Lever 2, new untested axis: every attempt across all 4 rounds fixed style_lora_weight at 0.7. The hard black outline + neon rim-glow seen whenever colour signal increases (attempts 24/28-33) is a soviet_brutalism_style_v1 trait at that weight, and is also the likely cause of attempt 28's cutout fragmentation (the outline's near-black tone bridges to the border-background via Oklab-tolerance flood). Testing whether a much lighter style weight (0.4) keeps the profile pose/colour lever from attempt 21's recipe while producing a flatter render the existing cutout can segment cleanly |
| 35 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 69.1 | PASS | no | round 5 Lever 2, refined: attempt 24's exact recipe (attempt-20 bootstrap secondary, no invert) plus the updated green-emphasis negative, which now also negatives the heavy-black-outline/neon-rim-light look diagnosed as the shared cause of both the colour-emphasis style collapse (29-30, 32-34) and attempt 28's cutout fragmentation |
| 36 | 31416 | 0.85/1.0 | 0.7 | 0.5 | 0.6 | 0.6 | 72.1 | PASS | no | round 5 Lever 2, final attempt of this round's budget: lowering ControlNet strength to 0.85 (never tried below 1.0 in 35 prior attempts) on attempt 21's clean-recipe secondary, with the outline/rim-glow-negating green-emphasis prompt, to test whether loosening the skeleton's rigid conditioning reduces the hard-edge/neon-outline collapse seen whenever colour signal is pushed, while still holding the profile pose |

## Round 5 ("vivid green on the profile"): still not achieved, with a newly isolated blocker

Round 5 opened a fresh 8-attempt DL-21 budget (`check_attempt_cap` now allows
29..36, `gen_hybrid_profile_T0272.py:457-474`) and asked for one of three
levers -- (1) crop a costume-bearing side reference from the concept sheet,
(2) iterate the attempt-24 bootstrap harder, (3) a general, palette-driven
recolour of the costume region during descent -- to close the colour gap
round 4 isolated, and to promote once profile + cutout + legible green held
simultaneously. **None of the three closed the gap.** No file was promoted;
`assets/final/character/` still carries no T-0272 keyframe. `pose_rig_profile_T0272.py`
and `char_gen/cutout.py` are both untouched this round (verified: `git diff
--stat 79d88fe..HEAD -- assets/src/character/pose_rig_profile_T0272.py
assets/src/character/src/char_gen/cutout.py` is empty), so the settled rig
and cutout invariants stand.

### Lever 1, re-checked with fresh evidence: still not literally achievable

Round 5's own text named two candidate panels on `player_character_concept_sheet_v1.png`
by approximate pixel box -- "the row-3 panel (approximately x 820-1024, y
500-740)" and "a near-profile panel above it at roughly y 260-490" -- and
explicitly said "look at the sheet and pick the panel yourself rather than
trusting these numbers." Both were opened directly with the Read tool at 3x
scale (`/tmp/panels/round5_candidate_820_500_1024_740.png`,
`/tmp/panels/round5_candidate_820_260_1024_490.png`, not committed --
throwaway inspection crops, not a generated asset). **Both are the sheet's
grey/tan tactical-variant costume tier**, the same panel column
`derive_profile_style_reference_T0272.py` already identified and cropped in
round 4 -- not the green cloth-coat tier. A green-pixel histogram scan across
the whole 1024x1024 sheet (`g > r+8 and g > b+8 and g < 160`, i.e. a broad
olive-to-forest-green band) quantifies this rather than relying on a visual
call alone: both round-5-named boxes, the round-4 derived panel's own box,
and the full rightmost column of the sheet's character rows (y512-704, the
same band the row-3/row-4 side-profile panels sit in) each come in at
**1.0-1.7% green pixels** -- consistent with stray anti-aliasing noise, not a
costume region -- versus **6,000-6,900 green pixels (roughly 15-20x more)**
in the confirmed front-facing green-coat panels the same scan finds in the
sheet's row 1 and row 3 first three columns. There is still no side-profile
or three-quarter panel anywhere on the sheet rendered in the green coat.
Lever 1 is not available to this card, exactly as round 4 found, now with a
quantitative check rather than only a visual one.

### Lever 2: eight new attempts, a newly isolated third failure mode

Attempts 29-36 tested six axes no prior round had tried: reusing a prior
attempt's own output as the secondary bootstrap reference (29), replicating
attempt 21's clean recipe with an attention-weighted colour phrase (30),
attempting to isolate that phrase with no secondary reference at all (31,
though as the footnote under the table details, it reproduced attempt 30's
output pixel-for-pixel rather than achieving a clean isolation), interpolating
primary IP-Adapter weight to 0.65 between the known 0.6/0.75 endpoints (32),
a fresh seed on attempt 21's recipe (33), a much lighter style-LoRA weight
(34), an emphasis prompt that also negatives the heavy-outline/rim-glow look
(35), and a lower ControlNet strength (36) -- see each row's own Notes above
for the full recipe and reasoning. Every `main_384.png` was opened and read
directly, not inferred from the mechanical gate alone.

**The trade-off round 4 isolated persists, along the same two axes:**
whenever a configuration keeps the profile lean (attempts 24, 28-32, 34-36,
all seed 31416, primary IP-Adapter <= 0.65), any costume colour that appears
stays a muted olive/khaki patch, never the vivid saturated green
`player_idle_sheet_hybrid_T0252.png` itself carries. Attempt 33's seed change
(84512) is the one case that produced genuinely vivid, saturated green --
but the resulting figure reads as bilaterally symmetric with two visible
legs and a geometric circuit-board-like leg pattern that resembles neither
the coat's actual silhouette nor a profile stance; a strong colour and a
correct pose have still never co-occurred in the same frame across 36
attempts.

**A third, newly-named failure mode:** attempts 29-35 -- every attempt this
round that carried any costume colour at all, whether via a secondary
reference, a higher primary weight, or the green-emphasis phrase -- collapse
into a flat, hard-black-outlined, neon-rim-lit abstraction: large flat
colour blocks behind a thick black silhouette line and a glowing coloured
halo, rather than the soft-shaded pixel art attempt 21 (this round's one
colourless, clean-recipe replication) produces. This is distinct from the
front-facing collapse (attempts 2, 19, 26-27, 33) and the wrong-subject
collapse (attempts 3, 6, 10-11): it is a rendering-style collapse that
tracks colour signal, independent of whether the pose itself holds --
attempt 33 shows it can co-occur with genuinely vivid, saturated green
(a first for this card) and still fail on identity, since the result reads
as a geometric circuit-board pattern rather than the coat. Two targeted
attempts to suppress the collapse directly both failed: dropping the style
LoRA to 0.4 (attempt 34, versus every other attempt's 0.7) did not remove
the hard outline or rim glow, showing it is not purely a
`soviet_brutalism_style_v1` trait at high weight; explicitly negativing
"heavy black outline, thick black border, neon rim light, glowing outline,
vignette" in the emphasized negative prompt (attempt 35) made the collapse
*more* pronounced (432 fg px of chaotic multi-colour blocks, the largest and
least legible frame of the round) rather than less. The one lever that
visibly softened it -- lowering ControlNet strength to 0.85 (attempt 36,
never tried below 1.0 in 35 prior attempts, still carrying the same
outline-negating emphasis prompt as attempt 35) -- produced the clearest
single-lean silhouette with the least glow of any colour-bearing attempt
this round, but the surviving costume colour was still a small yellow-green
patch (78 fg px total), not a coat-wide vivid green.

One caveat for the record, not load-bearing to the conclusion: attempt 29's
`gpu_seconds` (3.1, versus 48-75s for every sibling) is an implausible
outlier, almost certainly a ComfyUI node-cache hit from being re-run twice in
a row with identical sampler inputs (only the provenance note text differed
between the two runs, fixed by the `f21389b` commit below) -- the same
pattern round 3's attempt 12 footnote already named. The image and gate
numbers are real and were generated fresh on the first of the two runs.

### Lever 3: still not soundly applicable, and why

Round 5 said Lever 3 (a general, palette-driven recolour of the costume
region) was legitimate "if the profile and pose are right and only the hue
is muted" -- but applying it needs a candidate that is simultaneously (a)
genuinely side-facing, (b) survives cutout as one coherent silhouette, and
(c) carries a coat-*wide* muted colour a recolour could plausibly correct,
not a colourless figure (nothing to recolour) or a small isolated patch on
an otherwise white figure (recolouring the patch would not make the coat
read as green, since ~95% of the figure would still be white). No attempt in
this round or any prior round satisfies all three at once:

- Attempt 21 (this card's own cleanest, most-confirmed side-facing
  silhouette, re-confirmed again this round as the closest a `--secondary-concept`
  recipe gets to a clean pose): zero costume colour at all. Nothing for a
  recolour step to key off.
- Attempts 24, 29-32, 34, 36: a small isolated colour patch (53-238 fg px
  total, patch itself smaller still) on an otherwise white/black figure.
  Recolouring the patch's own pixels would not satisfy "recognisably the
  same character... including the green costume" -- it would still read as
  a mostly-white figure with a coloured rectangle on it.
- Attempt 28 (round 4's own best colour-coverage result, an olive coat body
  with a hood and a visible strap, opened again this round at 3x zoom,
  `/tmp/panels/attempt28_zoom.png`, not committed) is the one candidate
  whose colour genuinely covers the coat rather than a patch, and reads as a
  recognisable hooded-coat silhouette with a plausible forward lean --
  exactly what a recolour step would need to start from. It is not usable
  this round for a diagnosed, general reason, not a value judgement: its
  border-connected cutout mask (re-derived this round with the current,
  already-fixed `char_gen.cutout.extract_foreground_mask` --
  `/tmp/panels/attempt28_mask384.png`, not committed) shows the figure's own
  bold black outline stroke bridging, via the Oklab-tolerance flood, to the
  plain background wherever the outline's near-black tone falls inside
  tolerance of a path back to the border -- this eats clean through the
  torso/leg boundary and a diagonal strap, splitting the figure into several
  background-separated islands rather than one blob. That is *why* it
  "fragments into scattered disconnected debris" at 48px (round 4's own
  description, reconfirmed): the mask itself has already lost most of the
  coat before descent, not a downstream palette or descent-step problem a
  recolour could fix.

  Closing this soundly needs the underlying flood to stop treating a
  character's own outline stroke as bridgeable background -- e.g. an
  absolute background-colour-distance test instead of the current
  neighbour-chained Oklab tolerance, so a long chain of gradually-shifting
  anti-aliased pixels can no longer walk from the true background, through
  the outline, into the coat interior. That is a change to
  `border_flood_background_mask` itself, which round 5's own "Do not" list
  says not to regress ("do not... regress `char_gen`'s content-aware cutout
  -- both are settled and T-0259 reuses them") -- correctly read as
  "don't touch it this round," not as permission to attempt a fix without
  the regression-test rigour that change would deserve against every
  existing cutout consumer (T-0252, T-0259, the entity gates). Attempting it
  under this round's time and attempt budget, without that rigour, is a
  worse risk than leaving attempt 28 unpromoted.

### Conclusion and what would actually close this

Two independent, newly-diagnosed causes now stand between this card and a
promotable keyframe, on top of round 4's original colour/pose trade-off:
(1) a colour-signal-triggered rendering collapse into a hard-outlined,
glow-lit abstraction, worsened rather than fixed by the two most
straightforward prompt-level countermeasures tried against it; and (2) a
cutout mask defect specific to frames whose art carries a heavy black
outline near-tolerance-adjacent to the plain background, which is what
stands between attempt 28's coat-wide colour and a usable 48px cell. Neither
is fixable inside this round's own constraints (no LoRA retraining, no
cutout regression). `assets/final/character/` correctly carries no T-0272
file this round either. Follow-ups, in order of what this round's evidence
newly supports:

1. **A cutout enhancement using absolute background-colour-distance
   segmentation** (compare each pixel to a small set of sampled true-border
   colours directly, not neighbour-chained tolerance) instead of, or
   supplementing, `border_flood_background_mask`'s current algorithm --
   scoped as its own card so it gets the regression-test coverage against
   every existing cutout consumer that a change to a "settled" shared
   primitive deserves. This is the one lever this round's evidence points at
   that neither round 4 nor round 5 had actually diagnosed before now, and
   it is the only remaining blocker on attempt 28's own candidate.
2. **A profile-specific costume identity LoRA** (round 3/4's follow-up #1) --
   still out of this card's scope per @DennieSeth's standing direction and
   this card's own "do not retrain any LoRA" instruction.
3. **A genuine side-profile costume concept sheet** (round 3/4's follow-up
   #2) -- still the most direct fix for Lever 1's own gap, unchanged.
4. **Why did the secondary IP-Adapter node have zero measurable effect at
   weight 0.4 on the inverted T-0273 photo, at seed 31416, primary weight
   0.7?** (See the footnote under the round-5 table.) Attempts 30 and 31 are
   pixel-identical despite attempt 30 routing the sample through a second
   `IPAdapterAdvanced` node that attempt 31's graph omits entirely -- yet
   attempts 25/27/28 show the same node's weight *does* move the output
   elsewhere in this card's history. A cheap, zero-new-generation-budget
   first step: diff those two attempts' embedded graphs node-by-node beyond
   just the `IPAdapterAdvanced`/`KSampler` wiring already checked, to see
   whether ComfyUI's own caching silently short-circuited the second
   `IPAdapterAdvanced` node's contribution (e.g. an unconnected downstream
   input, or a weight/strength field that evaluates to a no-op at this
   particular seed) rather than the node genuinely sampling and being
   overridden.

## T-0315 diagnostic: attempts 30/31's pixel-identity resolved -- genuine no-op, NOT a caching artifact

Follow-up #4 above is now closed, at zero new GPU spend, using two sources
that cost nothing to query: (1) `build_graph()` itself is a pure function of
its arguments, so both attempts' submitted graphs can be reconstructed
exactly from the recipe each row's Notes already records, and (2) ComfyUI's
own `/history` endpoint on the dev-box host still held both jobs
(`1b6393dc-2343-4f3e-ba3c-fa1c4d9615c7` for attempt 30,
`09a0983a-8b4b-42cb-884b-7a6892c7a9fc` for attempt 31 -- the full IDs the
existing footnote only truncated), so the graphs actually submitted, and
ComfyUI's own per-node cache/execution log for each job, were read directly
rather than re-derived. No image was regenerated.

**Full node-by-node diff, not just IPAdapterAdvanced/KSampler wiring.**
Comparing every node ComfyUI actually ran (`history[prompt_id]["prompt"][2]`)
for the two jobs: attempt 30 has 20 nodes, attempt 31 has 18; the only nodes
present in one and not the other are `27` (secondary `LoadImage`) and `28`
(secondary `IPAdapterAdvanced`), both present only in attempt 30. Every
other shared node -- both `CLIPTextEncode` nodes (confirming the
green-emphasis prompt text is byte-identical between the two, not just
"probably the same"), `ControlNetApplyAdvanced`, all three `LoraLoader`
nodes, `CheckpointLoaderSimple`, `EmptyLatentImage`, `VAEDecode`, both
`SaveImage` nodes, and the descent `ImageScale` node -- is byte-for-byte
identical. The **only** wiring difference anywhere in the graph is
`KSampler`'s (`21`) `model` input: `["28", 0]` in attempt 30, `["19", 0]`
(the primary IP-Adapter output, skipping the secondary chain) in attempt 31.
This confirms and extends the existing footnote's own partial check (which
only compared the IPAdapterAdvanced/KSampler wiring) to every node in both
graphs.

**Independently re-verified the pixel-identity claim itself**, not just
trusted it: fetched both jobs' `main_384.png` directly from ComfyUI's `/view`
endpoint (`hybrid_profile_T0272_main_384_00031_.png` /
`..._00032_.png`, still present in ComfyUI's own output history) and diffed
them with the same PIL/numpy method the original footnote used --
`max abs diff = 0` across all four RGBA channels, confirming pixel-identity
independently rather than re-stating the merged commit's own claim.

**The decisive new evidence: ComfyUI's own execution log, not just the
graph shape.** Both jobs' `history[prompt_id]["status"]["messages"]` include
an `execution_cached` event listing exactly which node IDs were served from
cache rather than actually executed. For **both** attempt 30 and attempt 31,
the cached node list is identical:
`['1', '10', '11', '12', '26', '13', '14', '15', '16', '17', '18', '19',
'20']` -- the checkpoint, pose skeleton image, style/identity/pose LoRA
loaders, both prompt encodes, the ControlNet loader/apply pair, the primary
concept image and its IP-Adapter loader/apply. **Nodes `27` and `28`
(attempt 30's secondary reference chain) are absent from that cached list --
they were genuinely executed, not served from cache.** `21` (`KSampler`) is
absent from both jobs' cached lists too, confirming both attempts genuinely
resampled rather than reusing a prior sampler output (consistent with both
jobs' real `gpu_seconds`, 60.1 and 54.1 -- nothing like attempt 29's 3.1s
cache-hit outlier).

**Conclusion: this is a genuine no-op, not a caching short-circuit.** The
second `IPAdapterAdvanced` node in attempt 30 really ran, on its own real
input image, at its own real weight (0.4), and produced a real patched-model
object that `KSampler` really resampled from scratch -- and the result was
still bit-for-bit identical to sampling with no secondary patch at all. That
rules out the caching explanation this follow-up was raised to check: **no
prior "the secondary reference had no effect" conclusion in this log needs
to be marked unsound because of a caching bug**, because there was no
caching bug here. What it does newly establish is narrower and still
important: at seed 31416, with `combine_embeds="concat"` and this specific
secondary weight (0.4) on this specific image, a second, genuinely-executed
`IPAdapterAdvanced` node chained onto the model can be a real no-op --
consistent with, not contradicting, the existing footnote's own caveat that
this "does not generalise to 'the secondary IP-Adapter is inert'" (attempts
25/27/28 differ from each other by 32-82 mean-abs specifically because they
vary that same weight against each other). The mechanism inside the
`IPAdapterAdvanced` custom node that makes one particular weight/seed/
`combine_embeds` combination sample to an identical result is outside this
repo's own code (the node itself lives on the ComfyUI host, not in
`assets/src/`) and is not investigated further here -- this diagnostic's
scope was "caching bug or genuine no-op," and the ComfyUI execution log
settles that question directly.

## T-0315 step 3: attempt 28 regenerated and re-cut with the fixed absolute-distance cutout -- still not promotable, for a different, newly-isolated reason

Per this card's own instructions, attempt 28's logged recipe (seed 31416,
ControlNet 1.0/1.0, style LoRA 0.7, identity LoRA 0.5, pose LoRA 0.6,
primary IP-Adapter 0.6, style-reference secondary at 0.15, no invert) was
re-submitted once, deterministically, as a single generation -- not a
sweep. **The regenerated frame is not usable as attempt 28's candidate**:
diffed pixel-for-pixel against the committed evidence copy
(`attempt_28_secondary_reference_colour_lean.png`, the same file
`ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s round-4 section describes), the two
differ completely (max abs diff 255 across the frame) despite every logged
parameter matching exactly -- same seed, same weights, same secondary
reference file (hash-verified identical), same prompt/negative text. The
regenerated image reads as a flat white-torso silhouette with a single
horizontal olive band and a split light-grey/lavender background, with none
of "an olive coat body with a hood and a visible strap" the log's own
description names. Per this card's own instruction ("if the regenerated
frame differs materially from the log's description... say so and stop
rather than promoting something else"), **that regenerated frame is
discarded, not promoted, and not used for anything below** -- this
environment's ComfyUI/GPU stack is evidently not bit-exact reproducible
across separate submissions even with an identical seed and graph (most
likely non-deterministic reduction order in cuDNN/cuBLAS kernels, or a
different attention/memory code path chosen under this session's tighter
VRAM headroom -- 1.5GB free at `/system_stats` time -- than whatever the
original attempt 28 run had available); this is itself worth recording for
any future card that assumes "same seed" alone guarantees a reproducible
regeneration on this dev box.

**Because attempt 28's own raw frame is already committed as verified
evidence** (`docs/assets/evidence/T-0272/attempt_28_secondary_reference_colour_lean.png`,
copied byte-for-byte and sha256-checked in the commit that added it -- see
that directory's own README), the fixed cutout was instead tested directly
against that authentic frame, which is strictly more faithful to "attempt
28's own candidate" than a fresh, non-reproducible roll would have been.

**Result: the fixed cutout is a genuine, correct improvement at the mask
level, and still cannot rescue this specific frame at 48px.** Before/after
masks, all newly committed to `docs/assets/evidence/T-0272/`:

- `attempt_28_cutout_mask_before_fix_384.png` -- the OLD tolerance-chained
  flood's foreground (green), re-derived exactly as round 5 itself
  described: a mostly-solid 24,300px fill, but one that round 5's own
  analysis already showed comes apart into several background-separated
  islands once the outline's near-black tone bridges through it.
- `attempt_28_cutout_mask_after_fix_384.png` -- the NEW absolute-distance
  cutout's foreground (green): a clean, coherent, correctly-traced outline
  of the same hooded-coat-with-strap silhouette the log describes, 5,184px.
  This is the fix working exactly as intended at the mask level -- a
  legible, single silhouette trace, not a solid-but-secretly-fragmented
  blob.
- `attempt_28_cutout_result_after_fix_48_zoomed.png` -- the same frame,
  masked with the fixed cutout, quantized to the home palette, and
  descended to 48x48 (shown zoomed 10x, nearest-neighbour, for legibility).
  **This is not legible as a coat, a hood, or a figure at all** -- scattered
  1-6px specks and slivers, the mechanical gate barely passing on raw count
  alone (54 foreground px against the 50px floor, `background_fraction`
  0.977) while failing the human visual call the card itself requires.

**Why the fix does not close this specific gap, diagnosed rather than just
observed:** attempt 28's own 384px render is heavily soft/blurred, not
crisp pixel art (`docs/design/13-asset-pipeline.md`'s own target style,
which this raw SDXL sample precedes -- the "clean readable pixel outline"
only exists after quantization) -- the actual anti-aliased transition
between coat and background spans many pixels of gradually-blended colour,
not a thin one-or-two-pixel seam. `border_flood_background_mask`'s fix
(absolute distance to sampled *true* border colours) correctly refuses to
let a long chain of small hops walk background all the way into the coat's
solid fill any more -- confirmed above, the 384px mask is now a clean
outline trace, exactly the intended effect. But the *shape* that trace
encloses is, in this specific frame, already thin (a leaning silhouette a
few pixels wide through much of its torso/limb extent at 384px) even before
any cutout is applied. `downscale_mask`'s own area-box-filter +
50%-per-cell threshold (unchanged by this card, not touched per its own
"do not regress `char_gen`'s content-aware cutout" scope for anything
beyond `border_flood_background_mask`'s classification rule) discards any
8x8 source block that is not majority-covered -- and a silhouette only a
few px wide relative to an 8px block fails that threshold throughout most
of its own extent, regardless of how correct the 384px mask boundary is.
This is a **different, newly-isolated blocker** from round 5's own
diagnosis (which named the mask's outline-bridging leak specifically): the
mask defect this card set out to fix is confirmed fixed, and a second,
independent problem -- this frame's silhouette being too thin at native
resolution to survive standard 8x descent -- is what actually stands
between attempt 28 and a usable 48px cell. Widening the descent threshold
or changing `downscale_mask`'s own algorithm is out of this card's scope
(a change to `char_gen`'s shared descent path deserves the same
regression-test rigour as `border_flood_background_mask` got here, against
every consumer that also relies on `downscale_mask`, not a quick tweak
folded into this same commit).

**Conclusion, per this card's own explicit permission:** the fixed cutout
cannot rescue attempt 28 -- not for the reason originally diagnosed
(that defect is fixed, evidenced above), but for a different, newly-named
one (silhouette too thin for standard descent, independent of mask
correctness). `assets/final/character/` still correctly carries no T-0272
file; no substitute frame is promoted in its place. The natural next step
for a follow-up card is the `downscale_mask` threshold/algorithm itself
(e.g. weighting by fractional coverage per cell rather than a hard 50% cut,
or a higher source:target descent ratio for silhouettes this thin) --
scoped as its own change for the same reason the mask fix was scoped
separately from the component-selection layer above it.

## T-0315 round 2: the step-3 conclusion above is unsound -- the real root cause, the fix, and the promotion

Reviewer VALIDATION on round 1 (recorded on the card, not duplicated in full
here) found the "T-0315 step 3" conclusion immediately above **factually
wrong on its own evidence**, and traced why: `border_flood_background_mask`'s
round-1 fix (`cutout.py:130`, `np.unique(oklab[border], axis=0)`) used
*every distinct colour actually present on the frame's own border* as an
independent classification anchor -- 511 distinct Oklab colours on this
exact raw, un-quantized render, because the figure's own black outline
genuinely touches the frame edge in several places (this frame's border
spans the full Oklab lightness range, 0.0 to 1.0, plus a mid-tone
grey-purple background tone -- not a single flat colour). Deduplicating
exact repeats does not bound how *close together* the remaining 511
anchors sit: consecutive anchors averaged little more than one tolerance
apart, so their matching balls (radius `CUTOUT_OKLAB_TOLERANCE` each) still
overlapped, reproducing the exact hop-to-hop bridging defect this card
exists to close -- just relocated from spatial adjacency (the pre-T-0315
defect) to the border's own sample list (round 1's regression). The
regression suite's own 11 baseline fixtures could not see this: every one
is an already-palette-quantized sheet whose border carries exactly ONE
distinct colour (measured directly), so round 1's fix was trivially
equivalent to a correct one on all of them and only diverges on
un-quantized renders -- exactly the case this card's own target frame is.

**The step-3 "silhouette too thin for `downscale_mask`'s descent" claim is
therefore false, not merely superseded.** Re-running the *unchanged*
`downscale_mask` against the **pre-T-0315** mask (the original
tolerance-chained flood, kept in git history) on this same frame yields
**351px at 48x48** -- the descent step was never the blocker. Round 1's own
mask (5,184px foreground, `attempt_28_cutout_mask_after_fix_384.png`) is
also not "a clean, coherent, correctly-traced outline" as originally
written -- it is fragmented and hole-riddled (compare it directly against
`attempt_28_cutout_mask_before_fix_384.png`'s solid silhouette in
`docs/assets/evidence/T-0272/`). Both claims in the step-3 section above are
retracted; the section is left in place, uncorrected in its own text, so
the record shows the actual mistake rather than erasing it. See
`docs/assets/evidence/T-0272/README.md`'s own "T-0315 round 2" caption for
the corrected before/after.

**The fix:** `border_flood_background_mask` now reduces the border's
distinct colours to a small set of *representatives*, each at least
`BORDER_COLOR_MIN_SEPARATION` (2.5x `CUTOUT_OKLAB_TOLERANCE`) from every
other -- greedy, most-frequent-colour-first, so the survivors are the true
dominant border tones, not whichever rare anti-aliasing colour happened to
sort first. 2x tolerance is the strict minimum that guarantees two
representatives' matching balls cannot overlap (centres more than 2x the
ball radius apart); 2.5x adds headroom for the same reason the tolerance
itself carries headroom, and was confirmed empirically stable against this
exact frame (2.5x and 3x resolve to the same handful of genuinely distinct
colour regions and produce materially the same mask; exactly 2x still
leaves visible fragmentation the plateau does not). A new regression
fixture (`test_raw_unquantized_render_does_not_regress_below_pre_fix`,
`tests/test_cutout_absolute_background_distance_T0315.py`) runs this exact
frame through the real consumer pipeline (`extract_foreground_mask` with
`pose_rig_profile_T0272`'s own keypoints, then `downscale_mask`) and asserts
the result never drops below the pre-T-0315 baseline (351px) -- the gap
round 1's baseline suite structurally could not see, now closed. A second
fix, also reviewer-requested: when a frame's border colours span more than
`CUTOUT_OKLAB_TOLERANCE` (this frame: 33x), `border_flood_background_mask`
now raises a `UserWarning` -- a loud, observable signal that the border
isn't a single clean colour and the result should be checked visually,
rather than a silent guess in either direction (the card's own "fail loudly
rather than silently mis-cutting" edge case; the round-1 gradient edge-case
test only asserted the mis-cut region stayed foreground, which is not
loud -- `test_narrow_vignette_and_flat_background_do_not_warn` and the
updated wide-vignette test now assert the warning fires exactly when the
frame is actually ambiguous, not on every call).

**Result: attempt 28 is now legible at 48px and is promoted.** Through the
real production pipeline (`extract_foreground_mask` -> `downscale_mask` ->
`quantize_to_palette` -> `apply_cutout_masks` -> orphan cleanup, exactly
`gen_hybrid_profile_T0272.build_indexed_cell`), this frame now measures
36,392px foreground at 384px (a solid, legible hooded-coat-with-strap
silhouette -- `docs/assets/evidence/T-0272/attempt_28_cutout_mask_round2_384.png`)
and 529px at 48x48 after quantization/cleanup, 4 connected components,
mechanical gate PASS (`background_fraction` 0.770). Visually legible at 40px
as a hooded olive-drab coat with a visible strap, matching attempt 28's own
logged description ("an olive coat body with a hood and a visible strap")
closely enough to promote. The 384px source is attempt 28's own frame --
the already-committed, sha256-verified evidence copy, re-cut with the fixed
mask -- since a fresh same-seed regeneration (step 3 above) did not
reproduce it bit-exactly and was correctly discarded rather than promoted.
Promoted: `assets/final/character/player_profile_keyframe_hybrid_T0272.png`
+ `.provenance.json`.

**Attempt 28 summary (seed 31416, ControlNet 1.0/1.0, style LoRA 0.7,
identity LoRA 0.5, pose LoRA 0.6, primary IP-Adapter 0.6, style-reference
secondary 0.15, 72.1 GPU-s): re-cut with the fixed absolute-background-
distance cutout (round 2: minimum-separated border-colour clustering,
correcting round 1's "every distinct border colour" regression on this
exact un-quantized frame); frame recovered from the committed, hash-
verified evidence copy since original scratch was reaped and a same-seed
regeneration did not reproduce bit-exactly (see T-0315 step 3 above).
Mechanical gate PASS at every round (2, 3, 4). Promoted round 2, replaced
round 3, un-promoted round 4 -- see that section below for why: the mask is
now genuinely correct, but the frame's own colour content does not read as
the logged "coat-wide olive colour" at 40px, a defect no cutout-mask fix can
close.**

## T-0315 round 3: round 2's own reviewer FAIL, closed -- greedy set-cover by border pixel mass

Reviewer VALIDATION on round 2 found the promotion immediately above **not
"a true RGBA cutout, character only"** as Step 3 requires: the promoted
529px file's second-largest component (129px, 24.4% of the foreground, bbox
x29-34/y2-45 at 48px) is a background-coloured region incorrectly retained
as foreground. Root cause, precisely diagnosed: `BORDER_COLOR_MIN_SEPARATION`
(round 2's fix) chose representatives by a minimum *separation* (>= 2.5x
tolerance apart), which guarantees the accepted set is spread out but never
guarantees every rejected colour ends up within classification range of one
of them. Measured on this exact frame: 222 of 511 sampled border colours
(259 of 1,532 actual border pixels) sat strictly between 1x and 2.5x
tolerance from every accepted representative -- excluded from candidacy by
the separation floor, but too far to classify as background under any
survivor. Those pixels never seeded the flood, so the region of true
background connected only through them was retained as foreground.

**The fix:** `_representative_border_colors` now chooses representatives by
GREEDY SET COVER over border pixel MASS: repeatedly take the most-frequent
still-uncovered colour, mark every colour (and the border pixels it
accounts for) within tolerance of it as covered, and continue until
`BORDER_COLOR_COVERAGE_TARGET` of the frame's own border pixels are covered
(95%, a new named constant, not literal 100%) or a representative cap is
hit (64, warning loudly if reached).

**Why not literal 100% coverage.** This was tried first, against this exact
frame, and measured to be actively worse than round 2's own bug: the
frame's figure legitimately touches the frame border along most of one edge
(the coat's own black outline and its neon rim-glow run the full right
edge; the coat's hem touches the bottom edge directly), with a wide, gradual
anti-aliased blend, not a thin seam (border spread 33x tolerance). Chasing
every last, most-blended border sample into coverage requires
representatives packed closely enough across that whole span that some end
up within tolerance of genuine, non-border figure colours elsewhere in the
frame -- specifically the coat's own pale hood/shoulder fill, which sits
close in Oklab space to the pale end of that same blend. Measured result:
48px foreground collapsed from round 2's 529px to 117px, *below* even the
pre-T-0315 351px baseline, with the hood visibly swept into background
(`docs/assets/evidence/T-0272/README.md`'s own round-3 section has the
full before/after). A strong pixel-mass MAJORITY (95%) closes round 2's
actual regression instead: the frame's dominant true-background tone is
always covered within the first handful of representatives (coverage
proceeds most-frequent-colour-first), without chasing the rarest,
most-blended samples that caused the sweep.

**On round 2's own "component 2 is background" finding, more precisely.**
Direct pixel inspection of the corresponding region in the raw frame
(`docs/assets/evidence/T-0272/README.md`'s round-3 section has the crop)
shows it is not flat background at all: it is the coat's own back-edge trim
-- a black outline stroke with the render's own neon rim-glow (already
named in round 5's own "Lever 3" analysis as a `soviet_brutalism_style_v1`
trait at this weight), a white accent shape, and a row of small blue
rivet-like dots -- correctly a separate connected component from the main
torso (the same "a real figure often splits into several parts" property
`extract_foreground_mask`'s own module docstring already documents), not a
spurious background sweep. What round 2's reviewer measured as "8,982px
background" at 384px was almost entirely the TRUE grey-purple background to
the right of this trim (x272-357 of their cited x223-357 range), which
round 2's own bug also failed to correctly seed from the border in that
specific region -- both things were true at once: a real coverage gap
existed (closed by this round's fix, verified by
`test_border_coverage_meets_its_own_target_on_the_real_diagnostic_frame`
and `test_no_surviving_raw_component_is_background_coloured`), and the
specific component that survives in both round 2's and round 3's final
529px/452px files is genuine character trim, not the bug itself.

**Result: attempt 28 remains promoted, through the round-3 fix.** Through
the real production pipeline, this frame now measures 31,108px foreground
at 384px (`docs/assets/evidence/T-0272/attempt_28_cutout_mask_round3_384.png`)
and 452px at 48x48 after quantization/cleanup, 6 connected components,
mechanical gate PASS (`background_fraction` 0.804). Every component above a
5px noise floor was checked directly against the raw frame's own dominant
border colour and confirmed meaningfully distant from it (not background-
coloured) -- the property round 2's own regression suite could not
distinguish ("more foreground survived" is satisfied equally by genuine
recovered detail and by a spurious background blob; this round adds a test
that checks colour, not just count). Legible at 40px as a leaning, hooded,
olive-drab coat with a visible strap, matching attempt 28's own logged
description closely enough to promote.

## T-0315 round 4: round 3's own reviewer FAIL, closed -- majority-overlap component selection, and a second, independent, unfixable-here blocker

Reviewer VALIDATION on round 3 re-traced its own "component 2/3 are the
coat's own back-edge trim" claim (the paragraph immediately above) against
the actual pixel content and found it backwards: those components are 62.6%
and 61.4% flat grey-blue background, with essentially no black outline and
no white accent (0.1-0.9% each) -- the opposite of round 3's own
characterisation. Round 3's fix (greedy set-cover, closing round 2's
separation-floor gap) was real, but it was solving a problem one layer
below the actual defect.

**Root cause, finally isolated correctly.** `border_flood_background_mask`
was never the bug in rounds 2 or 3 -- it was already correctly classifying
these background panels as non-background (they are their own disjoint
components, never merged with the true border-connected background flood).
The bug is one layer up, in `extract_foreground_mask`'s component-selection
rule: `overlapping_labels = [lbl for lbl, ov in overlaps.items() if ov > 0]`
kept a component if it overlapped the keypoints hint AT ALL, however small
that overlap. Measured directly on this frame: a genuinely disjoint
8,427px-at-384px background-panel component survived in full because a mere
698px of it (8.3%) happened to fall inside the hint's own bbox+margin. That
one component alone accounts for the bulk of both round 2's 129px and round
3's 207px retained-background defects -- both rounds were re-tuning
`border_flood_background_mask`'s colour classification (separation floor,
then coverage target) to chase a bug that was never in that function.

**The fix:** `extract_foreground_mask` now requires a component's own area
to be at least `MIN_HINT_OVERLAP_FRACTION` (50%) inside the hint before
keeping it on overlap grounds, falling back to the old "any overlap"
behaviour only when nothing clears that bar, and to the largest component
when nothing overlaps at all. A real limb/head split from the torso by an
outline seam (T-0272 round 4's own regression, `test_multi_part_figure_
survives_whole_when_every_part_overlaps_hint`) sits with the overwhelming
majority of its own area inside the hint and is unaffected; a large decoy
mostly outside the hint, grazing it by a sliver, is now dropped
(`test_component_barely_grazing_the_hint_is_excluded`, RED-verified against
round 3's code before the fix).

**Result, mask now correct.** Through the real production pipeline, this
frame now measures 17,144px foreground at 384px
(`docs/assets/evidence/T-0272/attempt_28_cutout_mask_round4_after_384.png`)
and 248px at 48x48 after quantization/cleanup, 3 connected components, 98.8%
in the single largest one (245px) -- verified both by the component-overlap
maths above and by direct visual inspection: no floating background bar
beside the figure, unlike rounds 2 and 3's own promotions. Mechanical gate
PASS (`background_fraction` 0.892). This is *fewer* raw pixels than round
3's 452px -- deliberately: round 3's extra 204px were exactly the retained
background this round removes, not recovered character detail. The old
regression test asserting "48px foreground must not drop below 351px"
(flagged as a non-discriminating monotone bound since round 1, never fixed)
is replaced with a majority-largest-component-share assertion that this
figure was chasing all along.

**Second, independent finding: attempt 28 still cannot be promoted.** With
the mask now genuinely correct, the promoted candidate's own colour content
is measurable on its own terms for the first time. Of its 248 foreground
pixels, only 24 (10%) quantize to the home palette's own "green family"
slots (2, 3, 5, 7, 9, 11); the other 224 (90%) quantize to the neutral ramp
(`docs/assets/evidence/T-0272/attempt_28_palette_index_histogram_round4.png`).
This is not a quantization-nearest-neighbour artifact of a good green
render landing badly -- sampled directly on the un-quantized raw frame, the
coat's own main body fill sits closer in Oklab space to the palette's
neutral ramp than to any green-family swatch. Composited over a dark
backdrop for a fair read (transparency against plain white washes out
perceived saturation), the fixed cutout reads as a grey-taupe silhouette
with a few dark-olive flecks near the collar -- independently corroborating
round 3's own reviewer finding on this exact point ("the figure reads as a
grey slab with a few dark-olive flecks... not the 'coat-wide olive colour'
this card exists to ship"), which this round's mask fix does not and cannot
move, because it is not a mask defect. `border_flood_background_mask` and
`extract_foreground_mask` classify *which* pixels are character; they have
no way to change what colour those pixels already are.

**Decision: not promoted.** `player_profile_keyframe_hybrid_T0272.png` and
its provenance sidecar (added round 2, replaced round 3) are removed from
`assets/final/character/` rather than promoted a third time on a colour
basis that a second independent check (this round's own palette-index
measurement, corroborating round 3's reviewer) says will not read as the
logged "coat-wide olive colour." This returns the file to the state it was
in before T-0315 began -- absent, exactly as T-0272's own original 8
attempts left it -- per this card's own instruction: "If the fixed cutout
still cannot rescue attempt 28, say so with the before/after masks as
evidence and stop." The cutout fix itself (both the round-1-3 absolute-
distance rework and this round's majority-overlap selection) is real,
tested against every listed consumer, and kept.
