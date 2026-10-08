# 21 — Character rig: the canonical bone list

> **Superseded, T-0436 (2026-10-08).** `docs/design/23-canonical-rig.md` is now the
> rig authority. This document's single-hip/single-shoulder attach and flat-side-view
> framing are contradicted by @DennieSeth's canonical skeleton reference on
> structure, proportion and projection — see 23- §0–§3. §1 (COCO-18), §2 (the bone
> tree), §4 (pivot convention), §6 (layer order) and §9 (cutting checklist) are
> carried forward **unchanged** into 23-'s own §1; this document is kept, not
> deleted, as the record of the bone tree's own derivation. Do not treat anything
> below as the current word on shoulder/hip attach geometry.

**Status:** superseded (see above) — formerly authoritative. This is the reference every
character's cut parts must match, for every character, not just the player.

Parts are cut by hand from hi-res source art and composited onto a pose rig by script
(`docs/design/13-asset-pipeline.md`: *master sheets at 1024, motion composited by script*).
That only works if everyone — the person cutting, the generator, and the compositor — agrees
on **which bone each part hangs from and where its pivot is**. This document is that
agreement.

## 0. Side view only

**Decision, @DennieSeth 2026-10-04 — standing.** Characters are authored from the **side
view** only; front and back views are not produced. See
`docs/design/13-asset-pipeline.md`'s "Character views" section.

Consequences for this document:

- The part set below is the **side-view** set. A character needs one cut, not three.
- Parts are authored facing **+x**; a left-facing pose is a mirror at composite time (§4).
- In a side view the **far-side limbs are partly occluded**, so a far part is often cut
  shorter than its near counterpart even though the *bone* is the same length. Correct that
  with a per-part length scale rather than accepting an uneven chain — the reference walk
  needed exactly one such correction, on the far calf.
- Nothing in this spec requires a front or back T-pose.

## 1. Joint source of truth: COCO-18

Every pose rig in this pipeline already emits the standard 18-keypoint COCO/OpenPose
layout, and `assets/src/character/pose_rig_master_sheet_T0351.py` defines the indices.
Bones are derived from those joints — we add no new joints.

| idx | joint | idx | joint | idx | joint |
|---|---|---|---|---|---|
| 0 | NOSE | 6 | L_ELBOW | 12 | L_KNEE |
| 1 | NECK | 7 | L_WRIST | 13 | L_ANKLE |
| 2 | R_SHOULDER | 8 | R_HIP | 14 | R_EYE |
| 3 | R_ELBOW | 9 | R_KNEE | 15 | L_EYE |
| 4 | R_WRIST | 10 | R_ANKLE | 16 | R_EAR |
| 5 | L_SHOULDER | 11 | L_HIP | 17 | L_EAR |

`PELVIS` is not a COCO joint; it is defined as `midpoint(R_HIP, L_HIP)`. The eyes and ears
(14–17) carry no bone — they are facing hints only.

## 2. The bone tree

`.R` / `.L` are **anatomical** sides, not screen sides. A mirrored sprite keeps its
anatomical labels (`pose_rig_master_sheet_T0351.mirror_keypoints_lr` already swaps them
correctly).

| bone | parent | runs from → to |
|---|---|---|
| `root` | — | ground point directly under `PELVIS`; carries world position and the walk bob |
| `pelvis` | `root` | `PELVIS` — the hip anchor |
| `spine` | `pelvis` | `PELVIS` → `NECK`(1) |
| `neck` | `spine` | `NECK`(1) → base of skull |
| `head` | `neck` | `NECK`(1) → `NOSE`(0) |
| `clavicle.R` | `spine` | `NECK`(1) → `R_SHOULDER`(2) |
| `upperarm.R` | `clavicle.R` | `R_SHOULDER`(2) → `R_ELBOW`(3) |
| `forearm.R` | `upperarm.R` | `R_ELBOW`(3) → `R_WRIST`(4) |
| `hand.R` | `forearm.R` | `R_WRIST`(4) → fingertips |
| `clavicle.L` | `spine` | `NECK`(1) → `L_SHOULDER`(5) |
| `upperarm.L` | `clavicle.L` | `L_SHOULDER`(5) → `L_ELBOW`(6) |
| `forearm.L` | `upperarm.L` | `L_ELBOW`(6) → `L_WRIST`(7) |
| `hand.L` | `forearm.L` | `L_WRIST`(7) → fingertips |
| `thigh.R` | `pelvis` | `R_HIP`(8) → `R_KNEE`(9) |
| `shin.R` | `thigh.R` | `R_KNEE`(9) → `R_ANKLE`(10) |
| `foot.R` | `shin.R` | `R_ANKLE`(10) → toe |
| `thigh.L` | `pelvis` | `L_HIP`(11) → `L_KNEE`(12) |
| `shin.L` | `thigh.L` | `L_KNEE`(12) → `L_ANKLE`(13) |
| `foot.L` | `shin.L` | `L_ANKLE`(13) → toe |

19 bones. The tree is the full articulation; **not every bone takes its own part** — see §3.

## 3. Which part attaches to which bone

Two part sets. **CORE is what to cut today.** EXTENDED exists so the same bone names keep
working if we ever render characters larger than 40 px.

### CORE — 6 parts, what a 40 px figure actually resolves

| part file | attaches to | pivot sits at | covers bones |
|---|---|---|---|
| `head` | `neck` | `NECK`(1) | `neck`, `head` |
| `torso` | `spine` | `PELVIS` | `spine`, both `clavicle` |
| `arm.R` | `upperarm.R` | `R_SHOULDER`(2) | `upperarm.R`, `forearm.R`, `hand.R` |
| `arm.L` | `upperarm.L` | `L_SHOULDER`(5) | `upperarm.L`, `forearm.L`, `hand.L` |
| `leg.R` | `thigh.R` | `R_HIP`(8) | `thigh.R`, `shin.R`, `foot.R` |
| `leg.L` | `thigh.L` | `L_HIP`(11) | `thigh.L`, `shin.L`, `foot.L` |

**Why the arm is one piece.** Measured from this rig's own keypoints at a 40 px figure, an
upper arm is **5.6–8.7 px** and a forearm **5.9–7.5 px**. `13-asset-pipeline.md` says of
this scale: *"Nearly all generated detail is destroyed in the descent; what survives is
shape and a few value blocks."* An elbow joint inside a ~13 px limb is below what survives,
so splitting there costs a cut and buys nothing. The same reasoning applies to the knee.

### EXTENDED — 9 parts, for larger renders or when knee bend is wanted

Splits `arm` into `upperarm` + `forearm_hand`, and `leg` into `thigh` + `shin_boot`:

| part file | attaches to | pivot sits at |
|---|---|---|
| `upperarm.R/L` | `upperarm.R/L` | `R/L_SHOULDER` |
| `forearm_hand.R/L` | `forearm.R/L` | `R/L_ELBOW` |
| `thigh.R/L` | `thigh.R/L` | `R/L_HIP` |
| `shin_boot.R/L` | `shin.R/L` | `R/L_KNEE` |

Mixing is allowed — e.g. CORE arms with EXTENDED legs, if knee bend matters more than
elbow bend. It does for a walk.

## 4. Pivot convention

- A pivot is stored as a **normalized (x, y) fraction of the part's own cropped bounding
  box**, origin top-left. `(0.5, 0.0)` is the top-centre.
- The pivot marks the **proximal joint** — the end nearest the parent bone. An arm pivots
  at the shoulder, a shin at the knee.
- Rotation is about the pivot, and the pivot is the point that lands on the bone's joint
  position. The compositor is responsible for nothing else.
- Parts are authored **facing right**. Left-facing is produced by mirroring at composite
  time, not by cutting a second set.

## 5. Cutting rules

1. **Cut whole forms, including their shadow side.** Cut the silhouette of the thing, not
   the lit rim of it. A part cut along a highlight edge is half a part.
2. **Overlap the parent by ~10–15% at the proximal end.** A part that stops exactly at the
   joint shows a gap the moment it rotates. The overlap is hidden by layer order.
3. **One part, one connected region.** If a cut yields two islands, the cut is wrong.
4. **Include the joint's own covering.** A sleeve cap belongs to the arm; the coat shoulder
   belongs to the torso. Decide once and stay consistent.
5. **Save as PNG with real alpha.** Never JPEG — see §7.
6. Name files `<part>.<side>.png` for sided parts, `<part>.png` otherwise: `head.png`,
   `torso.png`, `arm.R.png`, `leg.L.png`.

## 6. Layer order

Back to front, for a right-facing side view:

```
leg.L  →  arm.L  →  torso  →  head  →  leg.R  →  arm.R
```

(far limbs, then body, then near limbs). For a front view the two legs and two arms sit at
the same depth and either order reads correctly; keep the same list for consistency.

## 7. Background and keying

Source art must be generated on a **flat magenta `#FF00FF` chroma-key background**, and
parts must be saved as **PNG with alpha**.

Dark-on-black costs real work: a hand-cut set taken from a dark render against black lost
the head's goggle lens entirely (it sat at luminance 2–10, indistinguishable from the
background at any threshold) and yielded a "arm" that was only the lit rim of a sleeve.
Magenta shares no channel with the green/brown costume, so a chroma key is unambiguous.

> **Collision note.** `#FF00FF` is also used *internally* as the cut-out background key in
> the asset-gate evidence pipeline (`docs/assets/evidence/T-0337/panel_*_oklab_after.png`).
> Generation-source magenta and internal key magenta must not be confused by downstream
> code. Resolving that explicitly is tracked separately — do not assume the two uses are
> interchangeable.

## 8. Worked example — the side-view walk

The first assembled walk used CORE with only near-side limbs plus a darkened stand-in for
the far side (`walk_preview_2026-10-04/rig.json`):

- `leg` swings **±24°** about `thigh` at `R_HIP`
- `arm` swings **±16°** about `upperarm` at `R_SHOULDER`, in **opposition** (π out of phase)
- `root` bobs **twice per cycle**, amplitude ≈ 1.8% of torso height
- `head` and `torso` stay unrotated and ride the root bob
- 8 frames, output 48×48 per cell with the figure 40 px tall

Those angles are a reasonable default for a walk, not a law.

## 9. Checklist before handing parts back

- [ ] Source was magenta-backed, not dark-on-black
- [ ] Every part is PNG with alpha
- [ ] CORE set complete: `head`, `torso`, `arm.R`, `arm.L`, `leg.R`, `leg.L`
- [ ] Each part is one connected region, whole form, shadow side included
- [ ] Proximal ends overlap the parent by ~10–15%
- [ ] All parts cut from the **same** source render, so lighting and colour match
- [ ] Parts face right
