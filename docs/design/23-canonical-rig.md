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
- **§6 Layer order** — back to front, right-facing: `leg.L → arm.L → torso → head →
  leg.R → arm.R` (far limbs, then body, then near limbs). Still correct: z-order
  decides which part wins a contested pixel, and nothing in this card changes that
  decision for the existing ten parts' default z values (`side_view_rig.json`'s
  `rig.*.z` is untouched). What this card adds (§4 below) is a SECOND, independent
  axis — position, not draw order — for when z-order alone cannot reveal a limb.
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
`shoulder_L`'s z (5) beats the torso's (3), and the far arm was STILL invisible,
because they occupied the *same x* — re-sorting never had anywhere to put it that
the sort could reveal. `lateral_offset_frac` moves the pixel itself.

## 4. The static render

`char_gen.reference_pose_T0436.render()` composites one static frame: a wide-stance
lunge (representative of the reference's own framing — its exact joint ANGLES were
never transcribed into the card body, only the two bar widths and the limb-length
ratios; see the module's own docstring, "What this render does and does not
prove"), with `shoulder_points`/`hip_points` set to the two canonical bar ends (§3a/
3b) and `lateral_offset_frac` set to the rig's own recorded demonstration values
(`canonical_rig.lateral_offset_axis.demonstration_values`):

```
shoulder_L: -0.50   forearm_L: -0.20   thigh_L: -0.08   calf_L: -0.03
```

(fractions of torso width; chosen empirically so the far arm clears the torso's own
silhouette — not re-derived from the reference image, which is not available this
round).

**Far-arm visibility, measured directly from the composited placements**
(`visible_pixel_count` in `tests/test_reference_pose_render_T0436.py` — a pixel is
counted only if removing the part changes the final composite AND the "with" result
is itself non-transparent there, so an occluded part's own opaque pixels do not
count):

| | without `lateral_offset_frac` | with it |
|---|---|---|
| `shoulder_L` | **0** | **6272** |
| `forearm_L` | **0** | **11042** |

Confirms the card's own premise (0 visible pixels at baseline) and that the lateral
offset — not the two-point bar attach alone — is what fixes it: `shoulder_L` is
still 0 with the bar-end attach active and the offset zeroed out.

Evidence, committed:

- `docs/assets/evidence/T-0436/reference_pose_render.png` — the composited pose.
- `docs/assets/evidence/T-0436/rig_vs_reference_overlay.png` — the same render with
  the shoulder bar (red), pelvis bar (red), spine (yellow) drawn on top, plus the
  front shin's actual-vs-adopted-target length (orange solid vs cyan dashed, §5) and
  a caption restating the pixel counts above.

### Per-joint deviation

Both bar lines are **drawn directly from the values that posed the render**, so
their own deviation from the target is sub-pixel rounding only (±0.5px, the `round()`
in `rig_compositor.place()`) — not independently meaningful. The deviation that
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

**Mechanism-level change (§3c): none.** `shoulder_points`, `hip_points`,
`lateral_offset_frac` all default to `None`; no pre-existing pose module passes
them. Confirmed both by direct test (`TestOptInCompositorHooks`) and by the full
existing suite: every test in `test_walk_cycle.py`, `test_idle_cycle.py`,
`test_sitting_idle_cycle.py`, `test_pose_rig_master_sheet_T0351.py`,
`test_pose_rig_T0249.py`, `test_pose_rig_walk_T0259.py` and
`test_pose_rig_profile_T0272.py` — 192 tests, unchanged — stays green after this
round's changes, with no edits to any of those test files.

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
