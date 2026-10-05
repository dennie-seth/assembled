# Sitting idle -- seated at-rest loop (T-0269)

Composited deterministically from the ten committed side-view parts
(`assets/src/character/parts/side_view/`) and `side_view_rig.json`, by
`char_gen.sitting_idle_cycle`. Zero GPU calls, zero sampling -- the same inputs always
produce the same frames; `assets/src/character/tests/test_sitting_idle_cycle.py` asserts
this from the actual composited pixels, not from intent.

| file | what |
|---|---|
| `sitting_idle_sheet_48.png` | 6-frame sheet, 288x48 |
| `sitting_idle_loop_x8.gif` | the loop, 8x upscaled (384px tall), background flattened for review |

## The seated base pose -- a rig configuration, not a generated image

`char_gen.sitting_idle_cycle.seated_stance()` pins **both ends** of the leg chain:

| plane | value |
|---|---|
| seat plane (hip) | y = 0.0 |
| ground plane (both ankles) | y = 330.24 |
| ankle forward of hip | x = 246.72 (the thigh's own measured length) |

With both ends fixed, `char_gen.idle_cycle.solve_leg` has nothing left to curve -- it
resolves to:

| angle | value |
|---|---|
| thigh | 90.0 deg (horizontal) |
| knee flexion | 90.00 deg (calf ~0 deg, near-vertical) |

The solve is **exact, not clamped**: the chosen reach (hip to ankle, 412.1px) sits well
inside the leg's workspace `(|thigh-calf|, thigh+calf)` = `(83.5, 576.9)`, with ~83px of
margin on either side -- `test_the_reach_is_not_at_the_clamp_boundary` pins this.
`test_the_solve_reaches_the_target_exactly` is the forward-kinematics check: `ankle_of`
applied to the solved angles reproduces the target to within 1e-6px.

Both leg angles, and the hip/ankle world positions they resolve to, are **identical for
every frame** -- they are computed once from `seated_stance()` and never touched by phase.
That is what makes the two contacts provably static (below), by construction rather than by
per-frame discipline.

## What moves, and what does not

Reused unmodified from the committed standing idle (`char_gen.idle_cycle.breath` and its
`BREATH_RISE_FRAC` calibration) -- same signal, same `torso.png`:

| | |
|---|---|
| **torso, head, both arms** | rise and fall together as one piece |
| **hips, both legs, both ankles** | do not move at all |

## Measured, not eyeballed

| | value |
|---|---|
| native figure height (head to ground, at rest) | 730.82px |
| descent scale (40px figure / native height) | 0.05473 |
| upper-body travel at the final 40px figure | **1.52px** |
| changed px per native frame pair | 63621 - 68112 (never zero) |
| loop seam changed px | 63621 (tied for the *smallest* of the six transitions) |

Travel clears the 1px floor by ~50% and stays well under the 2px "bob, not breath" ceiling
(`TestCompositedFrames.test_the_upper_body_amplitude_clears_a_pixel_at_the_final_height` /
`test_the_amplitude_stays_a_breath_not_a_bob`). The seam is not the worst transition in the
loop, which is the cosine ease resting at both ends doing its job -- same shape as the
standing idle's own seam measurement.

## Both contacts, proven from the composited pixels

`render_frames()`'s `lower_body_band` is clipped to start just below the lowest point any
part of the upper body (torso, head, or either arm -- all of which ride the breath) ever
reaches across all six frames, so it is provably free of anything that moves, and it still
covers both knees and both ankles. `test_both_contacts_are_provably_still` crops that band
from every native frame and asserts byte-for-byte equality against frame 0 -- not a
tolerance, an exact match.

(The hip itself sits exactly where torso meets leg, so a pixel crop of that single point
would inevitably include the breath-moving torso's own silhouette -- an anatomically
unavoidable overlap, not a defect. The hip's *world coordinate* is proven static the same
way the walk/idle rig numbers are: it is a constant, `(0.0, 0.0)`, that phase never touches,
checked directly by `TestOnlyTheUpperBodyMoves.test_the_legs_hold_the_seated_stance_at_every_phase`.)

## Honest notes / known limitations

- **Which state this reads as:** sitting, not standing or a slow walk -- the thigh's
  horizontal line and the calf dropping to a flat boot on the ground read clearly as a seat
  silhouette at both the 48px and 384px preview. Visually checked, not just measured.
- **The rectangular-crop limitation carries over from the walk/standing idle unchanged**:
  `shoulder_R`/`shoulder_L` (and `thigh_R`/`thigh_L`) are box crops rather than traced
  silhouettes (`assets/src/character/parts/side_view/README.md`). Nothing here drives any
  *additional* motion through them -- the arms carry no motion of their own beyond riding
  the torso's breath, same as the standing idle -- so this limitation costs nothing new.
- **No seat/chair/bench sprite was produced.** The seat is the `seat_plane_y = 0.0`
  coordinate above, nothing more; in-engine scenery supplies the visible seat.
- Nothing is added under `assets/final/` and no provenance sidecar is introduced --
  promotion is out of scope for this card.
- **gitleaks**: no persona grant to run `~/.local/bin/gitleaks` in this session. New content
  (one Python module, one test file, two evidence images, this README) hand-checked for
  secret-shaped strings and found clean -- reported honestly rather than claiming a scan
  that did not run.

## What the next side-view animation can reuse

- `char_gen.idle_cycle.breath` / `BREATH_RISE_FRAC` / `SHOULDER_REST_DEG` /
  `ELBOW_REST_DEG` / `HEAD_REST_DEG` / `FAR_LEG_OFFSET_FRAC` -- reused **unmodified**. No
  shared helper needed to change for this card; `char_gen.idle_cycle.py` and
  `char_gen.walk_cycle.py` are both untouched by this diff
  (`test_walk_cycle.py` / `test_idle_cycle.py` still pass unchanged, confirmed by running
  them in the same session as this card's own suite).
- `char_gen.idle_cycle.solve_leg` / `ankle_of` -- exactly the tool the design doc already
  called out for "a hip that moves while a foot stays put"; this card is the first real use
  of it for a *fixed* hip against a fixed ankle (both ends pinned), which is a strictly
  simpler case of the same solver.
- **New and reusable from this card**: `_pad_for_rotation` in `sitting_idle_cycle.py`.
  `Image.rotate(..., expand=False)` silently clips a non-square part at a large rotation
  angle -- the seated thigh's ~90 degree swing needed about 257px of horizontal room inside
  what was originally a 175px-wide crop. Any future pose with a large joint angle (a bigger
  knee bend, a raised arm) will need the same padding, not just the near-constant angles
  this card uses.
- The torso/neck/shoulder/hip attach-point reading (`attach_torso_local_px`) and the
  z-ordered compositing loop in `render_frames` are generic over pose -- a future pose only
  needs its own `*_stance`-equivalent plus a `pose_at`, not a new compositor.
