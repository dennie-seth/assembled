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

## 0. What this card changes, and what it does not

**In scope:** this document, `side_view_rig.json` v2, and a static render proving
the rig can reproduce the reference's measured structure. **It changes no
animation.** `walk_cycle`, `idle_cycle`, `sitting_idle_cycle` and (if it existed in
this codebase — it does not; see §7) `sit_down_transition` are not re-derived here.
Re-deriving each one's own pose, now that the rig has changed under it, is the
follow-on sequence, one card at a time, each reviewed on its own.

One exception, explicit and bounded: `shoulder_L`'s bone-length-fix scale (§5) DOES
reach every existing pose module, the same way `calf_L`'s already did — because both
are the same existing mechanism (`rig_compositor.scaled_parts`), generalized, not a
new one. §7 states exactly what that changes and by how much.

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

## 3d. Layer order — @DennieSeth's exact front-to-back order

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
| **R** (near, reaches forward) | −134.3 | −45.7 | −175.0 | −5.0 | **+44.3** | **+40.7** |
| **L** (far, trails back) | −33.6 | −146.4 | −66.8 | −113.2 | **−56.4** | **+33.2** |

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

## 4. The static render

`char_gen.reference_pose_T0436.render()` composites one static frame: a wide-stance
lunge (representative of the reference's own framing — its exact joint ANGLES were
never transcribed into the card body, only the two bar widths and the limb-length
ratios; see the module's own docstring, "What this render does and does not
prove"), with `shoulder_points`/`hip_points` set to the two canonical bar ends (§3a/
3b) and `lateral_offset_frac` set to the rig's own recorded demonstration values
(`canonical_rig.lateral_offset_axis.demonstration_values`):

```
shoulder_L: -0.35   forearm_L: -0.35   thigh_L: -0.06   calf_L: -0.06
```

(fractions of torso width — ONE value per limb chain, applied once at the chain's
root and inherited through FK, fix round 2 this round; see §3c for why fix round 1's
equalized-but-still-doubled values didn't actually achieve this, and for the sweep
run against the corrected code that derives this magnitude).

**Far-arm visibility, measured directly from the composited placements**
(`visible_pixel_count` in `tests/test_reference_pose_render_T0436.py` — a pixel is
counted only if removing the part changes the final composite AND the "with" result
is itself non-transparent there, so an occluded part's own opaque pixels do not
count). **Re-measured fix round 4, after the per-side arm angle fix (§3e)** — these
numbers supersede the fix-round-2 table (shoulder_L 0→5523, forearm_L 0→2888),
which was measured against the old shared rest-pose angle
(`SHOULDER_REST_DEG`/`ELBOW_REST_DEG`, both arms hanging the same way):

| | without `lateral_offset_frac` | with it |
|---|---|---|
| `shoulder_L` | **2623** | **7162** |
| `forearm_L` | **12789** | **12828** |
| `shoulder_L` + `forearm_L` | **15412** | **19990** |

Both parts are non-zero even WITHOUT the lateral offset now, unlike fix round 2's
table — the far arm's new angle (trailing back at −56.4°/+33.2°, §3e) already swings
it partly clear of the torso by itself; the lateral offset still visibly increases
`shoulder_L`'s own count (2623→7162, +173%) and gives `forearm_L` a smaller further
gain (12789→12828) since it was already mostly clear. This does not change the
card's premise — `shoulder_L`/`forearm_L` were 0/0 at this card's own starting point
(the pre-T-0436 rig, a single shared shoulder attach with no lateral axis at all);
it changes relative to fix round 2's specific rest-pose angle, which is exactly what
§3e's fix was for.

**Connected-component count on the regenerated evidence render.** 4-connectivity
labelling of the composited RGBA frame (`reference_pose_T0436.render()`'s own native
frame, 1071×1023 before the opaque background flatten `reference_pose_render.png` is
saved with) finds 3 components ≥50px: the main silhouette (**238351px**, up from fix
round 2's 221813px — the reaching/trailing arms cover more canvas) and the same two
pre-existing `calf_R` motion-streak fragments described in §3c (726px, 73px —
present at `lateral_offset_frac={}` too, i.e. independent of this card's chain
offsets and unaffected by this round's arm-angle change, confirmed by removing
`calf_R` from the composite). **No new fragment is introduced by the arm-angle
fix** — the figure's own silhouette (everything except the pre-existing, untouched
`calf_R` art detail) is still one connected piece, and `shoulder_L` + `forearm_L`
together own 19990 of its pixels with the lateral offset active, confirming the far
arm is both attached and visible in the same render.

Evidence, regenerated this round (fix round 4) from the fixed per-side arm angles
and committed:

- `docs/assets/evidence/T-0436/reference_pose_render.png` (1071×1023) — the
  composited pose, now with the near arm reaching forward and the far arm trailing
  back (§3e) instead of both hanging at the same rest droop, the far arm still
  attached to its own shoulder by a single, non-doubled chain offset (§3c), and the
  unchanged layer order (§3d — the hood draws over the torso collar, and the near
  fist crosses in front of the torso).
- `docs/assets/evidence/T-0436/rig_vs_reference_overlay.png` (1071×1023) — the same
  render with the shoulder bar (red), pelvis bar (red), spine (yellow) drawn on top,
  plus the front shin's actual-vs-adopted-target length (orange solid vs cyan
  dashed, §5) and a caption restating the pixel counts above.
- `docs/assets/evidence/T-0436/draw_order_audit.png` (1071×1023, new this round) —
  the same pose with every part labeled by its realized draw rank and published z
  (§3d), generated by `gen_draw_order_audit_T0436.py`.

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

## 6. `shoulder_L` — normalized by length, not re-cut

An earlier analysis proposed re-cutting `shoulder_L` because its raw bone length
(169.28px) is 64% longer than `shoulder_R`'s (103.04px). **That proposal is
withdrawn.** Examined directly, `shoulder_L` is a clean sleeve crop — alpha fill
0.88, a uniform width profile down its length, no torso fragment, no second limb, no
stray costume. It is simply cut further down the arm than `shoulder_R`; the cut is
long, not the bone.

This is exactly what `bone_length_fix` already exists to correct — `calf_L` carries
a `1.2929` scale for the opposite case (its cut is SHORT, because its upper portion
is occluded by the near leg). `shoulder_L` now carries its own entry:

```
"scaled": {
  "calf_L": 1.2929,
  "shoulder_L": 0.6087
}
```

`0.6087 = shoulder_R`'s measured length (103.04) `/ shoulder_L`'s own raw measured
length (169.28). `rig_compositor.scaled_parts` is generalized from a hardcoded
`calf_L` lookup to iterate every entry in `bone_length_fix.scaled`, so `shoulder_L`
is picked up by the same code path, not a second one.

**Both asserted directly:**
- `tests/test_canonical_rig_T0436.py::TestBoneLengthFix::
  test_shoulder_l_scaled_length_matches_shoulder_r` — after scaling,
  `shoulder_L`'s measured bone length equals `shoulder_R`'s (103.04 ≈ 103.04).
- `tests/test_canonical_rig_T0436.py::TestBoneLengthFix::
  test_shoulder_l_png_is_byte_identical` — asserts the raw committed
  `shoulder_L.png` is `(113, 184)`, the un-re-cut source size. §7 confirms from the
  diff that the file itself is untouched.

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
change — 237 tests across those seven files plus this card's own three test files
(`test_canonical_rig_T0436.py`, `test_reference_pose_render_T0436.py`,
`test_draw_order_audit_T0436.py`, the last one new this round) — stays green with
no edits to any animation test file.

**The z-order (§3d): yes for `idle_cycle` and `sitting_idle_cycle`, not for
`walk_cycle`, and here is the exact size of it.** Unlike the lateral-offset axis,
`rig.*.z` is not opt-in — it is the one shared default every part's `Placement`
carries unless a caller supplies its own `z_override`. `walk_cycle.py` does not call
`rig_compositor.render_frames` at all (it only supplies the `bone_length`/
`distal_joint` primitives `rig_compositor` imports), so it is untouched by this
change — confirmed by grep, no `render_frames` call anywhere in that module or its
own test file. `idle_cycle.py` supplies no `z_override`, so it is fully exposed to
the new z values; `sitting_idle_cycle.py` overrides only `thigh_R`/`thigh_L`
(`CROUCH_Z_OVERRIDE = {"thigh_R": 3.5, "thigh_L": 3.6}`), so its other eight parts
pick up the new default too. Measured directly (render each at frame 0 with the new
rig, then again forcing the old z values via `z_override`, and count changed
pixels):

| pose | changed px | frame size | fraction |
|---|---|---|---|
| `idle_cycle` | 9,379 | 486×986 (479,196px) | ≈2.0% |
| `sitting_idle_cycle` | 17,842 | 938×999 (937,062px) | ≈1.9% |

Both existing suites (`test_idle_cycle.py`, `test_sitting_idle_cycle.py`) stay green
— neither asserts exact per-pixel output tied to the old draw order, only geometry
(contact points, bounding bands, determinism) that this change does not touch. This
is expected, not a regression, per the same framing §0 and the shoulder_L paragraph
below already establish for the bone-length fix: the follow-on cards that re-derive
each animation's own pose will see this new, corrected draw order when they do, and
re-tuning either animation for it is explicitly their business, not this round's.

**`shoulder_L`'s bone-length fix (§6): yes, and here is the exact size of it.**
Every pose that composites `shoulder_L`/`forearm_L` (all three: `walk_cycle`,
`idle_cycle`, `sitting_idle_cycle`) now places `forearm_L`'s attach point (the
elbow) **66.24 native px closer to the shoulder** than before this round
(`shoulder_L`'s measured bone length: 169.28px → 103.04px). At the shipped
`CHARACTER_SCALE` (0.0398), that is **≈2.64px** at the final 48px cell — a real,
visible shift in where the far forearm sits relative to the shoulder in every frame
of every pose, in the direction that shortens the far upper arm (the near arm,
`shoulder_R`/`forearm_R`, is completely unaffected: it is not a `bone_length_fix`
entry).

This is expected, not a regression — it is the intended effect of §6's fix, and it
is accepted this round rather than re-tuned, per §0: the follow-on cards that
re-derive each animation's own pose will see (and can account for) this new,
corrected far-arm geometry when they do.

**`sit_down_transition` does not exist in this codebase.** `char_gen/` has
`walk_cycle.py`, `idle_cycle.py` and `sitting_idle_cycle.py`; no `sit_down_
transition` module or test file exists under `assets/src/character/` at this card's
head. Nothing to check or report for it.

## 8. `docs/design/21-character-rig-bones.md`

Marked superseded in place (banner added at its top, document not deleted) — see
its own file. §1 above states exactly which of its sections survive unchanged and
why; the rest (§0's single-hip/single-shoulder framing, implicitly) is what this
document replaces.

## 9. Ten source parts — unchanged

No part was re-cut or re-keyed this round. From the diff
(`git diff --stat -- assets/src/character/parts/side_view/`), the only change under
`parts/side_view/` is `side_view_rig.json` (data) — no `.png` file in that directory
appears in the diff. `shoulder_L.png`'s own bytes are additionally asserted
identical by `test_shoulder_l_png_is_byte_identical` (§6).
