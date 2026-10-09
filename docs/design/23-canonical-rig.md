# 23 — Canonical rig: shoulder bar, pelvis bar, lateral offset axis

**Status:** authoritative. This supersedes `docs/design/21-character-rig-bones.md`
(marked superseded in place, not deleted — see its own banner and §8 below).

**Source, T-0436 (2026-10-08).** @DennieSeth supplied a canonical skeleton reference
— a hooded figure in a wide-stance 3/4 action pose with the intended bone structure
drawn in red over it (`zorder_fix_2026-10-08/dennie_canonical_skeleton_ref.png`).
His instruction: *"He's facing another direction, but the overall skeleton bone
positions should match this pose. Do all the others from it."*

**Where these numbers came from.** That reference file is not present in this
worktree, and the card's attachments are empty. Every measurement in this document
is transcribed from the task card's own body and @DennieSeth's comment on it, which
record the method (seeding the image, snapping to maximize coverage of the drawn
strokes, two structural features confirmed by 1px scanline rather than by eye) —
this round did not re-derive them from source pixels. `canonical_rig.T0436_source`
in `side_view_rig.json` carries this same note next to the numbers it qualifies.

**Evidence path correction.** The card's own Deliverable section names
`docs/assets/evidence/T-0435/...` for both evidence files. T-0435 is a different,
already-existing, unrelated backlog card (an auto-proposed flow-health rework-rate
report — confirmed via `GET /api/tasks/T-0435`). Writing evidence there would
misattribute it to that card, so this round writes to `docs/assets/evidence/T-0436/`
(this card's own id) instead.

**Fix round 1, 2026-10-08T21:08 — two defects @DennieSeth found in the first render.**

1. **The far arm was shattered and detached from the torso.** The first round's
   `lateral_offset_axis.demonstration_values` assigned a DIFFERENT offset to each of
   the four parts it named (`shoulder_L -0.50`, `forearm_L -0.20`, `thigh_L -0.08`,
   `calf_L -0.03`), so each limb chain's two halves slid apart by their own,
   different amounts instead of moving together. Fix round 1 equalized each pair's
   dict VALUES — diagnosed correctly, but the compositor code still applied the
   offset twice per chain, so the equalized values still produced a DOUBLED (not
   equal) effective shift at the distal part. The reviewer's FAIL verdict
   (2026-10-08T21:54:30Z) caught this by direct measurement. **Fix round 2 (this
   round, §3c) fixes the compositor itself** — the offset now applies once, at each
   chain's root, and the distal part inherits it purely through forward kinematics.
2. **The z-order was wrong.** @DennieSeth specified an exact front-to-back order
   that reverses two relationships the first round's `rig.*.z` values had backwards
   — head now draws in front of torso, and the near arm now draws in front of the
   near leg. §3d publishes that order as canonical and confirms it from the
   rendered result, not just from the z numbers. Unaffected by fix round 2.

**Fix round 3, this round — the evidence overlay was itself miscalibrated, and one
debug field silently ignored this card's own lateral offset.** The reviewer's FAIL
verdict (2026-10-08T22:18:16Z) found two further defects, both in
`rig_compositor.render_frames`, not in the pose geometry fix round 2 already landed:

1. **`hip_px` changed meaning.** This card's first commit made `hip_px` equal
   `to_canvas(resolved_hip_points["R"])` whenever `hip_points` was supplied, instead
   of always `to_canvas(leg.hip)`. `gen_reference_pose_evidence_T0436.py`'s own
   `to_canvas` is built on `hip_px` meaning the canvas pixel for world `(0, 0)` —
   true for every pre-existing caller (none of which pass `hip_points`) but false
   for this card's own `reference_pose_T0436.render()`, which does. Measured on the
   committed (pre-fix) overlay: every drawn point was off by the same +9.0627px in
   x (the distance from world `(0, 0)` to `hip_R`). `hip_px` now reverts to always
   meaning `to_canvas(leg.hip)` — a no-op for every other caller, and correct again
   for this one.
2. **The debug leg-chain pixels ignored the lateral offset.** `knee_l_px`/
   `ankle_l_px` (and the `R`-side siblings) were solved from
   `resolved_hip_points["L"]` directly, never passing it through the same
   `lateral()` shift `build_placements` applies to the actually-rendered `calf_L`.
   The two agreed for the right leg (no offset there) but disagreed for the left by
   exactly the chain's own offset. A `lateral_debug()` closure mirroring
   `build_placements`'s own now applies it in both places.

Two regression tests (`TestHipPxMatchesWorldOrigin`,
`TestLegDebugPixelsTrackTheLateralOffset` in
`tests/test_reference_pose_render_T0436.py`) are red against the fix-round-2 code
and green after this round's fix. §4 below restates the per-joint deviation numbers
as independently re-measured against the regenerated, now-correctly-calibrated
overlay, rather than asserting the fix round 2 claim still holds.

**Fix round 4, 2026-10-09 — @DennieSeth reviewed the render again and raised two
items; one was a real defect, one was not.**

1. **The z-order is NOT wrong.** @DennieSeth's own re-check (`T0436_ORDER_AUDIT.png`,
   a part map built by replaying the paint loop and taking the last writer, not by
   re-sorting z) found the committed `rig.*.z` values match the realized paint order
   10 of 10, with 0 of 15 contested pairs resolving against the published list. §3d
   below is unchanged in its numbers — a straight read of 21-'s now-replaced order
   would have been wrong, but §3d's order was already correct going into this round.
   What was actually wrong was the arms' *pose*, which made a correct order look
   wrong because the overlaps it was supposed to govern barely existed. This round
   adds a committed, re-runnable version of that same replay-the-paint-loop check
   (`char_gen.draw_order_audit_T0436`, §3d) rather than leaving it as a one-off
   script and a human-attached PNG.
2. **Both arms were posed from one shared angle, and that IS wrong.**
   `rig_compositor.build_placements` computed a single `shoulder_abs_deg` before the
   per-side loop and applied it (plus one shared `elbow_deg`) to both arms. The
   reference has the near arm reaching forward and the far arm trailing back — two
   different angles no shared scalar can express. `UpperPose` gains four additive,
   `None`-defaulting fields (§3e) and `reference_pose_T0436` now poses each arm from
   its own angle, measured off the reference's own red bone lines (now attached to
   the card as `dennie_canonical_skeleton_ref.png`).

Evidence regenerated this round reflects both findings: the arm angles changed (§3e,
§4), the published z-order did not (§3d).

**Fix round 5, 2026-10-09T15:29 — the far shoulder reads as detached from the
torso, and the cause is not what the first read suggested.** @DennieSeth's
fix-round-4 verification found a wedge of background in the "armhole" between
`shoulder_L` and `torso`, right where the arm should plug into the body, and
initially read it as the part being undersized. Measured directly, a uniform
part up-scale does not close it — a part is pinned at its own pivot (`shoulder_L`'s
is its PROXIMAL/shoulder end), so scaling only extends the DISTAL end further out;
the sleeve-to-torso gap is unchanged at every scale factor swept, 1.00 through
1.64. The actual cause is fix round 2's arm-chain `lateral_offset_frac` (-0.35):
it over-pushes the whole far-arm chain clear of the torso, not just clear of its
own silhouette. §3f (new this round) drops the arm-chain offset to -0.10 and
separately restores `shoulder_L`'s own cut WIDTH (shrunk to 61% of the artist's
cut as a side effect of the existing bone-length correction) via a new
anisotropic form of `bone_length_fix.scaled` — two independent fixes, neither
touching the committed part art. §4 and §6 restate the resulting numbers;
`char_gen.shoulder_attachment_T0436` (new this round) carries the armhole/overlap
measurement and `tests/test_shoulder_attachment_T0436.py` its test coverage.
@DennieSeth also raised a possible `_R`/`_L` naming swap in the same comment
(the source art is mirrored) — audited and found the current naming correct (a
figure facing screen-right shows the viewer its anatomical RIGHT side, and the
`_L` art independently shows the expected far-side cues: lower ink detail,
e.g. `thigh_L` dark-ink fraction 0.02 vs `thigh_R` 0.22); no rename applied this
round, see the card's own fix-round-5 comment for the full three-point check.

## 0. What this card changes, and what it does not

**In scope:** this document, `side_view_rig.json` v2, and a static render proving
the rig can reproduce the reference's measured structure. **It changes no
animation.** `walk_cycle`, `idle_cycle`, `sitting_idle_cycle` and (if it existed in
this codebase — it does not; see §7) `sit_down_transition` are not re-derived here.
Re-deriving each one's own pose, now that the rig has changed under it, is the
follow-on sequence, one card at a time, each reviewed on its own.

One exception, explicit and bounded: `shoulder_R`'s bone-length-fix scale (§6) DOES
reach every existing pose module, the same way `calf_R`'s already did — because both
are the same existing mechanism (`rig_compositor.scaled_parts`), generalized, not a
new one. §7 states exactly what that changes and by how much.

> Fix round 10 correction: this paragraph named `shoulder_L`/`calf_L` and cited §5
> (leg-proportion reconciliation); the correction is keyed `shoulder_R`/`calf_R` in
> the committed rig, and the right cross-reference is §6 (the section the
> correction is actually described in). Both fixed directly, not pointer-noted —
> see §6's own fix-round-10 note for why.

## 1. Conventions carried forward from `docs/design/21-character-rig-bones.md`

Carried **verbatim, meaning unchanged**, from 21's own sections:

- **§4 Pivot convention** — a pivot is a normalized `(x, y)` fraction of the part's
  own cropped bounding box, origin top-left, marking the **proximal** joint (the end
  nearest the parent bone). Rotation is about the pivot. Parts are authored facing
  **+x**; left-facing is a mirror at composite time, never a second cut.
- **§3 Part/bone/pivot table format** — one row per part: which bone it attaches to,
  where its pivot sits, which bones it covers. The CORE/EXTENDED split (6 parts vs 9
  — this rig's committed ten parts are the EXTENDED set, per `parts/side_view/
  README.md`) is unchanged.
- **§6 Layer order** — NOT carried forward; REPLACED. 21-'s back-to-front order
  (`leg.L → arm.L → torso → head → leg.R → arm.R`) was correct for the round this
  document originally shipped in (its own `rig.*.z` values were untouched then). The
  fix round (2026-10-08T21:08) changes this: @DennieSeth specified an exact
  front-to-back order (§3d) that reverses two of 21-'s relationships — head now
  draws in front of torso, and the near arm now draws in front of the near leg.
  `side_view_rig.json`'s `rig.*.z` values are updated to match. §3d is the current
  word on layer order; 21- §6 is marked replaced in place, not deleted.
- **§9 Cutting/handoff checklist** — unchanged; still the checklist a newly cut part
  set is handed back against. This card cuts nothing (§6).
- **§1 COCO-18 joint source of truth** and **§2 the bone tree** — unchanged. The
  shoulder bar and pelvis bar below are new ATTACH geometry for the existing
  `clavicle.R/L` and `pelvis` bones, not new joints or a new tree.

Not carried forward as written: §0 ("Side view only," standing) is unaffected by
this card for the *production* animation set (§0 above) — the static reference-pose
render in §4 exercises the rig's structure in a representative wide-stance pose, it
does not establish a new production camera angle.

## 2. What the reference establishes, measured

Normalized to the reference's own spine (`NECK → PELVIS` = 295.7px = 1.00):

| | reference | this rig's current (pre-fix) value | |
|---|---|---|---|
| shoulder bar | **0.55** | 0.00 | absent — one shared attach point |
| pelvis bar | **0.08** | 0.00 | absent — one shared attach point |
| upper arm (near) | 0.47 | 0.4454 | already close |
| forearm (near) | 0.66 | 0.8573 | +30% over |
| thigh (near / far) | 0.68 / 0.72 | 1.0665 | ~+50% over |
| shin (near / far) | 1.21 / 0.80 | 1.4275 | ~+78% over (far-reconciled target) |

This rig's own spine (`attach_torso_local_px`: `NECK → HIP`) measures **231.34px**
in its own native units — a different absolute scale than the reference image, which
is why every structural quantity below is carried as a **fraction of spine**, not a
raw pixel count, and converted into this rig's own px only when applied.

### The projection caveat

A 3/4 projection conflates bone length with foreshortening. The raw near-side leg
numbers are visibly contaminated: near shin/near thigh = **1.78**; far shin/far
thigh = **1.11**; anatomy expects roughly **1.0–1.1**. In this lunge the near thigh
points away from the viewer (compressed) while the near shin crosses the view plane
(full length) — "near side is truth," correct for the arms, breaks down for this
pose's legs. See §3's reconciliation.

## 3. The three gaps, and how this rig closes each

### 3a. One hip for both legs → a pelvis bar with two distinct ends

`canonical_rig.pelvis_bar` in `side_view_rig.json`:

```
"pelvis_bar": {
  "reference_frac": 0.08,
  "px": 18.5074,
  "R_local_px": [115.3337, 236.44],
  "L_local_px": [96.8263, 236.44]
}
```

`0.08 × spine_px (231.3422) = 18.5074px`, split evenly either side of the existing
single `attach_torso_local_px.hip` point `[106.08, 236.44]`, along the local-x axis
(the same axis the torso's parts are already authored along). **Native-units note
(acceptance edge case):** 18.5px is real in the rig's own geometry; at the shipped
`CHARACTER_SCALE` (0.0398) it descends to 0.74px — sub-pixel at the final 48px cell.
That is the documented, accepted consequence, not a defect: the pelvis bar's effect
lives in the geometry (it is what `hip_points` resolves each leg's own root to), not
necessarily in a visibly separated final-cell pixel.

### 3b. One shoulder for both arms → a shoulder bar with two distinct ends

`canonical_rig.shoulder_bar`, same construction: `0.55 × 231.3422 = 127.2382px`,
split either side of `attach_torso_local_px.shoulder` `[114.92, 30.84]`:

```
"shoulder_bar": {
  "reference_frac": 0.55,
  "px": 127.2382,
  "R_local_px": [178.5391, 30.84],
  "L_local_px": [51.3009, 30.84]
}
```

### 3c. No lateral axis → a per-part opt-in lateral offset

`rig_compositor.build_placements`/`render_frames` gain three keyword-only
parameters, all defaulting to `None`:

- `shoulder_points: {"R": (x, y), "L": (x, y)}` — replaces the single shared
  `attach["shoulder"]` point with two independent world points (3a/3b's bar ends).
- `hip_points: {"R": (x, y), "L": (x, y)}` — same, for `leg_hip_points`'s result.
- `lateral_offset_frac: {part_name: frac}` — an ADDITIONAL sideways (local-x) shift,
  as a fraction of the torso's own width, applied to that part's own target
  position. A part hanging off a shifted root (e.g. `forearm_L` off `shoulder_L`)
  inherits the shift through the forward-kinematics chain automatically; naming it
  again adds a further, independent nudge.

All three are **a complete no-op when omitted** — every pre-existing pose module
(`walk_cycle`, `idle_cycle`, `sitting_idle_cycle`) omits all three, proven by
`tests/test_canonical_rig_T0436.py::TestOptInCompositorHooks::
test_omitting_all_three_params_is_identical_to_not_having_them` and by the full
existing suite staying green (§7).

**This is the fix for the far arm's 0-visible-pixel baseline.** A z/depth value only
changes which part wins a contested pixel; it was already true before this card that
`shoulder_L`'s z (then 5) beats the torso's (then 3), and the far arm was STILL
invisible, because they occupied the *same x* — re-sorting never had anywhere to put
it that the sort could reveal. `lateral_offset_frac` moves the pixel itself.

**Fix round 1, 2026-10-08T21:08 — one offset per chain, not one per part (diagnosis
correct, fix incomplete).** The first round assigned `shoulder_L -0.50`, `forearm_L
-0.20`, `thigh_L -0.08`, `calf_L -0.03` — four different numbers for two chains.
`rig_compositor.build_placements` applied each part's OWN offset to the joint it
owns, so the proximal and distal ends of one limb slid apart by the DIFFERENCE
between their two offsets. That round's response was to equalize each pair in
`canonical_rig.lateral_offset_axis.demonstration_values` — `shoulder_L`/`forearm_L`
share one value, `thigh_L`/`calf_L` share another — on the theory that equal dict
values would produce equal, non-tearing displacement.

**That theory was wrong, and the reviewer's FAIL verdict (2026-10-08T21:54:30Z)
caught it by direct measurement, not by re-reading the diff.** `build_placements`
computes the distal joint (elbow, knee/ankle) by forward kinematics FROM the root's
*already-shifted* position, then applied `lateral()` a SECOND time using the distal
part's own name. The root's shift is therefore inherited once through FK and then
added again explicitly — two equal dict values do not cancel into one shift, they
compound into a 2× shift at the distal part. Measured on the `-0.35`/`-0.35` values
fix round 1 actually committed: `shoulder_L` moved -0.350×torso (-77.35px) but
`forearm_L` moved **-0.700×torso (-154.70px) — exactly double**, not equal. The sweep
table and "sweep it directly" sentence this section used to carry were written
against this broken mechanism (and `gen_reference_pose_evidence_T0436.py` in fact
contains no sweep/connected-component code at all — that text described work that
was never run). Both are replaced below with a sweep actually executed against the
corrected code.

**Fix round 2, this round — the offset is applied ONCE per chain, at the root, and
inherited through FK; it is never applied again at the distal part.**
`rig_compositor.build_placements` no longer calls `lateral(elbow, fa_name)` or
`lateral(knee/ankle, cf_name)` — `elbow`/`knee`/`ankle` are forward-kinematics
results computed from the already-shifted root (`sh_world`/`hip_side`), so they
carry that same shift automatically, once. A regression test
(`TestOptInCompositorHooks::test_naming_both_chain_ends_does_not_double_the_shift`)
sets both a chain's root and distal key to the same value and asserts the distal
part's effective shift equals the root's, not double it — red against the committed
fix-round-1 code (confirmed: -154.70px vs the expected -77.35px), green after this
round's fix. Re-measured: `shoulder_L` **and** `forearm_L` both -0.350×torso
(-77.35px); `thigh_L` **and** `calf_L` both -0.060×torso (-13.26px) — equal dict
values now produce an equal effective shift, exactly once.

**A consequence of the fix: the chain is now RIGID — it cannot tear at any
magnitude**, because the distal part's position is pinned to the root's by
construction (no independent degree of freedom remains once the duplicate
`lateral()` call is gone). The only way a limb can now visually separate from the
main body is if the WHOLE chain is pushed far enough that the sleeve/boot itself no
longer overlaps anything — not a tear, a true detachment. The real sweep
(4-connectivity component labelling over the composited alpha mask, same algorithm
`char_gen.part_isolation._label_connected_components` already uses elsewhere in this
package, run directly against the fixed code):

```
 arm chain offset   extra blobs ≥50px*   shoulder_L px   forearm_L px
      -0.10                 0                    4               0
      -0.20                 0                 1703             296
      -0.35  <- chosen      0                 5523            2888
      -0.45                 0                 7118            5631
      -0.50                 0                 7155            7197
      -0.70                 0                 7154           10641
      -0.95                 0                   --              --
      -1.00                 1  (detaches, +19765px)

 leg chain offset   extra blobs ≥50px*     (arm chain held at the chosen -0.35)
      -0.03                 0
      -0.06  <- chosen      0
      -0.35                 0
      -0.70                 0
      -0.80                 1  (detaches, +85498px)
```

`*` **"extra" is beyond 2 pre-existing, unrelated fragments**, not beyond zero: even
at `lateral_offset_frac={}` (no lateral push at all), the composited alpha mask
already shows 2 components ≥50px besides the main body — a 726px and a 73px
fragment. Removing `calf_R` from the composite removes both; they are a motion-streak
mark baked into `calf_R.png`'s own committed art (visible under the boot in a direct
crop), present whenever `calf_R` renders at all, completely independent of this
card's lateral-offset mechanism or chosen magnitude. `calf_R` is not re-cut or
otherwise touched (§6/§9 forbid that), so the two fragments persist in the evidence
render; every count above is beyond those two.

**Chosen: `shoulder_L`/`forearm_L` = -0.35, `thigh_L`/`calf_L` = -0.06.** Both sit
far inside their own safe bracket — arm detaches at -1.00, chosen value has a
~0.65×torso margin; leg detaches at -0.80, chosen value has a ~0.74×torso margin —
while the arm chain already recovers most of its achievable far-arm visibility
(`shoulder_L` is within ~250px of its own ~7155px ceiling at -0.35; growing the
offset further mostly buys more `forearm_L` visibility at a steadily shrinking rate,
since `shoulder_L` itself plateaus by -0.50). `-0.35` was kept rather than pushed
toward the ceiling because the structural goal is to pull the far arm out from
inside the torso's silhouette, not to swing it visibly away from the body — a small
offset with both parts still non-zero satisfies the acceptance criterion without
making the pose read as anatomically implausible. The leg chain's offset is small
because the pelvis bar (§3a) already does most of the separating — `-0.06` is a
modest additional push, not the primary mechanism for that chain.

**Superseded by fix round 5 (§3f): the arm-chain value is now -0.10, not -0.35.**
This section's sweep only checked for new DETACHED fragments at the silhouette
level; it never measured the armhole gap at the shoulder joint itself, which is
what fix round 5 found and fixed. The leg-chain value (`-0.06`) and the
reasoning above for it are unchanged and still current.

## 3d. Layer order — @DennieSeth's exact front-to-back order

**Superseded by fix round 6 (§3g) — the table immediately below is the order fix
rounds 1 through 5 shipped (`_R` near, `_L` far). @DennieSeth's Option B
(2026-10-09T16:43) replaces it wholesale: the two limb groups swap, so `_L` is now
the near/frontmost group and `_R` is the far/backmost group. This is NOT a
regression back to 21-'s retired order — see §3g for the committed table, the
re-measured contested-pair audit, and why the swap happened. The rest of this
section (§3d) is kept as a historical record of what shipped through fix round 5
and the reasoning that supported it at the time; where it says "this round" below,
it means fix rounds 1–5, not fix round 6.**

Front (closest to viewer) first, back last. `rig_compositor.render_frames` sorts
`key=lambda p: -p.z` then composites in that order, so a LOWER z draws LAST and
therefore wins every contested pixel — z 0 is frontmost, z 9 is backmost:

| z | part | | z | part | |
|---|---|---|---|---|---|
| 0 | `forearm_R` | frontmost | 5 | `torso` | |
| 1 | `shoulder_R` | | 6 | `calf_L` | |
| 2 | `thigh_R` | | 7 | `thigh_L` | |
| 3 | `calf_R` | | 8 | `shoulder_L` | |
| 4 | `head` | | 9 | `forearm_L` | backmost |

*(fix rounds 1–5 table — superseded by §3g)*

This is `side_view_rig.json`'s own `rig.*.z` for all ten parts — the SAME default
every pose module reads unless it supplies its own `z_override` (§7 states exactly
who does and the resulting pixel impact). Two reversals from 21-'s retired order,
both exactly as @DennieSeth specified:

1. **`head` now draws in front of `torso`** (z 4 vs 5) — the committed rig had
   torso (3) in front of head (4) before this round.
2. **The near arm now draws in front of the near leg** — `shoulder_R`/`forearm_R`
   (z 0/1) in front of `thigh_R`/`calf_R` (z 2/3). The committed rig had the near leg
   (z 0) in front of the near arm (z 1) before this round.

**Confirmed from the rendered result, not asserted from the z numbers alone.**
Compositing `forearm_R` alone and `thigh_R` alone (same canvas, same placements)
finds 950 pixels where both are independently opaque — the contested region. In the
real, full composite, 674 of those 950 pixels match `forearm_R`'s own rendered
color exactly (the remainder are anti-aliased edge-blend pixels that do not match
either part's color exactly — not a parity-sort conflict) and only 4 match
`thigh_R`'s — `forearm_R` visibly wins essentially all of the contested region, as
z 0 vs z 2 says it should.

**Re-confirmed, fix round 4, after the arm-angle fix (§3e) changed where the arms
actually overlap everything else.** `char_gen.draw_order_audit_T0436` (new this
round) replays the identical paint order `render_frames` uses and reports, per pair
of parts whose own masks overlap, how many of the contested pixels each side
actually wins. Run against the reference pose with the new per-side arm angles
(`gen_draw_order_audit_T0436.py`, evidence below): **10 contested pairs, 0
resolving against the published z-order** (this round's `forearm_R`/`thigh_R` pair
from the paragraph above no longer overlaps at all at the new, more
forward-reaching near-arm angle — the near arm instead contests `shoulder_R` — so
the pair count itself is not meant to stay fixed across a pose change; the
zero-violations result is what §3d's order claim rests on):

| lower z (expected winner) | higher z | contested px | lower-z wins | higher-z wins |
|---|---|---|---|---|
| `thigh_R` | `thigh_L` | 9819 | 9819 | 0 |
| `shoulder_R` | `torso` | 6418 | 6418 | 0 |
| `thigh_R` | `calf_R` | 5250 | 5250 | 0 |
| `torso` | `thigh_L` | 4271 | 3261 | 0 |
| `thigh_R` | `torso` | 3597 | 3597 | 0 |
| `head` | `torso` | 3000 | 2964 | 0 |
| `calf_L` | `thigh_L` | 1573 | 1573 | 0 |
| `forearm_R` | `shoulder_R` | 1268 | 1268 | 0 |
| `shoulder_L` | `forearm_L` | 824 | 824 | 0 |
| `shoulder_R` | `head` | 36 | 36 | 0 |

The gap between a pair's `contested_px` and its `lower-z wins` count (e.g. `torso`/
`thigh_L`: 4271 vs 3261, `head`/`torso`: 3000 vs 2964) is anti-aliased edge-blend
pixels that belong to neither part's own exact rendered color — the same class of
pixel the earlier `forearm_R`/`thigh_R` paragraph already called out, never a
higher-z part winning outright (every `higher-z wins` column above is 0).

**Re-confirmed again, fix round 5, after §3f's offset/width changes.** The new
`torso`/`shoulder_L` overlap (4523px, §3f — the genuine overlap the attachment fix
introduces) adds an 11th contested pair; it resolves the same way as every other
pair here (`torso` is the lower-z/expected winner at z 5 vs `shoulder_L`'s z 8,
and wins all 4523 contested pixels). **Still 0 of 11 pairs resolving against the
published order.** §4 restates this result alongside the regenerated evidence.

## 3e. Per-side arm angles

`rig_compositor.UpperPose` gained one shared `shoulder_deg`/`elbow_deg` pair, used
by both arms, from its original authoring. That is sufficient for a hanging rest
pose but cannot express the reference's near arm reaching forward while the far arm
trails back — two different angles. Fix round 4 adds four fields, all defaulting to
`None`:

```
shoulder_deg_r: float | None = None
elbow_deg_r: float | None = None
shoulder_deg_l: float | None = None
elbow_deg_l: float | None = None
```

plus `shoulder_deg_for(side)`/`elbow_deg_for(side)` helpers that return the
per-side override when set and fall back to the existing shared `shoulder_deg`/
`elbow_deg` otherwise. `rig_compositor.build_placements` now computes each arm's
`shoulder_abs_deg` *inside* the per-side loop via these helpers, instead of once
before it. **A complete no-op when the four fields are omitted** — every
pre-existing pose module (`idle_cycle`, `sitting_idle_cycle`, `walk_cycle`) does not
set them, proven by
`tests/test_canonical_rig_T0436.py::TestPerSideArmAngles::
test_omitting_the_per_side_fields_is_byte_identical_to_before` and by the full
existing animation suite staying green with no edits to any animation test file
(§7 states the exact test count).

### The angles, measured from the reference's own red bone lines

`dennie_canonical_skeleton_ref.png` is attached to this card as of this round.
Extracted from the red strokes, in image frame (CCW from +x, y up), then mirrored
(the reference faces −x, this rig faces +x, so `theta -> 180 - theta`), then
converted into this rig's own `sign_convention.positive_angle` (0 = hanging straight
down, positive swings the tip toward +x — `rig = world + 90`):

| | upper arm, ref | mirrored | forearm, ref | mirrored | **shoulder_deg** | **elbow_deg** |
|---|---|---|---|---|---|---|
| **R** (near, trails back) | −33.6 | −146.4 | −66.8 | −113.2 | **−56.4** | **+33.2** |
| **L** (far, reaches forward) | −134.3 | −45.7 | −175.0 | −5.0 | **+44.3** | **+40.7** |

**Naming note (fix round 10).** This table uses the POST-fix-round-7 names, matching
the committed `reference_pose_T0436.py` constants below. At the time these angles
were first measured (fix round 4), the near/trails-back arm was named `R` and the
far/reaches-forward arm was named `L` — the opposite of this table's own labels at
that time. Fix round 7's suffix rename (§3h) swapped which physical arm each name
answers to, and this table was left under the pre-rename labels for three
subsequent rounds; it is corrected here. The physical measurements themselves (the
raw/mirrored columns and the resulting `shoulder_deg`/`elbow_deg` values) are
unchanged by the rename — only which row they sit under moved with it.

`reference_pose_T0436.py` carries these as `SHOULDER_DEG_R`/`ELBOW_DEG_R`/
`SHOULDER_DEG_L`/`ELBOW_DEG_L`, replacing the previous `SHOULDER_REST_DEG = 10.0`/
`ELBOW_REST_DEG = 20.0` pair that gave both arms the same ~10° droop — within 10° of
hanging straight down, which is the defect @DennieSeth's fix-round-4 comment points
at directly. `upper_pose()` sets `shoulder_deg`/`elbow_deg` to the **R** values (so
a reader diffing the dataclass never mistakes the shared fields for an unset
placeholder) and sets `shoulder_deg_r`/`elbow_deg_r`/`shoulder_deg_l`/`elbow_deg_l`
explicitly for both sides — so neither side ever actually falls back to the shared
pair; every arm's posed angle traces to one of the four reference-derived numbers
above.

Tests: `tests/test_canonical_rig_T0436.py::TestPerSideArmAngles` (the dataclass and
`build_placements` mechanism, against synthetic poses) and
`tests/test_reference_pose_render_T0436.py::TestPerSideArmAnglesFromTheReference`
(the constants match the measured values; the two elbows land at the
angle-derived forward-kinematics target, not just at different root points).

### Scope: additive, no animation re-derived

Adding per-side arm angles touches `UpperPose`, which every pose module constructs.
Per §0/§7, no animation is re-derived this round — `walk_cycle`, `idle_cycle` and
`sitting_idle_cycle` render exactly as they did before this round because none of
them sets the four new fields, confirmed by their own unmodified test files staying
green (§7 restates this with the exact test count).

## 3f. The far shoulder's attachment to the torso (fix round 5)

**Fix round 4's armhole wedge is a two-part measurement problem, not one.**
`char_gen.shoulder_attachment_T0436` (new this round) gives both halves:

- `armhole_wedge_px` — background pixels enclosed between `shoulder_L` and
  `torso`, within 130px of the shoulder joint. A per-row (scanline) test: on each
  row within the circle, if `torso`'s own opaque x-range and `shoulder_L`'s own
  opaque x-range don't overlap, the background pixels strictly between them are
  the wedge.
- `sleeve_torso_overlap_px` — pixels where both parts' own masks are opaque at
  once — a genuine overlap, not an abutment.

**Why a uniform up-scale does not work.** `shoulder_L`'s pivot (`rig.shoulder_L
.pivot`, `[0.5, 0.08]`) is near its PROXIMAL (shoulder) end — a part is always
placed and rotated about its own pivot, so scaling the image changes only how far
the DISTAL end reaches, never where the proximal end sits relative to the torso.
Swept directly: the sleeve-to-torso gap is unchanged at every scale factor from
1.00 to 1.64 — restoring the sleeve's full raw width alone (without touching the
offset below) cuts the armhole wedge by only ~6%.

**What actually causes it: the arm-chain lateral offset.** At the fix-round-4
committed value (-0.35), the far-arm chain is pushed far enough sideways that
`shoulder_L`'s proximal end clears the torso's own silhouette entirely instead of
just clearing it enough to read as attached. Re-swept directly against the fixed
code (armhole wedge px / sleeve-torso overlap px / `shoulder_L`+`forearm_L`
visible px, by arm-chain offset, with the width-restore anisotropic scale already
applied so these are the actual committed sleeve geometry):

```
 offset   armhole wedge   sleeve/torso overlap   shoulder_L+forearm_L visible
 -0.35         3322               166                      23963
 -0.25         1482              1274                      22824
 -0.16          516              2982                      21096
 -0.10  <-      184              4523                      19580
 -0.05           52              5865                      18231
```

**Chosen: -0.10, bracketed on both sides.** -0.05 leaves only 231px of margin
above the 18000px far-arm-visibility floor (fix round 2's own floor for the far
arm staying meaningfully visible) — too close to the edge of hiding the far arm
again. -0.16 and above reopen the armhole past a 400px ceiling (fix round 4's
committed -0.35 opened it to 3489px as originally measured by @DennieSeth; the
re-sweep above, run against this round's own code, measured 3322px at that same
offset — the two numbers differ slightly because this sweep already has the
width-restore applied, not because the wedge geometry itself changed). -0.10
keeps a comfortable margin on both bounds (184px of the 400px wedge ceiling,
1580px of margin above the 18000px visibility floor) while `shoulder_L`
genuinely overlaps the torso (4523px) rather than merely abutting it.

**The width restore: `bone_length_fix.scaled` gains an anisotropic form.**
`shoulder_L`'s entry was a single scalar (0.6087) through fix round 4, applied to
both axes by `rig_compositor.scaled_parts`. That scalar exists to correct the
BONE LENGTH (which `measured_bone_lengths` derives from height alone), but
applying it to both axes also shrank the sleeve's own CUT WIDTH from its raw
113px to 69px — 61% of the artist's own cut — as an unintended side effect.
`side_view_rig.json`'s `shoulder_L` entry is now `{"height": 0.6087, "width":
1.0}`; `scaled_parts` accepts either a plain number (isotropic — `calf_L`,
unchanged) or this `{height, width}` form (anisotropic), applying each axis's
own scale independently. The bone length is untouched: 103.04px before and
after, matching `shoulder_R`'s 103.04px either way (only the WIDTH changed, from
69px back to the raw 113px). The committed `shoulder_L.png` stays byte-identical
— the fix lives entirely in the rig's own data and composite-time math, per this
card's own no-re-cut rule (§6, §9).

**Measured net effect on far-arm visibility and the silhouette.** Dropping the
offset to -0.10 alone (before the width restore) cost 14.5% of far-arm
visibility (19541px → 16716px at -0.35 vs -0.10, isotropic width); the width
restore recovers most of that back (19580px combined, within 2% of fix round
4's 19990px) because the wider sleeve itself now contributes more of its own
visible area. Connected-component count on the regenerated evidence render
(4-connectivity labelling, same algorithm §4 already uses): still 3 components
≥50px — the main silhouette (238070px, down slightly from fix round 4's 238351px
— the sleeve's own reach shrank with the smaller offset) plus the same two
pre-existing, unrelated `calf_R` motion-streak fragments (726px, 73px). No new
fragment — the figure stays one connected piece.

**Draw order re-verified.** `char_gen.draw_order_audit_T0436`, run again against
this round's geometry: realized rank still matches the published list 10 of 10,
now with **11** contested pairs (gaining `torso`/`shoulder_L`, 4523px — the new
genuine overlap this fix introduces) and **0** resolving against the order. The
published z values (`forearm_R` 0 … `forearm_L` 9) are unchanged and must stay
so (§3d) — this round touches only position (the offset) and the part's own
pixel geometry (the width restore), never `rig.*.z`.

**On the possible `_R`/`_L` naming swap.** @DennieSeth's fix-round-5 comment also
raised, and then itself resolved, a question about whether the mirrored source
art means `_R`/`_L` are backwards. Three independent checks say the current
naming is correct: (1) the raw `head` part's face/eyes sit on the figure's own
right side with no flip anywhere in `rig_compositor.py` (confirmed by grep), so
`facing: "right"` is accurate; (2) a figure facing screen-right shows the viewer
its own anatomical RIGHT side (the frontal-view rule — "the side on the viewer's
left is the character's right" — inverts for a profile, it does not hold as-is);
(3) the `_L` parts independently carry a different ink-detail signature from the
`_R` parts — e.g. `thigh_L` dark-ink fraction 0.02 vs `thigh_R` 0.22, `shoulder_L`
0.15 vs `shoulder_R` 0.38, `calf_L` 0.25 vs `calf_R` 0.43. No rename is applied
this round. **Fix round 6 note:** at the time this paragraph was written, the
ink-detail gap was read as "the `_L` parts are the far side" (consistent with the
then-current occlusion explanation for `calf_L`'s short cut, below). @DennieSeth's
Option B (§3g) draws `_L` in front instead, which the measurement above does not
by itself rule out — the ink-detail gap is a fact about how the ten PNGs were cut,
not about which one a later round decides to draw in front. §3g records that
Option B was chosen and verified by direct part-to-label comparison (not re-argued
from ink detail), and that the rename mapping it implies is identity — no part's
name actually changes.

## 3g. Fix round 6 — Option B: the near/far layering swap

@DennieSeth raised the z-order again after fix round 4's re-audit, this time
attaching a side-by-side numbered part map (`T0436_AB_layer_choice.png`): Option A
is what fix rounds 1–5 shipped (§3d's table — `_R` near, `_L` far), Option B is the
same art with the near/far roles swapped. **@DennieSeth chose Option B
(2026-10-09T16:43).**

**Why, and what was actually wrong.** The earlier suspicion was that a part had
been renamed and the z-order list applied to the new names — that never happened;
no part has been renamed at any point on this card (confirmed again below). The
real issue was the frame of reference the z-order list was read against: fix round
4's audit confirmed the composite REALIZES the published numbers (a check of
internal consistency), but never checked whether those numbers were being applied
to the intended limb group. The A/B sheet resolved that with a direct visual
choice instead of another internal-consistency re-check.

**The rename mapping is IDENTITY — verified mechanically, not assumed.**
`T0436_B_labels_verified.png` (attached to the card) shows, for every rank under
Option B, the art AS DRAWN beside the raw cutout file of that same name:

| rank | label | file drawn | same limb? |
|---|---|---|---|
| 0 | `forearm_L` | `forearm_L.png` | yes |
| 1 | `shoulder_L` | `shoulder_L.png` | yes |
| 2 | `thigh_L` | `thigh_L.png` | yes |
| 3 | `calf_L` | `calf_L.png` | yes |
| 4 | `head` | `head.png` | yes |
| 5 | `torso` | `torso.png` | yes |
| 6 | `calf_R` | `calf_R.png` | yes |
| 7 | `thigh_R` | `thigh_R.png` | yes |
| 8 | `shoulder_R` | `shoulder_R.png` | yes |
| 9 | `forearm_R` | `forearm_R.png` | yes |

Every rendered patch is the cutout of its own name. Since @DennieSeth confirmed
the contact-sheet part labels are correct (fix round 5), and each drawn part is
that same file, the labels already describe the art honestly — old label → correct
label is identity for all ten. What was wrong was never the names; it was the
z-order, which had the two limb groups the wrong way round.

**The committed z values — this REPLACES §3d's table, which is superseded, not a
regression to restore:**

| z | part | | z | part | |
|---|---|---|---|---|---|
| 0 | `forearm_L` | frontmost | 5 | `torso` | |
| 1 | `shoulder_L` | | 6 | `calf_R` | |
| 2 | `thigh_L` | | 7 | `thigh_R` | |
| 3 | `calf_L` | | 8 | `shoulder_R` | |
| 4 | `head` | | 9 | `forearm_R` | backmost |

`head` and `torso` keep their fix-round-1 values (4, 5) — the two limb groups swap
wholesale, nothing else moves.

**Verified by replaying the paint loop and taking the last writer** — the same
`char_gen.draw_order_audit_T0436` check used every prior round, re-run against this
committed rig (`gen_draw_order_audit_T0436.py`, evidence regenerated, below):
realized rank matches the published z 10 of 10, **12 contested pairs, 0 resolving
against the order**:

| lower z (expected winner) | higher z | contested px | lower-z wins | higher-z wins |
|---|---|---|---|---|
| `thigh_L` | `thigh_R` | 9819 | 9819 | 0 |
| `shoulder_L` | `torso` | 7153 | 7029 | 0 |
| `calf_R` | `thigh_R` | 5250 | 5250 | 0 |
| `thigh_L` | `torso` | 4674 | 4674 | 0 |
| `torso` | `shoulder_R` | 3741 | 3741 | 0 |
| `torso` | `thigh_R` | 3468 | 2458 | 0 |
| `head` | `torso` | 3000 | 2754 | 0 |
| `thigh_L` | `calf_L` | 1573 | 1573 | 0 |
| `shoulder_R` | `forearm_R` | 1268 | 1268 | 0 |
| `forearm_L` | `shoulder_L` | 939 | 939 | 0 |
| `shoulder_L` | `head` | 248 | 248 | 0 |
| `forearm_L` | `torso` | 124 | 124 | 0 |

Every gap between `contested_px` and the winning side's own count is anti-aliased
edge-blend pixels (same class §3d already called out) — no `higher-z wins` column
is ever non-zero, i.e. zero violations.

**Lateral offsets move to the side that is now FAR.** The offset's purpose —
clearing the far limb from the torso's own silhouette — is unchanged; only which
named side needs it changed. `_R` is far under Option B, so
`canonical_rig.lateral_offset_axis.demonstration_values` moves from `shoulder_L`/
`forearm_L`/`thigh_L`/`calf_L` to `shoulder_R`/`forearm_R`/`thigh_R`/`calf_R`, sign
flipped (the far side now sits screen-right of the hip), magnitude unchanged
(0.10 arm, 0.06 leg — fix round 5's bracket, re-verified below rather than
re-derived, since equalizing the pair without checking the magnitude is exactly the
mistake fix round 1 made):

```
shoulder_R: 0.10   forearm_R: 0.10   thigh_R: 0.06   calf_R: 0.06
```

Re-measured directly on the new far side against the committed rig (`shoulder_name=
"shoulder_R"` is now `shoulder_attachment_T0436`'s default):

| measure | value | bound |
|---|---|---|
| armhole wedge | **340px** | ≤ 400px |
| sleeve/torso overlap | **3741px** | > 0 (genuine overlap) |
| `shoulder_R` visible px | 6260 (3555 without the offset) | > 0 |
| `forearm_R` visible px | 12432 | > 0 |
| `shoulder_R` + `forearm_R` | **18692** | ≥ 18000 |
| silhouette components ≥50px | **3** (237800 main + 726 + 73, both pre-existing `calf_R` motion-streak fragments) | no new fragment |

`shoulder_R` and `shoulder_L` are different art (only `shoulder_L` carries the
anisotropic bone-length-fix width restore, §6), so these numbers are NOT the
fix-round-5 numbers transplanted — they are measured fresh on `shoulder_R`, and
both bounds hold with real but narrower margin than fix round 5 had on `shoulder_L`
(60px of headroom on the wedge ceiling, 692px above the visibility floor). A sweep
at the baseline fix-round-4 magnitude (0.35) on the new side confirms this is a
real improvement, not an accident of the bound: armhole wedge 4214px at 0.35 vs
340px at 0.10.

**Per-side arm angles do NOT swap.** `SHOULDER_DEG_R` +44.3 / `ELBOW_DEG_R` +40.7
and `SHOULDER_DEG_L` -56.4 / `ELBOW_DEG_L` +33.2 (§3e) are unchanged —
`reference_pose_T0436.py`'s constants are untouched by this round. Option B was
approved with the near arm reaching and the far arm trailing exactly as fix round 4
measured them from the reference; only which side draws in front of the torso
changed, not which angle either side is posed at.

> **Correction (fix round 10):** the paragraph above is a historical record of the
> fix-round-6-era naming — at that time `R` was the near/reaching-forward arm and
> `L` was the far/trailing-back arm, matching fix round 4's own names, and the claim
> that the angle VALUES don't move across fix round 6 is still true. Fix round 7's
> suffix rename (§3h), two sub-sections later in this same document, swapped which
> physical arm each name answers to. At HEAD, `SHOULDER_DEG_R` is **−56.4** /
> `ELBOW_DEG_R` is **+33.2** (now the near, trailing-back arm) and `SHOULDER_DEG_L`
> is **+44.3** / `ELBOW_DEG_L` is **+40.7** (now the far, reaching-forward arm) —
> see §3e's corrected table. A reviewer FAIL (2026-10-09T19:10) found this
> paragraph's present-tense "(§3e) are unchanged" phrasing read as a current claim
> rather than a fix-round-6 snapshot, and cited it as authority for the (then-stale)
> §3e table; both are now consistent.

**Animation impact of the z-order swap** is restated in §7 with the numbers
re-measured against this round's rig (idle_cycle/sitting_idle_cycle changed-pixel
counts relative to the immediately-prior, fix-round-5 z values).

## 3h. Fix round 7 — L/R suffix rename

@DennieSeth (2026-10-09T17:06): the earlier verification that §3g's "the rename
mapping is IDENTITY" check performed was circular. It confirmed the renderer loads
`forearm_R.png` and draws it under the label `forearm_R` — true by construction,
since the renderer reads the filename back out and prints it as the label. It could
never have caught the actual defect: the files themselves were mirrored at cut time
and the `_R`/`_L` suffix on each FILENAME never followed the mirror, so the file
called `forearm_R` held the character's physically LEFT forearm. §3g's table proved
internal consistency ("the pixels match the number painted on them"), not that the
names were correct in the first place.

**The fix: rename all eight limb-part files so the suffix tracks DRAW DEPTH
directly** — near/front = `_R`, far/behind = `_L` — rather than whatever the
mirrored cut happened to leave on the file. This is a pairwise swap, not a
re-cut: each of the four limb types swaps its `_R`/`_L` filename with its own
opposite-side sibling.

| physical part (§3g z, fix-round-6 name) | renamed to | z (unchanged) |
|---|---|---|
| `forearm_L` (z=0, frontmost) | **`forearm_R`** | 0 |
| `shoulder_L` (z=1) | **`shoulder_R`** | 1 |
| `thigh_L` (z=2) | **`thigh_R`** | 2 |
| `calf_L` (z=3) | **`calf_R`** | 3 |
| `head` (z=4) | `head` (untouched) | 4 |
| `torso` (z=5) | `torso` (untouched) | 5 |
| `calf_R` (z=6) | **`calf_L`** | 6 |
| `thigh_R` (z=7) | **`thigh_L`** | 7 |
| `shoulder_R` (z=8) | **`shoulder_L`** | 8 |
| `forearm_R` (z=9, backmost) | **`forearm_L`** | 9 |

Note the result: **the z-order by NEW name is exactly the list @DennieSeth gave at
the very start of this card** (fix round 1's defect-2 table — `forearm_R` 0,
`shoulder_R` 1, `thigh_R` 2, `calf_R` 3, `head` 4, `torso` 5, `calf_L` 6, `thigh_L`
7, `shoulder_L` 8, `forearm_L` 9). That list was anatomically right all along;
applying it to misnamed files through fix rounds 1–6 is what produced a picture
that kept reading wrong no matter how the z numbers were shuffled.

**Verified by `git hash-object`, not by inspection.** Each of the eight files was
moved via a pairwise `git mv` swap (through a temporary name, so no destination
ever overwrote a file still needed). The new file at each path has the exact blob
hash the OLD file at its opposite-side path had — e.g. `shoulder_R.png`'s hash
after the rename equals `shoulder_L.png`'s hash before it, and vice versa — for all
eight pairs. `head.png`/`torso.png` are not renamed and do not appear in the diff.

**Every side-keyed value moved with its physical part, not with its old name:**

- **z** — unchanged per physical part (table above); only the key each value is
  filed under moved.
- **Lateral offsets** (`canonical_rig.lateral_offset_axis.demonstration_values`) —
  the far side is `_L` again: `shoulder_L` +0.10, `forearm_L` +0.10, `thigh_L`
  +0.06, `calf_L` +0.06; `_R` carries no entry (defaults to 0.0). Same physical
  parts, same magnitude and sign as fix round 6's `shoulder_R`/`forearm_R`/
  `thigh_R`/`calf_R` — only the key moved.
- **Arm angles** (`reference_pose_T0436.py`) — `SHOULDER_DEG_R` **-56.4** /
  `ELBOW_DEG_R` **+33.2** (near, trailing back — fix round 6's `shoulder_L`),
  `SHOULDER_DEG_L` **+44.3** / `ELBOW_DEG_L` **+40.7** (far, reaching forward —
  fix round 6's `shoulder_R`). Same two physical angles fix round 4 measured from
  the reference's own red bone lines; only which constant name carries which value
  swapped.
- **Leg stance angles** — `FRONT_THIGH_DEG`/`FRONT_KNEE_FLEXION_DEG` and
  `BACK_THIGH_DEG`/`BACK_KNEE_FLEXION_DEG` are a STANCE axis (which leg steps
  forward in the lunge), independent of the near/far DEPTH axis the rename
  tracks — `leg_stance()` now assigns `thigh_deg_r=BACK_THIGH_DEG`,
  `thigh_deg_l=FRONT_THIGH_DEG` (swapped from fix rounds 1–6's
  `thigh_deg_r=FRONT_THIGH_DEG`), so the forward-stepping leg (still the same
  physical leg, still the same two angle constants) stays attached to the same
  physical thigh under its new name.
- **`bone_length_fix.scaled`** — `calf_R: 1.2929` (was `calf_L`), `shoulder_R:
  {"height": 0.6087, "width": 1.0}` (was `shoulder_L`) — see §6 (rewritten under the
  current names, fix round 10) and §3h's own note below.
- **`canonical_rig.shoulder_bar`/`pelvis_bar`** — `R_local_px`/`L_local_px` swap
  values with each other, so the same physical attach point continues to be used
  by the same physical PNG under its new name (`canonical_world_points` always
  pairs `R_local_px` with whichever file is currently named `shoulder_R`/`thigh_R`
  — a code convention that does not itself change, so the DATA has to move
  instead). The two tests that assert the two ends are the bar's own width apart
  now compare `abs(dx)`, not a signed `dx` — which named end sits at the bigger
  local x is no longer a fixed invariant, only the ends' separation is.

**Pixel proof — not assumed, measured.** A full composite of the renamed rig's
reference-pose render, differenced against the render saved immediately before any
rename or code change: **0 differing pixels of 1,095,633** (`1071×1023`, every
channel). The rename changed no geometry, only names.

A first attempt at this rename was NOT pixel-identical — see §3g's own cross-check
of this exact pitfall, now reproduced for real: `LegStance.thigh_deg_r`/
`thigh_deg_l` is a SEPARATE field from the part-file name, so a rename that moves
only the z/offset/bone-length-fix/bar data while leaving `leg_stance()`'s
`thigh_deg_r=FRONT_THIGH_DEG` assignment untouched renders the legs at their OLD
angles under their NEW names — wrong, and only the pixel diff (not "the rename
should be neutral" reasoning) catches it. The committed diff includes the
`leg_stance()` swap above specifically because of this.

**Re-measured directly against the renamed, committed rig** (not assumed to carry
over from §3g by label):

| measure | value | bound |
|---|---|---|
| armhole wedge (`shoulder_name="shoulder_L"`, the new far side) | **340px** | ≤ 400px |
| sleeve/torso overlap | **3741px** | > 0 (genuine overlap) |
| `shoulder_L` visible px | 6260 (3555 without the offset) | > 0 |
| `forearm_L` visible px | 12432 | > 0 |
| `shoulder_L` + `forearm_L` | **18692** | ≥ 18000 |
| realized draw rank vs published z | **10 of 10** match | — |
| contested pairs resolving against the order | **0 of 12** | 0 |

Contested-pair replay (paint-loop last-writer, not a re-read of `rig.*.z`):

| lower z (expected winner) | higher z | contested px | lower-z wins | higher-z wins |
|---|---|---|---|---|
| `thigh_R` | `thigh_L` | 9819 | 9819 | 0 |
| `shoulder_R` | `torso` | 7153 | 7029 | 0 |
| `calf_L` | `thigh_L` | 5250 | 5250 | 0 |
| `thigh_R` | `torso` | 4674 | 4674 | 0 |
| `torso` | `shoulder_L` | 3741 | 3741 | 0 |
| `torso` | `thigh_L` | 3468 | 2458 | 0 |
| `head` | `torso` | 3000 | 2754 | 0 |
| `thigh_R` | `calf_R` | 1573 | 1573 | 0 |
| `shoulder_L` | `forearm_L` | 1268 | 1268 | 0 |
| `forearm_R` | `shoulder_R` | 939 | 939 | 0 |
| `shoulder_R` | `head` | 248 | 248 | 0 |
| `forearm_R` | `torso` | 124 | 124 | 0 |

Every number in this table is identical to §3g's own table — same physical
contests, same pixel counts — with each part's name swapped to its new identity.
That identity is exactly what the pixel-diff-zero check above proves directly,
rather than inferred from the fact that the numbers happen to match.

**Labels verified against draw depth, not against filenames (the actual fix for
§3g's circularity).** `tests/test_draw_order_audit_T0436.py::
TestSuffixAgreesWithRealizedDrawDepth::
test_each_limb_pairs_r_suffix_wins_the_realized_depth_contest` derives, for each of
the four limb pairs, which part WINS the paint-loop replay (an independent,
render-grounded signal — the same `realized_draw_rank` machinery §3d/3g already
use, not a re-read of the rig's own z numbers or a check that a part's rendered
content matches the file loaded under its own name) and asserts that winner's name
ends `_R`. This is the check §3g's own "rename mapping is IDENTITY" table could not
be, because that table could pass regardless of whether the names were right.

**Nothing left half-renamed — swept by grep, not assumed clean.** Searched the
whole repository for the eight old side-keyed part names
(`shoulder_L`/`shoulder_R`/`forearm_L`/`forearm_R`/`thigh_L`/`thigh_R`/`calf_L`/
`calf_R`) used as a PHYSICAL PART reference (as opposed to the abstract `"R"`/`"L"`
side selector `UpperPose.shoulder_deg_for`/`leg_angles` already use, which is not
part of this rename — it is the mechanism, not a name tied to one physical part):

- `side_view_rig.json`, `reference_pose_T0436.py`, `shoulder_attachment_T0436.py`,
  `gen_reference_pose_evidence_T0436.py`, and all four T-0436 test files — updated
  in this round's diff, including every prose note that explained a correction by
  which side was far/near/front at the time (`bone_length_fix`'s own `note`,
  `near_far_note`, `shoulder_*_note`/`shoulder_*_anisotropic_note`, and
  `lateral_offset_axis`'s own notes — each now carries an explicit correction
  pointing at the number it supersedes, not a silent rewrite).
- `rig.*.curves_deg`/`per_frame_angles` in `side_view_rig.json` — these are
  **not** side-keyed (`hip`/`knee_flexion`/`shoulder`/`elbow_flexion` curves and a
  flat `per_frame_angles` list, consumed by `walk_cycle` for its OWN, separate
  per-frame curve solve) — confirmed by direct read: no key or value in either
  block contains `_R`/`_L`. Nothing to rename there.
- `idle_cycle.py` — one hit, `lengths["thigh_R"], lengths["calf_R"]` in
  `solve_leg`'s own call — a functional reference to the current (correct) part
  names, not prose about which side is far/near. Nothing to fix.
- `rig_compositor.py` — the shared compositor every pose module (including this
  card's own `reference_pose_T0436.py`) imports. Its module docstring and
  `scaled_parts`'s own docstring both named `shoulder_L`/`calf_L` as the parts
  carrying the bone-length correction, with fix-round-6-and-earlier reasoning
  for which side each cut was short/long on. Both are stale: the correction is
  keyed `shoulder_R`/`calf_R` as of this round. **This was missed by this
  section's own first pass** — see the correction note immediately below.
- `sitting_idle_cycle.py` — reference `thigh_R`/`calf_R`/`shoulder_R`/`forearm_R`
  (and its own `CROUCH_Z_OVERRIDE = {"thigh_R": 3.5, "thigh_L": 3.6}`) as PART
  NAMES, same mechanism this card's rename affects. The override's own two
  absolute z VALUES, and every other functional line, are correctly left
  untouched — §7 states why (this card does not re-derive any animation, and the
  module's own tests stay green against the renamed parts without modification).
  But **two comments were prose, not mechanism, and were wrong**: the module
  docstring and the `THIGH_LEN`/`CALF_LEN` comment both said "the calf_L length
  correction" / "calf_L's own rig-recorded length-scale correction" — that
  correction is keyed `calf_R` as of this round (§3h, §6), so the comment named
  the wrong key. Fixed in this round's diff to say `calf_R`, with a parenthetical
  noting the rename; no functional line in the module changed, so its test file
  needed no update and none was made.
- `docs/design/23-canonical-rig.md` (this document) — §3f, §3g describe what was
  true THROUGH the round named in each section's own heading; left as written, as a
  historical record, with a correction annotation added inline at §3g where it made
  a forward-looking present-tense claim that later went stale. §9 is corrected
  directly (not just pointed at) because its claim — "no `.png` file appears in the
  diff" — is a factual statement about THIS round's own diff, not a historical
  record of a prior one. **Fix round 10 correction to this bullet itself:** §0, §3e,
  §6 and §7 are NOT historical records — none of their headings name a round, and
  §0/§7 describe the card's present-tense scope/impact — so this section's own
  stated policy already required them to match HEAD. They didn't: all four still
  used the pre-fix-round-7 `shoulder_L`/`calf_L` names in places (§0's scope
  exception, §3e's angle-derivation table, §6's heading and body, and two spots in
  §7 — the bone-length-fix paragraph and the `CROUCH_Z_OVERRIDE` aside). §6 had
  previously been given a pointer note ("read `shoulder_L` below as `shoulder_R`")
  instead of a wording fix; a reviewer FAIL (2026-10-09T19:10) correctly rejected
  that as not meeting the card's own "corrected, not annotated around" bar. All four
  are now corrected directly under the current names, and this section as the
  current authority for every side-keyed value.
- `docs/assets/evidence/T-0269/{README.md,rig.json}`,
  `docs/assets/evidence/T-0430/{README.md,rig.json}`,
  `docs/assets/evidence/side-view-walk-reference/README.md` — committed evidence
  for EARLIER, unrelated cards (T-0269, T-0430, and the original side-view-walk
  reference cut), predating this card entirely, left untouched. **Correction to
  this section's own first pass on these three files**: it previously claimed
  their `_R`/`_L` prose "is the SAME convention fix round 7 restores... still
  correct against the current rig." Re-checked against the actual physical-file
  identity rather than the wording alone, that claim is wrong, and the true
  answer is the opposite. `docs/assets/evidence/side-view-walk-reference/README.md`
  wrote "the far calf's upper portion is occluded... I corrected only `calf_L`" —
  at 77.3% of the other calf's length. That 77.3%-length, corrected calf is the
  SAME physical PNG `bone_length_fix.scaled` still corrects today (§3h's own
  table above), but fix round 7 renamed that exact file from `calf_L` to
  `calf_R` (it is the one Option B now draws in front, §3f/§3g). So
  `calf_L` as this old document uses the name points at the far/short physical
  part under ITS OWN, pre-T-0436 file identity — under the CURRENT, post-round-7
  identity, that same sentence's physical referent is named `calf_R`, not
  `calf_L`. The same inversion holds for `shoulder_R`/`shoulder_L` in
  `docs/assets/evidence/T-0430/rig.json` (its `shoulder_R: 103.0` /
  `shoulder_L: 169.3` is the pre-rename physical mapping; §3h's current
  `shoulder_R_note` above has the same two lengths on the opposite names) and for
  `thigh_R`/`thigh_L`/`calf_L` in `docs/assets/evidence/T-0269/README.md`'s "the
  near/R leg", "`thigh_L` joins `thigh_R` behind the torso" lines. The wording
  ("near/front = `_R`") is coincidentally identical because T-0269/T-0430 were
  written when the file identity happened to already match that rule — fix round
  7 is what RESTORES the rule, after T-0436's own fix round 6 (Option B)
  temporarily broke it by swapping draw depth without renaming files. That
  restoration is what makes the CURRENT files match the rule again; it does not
  make these three OLDER documents' specific part-name references resolve to the
  same physical art they did when written. **Not edited anyway**: they are
  another card's closed, frozen evidence, and rewriting them to track a rename
  made by a later card would corrupt the historical record of what was actually
  true when T-0269/T-0430 ran. The correct disposition is to leave them as-is and
  record the inversion here, not to assert an equivalence that does not hold.

**Correction to this section's own prior claim.** A reviewer FAIL
(2026-10-09T18:06) found this sweep's list above, as it stood at that time, did
not mention `rig_compositor.py` at all, and that file's own docstrings — both the
module docstring and `scaled_parts`'s — asserted the bone-length correction was
still keyed `shoulder_L`/`calf_L` and explained WHY using fix-round-6-and-earlier
reasoning, which the committed rig had already moved to `shoulder_R`/`calf_R`.
That was a real gap in the sweep, not a disagreement about the underlying facts:
`rig_compositor.py` is read by every pose module in this repo, so a stale claim
there is the single highest-leverage place to leave one. Fixed in this round:
the module docstring's `calf_L` mention is now `calf_R`, and `scaled_parts`'s
docstring now names `shoulder_R`/`calf_R`, generalizes the "why" by pointing at
`side_view_rig.json`'s own `near_far_note`/`shoulder_R_note`/
`shoulder_R_anisotropic_note` instead of restating a copy of that reasoning
inline (the inline copy is exactly what went stale last time), and its
`shoulder_L_anisotropic_note` cross-reference is corrected to
`shoulder_R_anisotropic_note`, the key that actually exists in the committed
rig. No behaviour changed — these are docstrings, confirmed by the full existing
suite staying green with no test file edited.

## 4. The static render

**Fix round 6 superseded the specific numbers below (not the mechanism) — see §3g
for the current, authoritative figures.** Everything from here through the end of
this section describes fix round 5's render, when the lateral offset and the
armhole-attachment fix both lived on `shoulder_L`/`forearm_L` (the far side at the
time). Fix round 6's Option B moved them to `shoulder_R`/`forearm_R`; the mechanism
(two-point bar attach, one offset per chain, the anisotropic width restore) is
unchanged and this section's description of HOW it works still applies — only
WHICH named part the numbers are measured on changed. The evidence images named at
the end of this section are regenerated fix round 6, from the current rig; their
captions and the §3g table reflect the current numbers.

`char_gen.reference_pose_T0436.render()` composites one static frame: a wide-stance
lunge (representative of the reference's own framing — its exact joint ANGLES were
never transcribed into the card body, only the two bar widths and the limb-length
ratios; see the module's own docstring, "What this render does and does not
prove"), with `shoulder_points`/`hip_points` set to the two canonical bar ends (§3a/
3b) and `lateral_offset_frac` set to the rig's own recorded demonstration values
(`canonical_rig.lateral_offset_axis.demonstration_values`):

```
shoulder_L: -0.10   forearm_L: -0.10   thigh_L: -0.06   calf_L: -0.06
```

(fractions of torso width — ONE value per limb chain, applied once at the chain's
root and inherited through FK, fix round 2; see §3c for why fix round 1's
equalized-but-still-doubled values didn't actually achieve this, and for the sweep
run against the corrected code that derives this magnitude. **The arm-chain value
dropped from -0.35 to -0.10 in fix round 5** — §3f has the armhole-wedge sweep that
derives it; the leg-chain value is unchanged).

**Far-arm visibility, measured directly from the composited placements**
(`shoulder_attachment_T0436.visible_pixel_count`, fix round 5 — a production-code
copy of the same definition `tests/test_reference_pose_render_T0436.py`'s own
helper used through fix round 4: a pixel counts only if removing the part changes
the final composite AND the "with" result is itself non-transparent there, so an
occluded part's own opaque pixels do not count). **Re-measured fix round 5, after
the arm-chain offset and the `shoulder_L` width restore (§3f)** — these numbers
supersede the fix-round-4 table (shoulder_L 2623→7162, forearm_L 12789→12828,
measured at the -0.35 offset):

| | without `lateral_offset_frac` | with it (-0.10, fix round 5) |
|---|---|---|
| `shoulder_L` | **4253** | **6908** |
| `forearm_L` | **12672** | **12672** |
| `shoulder_L` + `forearm_L` | **16925** | **19580** |

Within 2% of fix round 4's 19990px combined, despite the smaller offset — the
`shoulder_L` width restore (69px → 113px, §3f) gives the part more of its own
visible area back, largely offsetting the reduced sideways push. Comfortably
above the 18000px floor §3f's bracket is built around.

**Connected-component count on the regenerated evidence render.** 4-connectivity
labelling of the composited RGBA frame (`reference_pose_T0436.render()`'s own native
frame, 1071×1023 before the opaque background flatten `reference_pose_render.png` is
saved with) finds 3 components ≥50px: the main silhouette (**238070px**, down
slightly from fix round 4's 238351px — the smaller arm-chain offset reaches
slightly less far) and the same two pre-existing `calf_R` motion-streak fragments
described in §3c (726px, 73px — present at `lateral_offset_frac={}` too, i.e.
independent of this card's chain offsets and unaffected by this round's changes,
confirmed by removing `calf_R` from the composite). **No new fragment is
introduced by this round's offset/width change** — the figure's own silhouette
(everything except the pre-existing, untouched `calf_R` art detail) is still one
connected piece, and `shoulder_L` + `forearm_L` together own 19580 of its pixels
with the lateral offset active, confirming the far arm is both attached and
visible in the same render, now without the armhole gap §3f fixes.

Evidence as of fix round 5 (the smaller arm-chain offset and the `shoulder_L`
width restore) — **superseded by the fix round 6 regeneration described in §3g**,
which the three files below now actually contain. The bullets are kept as a
description of what each file shows and how it is produced, which is unchanged;
the pixel numbers inside them are fix round 6's (§3g), not fix round 5's:

- `docs/assets/evidence/T-0436/reference_pose_render.png` (1071×1023) — the
  composited pose: the near arm reaching forward and the far arm trailing back
  (§3e), the far shoulder now genuinely overlapping the torso instead of reading
  as detached (§3f/§3g), and the committed Option B layer order (§3g — the near
  (`_L`) arm and leg group draws in front of the torso, the far (`_R`) group trails
  behind it).
- `docs/assets/evidence/T-0436/rig_vs_reference_overlay.png` (1071×1023) — the same
  render with the shoulder bar (red), pelvis bar (red), spine (yellow) drawn on top,
  plus the front shin's actual-vs-adopted-target length (orange solid vs cyan
  dashed, §5) and a caption restating the pixel counts, including the armhole
  wedge and sleeve/torso overlap counts, now measured on `shoulder_R` (§3g).
- `docs/assets/evidence/T-0436/draw_order_audit.png` (1071×1023) — the same pose
  with every part labeled by its realized draw rank and published z (§3g),
  generated by `gen_draw_order_audit_T0436.py`, re-run against the committed Option
  B geometry (12 contested pairs, 0 resolving against the order — see §3g for the
  full table).

### Per-joint deviation

Both bar lines are **drawn directly from the values that posed the render**, so
their own deviation from the target is sub-pixel rounding only (±0.5px, the `round()`
in `rig_compositor.place()`) — not independently meaningful. **This is now confirmed
by direct pixel measurement, not asserted from the code alone**: fix round 3 (above)
found the committed overlay's bar lines were actually off by +9.0627px due to the
`hip_px` defect, and the regenerated overlay's red shoulder/pelvis bar pixels were
re-measured against `canonical_world_points`' own canvas coordinates after the fix —
within the ellipse-marker radius (3px) of the computed endpoints, i.e. the claim
holds only now that fix round 3 has landed. The deviation that
matters is the one §3c's z-only framing would have hidden: how far the rig's
**current, active** limb lengths sit from the reference-derived **adopted target**,
per §5's leg reconciliation (not applied this round):

| measure | current (active) | adopted target | deviation (×spine) |
|---|---|---|---|
| upper arm (near) | 0.4454 | 0.47 | 0.025 |
| forearm (near) | 0.8573 | 0.66 | 0.197 |
| thigh | 1.0665 | 0.72 | 0.347 |
| **shin (worst)** | **1.4275** | **0.80** | **0.627** |

**Worst joint: the front shin (`calf_R` in the static render), deviation +0.63×
spine.** It is the largest deviation by a wide margin and is exactly the leg-length
finding the card's own problem statement opens with ("its legs are ~50% too long
relative to the spine"). The overlay draws this specific segment: the current,
unreconciled shin (orange, solid) against the adopted-target shin from the same knee
(cyan, dashed) — the gap between the two line ends is the 0.63×spine deviation,
visible rather than only asserted. See §5 for why it is recorded, not corrected,
this round.

## 5. Leg-proportion reconciliation (recorded, not applied)

`canonical_rig.leg_proportions`:

```
"reference_near": {"thigh_frac": 0.68, "shin_frac": 1.21, "ratio": 1.78},
"reference_far":  {"thigh_frac": 0.72, "shin_frac": 0.80, "ratio": 1.11},
"anatomical_expected_ratio": [1.0, 1.1],
"adopted": {"thigh_frac": 0.72, "shin_frac": 0.80, "source": "far"},
"applied_to_active_rig": false
```

**Decision: adopt the far-side fractions (thigh 0.72, shin 0.80 — ratio 1.11),
not the near side.** This reverses the general "near-side is truth" rule from
@DennieSeth's own comment — a rule this card otherwise follows (see the upper-arm/
forearm figures, which DO use the near-side reference numbers directly). The
reversal is deliberate and pose-specific: in this lunge, the near thigh is
foreshortened (pointing away from the viewer) while the near shin crosses the view
plane at close to full length, so the near-side ratio (1.78) is a projection
artifact, not anatomy. The far-side ratio (1.11) sits inside the anatomically
expected range (1.0–1.1) and is adopted instead.

**Why this is recorded but not applied to the active rig this round.**
`thigh_R`/`calf_R` (mirrored to the `_L` parts via `bone_length_fix`) already drive
the leg geometry of every existing animation. Rescaling them to the adopted
fractions would shorten every one of those legs by roughly a third — exactly the
animation re-derivation this card's own scope excludes (§0). `canonical_rig.
leg_proportions.why_not_applied` carries this same reasoning in the rig data itself,
and `applied_to_active_rig: false` makes the state machine-checkable rather than
only prose. The follow-on cards that re-derive each animation's own leg geometry
apply this target when they touch that animation.

The forearm's own reference deviation (+30% over, §2) is left unapplied for the
identical reason, recorded in `canonical_rig.upper_limb_reference_comparison`.

## 6. `shoulder_R` — normalized by length, not re-cut

> **Fix round 10 correction.** Through fix round 9 this section was titled
> `shoulder_L` and narrated under that name, with a pointer note asking the reader
> to mentally substitute `shoulder_R` throughout. A reviewer FAIL (2026-10-09T19:10)
> correctly rejected that as not satisfying the card's own requirement that "the
> wording must be corrected, not annotated around" — a pointer note is exactly the
> kind of workaround that requirement exists to rule out. This section is now
> rewritten directly under the current names. Fix round 7 (§3h) is what renamed the
> file this section describes (the longer-cut sleeve, raw bone 169.28px) from
> `shoulder_L` to `shoulder_R`; the correction below is keyed to
> `bone_length_fix.scaled.shoulder_R` in the committed rig. The test names pytest
> actually runs today use the `_R` suffix (`test_shoulder_r_scaled_length_matches_
> shoulder_l`, etc. — see §3h).

An earlier analysis proposed re-cutting `shoulder_R` because its raw bone length
(169.28px) is 64% longer than `shoulder_L`'s (103.04px). **That proposal is
withdrawn.** Examined directly, `shoulder_R` is a clean sleeve crop — alpha fill
0.88, a uniform width profile down its length, no torso fragment, no second limb, no
stray costume. It is simply cut further down the arm than `shoulder_L`; the cut is
long, not the bone.

This is exactly what `bone_length_fix` already exists to correct — `calf_R` carries
a `1.2929` scale for the opposite case: its cut is SHORT relative to `calf_L`'s even
though the bone is not. (This was explained as occlusion of "the far calf's top" by
the near leg, correct when `calf_R` was the far side through fix round 5 — fix round
6's Option B, then fix round 7's rename, now draws `calf_R` in FRONT, so that
explanation is retracted, not replaced; see `side_view_rig.json`'s own `note` field
and §3g/§3h. The measured 77.3% shortfall itself is unchanged — it describes how the
two PNGs were cut, not which one a later round draws in front.) `shoulder_R` now
carries its own entry:

```
"scaled": {
  "calf_R": 1.2929,
  "shoulder_R": {"height": 0.6087, "width": 1.0}
}
```

`0.6087 = shoulder_L`'s measured length (103.04) `/ shoulder_R`'s own raw measured
length (169.28). `rig_compositor.scaled_parts` is generalized from a hardcoded
`calf_R` lookup to iterate every entry in `bone_length_fix.scaled`, so `shoulder_R`
is picked up by the same code path, not a second one.

**The `width: 1.0` is fix round 5 (§3f).** Through fix round 4, `shoulder_R`'s
entry was the plain number `0.6087`, applied by the old `scaled_parts` to BOTH
axes — correcting the bone length (height-derived) but also, as an unintended
side effect, shrinking the sleeve's own cut WIDTH from 113px to 69px (61% of the
artist's own cut). `scaled_parts` now accepts either a plain number (isotropic —
`calf_R`, unchanged) or a `{height, width}` object (anisotropic — `shoulder_R`);
`measured_bone_lengths` only ever reads a part's HEIGHT, so the bone length is
unaffected by this change (103.04px before and after) — only the sleeve's own
width changed, back to its raw 113px. §3f has the full armhole-attachment
reasoning this fix is part of.

**Asserted directly:**
- `tests/test_canonical_rig_T0436.py::TestBoneLengthFix::
  test_shoulder_r_scaled_length_matches_shoulder_l` — after scaling,
  `shoulder_R`'s measured bone length equals `shoulder_L`'s (103.04 ≈ 103.04).
- `tests/test_canonical_rig_T0436.py::TestBoneLengthFix::
  test_shoulder_r_width_is_not_shrunk_by_the_length_correction` (fix round 5) —
  the width scale is 1.0 and the scaled part's width equals the raw part's width.
- `tests/test_canonical_rig_T0436.py::TestBoneLengthFix::
  test_shoulder_r_png_is_byte_identical` — asserts the raw committed
  `shoulder_R.png` is `(113, 184)`, the un-re-cut source size. §7 confirms from the
  diff that the file itself is untouched.
- `tests/test_shoulder_attachment_T0436.py::TestReferencePoseShoulderAttachment::
  test_shoulder_r_bone_length_is_unchanged_by_the_width_restore` and
  `test_shoulder_r_png_is_still_byte_identical` (fix round 5, made a real
  content check in fix round 10 — see that test's own history) — the same two
  invariants, re-asserted against the real reference pose rather than only the
  raw part.

## 7. Animation impact — what changes, and by how much

**`shoulder_points`/`hip_points`/`lateral_offset_frac` (§3c): none.** All three
default to `None`; no pre-existing pose module passes them. Confirmed both by direct
test (`TestOptInCompositorHooks`) and by the full existing suite: every test in
`test_walk_cycle.py`, `test_idle_cycle.py`, `test_sitting_idle_cycle.py`,
`test_pose_rig_master_sheet_T0351.py`, `test_pose_rig_T0249.py`,
`test_pose_rig_walk_T0259.py` and `test_pose_rig_profile_T0272.py` — 192 tests,
unchanged — stays green after this round's changes, with no edits to any of those
test files.

**The four per-side arm angle fields (§3e, fix round 4): none.**
`shoulder_deg_r`/`elbow_deg_r`/`shoulder_deg_l`/`elbow_deg_l` all default to `None`;
no pre-existing pose module sets them, so `shoulder_deg_for`/`elbow_deg_for` always
resolve to the same shared `shoulder_deg`/`elbow_deg` those modules already passed.
Confirmed both by direct test
(`TestPerSideArmAngles::test_omitting_the_per_side_fields_is_byte_identical_to_before`)
and by the same full existing suite named above, run again after this round's
changes — 253 tests across those seven animation files plus this card's own four
test files (`test_canonical_rig_T0436.py`, `test_reference_pose_render_T0436.py`,
`test_draw_order_audit_T0436.py`, `test_shoulder_attachment_T0436.py`, the last
one new fix round 5) — stays green with no edits to any animation test file.

**The z-order (§3d/§3g): yes for `idle_cycle` and `sitting_idle_cycle`, not for
`walk_cycle`, and here is the exact size of it.** Unlike the lateral-offset axis,
`rig.*.z` is not opt-in — it is the one shared default every part's `Placement`
carries unless a caller supplies its own `z_override`. `walk_cycle.py` does not call
`rig_compositor.render_frames` at all (it only supplies the `bone_length`/
`distal_joint` primitives `rig_compositor` imports), so it is untouched by this
change — confirmed by grep, no `render_frames` call anywhere in that module or its
own test file. `idle_cycle.py` supplies no `z_override`, so it is fully exposed to
the new z values; `sitting_idle_cycle.py` overrides only `thigh_R`/`thigh_L`
(`CROUCH_Z_OVERRIDE = {"thigh_R": 3.5, "thigh_L": 3.6}`, unchanged by fix round 6 —
these two absolute z values still land between `calf_R`'s z (3) and `head`'s (4) in
the new ordering just as they did in the old one, so the crouch's own tuned
layering is unaffected), so its other eight parts pick up the new default too.

Measured directly, in two steps since the z-order changed twice (fix rounds 1/2's
original canonical assignment, then fix round 6's Option B swap): render each pose
at frame 0 with the CURRENT (Option B) rig, then again forcing the PRIOR round's z
values (fix round 5's, the ones §3d's superseded table lists) via `z_override`, and
count changed pixels:

| pose | changed px | frame size | fraction |
|---|---|---|---|
| `idle_cycle` | 80,305 | 486×986 (479,196px) | ≈16.8% |
| `sitting_idle_cycle` | 48,959 | 938×999 (937,062px) | ≈5.2% |

Larger than fix round 4's 9,379px/17,842px (≈2%) by roughly an order of magnitude
for `idle_cycle` — expected, since Option B swaps two whole limb groups wholesale
rather than reordering two individual pairs, so far more of the composite's
contested pixels resolve differently. Both existing suites (`test_idle_cycle.py`,
`test_sitting_idle_cycle.py`) stay green — neither asserts exact per-pixel output
tied to the old draw order, only geometry (contact points, bounding bands,
determinism) that this change does not touch. This is expected, not a regression,
per the same framing §0 and the shoulder_R paragraph below already establish for
the bone-length fix: the follow-on cards that re-derive each animation's own pose
will see this new, corrected draw order when they do, and re-tuning either
animation for it is explicitly their business, not this round's.

**`shoulder_R`'s bone-length fix (§6): yes, and here is the exact size of it.**
Every pose that composites `shoulder_R`/`forearm_R` (all three: `walk_cycle`,
`idle_cycle`, `sitting_idle_cycle`) now places `forearm_R`'s attach point (the
elbow) **66.24 native px closer to the shoulder** than before this card
(`shoulder_R`'s measured bone length: 169.28px → 103.04px). At the shipped
`CHARACTER_SCALE` (0.0398), that is **≈2.64px** at the final 48px cell — a real,
visible shift in where `forearm_R` sits relative to `shoulder_R` in every frame of
every pose. `shoulder_L`/`forearm_L` are completely unaffected by this specific fix
(they are not a `bone_length_fix` entry) — independent of which side a given round's
`rig.*.z` draws in front (fix round 6, §3g, swapped that; this bone-length
correction did not move with it, since it corrects `shoulder_R`'s own longer CUT,
not whichever side happens to be far).

This is expected, not a regression — it is the intended effect of §6's fix, and it
is accepted this round rather than re-tuned, per §0: the follow-on cards that
re-derive each animation's own pose will see (and can account for) this new,
corrected far-arm geometry when they do.

**`sit_down_transition` does not exist in this codebase.** `char_gen/` has
`walk_cycle.py`, `idle_cycle.py` and `sitting_idle_cycle.py`; no `sit_down_
transition` module or test file exists under `assets/src/character/` at this card's
head. Nothing to check or report for it.

**Fix round 7's L/R rename (§3h): yes for `idle_cycle` and `sitting_idle_cycle`'s
rendered ART, on top of (not instead of) the z-order impact already measured
above; `walk_cycle` is unaffected for the same reason it was unaffected by the
z-order swap — it never calls `rig_compositor.render_frames` or loads a part PNG
by name.** `idle_cycle`/`sitting_idle_cycle` both load all ten parts through the
shared `PART_NAMES`/`rig["rig"]` machinery §3h renamed, so every frame they render
now draws a DIFFERENT PNG under each limb name than it did before this round (the
physical art, not just the z-order, moved with the rename). Both modules' bone LENGTHS are unaffected in practice — `thigh_R`/`thigh_L`
measure exactly equal and both calves measure exactly equal post-correction
regardless of which physical PNG a given name currently loads (§3h). But
`sitting_idle_cycle`'s `CROUCH_Z_OVERRIDE = {"thigh_R": 3.5, "thigh_L": 3.6}`
(§7's own z-order paragraph above) now overrides the z of the physical thigh that
was `thigh_L` through fix round 6, not the one that was `thigh_R` — the override's
own two absolute z VALUES are unchanged, only which physical leg each one lands on
swapped, which is the direct, intended consequence of the rename working
correctly (the crouch's near leg is still the one drawn frontmost; which NAME that
leg answers to changed). Not re-measured to an exact changed-pixel count this round
— the z-order table above already establishes the measurement methodology and the
precedent (expected, not a regression, follow-on cards' business to re-tune) for
exactly this class of impact; both full test files stay green with no edits
(confirmed: `test_idle_cycle.py` + `test_sitting_idle_cycle.py`, 136 tests, same
count as before this round).

## 8. `docs/design/21-character-rig-bones.md`

Marked superseded in place (banner added at its top, document not deleted) — see
its own file. §1 above states exactly which of its sections survive unchanged and
why; the rest (§0's single-hip/single-shoulder framing, implicitly) is what this
document replaces.

## 9. Ten source parts — unchanged (re-cut/re-keyed), renamed (fix round 7)

No part was ever re-cut or re-keyed on this card. Through fix round 6, the only
change under `parts/side_view/` was `side_view_rig.json` (data) — no `.png` file in
that directory appeared in the diff. **Fix round 7 (§3h) changes that sentence's
second half, deliberately**: all eight limb-part PNGs are renamed (`git mv`, via a
pairwise swap) so the filename tracks draw depth directly. This is a RENAME, not a
re-cut — every renamed file's CONTENT is byte-identical to the file it was renamed
from, verified via `git hash-object` on both sides of the rename (not by inspection):
`shoulder_R.png`'s new blob hash equals the pre-round-7 `shoulder_L.png`'s blob hash,
and so on for all eight. `head.png` and `torso.png` are untouched — not renamed, not
touched in the diff at all. See §3h for the full rename table and verification.

## 10. Secret scan (gitleaks), reported honestly

No persona driving this card's implementer or reviewer sessions holds a grant to
execute `~/.local/bin/gitleaks`, so no automated gitleaks scan has been run against
this round's commits. Per the card's own acceptance criterion ("if no persona holds
a grant to execute gitleaks, satisfy this by keeping new content free of
secret-shaped strings and reporting that honestly"), this is that report: this
round's diff (fix round 10, docs and test-only) was read in full and contains no
API keys, tokens, passwords, private-key blocks, or other secret-shaped strings —
only geometry numbers, prose corrections, and a hardcoded SHA-256 content digest in
a test fixture. No scan tool was run; this is a manual read, stated as such.
