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
