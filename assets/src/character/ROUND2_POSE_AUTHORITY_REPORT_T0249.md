# Round-2 pose-authority report — T-0249 (HANDOFF §24-b, reframed §24.4)

**Author:** Claude (Sonnet 5)
**Card:** T-0249 — round 2 of the T-0227 character-pipeline bake-off, per
@DennieSeth's authorship override (`BAKEOFF_DECISION_T0231.md`) that continues
the generative path even though Arm C already passed and was cheaper. §24.4
reframes this card's mechanism: **the script becomes the pose authority** —
it emits a deterministic OpenPose-format 18-keypoint COCO skeleton per frame
(reusing Arm A's `draw_pose_skeleton_cell` renderer unchanged, not
re-authored) and every frame is generated as its own 384×384 image,
conditioned only on that frame's skeleton, with an identical seed/prompt/
initial-latent across all nine frames. Motion is authored; appearance is
generated. Runs stacked **on top of** §24-a's `player_identity_v2`
(T-0248), not against v1 — Limit 2 below records this explicitly so §24-a's
own contribution isn't masked.

## Result

**Mechanical gate: PASS. Arm C benchmark: NOT beaten.**

The best measured attempt (attempt 3, seed 31416, ControlNet strength
1.3/1.0, style-LoRA weight 0.7, identity-LoRA weight 0.5) produced a
frame-delta range of **0.0522–0.2573** across all 8 adjacent-cell
transitions — comfortably inside the round-2-unchanged **0.30 cap**
(DL-21 criterion 2), but well outside **Arm C's 0.072–0.112** benchmark
range, which remains the real bar per the round-2 rules (HANDOFF §24.3).
**This attempt clears the 0.30 gate; it does not beat the 0.072–0.112 bar.**
Promoted to `assets/final/character/player_idle_sheet_pose_authority_T0249.png`.

## Attempts (3 of 8 used, per `ARM_POSE_AUTHORITY_ATTEMPT_LOG_T0249.md`)

| Attempt | Recipe | Frame-delta range | Gate | vs. Arm C |
|---|---|---|---|---|
| 1 | seed 31416, CN 1.3/1.0 | n/a (crashed mid-frame-1, no measurement) | INCOMPLETE | n/a |
| 2 | seed 31416, CN 1.3/1.0 (resume of 1) | n/a (killed by this implementer's own `timeout 590` wrapper at frame 8/9, a tooling artifact not a ComfyUI/gate failure) | INCOMPLETE | n/a |
| **3** | seed 31416, CN 1.3/1.0, style 0.7, identity 0.5 | **0.0522–0.2573** | **PASS** | no (max 0.2573 > 0.112) |
| 4 | seed 31416, CN **1.5**/1.0 (raised strength — Limit 1 test) | 0.0278–0.2720 | PASS | no (max 0.2720 > 0.112, worse than attempt 3) |
| 5 | seed **31420**, CN 1.3/1.0 (seed-sensitivity check, same recipe as Arm B's own precedent) | 0.1935–0.3576 | **FAIL** (max 0.3576 > 0.30) | no |

Two directions were tried against attempt 3's passing baseline before
stopping: raising ControlNet strength (attempt 4, seed held constant) and
changing seed (attempt 5, strength held constant). Neither improved on
attempt 3 — attempt 4's max ratio is slightly worse (0.272 vs. 0.257) and
attempt 5 fails the gate outright, reproducing the same seed-sensitivity
pattern Arm B (T-0229) saw against its own identical-skeleton recipe
(`ARM_B_ATTEMPT_LOG_T0229.md`: seeds 31417/31420 both badly failed there
too). Attempt 3 is promoted as the best of the three measured, passing
attempts. 5 of the 8-attempt cap were used (2 incomplete/uninformative +
3 measured); the cap was not exhausted — stopping here is a judgement call
that further seed/strength search had diminishing expected return given the
pattern in attempts 3–5, not a forced stop.

## Two honest limits (recorded, not papered over)

**Limit 1 — a pose skeleton is strong conditioning, not absolute control.**
Even with ControlNet strength at 1.3 (the same value Arm B needed to
suppress its own idle swing against an *identical* per-cell skeleton),
adjacent-frame silhouette drift here ranges up to 0.257 — well under the
0.30 cap, but nowhere near Arm C's 0.072–0.112. Raising strength further to
1.5 (attempt 4) did not help; it marginally worsened the max ratio. This is
consistent with the mechanism's own design: unlike Arm B's shared grid
(one identical skeleton tiled nine times), the pose-authority skeleton
*legitimately varies* frame to frame (breathing/weight-shift), so some of
the measured delta is the intended, authored motion itself, not drift —
but the gate cannot separate "authored motion" from "model
inconsistency" and does not need to: **the frame-delta gate is the
arbiter**, not the mechanism's principle, and by that gate this mechanism
passes but does not beat the benchmark.

**Limit 2 — this does not address costume drift.** All five attempts ran
against `player_identity_v2` (T-0248's single-costume retrain), never
`player_identity_v1` — `test_identity_lora_is_v2` in the gate suite pins
this. §24-a's contribution is therefore not masked by this card, but this
card also does not independently improve on it: costume/identity stability
is §24-a's job, not this one's.

## Rig generalisation

The same rig generator (`pose_rig_T0249.py`'s `keypoints_for_frame` /
`render_pose_frame`) drives a second state — **move** — purely from
different committed numbers in `pose_rig_T0249.json` (`stride_extent_norm`
0.09 vs. idle's 0.0, larger weight-shift, lighter breathing), with no code
change. Evidence: nine rendered skeletons + their keypoint JSON under
`assets/src/character/pose_rig_move_evidence_T0249/`, committed. **This is
procedural evidence only** — no SDXL sampling was run for `move`, and the
generalisation is honestly bounded: today the rig only *offsets* Arm A's
standing-idle base pose, so it can drive an idle-with-stride variant, not a
true mid-stride walking gait, without also authoring a new base pose for
that state. Crouch-hide and die were not attempted at all — extending to
those would need their own base poses authored first, which is out of this
card's scope.

## Directability

Breathing amplitude, weight-shift extent, stride extent, cycle counts,
phase offset and easing are all committed, editable numbers in
`pose_rig_T0249.json`, not constants buried in `pose_rig_T0249.py` — see
that file's own docstring/`_comment` fields for what each number controls.

## Cost (recorded, not deciding — per the round-2 override)

- **Attempts-to-first-pass:** 3/5 measured (attempt 3 is the first and best
  pass); 2 further attempts (1–2) were spent on incomplete/crashed runs that
  produced no measurement, and are not counted as failed measured results,
  but do count against the 8-attempt cap since real ComfyUI submissions were
  made in both.
- **GPU-minutes:** 31.8 (sum of the three *measured* attempts' `gpu_seconds`:
  664.1 + 621.8 + 624.9 = 1910.8s, from `ARM_POSE_AUTHORITY_ATTEMPT_LOG_T0249.md`).
  Attempts 1–2's GPU time is not separately instrumented (both were
  interrupted before the script's own `gpu_seconds` timer completed) and is
  not back-filled with an estimate, per the same no-back-filled-estimates
  convention Arm A's own cost report used for its un-instrumented time — it
  is bounded within the wall-clock window below, not added on top of it.
- **Wall-clock:** ~01:04 (2026-08-29 23:39 – 2026-08-30 00:44 local, from
  attempt 1's first ComfyUI submission to attempt 5's completion, file
  timestamps). Includes all five attempts (2 incomplete, 3 measured) plus
  the between-attempt recipe changes; excludes the code/test-authoring time
  that produced this card's RED/GREEN commits (90fba48/8b8bfae), which
  predates this session's attempts.
- **$:** $0.00 (local GPU, hardware already owned — the entire premise of
  @DennieSeth's round-2 override).

See `BAKEOFF_COST_TABLE_T0231.md`'s round-2 section for this card's row,
copied verbatim from this section per that file's own convention.

## Bottom line

The pose-authority mechanism **works as designed and clears the round-2
gate** (0.30 cap) on its first fully-measured attempt, with no exploratory
search beyond a single ControlNet-strength probe and a single
seed-sensitivity check. It does **not** beat Arm C's 0.072–0.112 benchmark,
and per the round-2 rules that is reported plainly rather than reframed as
a win: **this attempt beat the 0.30 gate, not the 0.072–0.112 bar.** Arm C
remains both the benchmark and the shipping fallback should round 2 close
without a result that beats it.
