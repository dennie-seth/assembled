# T-0419 evidence: character-gate on merit

**Author:** Claude (assets agent)

Card: make `character-gate` green on merit for the six crouch/die/move
sheets `player_crouch_hide_sheet_v{1,2}`/`player_die_sheet_v{1,2}`/
`player_move_sheet_v{1,2}`, and honestly resolve the walk's two failures.
Authoritative command (run from `tools/asset-gate/`):

```
.venv/bin/python -m asset_gate.cli character-gate ../../assets/final --repo-root ../../
```

## Before (T-0359's own state, PR #422 HELD)

The exact 14 `[FAIL]` lines this card started from are already committed
verbatim in `tools/asset-gate/src/asset_gate/character_motion_class_baseline.txt`'s
own "AFTER-2" section (T-0359's own before/after record) -- not re-pasted
here to avoid two sources of truth for the same text. Total: **14 `[FAIL]`
lines**, exit code 1.

## What this card did

**Group A -- the 6 crouch/die/move sheets.** Per sheet, per the sidecar's
own `generator` record:

| sheet | generator | route taken |
|---|---|---|
| `player_crouch_hide_sheet_v1` | `char_gen.synth_states.generate_crouch_hide_sheet` (procedural, no diffusion model, no rig ever existed) | **recovered** -- `char_gen.rig_recovery_T0419.crouch_hide_frame_keypoints` transcribes `_draw_crouch_frame`'s own body/head/leg pixel-range constants into per-frame COCO-18 keypoints |
| `player_die_sheet_v1` | `char_gen.synth_states.generate_die_sheet` (procedural) | **recovered** -- `die_frame_keypoints`, same transcription approach |
| `player_move_sheet_v1` | `char_gen.synth_states.generate_move_sheet` (procedural) | **recovered** -- `move_frame_keypoints`; the sheet's own 2 documented spare/blank cells ((3,1),(3,2)) get every joint collapsed to the cell centre, recording "no pose" rather than inventing one |
| `player_crouch_hide_sheet_v2` | `gen_states_v2_tiled.py` (T-0213, SDXL, single tiled prompt, confirmed via `grep -n "controlnet\|pose\|keypoint" gen_states_v2_tiled.py` -- no ControlNet/pose conditioning anywhere) | **no rig ever existed to recover** -- regeneration is the only honest route; not attempted this run, see "Group A v2" below |
| `player_die_sheet_v2` | `gen_states_v2_tiled.py` (same as above) | same as above |
| `player_move_sheet_v2` | `gen_states_v2_tiled.py` (same as above) | same as above |

**Group B -- the walk.** Untouched, per the card's own explicit instruction
not to re-sample it. See "Walk (Group B)" below.

**The gate itself is unchanged.** `git diff develop...HEAD -- tools/asset-gate/src/`
shows no change to any check's logic or thresholds (verified below).
`character_motion_class_baseline.txt` gains no new entries (verified below)
-- T-0359's merge already removed every entry this card's 6 sheets used to
occupy; this card adds none back.

## After (this card's own HEAD)

**13 `[FAIL]` lines**, exit code 1 (down from 14 -- one fewer, never more).
Every `[FAIL]`/`[PASS]` line touching a Group A sheet or the walk,
captured verbatim:

```
[FAIL] character_motion_fidelity: character/player_crouch_hide_sheet_v1.provenance.json: motion_class='transition' pose-fidelity IoU floor 0.4486 < 0.7, identity-stability distance 0.8750 > 0.15 [recomputed live from the sheet's own pixels + versioned rig keypoints, not the sidecar's recorded range]
[FAIL] character_part_identity: character/player_crouch_hide_sheet_v1.provenance.json: worst per-region palette-histogram distance vs frame 0's own per-part pixels 0.8750 > cap 0.4 [recomputed live from the sheet's own pixels + versioned rig keypoints, per named region (head/torso/near_limb/far_limb), each frame compared against frame 0's own real per-part pixels -- never a rig silhouette]
[PASS] character_motion_score_binding: character/player_crouch_hide_sheet_v1.provenance.json: motion_score_binding matches the sheet's current content, rig/config version, palette and evaluator, and the recorded score agrees with a fresh pixel recompute
[FAIL] character_motion_fidelity: character/player_crouch_hide_sheet_v2.provenance.json: motion_class='transition' requires recomputing pose-fidelity/identity-stability from the sheet's own pixels + versioned rig evidence, but no 'frame_generation' is declared -- a locomotion/transition/loop asset must never fall back to trusting the sidecar's own self-reported scores (T-0357 Codex PR review 2026-09-11, P1)
[FAIL] character_part_identity: character/player_crouch_hide_sheet_v2.provenance.json: motion_class='transition' requires recomputing part identity from the sheet's own pixels + versioned rig evidence, but no 'frame_generation' is declared -- a locomotion/transition/loop asset must never fall back to trusting the sidecar's own self-reported scores (T-0361, mirroring T-0357's own P1 fix)
[FAIL] character_motion_fidelity: character/player_die_sheet_v1.provenance.json: motion_class='transition' pose-fidelity IoU floor 0.4067 < 0.7, identity-stability distance 0.1875 > 0.15 [recomputed live from the sheet's own pixels + versioned rig keypoints, not the sidecar's recorded range]
[PASS] character_part_identity: character/player_die_sheet_v1.provenance.json: worst per-region palette-histogram distance vs frame 0's own per-part pixels 0.2689 <= cap 0.4 [recomputed live from the sheet's own pixels + versioned rig keypoints, per named region (head/torso/near_limb/far_limb), each frame compared against frame 0's own real per-part pixels -- never a rig silhouette]
[PASS] character_motion_score_binding: character/player_die_sheet_v1.provenance.json: motion_score_binding matches the sheet's current content, rig/config version, palette and evaluator, and the recorded score agrees with a fresh pixel recompute
[FAIL] character_motion_fidelity: character/player_die_sheet_v2.provenance.json: motion_class='transition' requires recomputing pose-fidelity/identity-stability from the sheet's own pixels + versioned rig evidence, but no 'frame_generation' is declared -- a locomotion/transition/loop asset must never fall back to trusting the sidecar's own self-reported scores (T-0357 Codex PR review 2026-09-11, P1)
[FAIL] character_part_identity: character/player_die_sheet_v2.provenance.json: motion_class='transition' requires recomputing part identity from the sheet's own pixels + versioned rig evidence, but no 'frame_generation' is declared -- a locomotion/transition/loop asset must never fall back to trusting the sidecar's own self-reported scores (T-0361, mirroring T-0357's own P1 fix)
[FAIL] character_motion_fidelity: character/player_move_sheet_v1.provenance.json: motion_class='locomotion' pose-fidelity IoU floor 0.0000 < 0.7, identity-stability distance 1.0000 > 0.15 [recomputed live from the sheet's own pixels + versioned rig keypoints, not the sidecar's recorded range]
[FAIL] character_part_identity: character/player_move_sheet_v1.provenance.json: worst per-region palette-histogram distance vs frame 0's own per-part pixels 1.0000 > cap 0.4 [recomputed live from the sheet's own pixels + versioned rig keypoints, per named region (head/torso/near_limb/far_limb), each frame compared against frame 0's own real per-part pixels -- never a rig silhouette]
[PASS] character_motion_score_binding: character/player_move_sheet_v1.provenance.json: motion_score_binding matches the sheet's current content, rig/config version, palette and evaluator, and the recorded score agrees with a fresh pixel recompute
[FAIL] character_motion_fidelity: character/player_move_sheet_v2.provenance.json: motion_class='locomotion' requires recomputing pose-fidelity/identity-stability from the sheet's own pixels + versioned rig evidence, but no 'frame_generation' is declared -- a locomotion/transition/loop asset must never fall back to trusting the sidecar's own self-reported scores (T-0357 Codex PR review 2026-09-11, P1)
[FAIL] character_part_identity: character/player_move_sheet_v2.provenance.json: motion_class='locomotion' requires recomputing part identity from the sheet's own pixels + versioned rig evidence, but no 'frame_generation' is declared -- a locomotion/transition/loop asset must never fall back to trusting the sidecar's own self-reported scores (T-0361, mirroring T-0357's own P1 fix)
[FAIL] character_motion_fidelity: character/player_walk_sheet_hybrid.provenance.json: motion_class='locomotion' pose-fidelity IoU floor 0.3935 < 0.7, identity-stability distance 0.3203 > 0.15 [recomputed live from the sheet's own pixels + versioned rig keypoints, not the sidecar's recorded range]
[PASS] character_part_identity: character/player_walk_sheet_hybrid.provenance.json: worst per-region palette-histogram distance vs frame 0's own per-part pixels 0.3516 <= cap 0.4 [recomputed live from the sheet's own pixels + versioned rig keypoints, per named region (head/torso/near_limb/far_limb), each frame compared against frame 0's own real per-part pixels -- never a rig silhouette]
[FAIL] character_motion_score_binding: character/player_walk_sheet_hybrid.provenance.json is missing or has a malformed motion-score-binding field(s): motion_score_binding, pose_fidelity_range, identity_stability_range -- a recorded locomotion/transition/loop motion score must be bound to the sheet's content hash, rig/config version, palette hash and evaluator version (T-0360)
```

13 `[FAIL]` lines total (verified: `grep -c '^\[FAIL\]'` on the full command
output). Full output (all 137 lines, including every non-character-class
sheet the gate correctly skips) is reproducible by re-running the
authoritative command above; not pasted in full here since every line not
shown above is an unrelated `[PASS]` this card did not touch.

## Per-sheet result, on merit

- **`player_crouch_hide_sheet_v1`** -- recovered rig evidence.
  `character_motion_fidelity` FAILS (pose-fidelity IoU floor 0.4486 < 0.70
  cap; identity-stability distance 0.8750 > 0.15 cap). `character_part_identity`
  FAILS (worst per-region distance 0.8750 > 0.40 cap). `character_motion_score_binding`
  PASSES. **Why it fails on merit:** this sheet is a flat rectangular
  colour-block figure (body/head/leg rectangles, no limb geometry), and the
  gate's capsule-rig prediction is a thin skeleton line — a thin predicted
  silhouette against a thick real block silhouette does not reach 0.70 IoU,
  and the head visibly descending into/through the body core across 9
  frames (by design, `_draw_crouch_frame`'s own comment: "head inside body"
  by step 5) changes what a fixed near/far-limb region actually contains
  frame to frame, which is exactly what `character_part_identity` measures.
- **`player_die_sheet_v1`** -- recovered rig evidence.
  `character_motion_fidelity` FAILS (IoU floor 0.4067 < 0.70; identity
  distance 0.1875 > 0.15, only marginally over). `character_part_identity`
  **PASSES on merit** (worst per-region distance 0.2689 <= 0.40 cap) -- the
  die sheet's head moves diagonally but never overlaps the body core the
  way crouch's head does, so its named regions stay far more self-similar
  across frames. `character_motion_score_binding` PASSES.
- **`player_move_sheet_v1`** -- recovered rig evidence.
  `character_motion_fidelity` FAILS at the extreme (IoU floor 0.0000;
  identity distance 1.0000). **Root cause, not a bug:** this sheet's own
  `layout` is a 3x4 grid (12 cells) but only 10 are real walk frames -- 2
  are the sheet's own pre-existing documented spare/blank cells (`(3,1)`,
  `(3,2)`, T-0199). A blank frame has zero foreground pixels; no non-empty
  rig can score IoU above 0 against genuine blankness once a boundary
  capsule is drawn at all (`render_rig_silhouette` always draws something),
  so the honest keypoints for those 2 frames (all 18 joints collapsed to
  the cell centre, in the module's own documented convention for "no pose
  to report") measure a real, deserved 0.0 against the min() floor across
  all 12 frames. This is not fabricatable around: any other choice of
  keypoints for a blank cell is either the same degenerate result or an
  invented pose where none exists. `character_part_identity` FAILS
  (1.0000 > 0.40) for the identical reason -- the blank frames' named
  regions have no content to compare against frame 0's real content.
  `character_motion_score_binding` PASSES.

## Group A v2 (`player_crouch_hide_sheet_v2`, `player_die_sheet_v2`, `player_move_sheet_v2`) -- not attempted this run

All three are T-0213's `gen_states_v2_tiled.py` SDXL bake-off sheets: a
**single tiled prompt**, no ControlNet, no per-frame skeleton, no rig of
any kind (confirmed: `grep -n "ControlNet\|controlnet\|pose\|keypoint\|OpenPose" gen_states_v2_tiled.py`
returns only prompt-text substrings like "no action poses other than
falling" -- never an actual conditioning node). There is nothing to
recover: no rig ever produced these pixels. Per this card's own acceptance
criteria, **regeneration through a rig-driven path is the only honest
route** -- and per the edge case "state the GPU cost before starting it
rather than discovering it midway," that cost is stated here, before
starting, rather than discovered mid-card:

- The walk (`player_walk_sheet_hybrid`, T-0259/T-0266) is this repo's own
  working example of what a rig-driven regeneration of a comparable sheet
  costs: **6 tuning attempts** (attempts 1-3 independent-per-frame sampling,
  all failed the 0.30 frame-delta cap; attempt 4 the img2img-chain fix that
  finally passed the mechanical cap; attempts 5-6 additional denoise
  checks), **801.7 GPU-seconds for attempt 4 alone** (8 frames), and even
  that promoted attempt still fails `character_motion_fidelity` on the real
  pose/identity thresholds this card also measures. `pose_rig_walk_T0259.py`
  + `gen_hybrid_walk_T0259.py` together are **1,327 lines** of dedicated
  rig-authoring + generation infrastructure, built across two separate
  cards (T-0259, T-0266).
- Building an equivalent pipeline for crouch-hide and die (each a
  9-frame, one-directional transition rather than a repeating gait --
  plausibly simpler to rig than a walk gait, but unproven) would mean
  authoring two more dedicated pose-rig + generation scripts of comparable
  scope, then driving each through multiple GPU attempts to reach a
  complete (not necessarily passing) sheet: a reasonable estimate, scaled
  from the walk's own attempt-4-alone cost, is **on the order of
  1,000-3,000 GPU-seconds (17-50 minutes) per sheet**, not counting the
  engineering time to author each new rig script and the near-certain need
  for multiple tuning attempts (the walk needed 6).
- `player_move_sheet_v2` is a harder case than "another transition": its
  own motion (a repeating walk-gait cycle) is the same kind of motion the
  already-shipped `player_walk_sheet_hybrid` represents. Regenerating it
  through a genuinely independent rig-driven pipeline would either
  duplicate the walk's own rig (making the result a near-duplicate asset)
  or require inventing a materially different walk cycle to justify a
  second, separate sheet's existence -- a product/asset-inventory question
  (does the game need two independently-authored walk-cycle sheets?)
  outside this card's scope to decide.
- **No client, server, or `shared/` code references any of these 6 sheets**
  (verified: `grep -rl "player_move_sheet\|player_crouch_hide_sheet\|player_die_sheet"`
  across the repo returns only this card's own gate/test/provenance
  machinery -- no `client/**`, `server/**`, or `shared/**` hit). Nothing
  downstream depends on these sheets existing in their current form, so
  there is no urgency forcing an under-resourced regeneration this run.

**Recommendation:** size the v2 regeneration as its own dedicated
follow-up card(s) per motion (mirroring how T-0259/T-0266 got dedicated
cards for the walk), rather than folding a multi-session GPU effort into
this gate-clearing card. Their `character_motion_fidelity`/
`character_part_identity` FAILs remain exactly as documented in the
"Before" state -- unchanged, not silently punted: `missing_rig_evidence`,
truthfully, because no rig evidence exists to declare.

## Walk (Group B) -- not re-sampled, per this card's own instruction

`player_walk_sheet_hybrid` remains exactly as T-0359 left it. Its two
`[FAIL]`s are real and current:

- `character_motion_fidelity`: pose-fidelity IoU floor 0.3935 < 0.70;
  identity-stability distance 0.3203 > 0.15.
- `character_motion_score_binding`: no `motion_score_binding`/
  `pose_fidelity_range`/`identity_stability_range` has ever been
  self-reported to bind (T-0357's own recompute is what reports the real
  numbers above; nothing has claimed a score, so there is nothing to bind
  yet, and inventing one to bind would be exactly the fabrication this
  card must not do).

This sheet is the shipped T-0266 walk, accepted by @DennieSeth on
2026-09-11 as an **explicit interim placeholder** so T-0235/T-0328 had a
stand-in for engine integration -- it is not the game's walk and has never
been claimed to be. Its real replacement is **T-0338**, the Tier-2 part
compositor, whose entire premise (pose fidelity exact and identity
invariant by construction) is exactly what these two failing metrics
measure. T-0338 has not landed a replacement walk sheet as of this run
(`git log --oneline --all | grep -i T-0338` finds no commit); these two
failures remain outstanding, reported honestly, not re-sampled per this
card's own explicit instruction (13 sessions of T-0259 already proved
frame-by-frame re-sampling does not converge).

## Gate-unchanged verification

```
git diff origin/develop...HEAD -- tools/asset-gate/src/ \
  ':(exclude)tools/asset-gate/src/asset_gate/character_motion_class_baseline.txt'
```
returns empty (no output) -- no check's `.py` logic or threshold changed,
anywhere under `tools/asset-gate/src/`.

`character_motion_class_baseline.txt` itself DOES differ from
`origin/develop` (149 diff lines) -- entirely T-0359's own merged-in
change, not this card's: it removed 18 of its 19 list entries (every
non-walk sidecar T-0359 accurately labelled) and rewrote its own comments
to document why, keeping only `character/player_walk_sheet_hybrid.provenance.json`
listed (T-0359's own explicit note explains it stays listed as a reviewed
historical record even though the missing-label check it names no longer
does anything for that sidecar). **This card's own commits add zero new
entries to that file** -- verified directly against the file's own
committed list, not just by inspection of this card's diff.

## Outcome

**Not fully green.** Per the card's own "Done when" criterion, the
remaining `[FAIL]` lines are **not only** the walk's two -- 6 Group-A v2
`[FAIL]` lines (2 checks x 3 sheets) also remain, each because no rig
evidence exists to recover and regeneration was deliberately not attempted
this run (GPU cost stated above, per the edge case). Every remaining
`[FAIL]` is named, with its own real evidence or its own stated reason for
being deferred: **3 real, on-merit numeric failures** (crouch-hide,
move, plus the walk's own pre-existing one) and **1 real, on-merit
numeric partial success** (die's part-identity passes), **6 real
`missing_rig_evidence` failures** (the 3 v2 sheets x 2 checks, honestly
reported, not baseline-exempted), and **the walk's own 2 outstanding
failures**, named with T-0338 as their mechanism per this card's own
instruction.

## gitleaks

No agent persona currently holds a grant to execute `~/.local/bin/gitleaks`
(per this card's own acceptance note). Not run; not claimed. This round's
new content (recovered keypoint JSON files, provenance edits, test edits,
this evidence doc) contains no secret-shaped strings by inspection --
keypoint files are plain numeric coordinate lists, provenance edits are
hashes/booleans/prose, and no credential, token, or key material was
introduced.
