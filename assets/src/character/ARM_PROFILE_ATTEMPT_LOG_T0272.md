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
