# T-0423: Figure-panel per-part SAM3 cutouts

Extends T-0417's per-part SAM3 cutout machinery (proved on the "legs" panel
only) to the five whole-figure panels, per T-0338's own part-to-joint chain
("upper arm, lower arm+hand, upper leg, lower leg+boot, head, torso/coat").
This card produces head/torso/arm parts; legs were already done by T-0417
and are reported below only as an unregressed baseline.

> ## WARNING FOR T-0338 -- read before consuming any part by name
>
> T-0338 reads these parts **by name**, so this warning has to live here,
> not only in a review thread. Two mechanically-isolated parts are **not**
> what their name claims:
>
> - **`front_tpose/right_upper_arm`** is mechanically `isolated: true` but
>   **46.9% of its own retained pixels lie past the elbow** -- it is the
>   upper arm AND the forearm, combined. Do **not** consume it as an
>   `upper_arm`; rotating it at the shoulder will carry the forearm with it.
> - **The front `head`** (`front_tpose/head`) keeps the face/goggles but
>   **omits the surrounding hood** visible in the source crop. Do **not**
>   treat it as a complete hooded head.
>
> See "Mechanical isolation vs. anatomical suitability" below for the full
> per-part table and every other part's own status. Only **5 of the 8**
> mechanically-isolated figure-panel parts are anatomically usable by name
> -- see that section for which five.

All evidence files (masks, overlays, prompts, descended PNGs, provenance)
live under `docs/assets/evidence/T-0417/`, same `EVIDENCE_DIR` the machinery
already wrote to -- this card extends the mechanism in place rather than
forking a second evidence directory for the same `part_comparison.json`.
The full machine-readable record is
`docs/assets/evidence/T-0417/part_comparison.json`.

Code: `assets/src/character/gen_master_sheet_part_cutouts_T0417.py`
(`_build_figure_part_specs`, `PARTS_BY_PANEL`, `SIBLING_PART_PAIRS_BY_PANEL`,
`_NON_PART_NEGATIVE_JOINTS_BY_PANEL`). Tests:
`assets/src/character/tests/test_gen_master_sheet_part_cutouts_T0423.py`.

**FIX ROUND (2026-10-01, Chat's review of PR #426):** anatomical-suitability
check, new and purely additive, computed offline from the evidence already
committed above -- no SAM3/GPU/ComfyUI re-run, no mask/count/threshold/
isolation-verdict change. Code:
`assets/src/character/src/char_gen/part_suitability.py`
(`beyond_distal_joint_fraction`, `is_combined_with_next_segment`),
`assets/src/character/assess_figure_part_suitability_T0423.py` (the report
script that produced the table in "Mechanical isolation vs. anatomical
suitability" below). Tests:
`assets/src/character/tests/test_part_suitability_T0423.py`.

## Design decision: the torso anchor

`PartSpec` only expressed a one- or two-joint anchor; the torso's natural
anchor (NECK to the *hip midpoint*) is a three-point derivation. Resolved
by extending `PartSpec` with a third, explicitly-named field,
`joint_b_pair: tuple[int, int] | None`: when set, the anchor is
`midpoint(joint_a, midpoint(*joint_b_pair))`. The torso spec is
`PartSpec("torso", "", "torso_coat", _NECK, joint_b_pair=(_R_HIP, _L_HIP))`
-- anchored on the true hip midpoint, not approximated by a single hip
joint. See `PartSpec`'s own docstring and
`TestTorsoAnchorDesignDecision` in the T-0423 test module.

## Per-panel part sets (explicit, stated)

| panel | parts requested | why |
|---|---|---|
| `front_tpose` | head, torso, right_upper_arm, right_lower_arm, left_upper_arm, left_lower_arm | both arms spread clear of the torso -- full figure, both sides visible |
| `back_tpose` | same six as `front_tpose` | T-pose is bilaterally symmetric; `back_tpose = mirror_keypoints_lr(front_tpose)` lands within float tolerance of the same positions (`pose_rig_master_sheet_T0351`'s own module docstring) -- front and back T-pose are not different topologies, so the same joint-index convention applies to both (see "back_tpose handedness" below) |
| `side_right_forward` | head, torso, right_upper_arm, right_lower_arm | true profile, right side forward/near; the far (left) arm is held back close to the body -- excluded from this panel's set up front, never requested |
| `side_left_forward` | head, torso, left_upper_arm, left_lower_arm | mirror of `side_right_forward`; left is the near side, right arm excluded up front |
| `side_neutral` | head, torso, right_upper_arm, right_lower_arm | true profile, same near-right-side camera convention as `side_right_forward` (confirmed: its own eye/ear keypoints are copied verbatim from `side_right_forward`'s) |

## back_tpose handedness

`front_tpose` is bilaterally symmetric (every joint pair's x-coordinates
sum to 1.0), so mirroring it changes nothing numerically -- `back_tpose`'s
keypoints equal `front_tpose`'s within float round-trip tolerance. This
module therefore applies the *same* joint-index -> part-key convention to
both panels rather than adding a mirrored branch; pinned by
`TestBackTposeHandednessConvention` in the test module.

## Per-panel negative-point rule

T-0417's `_LEGS_ONLY_PANEL_KEYS` special case (a single NECK "collapse
point" negative, since the legs panel's own rig collapses the whole upper
body to one point -- not real anatomy on that panel) is generalized into
`_NON_PART_NEGATIVE_JOINTS_BY_PANEL`, a per-panel rule:

- **legs**: unchanged -- NECK is still not real anatomy on that waist-down
  crop.
- **the five figure panels**: both ANKLE joints are added as negatives.
  Legs ARE real anatomy on a figure panel, but they are not one of this
  card's parts (head/torso/arms only) -- same purpose (keep a part mask
  from bleeding into anatomy outside this card's scope), different reason
  (real-but-out-of-scope, not not-real).

## Results

One `SAM3_Detect` call per part throughout (never batched), same structural
shape T-0417 proved for legs -- see
`TestSeparateSam3CallPerFigurePart`/`TestBuildSam3PartWorkflowIsCalledSeparatelyPerPart`.
All-pairs overlap rejection (`_evaluate_overlaps`/`_apply_overlap_rejection`,
unmodified from T-0417's own FIX ROUND finding 3) is reused as-is -- a part
is only ever marked `isolated` when it is present, not stray-rejected, and
not overlap-rejected against any other present part in the same panel.

**Evidenced limitation, reported honestly, not retuned**: the coat/torso
occludes an arm (and vice versa) on several panels, exactly the hard case
the card calls out up front. No threshold or adjacency pairing was adjusted
to force a pass.

### legs (T-0417, unregressed baseline -- not reproduced by this card)

| part | present | isolated | fg_px (raw -> after) | stray_fraction | note |
|---|---|---|---|---|---|
| right_upper_leg | yes | **yes** | 31799 -> 22945 | 0.278 | |
| right_lower_leg | yes | **yes** | 18254 -> 14170 | 0.224 | |
| right_boot | yes | **yes** | 8673 -> 6747 | 0.222 | |
| left_upper_leg | no | n/a | 0 | n/a | empty detection, as T-0417 originally recorded |
| left_lower_leg | no | n/a | 0 | n/a | empty detection, as T-0417 originally recorded |
| left_boot | yes | **yes** | 5505 -> 5081 | 0.077 | |

Same six verdicts T-0417 originally committed -- confirms this card's
changes do not regress the legs panel.

### front_tpose

| part | present | isolated | fg_px (raw -> after) | stray_fraction | overlap-rejected | note |
|---|---|---|---|---|---|---|
| head | yes | **yes** | 5696 -> 5527 | 0.030 | no | |
| torso | no | n/a | 0 | n/a | n/a | empty detection |
| right_upper_arm | yes | **yes** | 29982 -> 29077 | 0.030 | no | |
| right_lower_arm | no | n/a | 0 | n/a | n/a | empty detection |
| left_upper_arm | no | n/a | 0 | n/a | n/a | empty detection |
| left_lower_arm | no | n/a | 0 | n/a | n/a | empty detection |

2/6 isolated. Both arm *lower* segments and the torso returned empty on
this run; head and the one upper arm that did detect are clean.

### back_tpose

| part | present | isolated | fg_px (raw -> after) | stray_fraction | overlap-rejected | note |
|---|---|---|---|---|---|---|
| head | yes | **yes** | 7046 -> 7046 | 0.000 | no | |
| torso | no | n/a | 0 | n/a | n/a | empty detection |
| right_upper_arm | yes | no | 27536 -> 10850 | **0.606** | no | rejected on stray-fraction grounds (> 0.35 tolerance) |
| right_lower_arm | yes | **yes** | 16488 -> 15330 | 0.070 | no | |
| left_upper_arm | no | n/a | 0 | n/a | n/a | empty detection |
| left_lower_arm | yes | **yes** | 18441 -> 16648 | 0.097 | no | |

3/6 isolated. Best figure-panel result besides `side_left_forward`.

### side_right_forward

| part | present | isolated | fg_px (raw -> after) | stray_fraction | overlap-rejected | note |
|---|---|---|---|---|---|---|
| head | yes | no | 38175 -> 32783 | 0.141 | **yes** | overlaps right_upper_arm (frac 0.052, zero non-adjacent tolerance -- head/upper_arm share no joint) |
| torso | yes | **yes** | 128748 -> 126159 | 0.020 | no | |
| right_upper_arm | yes | no | 13955 -> 9336 | **0.331** | **yes** | stray fraction itself is under 0.35 but close, and also overlaps head |
| right_lower_arm | yes | no | 30213 -> 16533 | **0.453** | no | rejected on stray-fraction grounds alone |

1/4 isolated (torso only). `left_upper_arm`/`left_lower_arm` were never
requested -- excluded from this profile panel's own set up front, the far
arm held back close to the body.

### side_left_forward

| part | present | isolated | fg_px (raw -> after) | stray_fraction | overlap-rejected | note |
|---|---|---|---|---|---|---|
| head | yes | no | 5301 -> 4391 | 0.172 | **yes** | overlaps left_upper_arm (frac 0.008, zero non-adjacent tolerance) |
| torso | yes | no | 37987 -> 36653 | 0.035 | **yes** | overlaps left_upper_arm (frac **0.392** > 0.25 joint-blur tolerance -- the coat swallowing the upper arm, the card's own expected hard case) |
| left_upper_arm | yes | no | 10546 -> 7560 | 0.283 | **yes** | same torso overlap, both parts marked per the "reject both sides" rule |
| left_lower_arm | yes | **yes** | 11176 -> 11158 | 0.002 | no | |

1/4 isolated (left_lower_arm only). `right_upper_arm`/`right_lower_arm`
were never requested -- excluded up front, the far arm held back.

### side_neutral

| part | present | isolated | fg_px (raw -> after) | stray_fraction | overlap-rejected | note |
|---|---|---|---|---|---|---|
| head | yes | **yes** | 4118 -> 4118 | 0.000 | no | |
| torso | yes | no | 43005 -> 13605 | **0.684** | **yes** | both stray-rejected AND overlaps both arms -- the worst single result this card produced |
| right_upper_arm | yes | no | 13661 -> 11439 | 0.163 | **yes** | overlaps torso (frac 0.369 > 0.25 joint-blur tolerance) |
| right_lower_arm | yes | no | 20386 -> 19471 | 0.045 | **yes** | overlaps torso (frac 0.194, zero non-adjacent tolerance -- torso/lower_arm share no joint) |

1/4 isolated (head only). This panel's `right_lower_arm` run also hit a
real thermal-gate refusal (T-0422, GPU at the 75.0C ceiling) mid-attempt;
the gate was never bypassed, and the part was re-run with `--part` once the
reading cleared (see the FIX ROUND commit below).

## Summary across the five figure panels

**Two independent counts, never conflated into one.** "Isolated" below is
the *mechanical* verdict only -- a connected, non-stray, non-overlapping
mask (`char_gen.part_isolation`). It says nothing about whether the mask
actually contains the complete, correct part and nothing else. See
"Mechanical isolation vs. anatomical suitability" immediately below this
table for the second, independent count -- **anatomically usable by
name** -- and exactly which mechanically-isolated parts fail it.

| panel | isolated / requested (mechanical only) |
|---|---|
| front_tpose | 2 / 6 |
| back_tpose | 3 / 6 |
| side_right_forward | 1 / 4 |
| side_left_forward | 1 / 4 |
| side_neutral | 1 / 4 |
| **total** | **8 / 24 mechanically isolated** |

**Head isolates cleanly on 3 of 5 panels** (`front_tpose`, `back_tpose`,
`side_neutral`) **-- not 4 of 5.** Both forward-side heads
(`side_right_forward`, `side_left_forward`) are present but
overlap-rejected; a prior draft of this README miscounted them as one
rejection. (Corrected 2026-10-01 -- see FIX ROUND 2 below.) Torso isolates
*mechanically* on exactly 1 of 5 (`side_right_forward`) -- but that one
mechanical pass is itself only a coat-fold strip, not the complete
torso/coat (see below); every other panel's torso either stray-failed,
overlapped an arm, or both, consistent with the card's own framing that
coat-over-torso occlusion is genuinely harder than legs. Arm segments are
the most inconsistent: several detect empty entirely (no coordinates ever
produced a mask), several detect but bleed into a sibling, and one
(`front_tpose/right_upper_arm`) detects as a single clean mechanical
component that is nonetheless the wrong anatomical extent -- see below.

## Mechanical isolation vs. anatomical suitability

**FIX ROUND 2 (2026-10-01, Chat's review of PR #426).** Mechanical
isolation (above) and anatomical/compositor suitability are independent
axes. A part can be one clean connected component, zero stray, zero
overlap, and still not be usable under its own name -- because it includes
content past the joint that is supposed to bound it, or because it's
visually missing part of what its name claims. Computed by
`assess_figure_part_suitability_T0423.py`, offline, from the mask PNGs and
`part_comparison.json` already committed above -- no value in that JSON is
read differently or written to by this section.

| panel | part | present | isolated (mechanical) | suitability | reason |
|---|---|---|---|---|---|
| front_tpose | head | yes | yes | **incomplete** | face/goggles retained, surrounding hood omitted |
| front_tpose | torso | no | n/a | n/a | not present (empty detection) |
| front_tpose | right_upper_arm | yes | yes | **combined** | 46.9% of retained pixels lie past its own elbow (x=235) -- includes the forearm, not compositor-ready as `upper_arm` |
| front_tpose | right_lower_arm | no | n/a | n/a | not present (empty detection) |
| front_tpose | left_upper_arm | no | n/a | n/a | not present (empty detection) |
| front_tpose | left_lower_arm | no | n/a | n/a | not present (empty detection) |
| back_tpose | head | yes | yes | adequate | visually complete hooded head |
| back_tpose | torso | no | n/a | n/a | not present (empty detection) |
| back_tpose | right_upper_arm | yes | no | mechanically rejected | 1.3% beyond its own elbow -- stray/noise failure, not a combined-part failure |
| back_tpose | right_lower_arm | yes | yes | adequate | beyond-wrist metric n/a (see below) -- forearm+hand shape, proportionate |
| back_tpose | left_upper_arm | no | n/a | n/a | not present (empty detection) |
| back_tpose | left_lower_arm | yes | yes | adequate | beyond-wrist metric n/a -- forearm+hand shape, proportionate |
| side_right_forward | head | yes | no | mechanically rejected | overlap-rejected AND visually poor -- fragmentary hood streamers, not a usable head shape either way |
| side_right_forward | torso | yes | yes | **partial** | a strip of coat fold, not the complete torso/coat |
| side_right_forward | right_upper_arm | yes | no | mechanically rejected | 21.8% beyond its own elbow (also elevated, already excluded for stray/overlap reasons) |
| side_right_forward | right_lower_arm | yes | no | mechanically rejected | beyond-wrist metric n/a |
| side_left_forward | head | yes | no | mechanically rejected | overlap-rejected AND visually poor -- fragmentary, not a usable head shape either way |
| side_left_forward | torso | yes | no | mechanically rejected | coat mask extends into the swallowed `left_upper_arm` |
| side_left_forward | left_upper_arm | yes | no | mechanically rejected | 0.0% beyond its own elbow -- failure is the torso overlap, not combined-ness |
| side_left_forward | left_lower_arm | yes | yes | adequate | beyond-wrist metric n/a -- compact forearm+glove shape, proportionate |
| side_neutral | head | yes | yes | adequate | visually complete small hood/head shape |
| side_neutral | torso | yes | no | mechanically rejected | 68.4% stray AND overlaps both arms -- the worst single result this card produced |
| side_neutral | right_upper_arm | yes | no | mechanically rejected | 0.0% beyond its own elbow -- failure is the torso overlap, not combined-ness |
| side_neutral | right_lower_arm | yes | no | mechanically rejected | beyond-wrist metric n/a |

**Totals: 24 requested, 8 mechanically isolated, 5 anatomically usable by
name.** The 8 mechanical passes are unchanged from the count above. Of
those 8, three are mechanically clean but anatomically unusable under
their own name (bold above: `front_tpose/head` incomplete,
`front_tpose/right_upper_arm` combined, `side_right_forward/torso`
partial) -- **these are the parts T-0338 must not consume as-is**, see the
warning at the top of this document. The five that are both mechanically
isolated and anatomically usable by name: `back_tpose/head`,
`back_tpose/right_lower_arm`, `back_tpose/left_lower_arm`,
`side_left_forward/left_lower_arm`, `side_neutral/head`.

**Both mechanically-rejected heads were also checked visually** (the
edge case "a mechanically-rejected part that is nonetheless anatomically
fine" -- plausible for an overlap-rejected head in principle). For this
run, neither `side_right_forward/head` nor `side_left_forward/head` is: both
raw SAM3 detections are fragmentary, dangling streamer shapes, not a usable
head silhouette either before or after isolation. The honest answer this
round is that mechanical rejection and visual quality agree for both, not
that a rejected part was secretly the better pixel source.

**The beyond-joint-fraction metric (`char_gen.part_suitability`) applies to
`upper_arm` parts only.** `lower_arm` is explicitly exempted: T-0338 names
it "lower arm+hand," so content past the wrist is that part's own declared
hand, not a sibling's territory -- applying the same check there would flag
every well-formed forearm+hand cutout as "combined" for containing its own
hand (confirmed: `side_left_forward/left_lower_arm` measures 65.3% beyond
its own wrist and is a proportionate forearm+glove shape, not a defect).
`head` and `torso` have no second joint to measure "beyond" against (see
`PartSpec.joint_b_pair`'s own docstring) -- the metric does not apply to
either, so their completeness above is recorded from a one-time visual
inspection of each part's own evidence PNG, cited by filename in
`assess_figure_part_suitability_T0423.py`'s own `_VISUAL_FINDINGS`, not
computed from pixels. **Edge case: no figure panel in this card's own
`PARTS_BY_PANEL` requests an `upper_arm` without also requesting its
matching `lower_arm`**, so "a part whose distal joint is not in the
panel's own part set" does not actually arise in this dataset; if it did,
the beyond-elbow fraction would still be computable (it depends only on
the rig's elbow keypoint and the `upper_arm`'s own committed mask, never on
whether `lower_arm` was separately requested) -- stated here rather than
silently assumed.

## FIX ROUND 1: thermal-gate refusal crashed instead of being recorded

Running this card's own live evidence generation surfaced a real gap: the
thermal gate (T-0422) raises `ThermalGateRefused` (`comfy_client.thermal_gate`)
at `ComfyUIClient.submit()`'s own choke point -- a plain `RuntimeError`, not
one of the `ComfyClientError` subtypes (`SubmitError`/`ExecutionError`/
`PollTimeoutError`) `_make_part_sam3_runner`'s own `_run()` closure already
caught. Uncaught, it crashed the whole script with a bare traceback instead
of going through `main()`'s existing "SAM3 unavailable mid-run" recording
path -- exactly the path this card's own edge-case wording says "applies
unchanged" for a prerequisite that becomes unavailable mid-run.

Fixed by adding `ThermalGateRefused` to the caught exception tuple, which
`main()`'s pre-existing `_record_mid_run_sam3_failure` handling already
covers from there -- the gate itself was never touched, weakened, or
bypassed; `submit()` still refused, and the refused request was never
retried automatically. The `side_neutral`/`right_lower_arm` request above
is the real refusal this surfaced: re-run manually with `--part` once the
GPU reading cleared. Regression test:
`TestThermalGateRefusalIsRecordedNotCrashed` in the T-0423 test module.

## FIX ROUND 2: three overclaims corrected, mechanical vs. anatomical split out

Chat's review of PR #426 (2026-10-01) found this README's own write-up
overclaiming: mechanical isolation (one clean connected component, no
stray, no overlap) was being read as "an anatomically usable part," and
three specific parts did not actually hold up under inspection --
`front_tpose/right_upper_arm` (forearm included), the front `head` (hood
omitted), and `side_right_forward/torso` (a coat strip, not the complete
torso/coat). It also found a reporting error: "4 of 5" heads isolate
cleanly was actually 3 of 5, both forward-side heads being present but
overlap-rejected.

**This round changes no code behaviour, runs no GPU, and touches no
threshold.** It adds the "Mechanical isolation vs. anatomical suitability"
section above, the warning at the top of this document, the corrected
head-count paragraph in "Summary across the five figure panels," and one
new, purely additive offline module (`char_gen.part_suitability`) plus its
report script (`assess_figure_part_suitability_T0423.py`) that reproduces
the forearm-inclusion finding as a test instead of prose -- see
`TestFrontTposeRightUpperArmReproducesTheReviewFinding` in
`tests/test_part_suitability_T0423.py`, which independently recomputes
46.9% from the committed mask PNG and the rig's own elbow keypoint and
matches the review's own number exactly.

**Verified this round, not assumed:**

- `git diff 6e8d27ac..HEAD` touches only `docs/assets/evidence/T-0423/README.md`
  (this file), the new `char_gen/part_suitability.py` module, the new
  `assess_figure_part_suitability_T0423.py` report script, and the new
  `tests/test_part_suitability_T0423.py` test module -- no file under
  `docs/assets/evidence/T-0417/` (masks, counts, `part_comparison.json`),
  no change to `part_isolation.py`, `_build_figure_part_specs`,
  `PARTS_BY_PANEL`, or any existing T-0417/T-0423 test file.
- `TestCommittedRecordsUnchangedByThisRound` in the new test module pins
  the exact pixel counts and isolation verdicts this round's own Finding 1
  depends on (`front_tpose/right_upper_arm`, `front_tpose/head`,
  `side_right_forward/torso`, and the two overlap-rejected heads) against
  `part_comparison.json` as committed at `6e8d27ac` -- an accidental edit
  to the committed evidence during this round fails loudly here.
- 105 of T-0417/T-0423's own focused tests from round 1 plus 22 new ones
  (127 total) pass; `ruff check .` is clean; the legs panel's six verdicts
  and the Oklab border-flood tests are unmodified and still pass. The
  pre-existing full-suite noise (17 failed / 131 errors, confined to
  `test_{watcher,still_air,sound}_{move,idle,trapped}_gate_v2.py`,
  `test_player_profile_hybrid_T0272_gate.py`, `test_player_idle_arm_a_gate.py`
  and `test_gate_report_T0349.py`, none of which import anything this round
  touched) is unchanged from round 1 and reported here, not chased.
- No gitleaks scan was run this round -- no agent persona currently holds
  a grant to execute `~/.local/bin/gitleaks`. This round's own new content
  (two Python modules, one markdown doc) was written with no secret-shaped
  strings; reported honestly as an un-run scan, not claimed.
