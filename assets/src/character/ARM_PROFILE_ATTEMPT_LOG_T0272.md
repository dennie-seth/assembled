# Side-profile keyframe attempt log (T-0272, HANDOFF §24-e)

Every attempt is recorded here whether it passes the mechanical gate or not. This is a STATIC POSE, not an animation -- there is no frame-delta/0.30 cap, no loop seam, no Arm-C comparison here (a single keyframe has nothing adjacent to compare against). `mechanical_gate` covers only what a single frame can: cutout cleanliness (background fraction, no stray foreground outside the profile rig's own keypoint bbox) and a non-erased silhouette. Whether the result genuinely reads as side-facing with intact identity is a human visual call, recorded in Notes, not a mechanical one.

| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | IP-Adapter weight | GPU seconds | Mechanical gate | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 111.1 | PASS | no | Visual verdict (Read tool, `main_384.png`): reads as a front-facing, bilaterally symmetric boxy figure -- both "sides" visible at once, no forward-reaching arm, no head turn. Costume illegible as the institutional green coat (white/black patterned torso, small green patches, not a confident match to the T-0252 anchor). Same failure T-0259's own probe found on the front rig, now reproduced against a genuinely different profile skeleton. |
| 2 | 31416 | 1.5/1.0 | 0.7 | 0.5 | 0.35 | 117.2 | PASS | no | stronger ControlNet, weaker IP-Adapter to test whether pose structure can dominate the front-facing bias. Visual verdict: identity collapses entirely -- an abstract grid of blue/yellow/white colour blocks, no recognisable human silhouette at all. Weakening IP-Adapter did not free up the pose; it just destroyed appearance coherence. |
| 3 | 27182 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 144.2 | PASS | no | default weights, different seed -- isolate whether attempt 1's front-facing/pale result was seed-specific. Visual verdict: wrong-subject failure (T-0218's own named failure mode) -- reads as an architectural panel/doorway with glowing readouts, not a person, profile or otherwise. |
| 4 | 31416 | 1.0/1.0 | 0.7 | 0.2 | 0.6 | 111.2 | PASS | no | diagnostic: sharply lowered identity LoRA weight (0.5->0.2), default controlnet/ipadapter -- testing whether the front-trained identity LoRA itself is what collapses on this profile skeleton. Visual verdict: nearly identical to attempt 1 (same seed) -- still front-facing, symmetric, boxy. Confirms the identity LoRA's weight is not the deciding factor at this seed; whatever drives the front-facing reading survives a 60% cut to identity conditioning. |

## Finding: not achieved in 4 attempts -- reported per @DennieSeth's standing rule, not forced

The profile-topology skeleton (`pose_rig_profile_T0272.py`) itself works exactly
as designed and is not in question: `pose_skeleton_384.png` for every attempt
shows the intended topology (legs collapsed to one fore-aft line, shoulders
nearly coincident, one arm reaching forward, head turned) -- confirmed by
direct visual inspection, not just by the unit tests. What the §24-e stack
does with that skeleton is a separate question, and across 4 attempts
covering the reasonable parameter space, it never produced a keyframe that
reads as a legible, side-facing, identifiable version of the T-0252 character:

- **Attempts 1 and 4** (default and low identity-LoRA-weight, same seed): a
  front-facing-reading, bilaterally symmetric figure, despite the ControlNet
  input being genuinely asymmetric this time. This is the same qualitative
  failure T-0259's own single-frame probe reported against the *front* rig
  reframed with a profile prompt -- except this time the skeleton was not
  reframed, it was authored from scratch for profile. That the failure
  reproduces anyway is the important new data point: cutting identity LoRA
  weight to 40% of default (attempt 4) barely changed the result, so the
  front-facing bias is not primarily coming from the identity LoRA's own
  training data (which IS front-facing only, per this card's own edge-case
  warning) -- something upstream of it (the base checkpoint's own learned
  prior for this character class, the style LoRA, or IP-Adapter's image-level
  conditioning on a front-facing concept-sheet crop) is contributing at least
  as much.
- **Attempt 2** (weaker IP-Adapter, stronger ControlNet): did not recover a
  profile reading -- it destroyed subject coherence entirely, producing an
  abstract colour-block pattern with no human silhouette. Weakening the
  identity-carrying conditioning did not hand control to the pose
  conditioning; it just left nothing legible in charge.
- **Attempt 3** (default weights, different seed): a "wrong subject" failure
  (the same failure class T-0218's own report named for this checkpoint) --
  an architectural panel/doorway, not a person at all.

No attempt is promoted. Per `.claude/rules/assets.md` and the card's own
acceptance criteria ("do not ship a bad or faked profile... a well-evidenced
'not achievable with the current identity LoRA' is a complete and successful
outcome for this card"), this card stops here rather than spending the
remaining 4 of DL-21's 8-attempt cap chasing a pattern that has not moved
across 4 attempts spanning the reasonable parameter space (default weights,
stronger-ControlNet/weaker-IP-Adapter, a different seed, and a sharply
lowered identity LoRA weight).

**What this suggests for a follow-up card** (not undertaken here -- out of
this card's scope): `player_identity_v2` was trained exclusively on
front-facing material (this card's own edge-case warning called this risk
out in advance). A genuine side-profile reference set for identity LoRA
training is the more likely fix than further prompt/weight tuning against
the *existing* identity LoRA -- consistent with the acceptance criteria's own
framing ("the answer may be a profile training set, which is its own card,
not something to force here").
