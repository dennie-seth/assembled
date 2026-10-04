# Side-view walk, round 4 — leg lengths equalised — 2026-10-04

**Confirmed: the two legs now read as equal length.** Both chains measure **577.0 px**, bone
for bone, and both boots plant on the same ground line through the cycle. Round 3's
articulation is unchanged — same parts, same curves.

## The fix was in one bone, not the whole leg

Before touching anything I measured the bone lengths (bone = `img.height × (1 − pivot_y)`,
since the pivot sits at the proximal joint):

| bone | near (R) | far (L) | far / near |
|---|---|---|---|
| thigh | 246.7 | 246.7 | **100.0%** |
| calf | 330.2 | 255.4 | **77.3%** |
| **chain** | **577.0** | **502.1** | **87.0%** |

**The thighs were already exactly equal.** The entire shortfall was `calf_L`, at 77.3% of
`calf_R`. That makes sense from the source art: in a side view the far calf's upper portion is
occluded by the near leg, so the *cut* is short even though the *bone* is not.

So I corrected only `calf_L`, by **×1.293**:

| | after |
|---|---|
| thigh R / L | 246.7 / 246.7 — **100.0%** |
| calf R / L | 330.2 / 330.2 — **100.0%** |
| chain R / L | 577.0 / 577.0 — **100.0%** |

## Why not the ~10% on the whole leg

Measured, a uniform +10% on both left segments would have:

- made **`thigh_L` 10% longer than `thigh_R`** — a new asymmetry where there was none
- left `calf_L` still **14.9% short** of `calf_R`
- left the chain still **4.3% short** overall

The estimate of ~10% was reading the *chain* deficit (13%) by eye, which is the right
observation — but spreading the correction across both segments would have fixed the total
while breaking the parts. Correcting the one short bone fixes both.

## How the chain stayed intact

By scaling the part image rather than adding a separate length field. Bone length in this rig
is **derived** from `img.height`, and pivots are **normalized fractions** of the part's own
box — so scaling the art moves the knee and ankle pivots down proportionally and the chain
stays correct by construction. The foot plants on the same ground line because the ankle is
now where the longer bone puts it.

Scaling is **uniform**, not vertical-only, so the boot keeps its proportions. The cost is that
the far calf is ~29% wider than cut — about 1.5 px at final resolution, on a darkened far-side
limb. Acceptable, and noted below.

## Files

| file | what |
|---|---|
| `walk_sheet_48_nearfar.png` | 8-frame sheet, 384×48 |
| `walk_48_nearfar.gif` / `walk_384_nearfar.gif` | the loop, native and 8× |
| `frames/` | individual 48×48 cells |
| `comparison_round3_vs_round4.png` | the two rows at 7× — far boot reaches the ground line |
| `rig.json` | curves, per-frame angles, pivots, and the `bone_length_fix` record |

Same parts as rounds 2–3, same knee/elbow curves as round 3. All CPU.

## Outstanding — unchanged

The five re-cuts: **`torso`, `thigh_R`, `thigh_L`, `shoulder_R`, `shoulder_L`**, traced around
the form the way `calf_R` and `forearm_R` were. The **shoulders remain the highest value** —
they are still the only thing hiding the elbow articulation.

One addition for whenever `calf_L` is re-cut: **include the occluded upper portion of the far
calf** if it can be recovered, and the ×1.293 scale here becomes unnecessary — the art would
carry the right length on its own, at its native width.
