# T-0431: deterministic walk-sheet -- measured, not promoted

## What was built

`char_gen.walk_sheet` (new module, `assets/src/character/src/char_gen/walk_sheet.py`)
composites the 8-frame side-view walk cycle from exactly the committed inputs
this card names, with **zero GPU calls and zero network calls**:

- the ten committed parts under `assets/src/character/parts/side_view/*.png`
- `side_view_rig.json`
- `char_gen.walk_cycle`'s already-tested keyframed hip/knee/shoulder/elbow
  curves

None of those three are modified by this card -- `test_walk_sheet_T0431.py`'s
`TestCommittedInputsAreUntouched` hashes all of them (plus the existing
placeholder `player_walk_sheet_hybrid.*`) before and after a render and
asserts no change, rather than assuming it.

`gen_walk_sheet_deterministic_T0431.py` (new generator script) renders the
sheet, quantizes it to the home palette, writes per-frame rig-keypoint
evidence (what the rig actually commanded, in the same shape
`asset_gate.character` recomputes pose-fidelity/identity-stability/
part-identity from), builds a provenance record with `motion_class:
locomotion` set from the start, and runs
`asset_gate.character.build_character_gate_report` -- the same function the
reviewer's deliverable gate and `ci-asset-gate.yml` call -- **before writing
anything into `assets/final/`**.

## Measured numbers

| check | result | threshold | verdict |
|---|---|---|---|
| `character_arm_c_provenance` | `frame_delta_range`/`arm_c_benchmark`/`beats_arm_c_benchmark` all recorded | presence/shape only | **PASS** |
| `character_frame_delta_cap` | n/a for `locomotion` (T-0340/DL-31 retires the whole-silhouette cap for this motion class) | n/a | **PASS (skipped)** |
| `character_motion_fidelity` | pose-fidelity IoU range **[0.6022, 0.7367]**; identity-stability distance range **[0.1172, 0.1719]** | IoU floor `>= 0.70`; identity cap `<= 0.15` | **FAIL -- both halves** |
| `character_part_identity` | worst per-region (head/torso/near_limb/far_limb) palette-histogram distance **[0.0, 0.2944]** | cap `<= 0.40` | **PASS**, with headroom |
| `character_motion_score_binding` | recorded score matches a fresh pixel recompute, sheet/rig/palette/evaluator hashes all current | exact match | **PASS** |

Reporting the two motion-fidelity halves separately, as the card's edge
cases ask: **pose fidelity fails on its own** (0.6022 < 0.70, driven by the
worst single frame; several individual frames do clear 0.70) **and identity
stability fails on its own** (0.1719 > 0.15, on an interior frame pair, not
the loop seam) -- this is not one check dragging the other down, both
independently miss their own bar. Both are close to their thresholds (off
by 0.10 and 0.02 respectively), not a wide miss -- flagged per the "near a
threshold" edge case, since a marginal pass would have been worth flagging
too.

Full machine-readable detail: `docs/assets/evidence/T-0431/player_walk_sheet_deterministic_T0431.gate_report.json`
(committed) -- the exact output of `build_character_gate_report`, not a
hand-summary of it.

## Why this isn't a bug fix in progress

The pose-fidelity measure compares the rendered silhouette against capsules
drawn along the keypoints this module itself derives from the rig's forward
kinematics -- i.e. against what the rig actually commanded, not a re-posed
or re-tuned skeleton. One real improvement was made during this card: the
head's five joints (nose/eyes/ears) were originally seeded from
`gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM`, a FRONT-facing reference pose
-- wrong for this profile character, and it inflated every frame's capsule
footprint well past the real head art. Replacing it with the head part's own
measured opaque-pixel centroid (relative to its rig pivot) raised the
pose-fidelity floor from 0.555 to 0.602 and the ceiling from 0.669 to 0.737
-- a real fix to this module's own keypoint derivation, not a gate change.

Beyond that, the shortfall traces to the hand-cut parts themselves: five of
the ten are box-like crops rather than traced silhouettes (`parts/side_view/
README.md`'s own table), and the gait's large knee-flexion swing (up to
62 degrees, intentionally -- `walk_cycle.py`'s own docstring explains a
smaller, smoother earlier revision read as rigid limbs) rotates those
box-like parts far enough that their silhouette diverges from a thin
2.5px-radius capsule approximation more than the floor allows on the
worst frame. This is a real, structural reading of the same gap DL-31
already measured on the GPU-generated placeholder (0.393-0.630, "motion
barely visible") -- this deterministic composite actually clears a higher
floor on every metric than that placeholder did, but still falls short of
`POSE_FIDELITY_IOU_FLOOR`.

## Decision: NOT PROMOTED

Per this card's acceptance criteria, this is a complete, valid outcome:
**no threshold was retuned, no exemption was added.** Nothing was written
to `assets/final/character/`. The existing placeholder
`player_walk_sheet_hybrid.*` is untouched.

## Evidence committed

- `docs/assets/evidence/T-0431/player_walk_sheet_deterministic_T0431.png` --
  the rendered, palette-quantized candidate sheet
- `docs/assets/evidence/T-0431/player_walk_sheet_deterministic_T0431_frames_check.png`
  -- the same frames reassembled via `walk_sheet.save_sheet` (a cross-check
  the sheet-assembly path itself is correct)
- `docs/assets/evidence/T-0431/player_walk_sheet_deterministic_T0431.gate_report.json`
  -- the full `build_character_gate_report` output quoted above
- `docs/assets/evidence/T-0431/player_walk_sheet_deterministic_T0431.provenance_candidate.json`
  -- the full provenance record that was measured against the gate (named
  `*_candidate.json`, not `.provenance.json`, since nothing was promoted --
  a real `.provenance.json` sidecar only exists for a shipped asset)
- `assets/src/character/pose_rig_walk_deterministic_frame_evidence_T0431/frame_{0..7}_keypoints.json`
  -- the per-frame rig-keypoint evidence the gate recomputed from

## What this card does not do

- Does not touch `player_walk_sheet_hybrid.*` -- that is [T-0359](T-0359)'s job, and only after a sheet actually promotes.
- Does not add an `ASSET_PROVENANCE.md` entry -- that entry is for a curated, shipped asset; nothing shipped here.
- Does not retune `POSE_FIDELITY_IOU_FLOOR`, `IDENTITY_STABILITY_HISTOGRAM_CAP`, or any other gate constant, and does not add a baseline exemption.
