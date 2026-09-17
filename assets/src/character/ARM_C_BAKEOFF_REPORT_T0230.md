# Arm C bake-off report (HANDOFF §23-f) -- the script (T-0230)

**Author:** Claude (Sonnet 5)
**Card:** T-0230 -- Arm C of the T-0227 character-pipeline bake-off (DL-21, `docs/decision-log.md`)
**Cost template:** `docs/decisions/T-0227-bakeoff-cost-record-template.md` (copied below, row filled)

## Result

**Pass on attempt 1 of 8.** No diffusion model anywhere in the generation path.
`char_gen.synth_entities.generate_player_idle_sheet_arm_c` (extended in this card from the
existing entity-sheet module, `assets/src/character/src/char_gen/synth_entities.py`) draws a
real articulated player figure -- head, neck, torso, two-segment arms (upper arm + swinging
forearm), two-segment legs (thigh + weight-shifting shin) -- directly into a 3x3 grid of
48x48 index arrays, using the home palette's own indices (`BG_IDX`/`HEAD_IDX`/`BODY_IDX`/
`LEG_IDX`) as literal constants in the drawing code. No image is ever rendered to RGB and
then quantised down to indices; the indices are correct from the moment they're assigned.

Per-frame pose (head-bob, arm-swing, leg weight-shift) is chosen from six hand-verified
9-value idle-cycle patterns, each checked by construction to have no adjacent-frame step
greater than 1px -- `random.Random(seed)` picks one pattern per motion channel, so a given
seed always selects the same three patterns and the same pixels, but the DL-21 criterion-2
frame-delta cap cannot be blown by *any* seed, not just the one that happened to be tried.
Driven by `gen_arm_c_idle_T0230.py --attempt 1 --seed 23230 --promote`: attempt 1 rendered
the sheet, re-rendered it a second time from the same seed and confirmed the two renders are
byte-identical (`determinism.passed: true`, matching sha256 in
`player_idle_sheet_arm_c_T0230.provenance.json`), ran the full mechanical gate (palette
membership, index semantics, cell-fit, orphan pixels, frame-consistency), and passed all of
it on the first try. Promoted to `assets/final/character/player_idle_sheet_arm_c_T0230.png`.
Full attempt trace: `ARM_C_ATTEMPT_LOG_T0230.md`; provenance:
`player_idle_sheet_arm_c_T0230.provenance.json`; judging preview:
`arm_c_judging_preview_T0230.gif`.

**Criterion 1 self-assessment (silhouette @ 40px in motion, visual review of the judging
preview).** Is it a person: yes -- a round head, a distinct torso, two arms bent at the
elbow, and two legs that stay visibly separated in every frame (the initial draft let the
legs' shins touch and merge into one blob at the extreme weight-shift offset; the thigh gap
was widened from 2px to 3px specifically to keep two legs visible in every frame -- see the
commit history on `_draw_player_arm_c`). Which way is it facing: unambiguously toward the
camera -- the figure is always rendered front-on by construction, so there is no orientation
for the pose to get wrong, unlike a diffusion sample that can turn a shoulder the wrong way.
What is it doing: standing idle, with a small breathing head-bob and a natural weight shift
between the two legs. This is a self-assessment, not §23-g's ratification -- the judging
preview and promoted sheet are delivered for that separate step, per DL-21's own note that
§23-g consumes the arms' output.

**Criterion 2.** Mechanical gate: PASS, all 8 adjacent-cell transitions well inside the 0.30
cap (ratios 0.072-0.112, see the table below) -- comfortably passing, not marginal, because
every per-frame offset is bounded to +/-1px by the pattern pool rather than tuned close to
the cap. Human drift verdict: PASS by construction -- the torso, head silhouette, and limb
attachment points never move; only small, bounded joint offsets change between frames, so
there is no possible reading of "identity drift" the way SDXL's row-to-row costume/palette
drift produced in Arm A/B.

## The table

| Arm | Criterion 1 (silhouette @ 40px in motion) | Criterion 2 (identity stable) | Attempts-to-first-pass | GPU minutes | Wall-clock | $ | Sheet | Provenance sidecar | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Arm C (§23-f, the script) | PASS | PASS | 1/8 | 0.0 | 00:14 | $0.00 | `assets/final/character/player_idle_sheet_arm_c_T0230.png` | `assets/final/character/player_idle_sheet_arm_c_T0230.provenance.json` | **Criterion 1** PASS: reads as a standing front-facing person at 40px in `arm_c_judging_preview_T0230.gif` (self-assessment; final ratification is §23-g's). **Criterion 2** PASS: all 8 adjacent-cell silhouette-delta ratios well inside the 0.30 cap -- (0,0)->(0,1) 0.072, (0,1)->(0,2) 0.111, (0,2)->(1,0) 0.072, (1,0)->(1,1) 0.112, (1,1)->(1,2) 0.072, (1,2)->(2,0) 0.111, (2,0)->(2,1) 0.072, (2,1)->(2,2) 0.112 (`ARM_C_ATTEMPT_LOG_T0230.md`, `player_idle_sheet_arm_c_T0230.provenance.json`'s `frame_deltas`) -- plus the identity-stable-by-construction argument above. **Attempts-to-first-pass 1/8**: no exploratory search was needed or possible -- the figure's geometry and the pose-pattern pool's safety bound are correct by inspection of the committed drawing code, not by re-rolling a seed and hoping; one iteration was needed on the geometry itself (the initial thigh gap let two legs merge into one blob at the extreme weight-shift offset, fixed by widening the gap from 2px to 3px) but this was a code change made and verified *before* logging attempt 1, not a discarded numbered attempt -- the same "corrected before its first real evaluation" bookkeeping convention Arm A used for its own attempt-1 cache hit. **GPU minutes (0.0)**: no GPU anywhere in the pipeline -- CPU-only PIL/numpy array assignment, confirmed in `gpu_seconds`/`gpu_minutes_note` in the provenance sidecar. **Wall-clock (00:14)** = measured from `git reflog`'s branch-creation timestamp (2026-08-28T13:26:00+02:00, `feature/T-0230` cut from `develop`) to the implementation commit that produced the passing, promoted sheet (2026-08-28T13:40:23+02:00, `feat(assets): Arm C player idle sheet`) -- both are real git timestamps, not estimates (DL-21's no-back-filled-estimates rule). This window includes reading the DL-21/§23-c/Arm A/B precedent, designing the figure geometry, writing the RED test file, implementing, and iterating on the leg-gap fix -- i.e. the entire arm, not just "the script's runtime" (which is sub-second and would understate the real cost of standing this arm up). Time spent afterward writing this report, the judging preview, and the provenance-registry entry is not included in this figure per the same "committed sheet" cutoff Arm A/B used, and is CPU-only regardless. **$ ($0.00)**: local CPU only, no rented compute -- no electricity/opportunity-cost caveat needed the way Arm A/B's local-GPU rows required, since there is no GPU utilisation to discount. |

## Reading for §23-g

Arm C is the cheapest arm by a wide margin on every criterion-3 column -- zero GPU minutes
against Arm A's 28.0 and Arm B's 165.5, and a wall-clock measured in minutes against Arm B's
hours -- and it is also the only arm that passed criterion 1 and criterion 2 on its first
counted attempt, because there was no sampling noise to fight: the figure's silhouette,
facing, and per-frame motion bounds are guaranteed by the committed drawing code, not
discovered by trial and error against a model. Per DL-21's decision rule, Arm C both wins on
cost among the criterion-1-passing arms (Arm A is eliminated at criterion 1 per its own
report; Arm B passes both criteria but at far higher cost) and would win the tie-break even
if cost were equal. The trade a reader should weigh against this: Arm C's articulated figure
is visibly simpler and less detailed than Arm B's SDXL-rendered soldier (no equipment
silhouette, no uniform texture, no distinguishing gear) -- §23-g is judging silhouette
clarity and motion at 40px, not detail, but that trade-off should be seen, not just totalled
in a cost column.
