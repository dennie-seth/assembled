# Side-view idle — simplified — 2026-10-05 (T-0430)

**One signal: a gentle vertical breath in the upper body.** Nothing else moves.

The 2026-10-04 version is kept alongside this one as a before/after. It layered breathing, a
weight shift, torso pitch and roll, and trailing arm motion — every signal measured and
correct, and collectively too busy to watch. Idle plays constantly, so it has to sit still
enough to ignore.

| file | what |
|---|---|
| `idle_sheet_48.png` | 12-frame sheet, 576×48 |
| `idle_48.gif` / `idle_384.gif` | the loop, native 48 px and 8× |
| `idle_sheet_336_7x_viewable.png` | the sheet at 7× |
| `frames/frame_0..11_48.png` | individual cells |
| `comparison_busy_vs_simple.png` | 2026-10-04 above, this version below |
| `rig.json` | the signal, per-frame pose, and every measurement below |

## What moves, and what does not

| | |
|---|---|
| **torso, head, arms** | rise and fall together as one piece |
| **hips, both legs, both feet** | do not move at all |
| sway / pitch / roll / arm swing / limb articulation | **removed** |

The legs are **solved once, at rest, and reused for every frame**, so the feet are static by
construction rather than by per-frame IK. Measured: the lower-body band differs from frame 0
by at most **6 subpixel units** across the whole loop — and that is the coat hem overlapping
the band, not the legs.

## Measured

| | 2026-10-04 (busy) | **this version** |
|---|---|---|
| signals | 4 (breath, sway, pitch, roll) + arm trail | **1** |
| breath rate | 2 cycles / loop | **1 cycle / loop** |
| upper-body travel at 40 px | 1.15 px | **1.13 px** |
| changed px per frame (mean) | 282 | **64** |
| loop seam | 319 (≈ typical) | **21** (the quietest transition) |

Travel stays **above a pixel so it reads** and is bounded **below two by a test** so it stays
a breath rather than a bob. One cycle per loop rather than two — two reads as panting at this
frame count.

The seam being the *quietest* transition is the cosine ease doing its job: the figure rests at
the bottom of the breath at both ends of the loop, so there is nothing to pop.

## Honest note

The arm limitation from the walk no longer applies here — **the arms carry no motion of their
own in this version**, so the fact that `shoulder_R`/`shoulder_L` are rectangular coat crops
costs nothing. They simply ride the torso.

`solve_leg` / `ankle_of` remain in the module. They are used for the one-off rest pose, and
stay the right tool for any future animation whose hips move while a foot stays put.
