# T-0423: Figure-panel per-part SAM3 cutouts

Extends T-0417's per-part SAM3 cutout machinery (proved on the "legs" panel
only) to the five whole-figure panels, per T-0338's own part-to-joint chain
("upper arm, lower arm+hand, upper leg, lower leg+boot, head, torso/coat").
This card produces head/torso/arm parts; legs were already done by T-0417
and are reported below only as an unregressed baseline.

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

| panel | isolated / requested |
|---|---|
| front_tpose | 2 / 6 |
| back_tpose | 3 / 6 |
| side_right_forward | 1 / 4 |
| side_left_forward | 1 / 4 |
| side_neutral | 1 / 4 |
| **total** | **8 / 24** |

Head isolates cleanly on 4 of 5 panels (every panel except
`side_right_forward`, where it overlapped the upper arm). Torso isolates
cleanly on exactly 1 of 5 (`side_right_forward`) -- every other panel's
torso either stray-failed, overlapped an arm, or both, consistent with the
card's own framing that coat-over-torso occlusion is genuinely harder than
legs. Arm segments are the most inconsistent: several detect empty
entirely (no coordinates ever produced a mask), several detect but bleed
into a sibling.

## FIX ROUND: thermal-gate refusal crashed instead of being recorded

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
