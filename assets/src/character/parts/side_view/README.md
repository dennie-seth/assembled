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
`bbox_fill`, the fraction of each part's own bounding box that is opaque:

| traced | | box-like | |
|---|---|---|---|
| `calf_R` | 0.43 | `shoulder_R` | 0.84 |
| `forearm_R` | 0.58 | `thigh_R` | 0.87 |
| `calf_L` | 0.70 | `shoulder_L` | 0.88 |
| `forearm_L` | 0.75 | `torso` | 0.93 |
| `head` | 0.87 | `thigh_L` | 0.94 |

Consequence: **the elbow articulation is driven correctly but is not visible**, because the
upper arms have no silhouette of their own and read as part of the coat mass. The knee bend
reads clearly, because both calves are well traced.

Re-cutting `shoulder_R` and `shoulder_L` as traced pieces would make the arm swing appear
with no animation change. This is **optional polish** — @DennieSeth accepted the current
result and nothing is blocked on it.

`calf_L` additionally carries a `length_scale` of **×1.2929** in the rig. Its upper portion
is occluded by the near leg in a side view, so the cut is short even though the bone is not;
the thighs measured exactly equal, and only this one bone needed correcting. A re-cut that
recovers the occluded top would make the scale unnecessary.
