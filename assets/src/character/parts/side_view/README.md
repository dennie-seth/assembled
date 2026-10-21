# Side-view character parts

The ten hand-cut parts the side-view animations are built from, keyed to transparent PNG and
oriented to face **+x (right)**.

| part | bone it drives |
|---|---|
| `head` | `neck` |
| `torso` | `spine` (root) |
| `shoulder_R` / `shoulder_L` | `upperarm.R` / `upperarm.L` |
| `forearm_R` / `forearm_L` | `forearm.R` / `forearm.L` |
| `thigh_R` / `thigh_L` | `thigh.R` / `thigh.L` |
| `calf_R` / `calf_L` | `shin.R` / `shin.L` |

Mapping, pivots and layer order: `docs/design/21-character-rig-bones.md` (EXTENDED set).
Rig data for the walk: `side_view_rig.json`.

## How these were made

1. Generated with the stock prompt — **no background instruction.** Trying to control the
   backdrop colour from the positive prompt bleeds that colour onto the costume; it is what
   turned the coat pink under magenta and pale blue-grey under an emphasised grey.
2. Background removed afterwards with `char_gen.background_key`, which floods in from the
   frame border so an interior highlight matching the backdrop survives by construction.
3. Cut by hand, then flipped horizontally: the source render faces left, the rig faces right.

`keying_stats.json` records each part's measured backdrop, keyed fraction, and
`figure_pixels_colliding_with_backdrop` — the pixels a naive global threshold would have
destroyed.

## Why these live in `assets/src/`, not `assets/final/`

They are **source art**, not shipped sprites. Two concrete reasons:

- `assets/final` is swept by the transparency gate, which requires indexed `P` + `tRNS`.
  Converting these would discard the **soft alpha edge the compositor needs** to place and
  rotate a part without a hard jagged boundary.
- The shipped artifact of this path is the composited **sheet**, not its ingredients.
  Promoting a sheet into `assets/final` is a separate step with its own provenance and
  character-gate obligations.

## Known limitations (not blocking)

Five of the ten are rectangular crops rather than traced silhouettes — measured as
`bbox_fill`, the fraction of each part's own bounding box that is opaque. **T-0436 fix round 7
(2026-10-09T17:06) renamed all eight limb-part files** (a pairwise swap, content
byte-identical -- see `docs/design/23-canonical-rig.md` §3h) so the suffix tracks draw depth
(near/front = `_R`, far/behind = `_L`) instead of the mirrored source art's original,
anatomically-backwards labels; the `bbox_fill` numbers below are keyed to the CURRENT
(post-rename) filenames, re-measured per file rather than assumed to carry the old label's row:

| traced | | box-like | |
|---|---|---|---|
| `calf_L` | 0.43 | `shoulder_L` | 0.84 |
| `forearm_L` | 0.58 | `thigh_L` | 0.87 |
| `calf_R` | 0.70 | `shoulder_R` | 0.88 |
| `forearm_R` | 0.75 | `torso` | 0.93 |
| `head` | 0.87 | `thigh_R` | 0.94 |

Consequence: **the elbow articulation is driven correctly but is not visible**, because the
upper arms have no silhouette of their own and read as part of the coat mass. The knee bend
reads clearly, because both calves are well traced.

Re-cutting `shoulder_R` and `shoulder_L` as traced pieces would make the arm swing appear
with no animation change. This is **optional polish** — @DennieSeth accepted the current
result and nothing is blocked on it.

`calf_R` (fix round 7: renamed from `calf_L`) additionally carries a `length_scale` of
**×1.2929** in the rig. Its cut is short even though the bone is not -- the thighs measured
exactly equal, and only this one bone needed correcting. A re-cut that recovers the missing
length would make the scale unnecessary. (An earlier explanation attributed the short cut to
occlusion by the near leg; T-0436 fix round 6 retracted that explanation once the near/far
layering it depended on changed -- the measured shortfall itself is a fact about the cut,
unaffected by either that round's z-order swap or this round's name swap.)

`shoulder_R` (fix round 7: renamed from `shoulder_L`) carries the same mechanism (T-0436), in
the opposite direction: its raw cut is cut further down the sleeve than `shoulder_L`'s, so its
measured bone length is *longer*, not shorter. `bone_length_fix.scaled.shoulder_R = {"height":
0.6087, "width": 1.0}` brings its bone length back to `shoulder_L`'s own length without
shrinking its cut width. No re-cut here either — see `docs/design/23-canonical-rig.md` §6, §3h.
