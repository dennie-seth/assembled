# Sitting idle -- crouch-sit at-rest loop (T-0269, round 2)

Composited deterministically from the ten committed side-view parts
(`assets/src/character/parts/side_view/`) and `side_view_rig.json`, by
`char_gen.sitting_idle_cycle`. Zero GPU calls, zero sampling -- the same inputs always
produce the same frames; `assets/src/character/tests/test_sitting_idle_cycle.py` asserts
this from the actual composited pixels, not from intent.

**Round 2 replaces round 1's two defects, both corrected in this evidence:**

1. **The pose was a chair sit, not a crouch.** Round 1 pinned the hip to an abstract
   `seat_plane_y = 0.0` and projected the ankle a full thigh-length forward, which resolved
   to a horizontal thigh (90.0deg) and 90.00deg of knee flexion -- a character perched on an
   invisible seat. That abstraction is deleted outright: there is no seat plane anywhere in
   `sitting_idle_cycle.py` now, no `seat_plane_y`, no hip-on-seat pin. The only ground
   constraint is both ankles on the ground plane; the hip is a free point, chosen directly.
2. **The scale was derived per-pose, not shared.** Round 1 measured the seated figure's own
   730.82px native height and derived a 0.05473 descent scale to force it to fill the same
   40px figure cell as the standing idle -- which rendered the crouched character **~37.5%
   larger than when standing**. There is now exactly ONE world-to-pixel scale
   (`char_gen.character_scale.CHARACTER_SCALE = 0.0398`), defined once, consumed by both
   `char_gen.idle_cycle` and `char_gen.sitting_idle_cycle`, and never recomputed from a
   pose's own height.

| file | what |
|---|---|
| `sitting_idle_sheet_48.png` | 6-frame sheet, 288x48 |
| `sitting_idle_loop_x8.gif` | the loop, 8x upscaled (384px tall), background flattened for review |
| `scale_match_crouch_vs_standing.png` | the corrected crouch beside the approved standing idle, same scale, same ground line |
| `rig.json` | the signal, the resolved stance, and every measurement below |

## The crouch base pose -- a rig configuration, not a generated image

`char_gen.sitting_idle_cycle.crouch_stance()` places the hip as a **free point** -- not
pinned to any plane -- and solves the two leg angles that reach a chosen ankle target with
`char_gen.idle_cycle.solve_leg`:

| | value |
|---|---|
| ground plane (both ankles) | y = 300.0 |
| hip | y = 0.0 (300.0px above the ground) |
| hip forward of ankle | x = 0.0 (directly above the ankle -- "over the heels" taken literally) |
| thigh | **73.59deg** (not horizontal) |
| knee flexion | **119.37deg** (deeper than round 1's 90.00deg) |
| torso lean | 0.0deg (upright; a small lean was allowed by the card, this pose chooses none) |
| feet | flat (the calf part's own baked-in foot shape, unchanged from round 1 -- not a newly decided pose) |

The solve is **exact, not clamped**: the chosen reach (hip to ankle, 300.0px) sits well
inside the leg's workspace `(|thigh-calf|, thigh+calf)` = `(83.5, 577.0)`, with ~217px of
margin on the short side and ~277px on the long side.
`test_the_solve_reaches_the_target_exactly` is the forward-kinematics check: `ankle_of`
applied to the solved angles reproduces the target to within 1e-6px.

The reach (300.0px) is also **27% shorter than round 1's retired chair-sit reach**
(hypot(246.72, 330.24) = 412.1px) -- the leg genuinely folds up more compactly, which is
what the deeper knee flexion costs in hip-to-ankle distance.

Both leg angles, and the hip/ankle world positions they resolve to, are **identical for
every frame** -- computed once from `crouch_stance()` and never touched by phase. That is
what makes the two contacts provably static (below), by construction rather than by
per-frame discipline. This property survives unchanged from round 1.

## One shared scale, not one per pose

`char_gen.character_scale.CHARACTER_SCALE = 0.0398` and `GROUND_ANCHOR_CELL_Y = 44.0` are
defined once and consumed by both `char_gen.idle_cycle.render_frames()` (added this round,
purely additive -- the standing idle's existing pose math is untouched) and
`char_gen.sitting_idle_cycle.render_frames()`. Neither module recomputes a scale from its
own pose's height; `char_gen.rig_compositor.render_frames()` is the one place that applies
`CHARACTER_SCALE` to native-pixel frames and anchors the ground to
`GROUND_ANCHOR_CELL_Y` within the 48px cell.

| | crouch | standing (approved, T-0430) |
|---|---|---|
| native figure height (head to ground) | 700.58px | 977.54px |
| final figure height at the shared 0.0398 scale | **27.88px** | **38.91px** |

The crouch comes out **shorter than the standing figure at the same scale -- the correct
result**, not something to correct for by inflating the crouch's own scale. The standing
figure lands close to its approved ~40px convention (within a few percent -- this round
measures it freshly from the committed parts/rig via the same compositor, rather than
hand-copying T-0430's own number) proving the shared-scale refactor did not move it.
`test_shared_parts_come_out_at_the_same_pixel_size` renders `torso.png` through both poses
at the shared scale and asserts the two outputs agree exactly -- the cross-state check this
round adds, and the one that would have caught round 1's bug directly.

## What moves, and what does not

Reused from the committed standing idle (`char_gen.idle_cycle.breath` and its cosine ease)
-- same signal, same `torso.png` -- but **not** the unmodified amplitude:

| | |
|---|---|
| **torso, head, both arms** | rise and fall together as one piece |
| **hips, both legs, both ankles** | do not move at all |

`BREATH_RISE_FRAC` (0.108, idle's own calibration) at the corrected 0.0398 scale would land
at **~1.10px** of travel -- clears the 1px floor, but with far less margin than round 1's
1.52px. This module raises its own `CROUCH_BREATH_RISE_FRAC = 0.15` to restore a comfortably
visible breath:

| | value |
|---|---|
| upper-body travel at the final figure, round 1 (0.05473 scale, unmodified 0.108 frac) | 1.52px |
| upper-body travel at the final figure, round 2 unmodified frac (0.0398 scale) | ~1.10px (not shipped) |
| **upper-body travel at the final figure, round 2 shipped (0.0398 scale, 0.15 frac)** | **1.53px** |

Travel clears the 1px floor by over 50% and stays well under the 2px "bob, not breath"
ceiling (`test_the_upper_body_amplitude_clears_a_pixel_at_the_final_height` /
`test_the_amplitude_stays_a_breath_not_a_bob`). `idle_cycle.BREATH_RISE_FRAC` itself is
untouched -- the standing idle keeps its own calibration.

## Both contacts, proven from the composited pixels

`render_frames()`'s `lower_body_band` is clipped to start just below the lowest point any
part of the upper body (torso, head, or either arm -- all of which ride the breath) ever
reaches across all six frames, so it is provably free of anything that moves, and it still
covers both knees and both ankles. `test_both_contacts_are_provably_still` crops that band
from every native frame and asserts byte-for-byte equality against frame 0.

## Shared ground anchor

Both `char_gen.idle_cycle.render_frames()` and `char_gen.sitting_idle_cycle.render_frames()`
anchor the ground plane to the same row, `GROUND_ANCHOR_CELL_Y = 44.0`, within the 48px
cell, by construction -- `test_shared_ground_anchor` asserts both results report the same
value rather than trusting the default was not overridden somewhere. A sprite swap between
states cannot make the character hop.

## Measured

| | value |
|---|---|
| changed px per native frame pair | 66164 - 70970 (never zero) |
| loop seam changed px | 66164 (tied for the smallest of the six transitions) |

The seam is not the worst transition in the loop -- the cosine ease resting at both ends
doing its job, same shape as the standing idle's own seam measurement.

## Honest notes / known limitations

- **Which state this reads as:** a crouch -- the bent-forward knee, the folded-up thigh,
  and the foot tucked back under the hip read as resting on the haunches, not sitting on a
  seat and not standing. Visually checked (`scale_match_crouch_vs_standing.png`), not just
  measured.
- **The rectangular-crop limitation carries over from the walk/standing idle unchanged**:
  `shoulder_R`/`shoulder_L` and `thigh_R`/`thigh_L` are box crops rather than traced
  silhouettes (`assets/src/character/parts/side_view/README.md`). Nothing here drives any
  additional motion through them -- the arms carry no motion of their own beyond riding the
  torso's breath, same as the standing idle.
- **No seat/chair/bench/stool sprite exists**, and no seat plane either -- deleted outright
  per the card, not merely renamed. `TestNoSeatPlaneAnywhere` pins this.
- Nothing is added under `assets/final/` and no provenance sidecar is introduced --
  promotion is out of scope for this card.
- **gitleaks**: no persona grant to run `~/.local/bin/gitleaks` in this session. New content
  (three Python modules, one test file, four evidence files, this README) hand-checked for
  secret-shaped strings and found clean -- reported honestly rather than claiming a scan
  that did not run.

## What the next side-view animation can reuse

- `char_gen.rig_compositor` -- new this round: the generic part-compositing machinery
  (part loading, the calf_L length correction, rotation padding, z-ordered compositing,
  descent to the shared `CHARACTER_SCALE`/`GROUND_ANCHOR_CELL_Y`) factored out of round 1's
  bespoke `sitting_idle_cycle` internals. A future pose supplies only its own `LegStance`
  (hip + leg angles) and `phase -> UpperPose` function -- no new compositor.
- `char_gen.character_scale` -- the one shared scale and ground anchor. A future pose
  imports `CHARACTER_SCALE`/`GROUND_ANCHOR_CELL_Y` from here; it never derives its own.
- `char_gen.idle_cycle.render_frames()` -- new this round, purely additive: the standing
  idle's existing pose math (`pose_at`, `breath`, `solve_leg`, `idle_stance`) is completely
  untouched, so every resolved per-frame value from before this round is unaffected.
