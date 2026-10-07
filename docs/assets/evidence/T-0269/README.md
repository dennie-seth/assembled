# Sitting idle -- crouch-sit at-rest loop (T-0269, round 3)

Composited deterministically from the ten committed side-view parts
(`assets/src/character/parts/side_view/`) and `side_view_rig.json`, by
`char_gen.sitting_idle_cycle`. Zero GPU calls, zero sampling -- the same inputs always
produce the same frames; `assets/src/character/tests/test_sitting_idle_cycle.py` asserts
this from the actual composited pixels, not from intent.

@DennieSeth confirmed round 2's crouch reads correctly. **Round 3 is pose refinement
only** -- everything round 2 established (no seat plane, the one shared
`CHARACTER_SCALE`, the static legs/planted feet) is unchanged. Three refinements:

1. **A forward torso lean, actually applied.** Round 2 recorded `TORSO_LEAN_DEG = 0.0`
   into `rig.json` without ever consuming it -- `rig_compositor.UpperPose` had no
   torso-rotation field at all, so the recorded value was correct only because it was
   zero. `rig_compositor.UpperPose.torso_deg` (new) now actually rotates the torso
   about its hip attach point, via `rig_compositor.rotate_offset` and `Image.rotate`,
   and carries the head/shoulders/forearms along as a parent rotation. `TORSO_LEAN_DEG`
   is now **-12.0deg** (negative is forward in this rig's rotation convention -- see
   `sitting_idle_cycle`'s own module docstring for the sign derivation).
   `TestTorsoLeanIsApplied` proves this from the actual rendered pixels: the head's own
   rotated bitmap (not just its placement coordinate) differs between two different
   lean angles, and the lean moves the head toward +x (over the knees), not away from
   them.
2. **The crouch's own arm rest pose.** Round 2's arms reused `idle_cycle`'s STANDING
   rest angles verbatim (`SHOULDER_REST_DEG=0`, `ELBOW_REST_DEG=14`), which is why they
   hung straight down. `arm_stance()` solves this pose's own `(shoulder_deg,
   elbow_deg)` with the same two-bone IK `crouch_stance()` already uses for the legs,
   targeting the near (R) knee. The solve is exact (not clamped): the near wrist lands
   within floating-point precision of the near knee.
3. **A real stagger.** Round 2's two ankles were both pinned to the same
   `hip_forward_of_ankle_x`, separated only by `far_leg_offset_frac` shifting the far
   leg's hip sideways -- an identical leg pose shifted **0.48 final pixels**, not a
   stagger. `crouch_stance()` now solves each leg independently, from the ONE shared
   hip, to its OWN ankle x-target -- different reach, therefore different knee flexion,
   therefore two visibly different legs, **5.97 final pixels** apart.

| file | what |
|---|---|
| `sitting_idle_sheet_48.png` | 6-frame sheet, 288x48 |
| `sitting_idle_loop_x8.gif` | the loop, 8x upscaled (384px tall), background flattened for review |
| `scale_match_crouch_vs_standing.png` | the refined crouch beside the approved standing idle, same scale, same ground line |
| `rig.json` | the signal, the resolved stance, and every measurement below |

## The crouch base pose -- still a rig configuration, not a generated image

`char_gen.sitting_idle_cycle.crouch_stance()` keeps the hip as a **free point** -- not
pinned to any plane, and now genuinely shared by both legs (`far_leg_offset_frac =
0.0`). Each leg is solved independently to its own ankle target with
`char_gen.idle_cycle.solve_leg`:

| | front leg (R, near, leads) | back leg (L, far, trails) |
|---|---|---|
| ground plane | y = 300.0 | y = 300.0 |
| hip | shared, y = 0.0 (300.0px above ground) | shared, y = 0.0 |
| ankle x-target | **+90.0** | **-60.0** |
| thigh | **87.86deg** | **61.18deg** |
| knee flexion | **116.15deg** | **117.93deg** |
| reach | 313.2px (of a (83.5, 577.0) workspace) | 305.9px (of the same workspace) |

Both solves are **exact, not clamped** -- `TestStagger.test_each_sides_solve_reaches_its_own_target_exactly`
is the forward-kinematics check, and `test_both_legs_reaches_are_inside_the_workspace_not_clamped`
pins both reaches comfortably inside `(83.5, 577.0)`. The front leg's thigh (87.86deg) is
close to horizontal -- a genuine consequence of staggering the ankle forward at a fixed
hip height, not round 1's seat-pinned exact 90.0deg (`test_no_legs_thigh_is_pinned_to_round_1s_exact_90_degrees`
pins the distinction). Both legs stay well past 90deg of knee flexion -- the stagger
changes the stance, not the depth.

**Stagger separation: 5.97 final px** (`(90.0 - (-60.0)) * 0.0398`), clearly visible at
the 40px figure convention -- round 2's bug was 0.48px, sub-pixel and invisible.

Torso lean: **-12.0deg**, a gentle forward lean ("hunched a little over the knees, not
bolt upright"), now actually rotating the torso (see below).

Both leg angles, and the hip/ankle world positions they resolve to, remain **identical
for every frame** -- computed once from `crouch_stance()` and never touched by phase.
That is what makes the contacts provably static (below), by construction rather than by
per-frame discipline. This property survives unchanged from round 1/2.

## The torso lean -- plumbed for real this round

Round 2's `TORSO_LEAN_DEG` constant existed but was read only once, to write itself
into `rig.json` -- no rotation ever consumed it. This round adds
`rig_compositor.UpperPose.torso_deg` (default `0.0`, so `idle_cycle`'s standing render
is bit-for-bit unaffected) and rewrites `rig_compositor.build_placements` to:

1. Rotate the torso's own image about its `attach["hip"]` pivot by `torso_deg`, via
   `Image.rotate` -- the same mechanism the legs and arms already use for their own
   angles.
2. Carry the head and both shoulders' attach points through the SAME rotation
   (`rig_compositor.rotate_offset`, a generalization of `distal_joint`'s own sign
   convention to an arbitrary local offset, not just a straight-down bone).
3. Add `torso_deg` as a PARENT rotation to the head's and both arms' own absolute
   angles (`child_absolute = torso_deg + child_local`), so a leaning torso carries its
   head and arms with it instead of leaving them behind.

**Sign note:** the torso's own hip-to-neck vector points mostly straight UP. The same
spin that swings a straight-DOWN vector (a thigh, a calf) toward +x swings a straight-UP
vector toward -x -- so a FORWARD lean (head/chest toward +x, over the knees) needs a
**negative** `TORSO_LEAN_DEG`. `TestTorsoLeanIsApplied.test_the_lean_moves_the_head_toward_the_knees_not_away`
checks this from the actual resolved placement, not from the sign alone.
`test_the_heads_own_rendered_pixels_change_with_the_lean` is the strongest proof: the
HEAD part's own rotated bitmap differs between two different non-zero lean angles,
which is only possible if `torso_deg` reaches `Image.rotate`.
`test_the_lean_does_not_move_any_contact` confirms the hip and both ankles are
untouched by the upper body's own rotation.

## The crouch's own arm rest pose

Round 2's arms used `idle_cycle.SHOULDER_REST_DEG` (0.0) / `idle_cycle.ELBOW_REST_DEG`
(14.0) verbatim -- the STANDING idle's hanging-arm rest pose. `arm_stance()` solves this
pose's own angles instead, targeting the near (R) knee with the same two-bone IK
`crouch_stance()` already uses for the legs (`idle_cycle.solve_leg`, reused for the
shoulder-to-wrist chain):

| | value |
|---|---|
| shoulder_deg (this pose's own, local) | **81.25deg** |
| elbow_deg (this pose's own, local) | **-39.37deg** |
| reach (shoulder to near knee) | 285.58px (of a (95.3, 301.4) workspace -- 94.8% of max) |
| clamped | **no** -- exact solve |
| wrist-to-knee distance | **~2.4e-15 final px** (floating-point zero) |

**Sign conversion, not a sign bug:** `idle_cycle.solve_leg` always resolves a
SUBTRACTIVE two-bone chain (`calf_deg = thigh_deg - knee_flexion_deg`, the leg's own
convention). The rendered arm is ADDITIVE (`forearm_deg = shoulder_deg + elbow_deg`,
`side_view_rig.json`'s own `sign_convention.forearm`). `arm_stance()` sets
`elbow_deg = -ik.knee_flexion_deg` precisely so the additive render reproduces the
angle the subtractive solve found -- `TestArmRestPose.test_the_arm_solve_reaches_the_near_knee`
is the forward-kinematics proof.

The elbow stays genuinely bent (39.37deg), not locked straight at near-full extension --
`test_the_elbow_is_bent_not_locked_straight` pins this away from both singularities.
Visually (`scale_match_crouch_vs_standing.png`), the arm reads as resting toward the
knee, not reaching for it -- the reach is close to this rig's own arm-length ceiling
(94.8% of max) because the crouch's hip-high knee sits well below the high-set shoulder,
not because of any choice this round made about the stagger or the lean.

## One shared scale, not one per pose -- unchanged from round 2

`char_gen.character_scale.CHARACTER_SCALE = 0.0398` and `GROUND_ANCHOR_CELL_Y = 44.0`
are still defined once and consumed by both `char_gen.idle_cycle.render_frames()` and
`char_gen.sitting_idle_cycle.render_frames()`. Neither module recomputes a scale from
its own pose's height.

| | crouch (round 3) | standing (approved, T-0430) |
|---|---|---|
| native figure height (head to ground) | 700.58px | 977.54px |
| final figure height at the shared 0.0398 scale | **27.88px** | **38.91px** |

The crouch comes out shorter than the standing figure at the same scale -- still the
correct result. `TestSharedScale.test_standing_idle_is_unaffected_by_the_torso_deg_field`
pins that `UpperPose.torso_deg`'s new default (`0.0`) leaves the standing idle's own
figure height at its approved ~40px convention.

## What moves, and what does not

Reused from the committed standing idle (`char_gen.idle_cycle.breath` and its cosine
ease) -- same signal, same `torso.png` -- but not the unmodified amplitude, and
re-measured this round at the refined pose (the lean and the arm change do not touch
the breath signal itself):

| | |
|---|---|
| **torso, head, both arms** | rise and fall together as one piece, carrying the fixed torso lean and arm rest angles with them |
| **hips, both legs, both ankles** | do not move at all |

| | value |
|---|---|
| `CROUCH_BREATH_RISE_FRAC` | 0.15 (unchanged from round 2 -- the lean/arm change does not touch this signal) |
| upper-body travel at the final figure | **1.53px** |

Travel clears the 1px floor by over 50% and stays well under the 2px "bob, not breath"
ceiling (`test_the_upper_body_amplitude_clears_a_pixel_at_the_final_height` /
`test_the_amplitude_stays_a_breath_not_a_bob`). `idle_cycle.BREATH_RISE_FRAC` itself is
untouched -- the standing idle keeps its own calibration.

**Hands on the knees across the breath:** the breath moves the upper body (and
everything riding it, including the resting arm) by ~1.53 final px while the knees are
static. The wrist-to-knee solve is computed at the rest pose (phase 0, `upper_dy = 0`);
across the loop the hand stays close to the knee but is not independently re-solved
per frame, so a sub-2px drift is expected and not hidden -- it is well within what
reads as "resting," not detaching.

## Both contacts, proven from the composited pixels -- now five points, not three

Round 2's validation found the lower-body band alone could not reach the hip (the
breathing upper body overlaps it) and did not explicitly cover the knees either. This
round extends the same per-point proof from `{hip, ankle_r, ankle_l}` to
`{hip, knee_r, knee_l, ankle_r, ankle_l}`:

`thigh_R`/`calf_R` (the near leg) are the topmost z-order layer in every frame --
`build_placements` draws them last -- so wherever they are opaque, the composited pixel
is their own phase-invariant content regardless of what the breathing torso, leaning
head, or resting arm are doing underneath. `rig_compositor.RenderResult` now returns
`hip_px`, `knee_r_px`, `knee_l_px`, `ankle_r_px` and `ankle_l_px` -- the exact canvas
coordinate of each contact, computed with the same `leg_chain` two-bone solve that
placed that leg's calf, not a separately re-derived point.
`test_each_contact_pixel_is_identical_across_every_frame` samples a 19x19 neighbourhood
(radius 9 -- empirically the widest radius that stays both opaque and pixel-identical
for all five points at once; radius 10 already picks up a phase-varying edge near the
hip/knee) at each coordinate from every native frame, asserts it is opaque (not a
vacuous all-transparent match), and asserts it is pixel-identical across every frame.

The lower-body band (`test_the_lower_body_band_is_still_bit_identical`) remains a
second, complementary proof over a larger region (mostly the calves/feet) -- it no
longer needs to reach the hip or the knees, since those are now proven individually.

| contact | canvas px |
|---|---|
| hip | (345, 508) |
| knee (R, near) | (592, 517) |
| knee (L, far) | (561, 627) |
| ankle (R, near) | (435, 808) |
| ankle (L, far) | (285, 808) |

## Shared ground anchor

Both `char_gen.idle_cycle.render_frames()` and `char_gen.sitting_idle_cycle.render_frames()`
anchor the ground plane to the same row, `GROUND_ANCHOR_CELL_Y = 44.0`, within the 48px
cell, by construction -- `test_shared_ground_anchor` asserts both results report the same
value rather than trusting the default was not overridden somewhere. A sprite swap
between states cannot make the character hop.

## Measured

| | value |
|---|---|
| changed px per native frame pair | 84472 - 92217 (never zero) |
| loop seam changed px | 84472 (tied for the smallest of the six transitions) |

The seam is not the worst transition in the loop -- the cosine ease resting at both ends
doing its job, same shape as the standing idle's own seam measurement.

## Honest notes / known limitations

- **Which state this reads as:** a crouch, resting on the haunches -- viewed at native
  resolution and at the final scale (`scale_match_crouch_vs_standing.png`), the forward
  lean and the arm-toward-the-knee read as resting, not as reaching or as bending over
  to pick something up. The near arm's reach is close to this rig's own max (94.8%),
  but the retained elbow bend (39.37deg) keeps the silhouette from reading as a locked,
  stretched-out arm.
- **The rectangular-crop limitation carries over from the walk/standing idle
  unchanged**: `torso`, `shoulder_R`/`shoulder_L` and `thigh_R`/`thigh_L` are box crops
  rather than traced silhouettes (`assets/src/character/parts/side_view/README.md`).
  The lean and the arm change are driven correctly through these parts' geometry, but
  their own rectangular crop may make the motion harder to read than a traced
  silhouette would -- reported, not compensated for with a larger amplitude.
- **No seat/chair/bench/stool sprite exists**, and no seat plane either -- deleted
  outright per the card, not merely renamed. `TestNoSeatPlaneAnywhere` pins this.
- Nothing is added under `assets/final/` and no provenance sidecar is introduced --
  promotion is out of scope for this card.
- **gitleaks**: no persona grant to run `~/.local/bin/gitleaks` in this session. New
  content (this round's module/test changes and evidence) hand-checked for
  secret-shaped strings and found clean -- reported honestly rather than claiming a
  scan that did not run.

## What the next side-view animation can reuse

- `rig_compositor.UpperPose.torso_deg` and `rig_compositor.rotate_offset` -- new this
  round: a pose can lean/rotate its torso and have the head/arms follow, for free.
- `rig_compositor.LegStance`'s per-side `thigh_deg_r/l` + `knee_flexion_deg_r/l` --
  new this round: a pose can stagger its stance with two independent per-leg IK
  solves, for free. `far_leg_offset_frac` still exists for a pose that only wants a
  cosmetic sideways offset (the standing idle's own use), not a genuine stagger.
- `char_gen.rig_compositor` -- the generic part-compositing machinery (part loading,
  the calf_L length correction, rotation padding, torso-lean propagation, z-ordered
  compositing, descent to the shared `CHARACTER_SCALE`/`GROUND_ANCHOR_CELL_Y`). A
  future pose supplies only its own `LegStance`, its own arm rest angles, and its own
  `phase -> UpperPose` function -- no new compositor.
- `char_gen.character_scale` -- the one shared scale and ground anchor.
