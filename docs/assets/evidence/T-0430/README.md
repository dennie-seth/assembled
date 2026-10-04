# Side-view idle loop — 2026-10-04 (T-0430)

12-frame breathing/weight-shift loop, built from the ten committed parts and
`side_view_rig.json` on develop. All CPU — no GPU, no thermal-gate involvement.

| file | what |
|---|---|
| `idle_sheet_48.png` | 12-frame sheet, 576×48 |
| `idle_48.gif` / `idle_384.gif` | the loop, native 48 px and 8× |
| `frames/frame_0..11_48.png` | individual cells |
| `rig.json` | signals, per-frame pose, bone lengths, and every measurement below |

## Measured, not assumed

**The first pass was sub-pixel and I caught it.** "Subtle" amplitudes (1.6% and 1.2% of
torso height) measured **0.15 px and 0.25 px** of travel at the 40 px figure — arithmetically
present, visually absent. Exactly the trap the walk already paid for.

Rather than ship invisible motion, the amplitudes were **calibrated to the output
resolution**:

| signal | rate | travel at 40 px |
|---|---|---|
| **breathing** (primary) | 2 cycles per loop | **1.15 px** |
| **weight shift** (secondary) | 1 cycle per loop | **0.93 px** |

A 2:1 ratio is harmonically clean, so the two never beat against each other. This is how
pixel-art idles have always worked — the whole figure moves by a pixel, rather than a chest
inflating by a hair.

Empirically, **172–362 pixels change between consecutive cells** (mean 282), so the motion is
genuinely there in the output and not just in the numbers.

## Feet planted — by construction

Idle is defined by the feet not moving. Posing the legs forward and hoping they stay put does
not work: any hip motion drags them. So the **ankles are fixed for the whole loop** and the
legs are solved by **two-bone inverse kinematics** from the moving hip back to the stationary
ankle.

**Measured IK residual: max 0.000000 px.** The feet are planted exactly, every frame.

One real bug this surfaced: at a near-full-extension rest pose (0.97), the breath raised the
hip far enough to put the ankle **beyond reach**, the solver clamped, and the foot slid by up
to **11.3 px**. Dropping the rest pose to **0.90** keeps the whole loop inside the leg's
workspace — and slightly unlocked knees are the natural standing pose anyway. A test pins
both the correct case and the over-extended one.

## Seamless loop

The seam change (319 px) matches the typical inter-frame change (319 px) — no pop. The pose
function is also asserted to agree exactly at phase 0 and phase 1.

## Arms trail, they do not swing

The arms carry a **lagged fraction** of the torso's own motion rather than a driven arc, with
the far arm lagging slightly more than the near one so they do not move as a rigid pair. Total
shoulder travel is **under 8°** — a test asserts that, because anything larger starts to read
as a slow walk.

## Honest limitation

The **arm motion is driven correctly but is hard to see**, for the same reason as in the walk:
`shoulder_R` / `shoulder_L` are rectangular coat crops rather than traced silhouettes, so the
upper arms read as part of the coat mass. Per the card, this is reported rather than
compensated for — inflating the amplitude would make it look like a walk without making the
arm any more legible.

The figure also sits slightly more settled than a locked-knee stance, from the 0.90 rest pose.
That is deliberate and is what keeps the feet planted.

## What the next animation can reuse

- `char_gen.idle_cycle.solve_leg` / `ankle_of` — the two-bone IK, useful for **anything with
  a planted foot** (crouch, sit, reach).
- The amplitude-calibration habit: measure travel at the final height before accepting a
  value. Both animations have now been bitten by sub-pixel motion.
- `char_gen.walk_cycle`'s geometry helpers (`bone_length`, `distal_joint`) carried over
  unchanged — the shared layer is holding up.
