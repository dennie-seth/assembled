# T-0427: Untangling the coupled torso/upper_arm overlap, and the empty T-pose torso

Retunes the torso's own SAM3 request from T-0423's figure-panel part machinery
(`gen_master_sheet_part_cutouts_T0417.py`'s `_build_figure_part_specs`/
`part_prompt_points`), per T-0423's own evidence
(`docs/assets/evidence/T-0423/README.md`): the torso and `upper_arm` failures
were recorded as coupled (a shared cause, four `upper_arm` rejections
measuring **0.0% beyond their own elbow** -- anatomically fine, failed only
on torso overlap), and the torso's single-point anchor found nothing at all
on either T-pose coat (an empty detection, a separate problem).

**ROUND 2 of this card, reporting a corrected, still-honest result.** Round
1 (committed, then reviewed) retuned the torso to a three-point centerline
run and claimed two new usable torsos (`side_right_forward`,
`side_left_forward`). **That claim was wrong, and the review that caught it
was right.** Independent pixel measurement against the whole-figure mask
(`docs/assets/evidence/T-0337/panel_*_oklab_after.png`) found
`side_left_forward`'s round-1 mask covered 20,111px -- 4.8% of the whole
figure, *smaller* than T-0423's own already-rejected mask for the same panel
(36,653px/8.8%) -- and excluded the entire green cloak when overlaid on the
source panel, the opposite of the "complete-looking triangular coat/cloak
silhouette" round 1's own `_TORSO_VISUAL_FINDINGS` claimed. That subjective,
unmeasured visual language is exactly what let the false claim through; this
round replaces it with the same pixel-percentage-against-whole-figure
measurement the review used, for every panel, not just the one it happened
to check.

Round 2 adds two lateral positive points (one per side, at
`midpoint(shoulder, hip)`) on top of round 1's centerline run, to test
whether the mask could actually be pulled wider into the garment instead of
staying confined to its own centerline. **The honest result: it helped on
one panel (`back_tpose`, substantially larger and visually fuller) and did
nothing on the others (the lateral points landed within ~15px of the
centerline on profile panels, where left/right body landmarks project to
nearly the same screen position) or didn't matter (the other panels'
coverage is governed by which disconnected visual region of a multi-layered,
partly-open coat SAM3 treats as one segment, not by where the point sits on
the body).** No panel reaches a genuinely complete torso by either round's
retune. This is reported as this card's own evidenced-limitation outcome,
not retuned to manufacture a pass.

Nothing here retunes `PART_STRAY_FRACTION_TOLERANCE`, either overlap
tolerance, or relabels a bad part as good — every verdict below is exactly
what `char_gen.part_isolation`/`char_gen.part_suitability` compute from the
masks actually produced this run, and every suitability label is anchored
to a measured percentage of the whole-figure mask first, a visual
description second.

All evidence files (masks, overlays, prompts, descended PNGs, provenance)
live under `docs/assets/evidence/T-0417/`, the same `EVIDENCE_DIR` T-0417/
T-0423 already wrote to — this card re-runs the torso request in place,
exactly as that machinery's own `--panel X --part torso` re-run path is
designed to do. **Only `torso`'s own files changed** (`git diff` touches
`panel_<panel>_part_torso_*` for all five figure panels and
`part_comparison.json` only) — `head`, every `upper_arm`/`lower_arm` mask,
and the whole `legs` panel are byte-for-byte untouched; their own T-0423/
T-0417 verdicts are reproduced below only as an unregressed baseline, never
recomputed.

Code: `gen_master_sheet_part_cutouts_T0417.py` (`_TORSO_POSITIVE_RUN_FRACTIONS`,
`_TORSO_EXTRA_NEGATIVE_JOINTS`, `_TORSO_LATERAL_POSITIVE_JOINT_PAIRS`, the
`joint_b_pair` branch in `part_prompt_points`). Tests:
`tests/test_gen_master_sheet_part_cutouts_T0427.py` (offline, pins both
rounds' prompt-structure changes), plus the T-0423 tests this card's own
change necessarily supersedes
(`tests/test_gen_master_sheet_part_cutouts_T0423.py`'s
`TestTorsoAnchorDesignDecision`/`TestSeparateSam3CallPerFigurePart`) and
`tests/test_part_suitability_T0423.py`'s
`TestCommittedRecordsUnchangedByThisRound`/`TestFigurePartSuitabilityReport`
(the latter pins what T-0423's own frozen script computes, blind spot
included, as a historical reproduction — never as a correctness target) plus
the new `TestT0427OwnScriptDoesNotRepeatTheAdequateMislabel` class, which
pins THIS card's own corrected script output and guards against a repeat of
round 1's specific mistake (no torso row ever labelled "adequate"). Report
script: `assess_figure_part_suitability_T0427.py` (produced the table below;
T-0423's own `assess_figure_part_suitability_T0423.py` and its README are
left completely unmodified as history).

## What changed in the torso's own request

**Round 1:**

1. **Positive set: one point → a three-point run.** T-0423's torso anchored
   on a single `midpoint(NECK, midpoint(R_HIP, L_HIP))` point, which found
   nothing on either T-pose coat. `_TORSO_POSITIVE_RUN_FRACTIONS = (0.3, 0.5,
   0.7)` places three points along that same NECK→hip-midpoint
   centerline — t=0.5 is the exact original anchor, kept as the run's middle
   point, not discarded.
2. **Negative set: +2 raw shoulder joints.** `_TORSO_EXTRA_NEGATIVE_JOINTS`
   adds `_R_SHOULDER`/`_L_SHOULDER` (COCO-18 indices 2/5) as explicit
   negatives on the torso's own request, beyond the generic one-point-per-
   sibling negative every part already gets.

**Round 2 (current committed state):**

3. **Positive set: +2 lateral points.** `_TORSO_LATERAL_POSITIVE_JOINT_PAIRS`
   adds one positive point per side at `midpoint(shoulder, hip)` — a real
   anatomical landmark on the torso's own left/right edge, added because a
   centerline-only run cannot, by construction, claim pixels off its own
   line. The torso's positive set is now 5 points (3 centerline + 2
   lateral), additive to round 1, never a replacement.

Neither round touches `head`'s, any `upper_arm`'s, or any `lower_arm`'s own
request — `part_prompt_points` still emits exactly one positive point for
every part except `torso`, pinned by
`TestNonTorsoPartsUnaffected`/`TestOutputGeometryUnchangedByThisCard` in the
test module. The all-pairs overlap mechanism
(`_evaluate_overlaps`/`_apply_overlap_rejection`), the stray-fragment/
degenerate-mask isolation checks, and the `upper_arm` beyond-elbow
suitability metric are all reused unmodified — this card changed the torso's
prompt only and let the existing machinery re-judge everything from the new
masks.

## Criterion 2: do the two EMPTY T-pose torsos detect now?

**Yes, both do, in both rounds.**

| panel | T-0423 | round 1 | round 2 (current) |
|---|---|---|---|
| `front_tpose` | empty (0px) | present, 13,092px, isolated, stray 4.3% | present, **19,983px** (5.1% of whole figure), isolated, stray 25.3% |
| `back_tpose` | empty (0px) | present, 5,955px, isolated, stray 29.9% | present, **99,640px** (24.3% of whole figure), isolated, stray 14.6% |

The positive-point additions fix the empty-detection problem outright on
both panels, in both rounds. **Neither is anatomically a complete torso
even now** — see the suitability table below. `front_tpose` stayed a narrow
~70px-wide vertical strip (the lateral points landed close to the
centerline on this pose's own geometry, not meaningfully widening it).
`back_tpose` genuinely grew (24.3% of the whole figure, up from 1.5%) and
visually spans much of the upper-to-mid back coat width, but overlaid on
the source panel it still has extensive internal holes and falls short of
the garment's left/right edges — real progress, not completeness. The
literal acceptance wording ("must return a non-empty torso mask") is
satisfied on both panels; a *usable* torso is not, on either.

## Criterion 1: does a usable torso now exist anywhere?

**No. Zero of the five figure panels meet the two-axis bar (mechanically
isolated AND anatomically complete).** This is this card's own
evidenced-limitation outcome, not a gap in effort: two full live rounds
(centerline run, then centerline + lateral points) were run against every
panel, and the result is reported here exactly as measured, not glossed.

| panel | isolated? | pixel measurement | verdict |
|---|---|---|---|
| `front_tpose` | yes | 19,983px / 5.1% of whole figure, ~70px wide | **partial** — narrow center-seam strip |
| `back_tpose` | yes | 99,640px / 24.3% of whole figure, ~345px wide | **partial** — widest/fullest result this card produced, but visibly holey and short of both garment edges |
| `side_left_forward` | yes | 20,722px / 5.0% of whole figure, ~89px wide | **partial** — **round 1 wrongly called this "adequate"; retracted.** A narrow center-seam strip that excludes the entire cloak |
| `side_right_forward` | yes | 107,293px / 35.8% of whole figure, ~240px wide | **partial** — **round 1 wrongly called this "adequate"; retracted.** A single coat-fold panel; the open coat's opposite flap is not captured |
| `side_neutral` | no | 44,092px / 33.8% of whole figure | **mechanically rejected** — overlaps both arm masks past tolerance |

Every percentage above is pixel count divided by the whole-figure foreground
pixel count from `docs/assets/evidence/T-0337/panel_<panel>_oklab_after.png`
— the same method the reviewer used to catch round 1's false claim, applied
here to every panel rather than just the one that was checked. **T-0338 has
zero torsos it may safely consume by name after this card** — see the
consumption statement at the end of this document.

## Criterion 3 and the coupling hypothesis: did the implicated upper_arms recover?

T-0423's own evidence named four `upper_arm` rejections that measured 0.0%
beyond their own elbow and failed only on torso overlap. Two of those four
are on the panels this card retuned (`side_left_forward/left_upper_arm`,
`side_neutral/right_upper_arm`); the hypothesis under test is whether fixing
the torso recovers them. **Re-verified against round 2's own masks, not
assumed carried over from round 1** — the torso mask changed again between
rounds, so the overlap numbers were re-read from the current
`part_comparison.json`, not copied forward.

**The hypothesis is confirmed on the torso-overlap axis specifically for one
of the two arms, and refuted on the overall mechanical-isolation outcome for
both.** Neither arm newly became usable, for two different reasons.

### `side_left_forward/left_upper_arm`

| | T-0423 | round 1 | round 2 (current) |
|---|---|---|---|
| overlap with `torso` | 0.392 (over 0.25 tolerance) | 0.009 | **0.013** (both rounds: well under tolerance — recovered) |
| overlap with `head` | 0.008 (over 0.0 non-adjacent tolerance) | 0.008 | **0.008** (unchanged in every round — T-0423's own README already recorded this) |
| mechanically isolated | no | no | **still no** |
| beyond-elbow fraction | 0.0% | 0.0% | **0.0%** (mask untouched by this card in either round) |

T-0423's own README headlined this rejection as "failure is the torso
overlap," but its own per-panel table already recorded a SECOND,
independent `head`/`left_upper_arm` overlap (0.008) at the same time — it
was simply overshadowed by the larger torso overlap. Fixing the torso
exposes that pre-existing second cause: `left_upper_arm` is still rejected,
but the reason changed from "torso overlap" to "head overlap." The arm
itself remains anatomically fine (0.0% beyond its own elbow, unchanged,
since this card never touched the arm's own mask in either round).

### `side_neutral/right_upper_arm`

| | T-0423 | round 1 | round 2 (current) |
|---|---|---|---|
| overlap with `torso` | 0.369 (over 0.25 tolerance) | 0.577 | **0.577** (unchanged this round — worse than T-0423, not recovered) |
| overlap with `right_lower_arm` (torso vs. lower_arm) | 0.194 | 0.754 | **0.897** (worse again this round) |
| torso's own stray fraction | 68.4% (torso stray-rejected) | 1.3% | **1.1%** (torso's OWN stray problem stays fixed) |
| mechanically isolated | no | no | **still no** |
| beyond-elbow fraction | 0.0% | 0.0% | **0.0%** (mask untouched by this card in either round) |

The retune is a genuine net regression on overlap for this panel in both
rounds: fixing the torso's stray-fragment problem retained far more of the
raw SAM3 detection as a single connected mask, and that larger mask
overlaps *both* arms more than T-0423's original narrower one did.
`right_upper_arm` did not recover — it is blocked by a worse version of the
same torso-overlap problem, not a new cause, and round 2's lateral points
made this panel's torso mask larger still (39,302px → 44,092px) without
reducing the overlap.

**Net result on the coupling hypothesis, stated plainly for both arms across
both rounds:** fixing the torso's bleed into the arm region was necessary
but not sufficient for either implicated arm. `side_left_forward` was
blocked by a second, previously-overshadowed cause (a pre-existing
`head`/`left_upper_arm` overlap) once the torso cause was genuinely and
stably resolved across both rounds. `side_neutral` never had its torso cause
resolved at all — the retune's own stray-fragment fix enlarged the torso
mask in a way that made the overlap worse in round 1 and did not improve it
in round 2. Neither `PART_OVERLAP_FRACTION_TOLERANCE`/
`PART_OVERLAP_FRACTION_TOLERANCE_NON_ADJACENT` nor
`PART_STRAY_FRACTION_TOLERANCE` were retuned to reach this conclusion — every
number above is read directly from `_evaluate_overlaps`' own output against
the masks each round actually produced.

### The other two upper_arm failures, for completeness (unaffected by this card)

- `back_tpose/right_upper_arm` — still rejected on its own 0.606 stray
  fraction (unrelated to torso; this card never re-ran this arm's own
  request, in either round). The card's own edge-case wording asks
  specifically whether "the closest near-miss in the set" flips to passing
  from a torso change alone — **it does not**: 0.606 is unchanged, and is
  nowhere near the 0.35 tolerance regardless (the beyond-elbow suitability
  metric separately reads 1.3% for this arm, a different measurement from
  the stray fraction; neither was close to flipping).
- `front_tpose/right_upper_arm` — still "combined" at 46.9% beyond its own
  elbow, unaffected (an arm-prompt/over-reach issue, not a torso-overlap
  issue, and this card did not touch any arm's own request).

## Edge cases

**Did tightening the torso trade one failure for another?** Yes, at
`side_neutral`, in both rounds, reported honestly rather than glossed over.
`side_neutral/torso` went from "stray- AND overlap-rejected" (T-0423) to
"overlap-rejected only" (round 1) and stayed there in round 2 — the stray
problem is fixed, but it remains unusable, and its overlap with both arms is
worse than T-0423's original numbers in every round since. No tolerance was
adjusted in response; the result is reported as-is.

**Did an upper_arm recover mechanically but become combined (include the
forearm)?** No — no `upper_arm` mask was re-run by this card in either
round, so none of the "0.0% beyond elbow" arms gained forearm pixels. This
edge case does not apply to this card's own changes.

**A torso that detects on a T-pose but swallows both arms?** `front_tpose`
and `back_tpose` both detect without swallowing an arm in either round
(overlap with `right_upper_arm`/`left_upper_arm` reads 0.0 for both in the
current `part_comparison.json`) — the all-pairs overlap mechanism made that
decision and it's recorded per-part in the table below, not merged silently.

**`back_tpose/right_upper_arm`'s 1.3% stray near-miss** — unaffected by
either round of this card (this arm's mask was never re-run); still
rejected on its own 0.606 stray fraction, not a near-miss to the 0.35
tolerance as described above.

**A panel where the far-side arm is legitimately not visible** — still
excluded from that panel's part set up front (`PARTS_BY_PANEL`, unchanged by
this card), not requested and reported empty, exactly as T-0423 already
does.

**SAM3 unavailable or the thermal gate refusing mid-run** — not hit in
either round of this card; the existing driver-boundary handling
(`_record_mid_run_sam3_failure`) was never exercised and never needed to be,
and no committed evidence was clobbered since it wasn't invoked.

## Full per-panel, per-part table (round 2, current committed state)

Reused computation (`char_gen.part_suitability.beyond_distal_joint_fraction`/
`is_combined_with_next_segment` for `upper_arm`; a visual judgement, cited by
file and anchored to a measured whole-figure percentage, for `head`/`torso`)
— produced by `assess_figure_part_suitability_T0427.py`. `head` rows are
**unchanged by this card** (not re-run) and reproduce T-0423's own recorded
findings verbatim, cited back to `docs/assets/evidence/T-0423/README.md`.

| panel | part | present | isolated | suitability | reason |
|---|---|---|---|---|---|
| front_tpose | head | yes | yes | incomplete | unchanged by T-0427 — face/goggles retained, surrounding hood omitted |
| front_tpose | torso | yes | yes | **partial** | 19,983px, 5.1% of the whole figure, a narrow ~70px-wide vertical strip down the coat's own center seam; lateral points landed within ~15px of the centerline on this pose — empty-detection problem fixed, full torso width is not |
| front_tpose | right_upper_arm | yes | yes | combined | 46.9% beyond its own elbow — unaffected by this card |
| front_tpose | right_lower_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| front_tpose | left_upper_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| front_tpose | left_lower_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| back_tpose | head | yes | yes | adequate | unchanged by T-0427 |
| back_tpose | torso | yes | yes | **partial** | 99,640px, 24.3% of the whole figure (up from round 1's 5,955px/1.5%) — genuinely larger and visually spans most of the upper-to-mid back coat width, but has extensive internal holes and still falls short of the garment's left/right edges |
| back_tpose | right_upper_arm | yes | no | mechanically rejected | 0.606 stray fraction (unaffected by this card) |
| back_tpose | right_lower_arm | yes | yes | adequate | unaffected by this card |
| back_tpose | left_upper_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| back_tpose | left_lower_arm | yes | yes | adequate | unaffected by this card |
| side_right_forward | head | yes | no | mechanically rejected | unchanged by T-0427 |
| side_right_forward | torso | yes | yes | **partial** | 107,293px, 35.8% of the whole figure, a single vertical coat-fold panel with visible fold lines — same conclusion T-0423's original run reached; the open coat's opposite flap (the other half of the garment's visible width) is not captured. **Round 1 wrongly called this "adequate"; retracted here.** |
| side_right_forward | right_upper_arm | yes | no | mechanically rejected | 21.8% beyond its own elbow (unaffected by this card) |
| side_right_forward | right_lower_arm | yes | no | mechanically rejected | unaffected by this card |
| side_left_forward | head | yes | no | mechanically rejected | unchanged by T-0427 |
| side_left_forward | torso | yes | yes | **partial** | 20,722px, 5.0% of the whole figure, a ~89px-wide vertical strip down the center seam only, excluding the entire cloak. The torso/left_upper_arm overlap that rejected this panel under T-0423 is genuinely resolved (0.392 → 0.013), which is why the mask isolates mechanically — but resolving an overlap does not make it anatomically complete. **Round 1 wrongly called this "adequate"/"complete-looking"; retracted here with pixel evidence.** |
| side_left_forward | left_upper_arm | yes | no | mechanically rejected | 0.0% beyond its own elbow — torso overlap fixed (0.013), now blocked by a pre-existing head overlap (0.008) instead |
| side_left_forward | left_lower_arm | yes | yes | adequate | unaffected by this card |
| side_neutral | head | yes | yes | adequate | unchanged by T-0427 |
| side_neutral | torso | yes | no | mechanically rejected | 44,092px, 33.8% of the whole figure, visually a clean vertical panel on its own, but overlaps right_upper_arm (0.577) and right_lower_arm (0.897) past tolerance — both worse than T-0423's original 0.369/0.194; the stray-fragment problem T-0423 recorded (68.4%) stays fixed (1.1%), but overlap is still the blocker |
| side_neutral | right_upper_arm | yes | no | mechanically rejected | 0.0% beyond its own elbow — torso overlap unchanged/worse (0.369→0.577), did not recover |
| side_neutral | right_lower_arm | yes | no | mechanically rejected | torso overlap worse (0.194→0.897); unaffected otherwise |

**Totals: 24 requested, 11 mechanically isolated (up from T-0423's 8), 5
anatomically usable by name — unchanged from T-0423's original 5.** This
card's own retune recovered zero new usable parts: every one of the 3
newly-present/isolated torsos (`front_tpose`, `back_tpose`,
`side_left_forward`) is "partial," and `side_right_forward`'s torso, already
mechanically isolated under T-0423, is reconfirmed "partial," not promoted.
`assess_figure_part_suitability_T0427.compute_report()`'s own totals are
pinned by `TestT0427OwnScriptDoesNotRepeatTheAdequateMislabel` in
`tests/test_part_suitability_T0423.py` — guarding specifically against a
repeat of round 1's "adequate" mislabel on any of the five torso rows, not
just the two the reviewer happened to check.

(T-0423's own **unmodified** `assess_figure_part_suitability_T0423.py`
script, reproduced for history by
`TestFigurePartSuitabilityReport`/`test_totals_distinguish_mechanical_from_anatomically_usable`,
still computes 7 "usable" by its own pre-existing blind spot — it has no
`_VISUAL_FINDINGS` entry for a torso present on a T-pose panel at all, so
its "no finding → usable" default silently counts both `front_tpose/torso`
and `back_tpose/torso` as usable. That script is deliberately left
unmodified as a historical artifact; its own 7 is reproduced as "what that
frozen script computes," never cited as this card's own correct number.
This card's own script, `assess_figure_part_suitability_T0427.py`, has an
explicit finding for every torso row on every panel and does not have this
blind spot.)

## Legs and T-0423's five already-usable parts: unregressed

`git diff` against `develop` touches only `panel_<panel>_part_torso_*` (five
figure panels) and `part_comparison.json` — no `legs` file, no `head`/
`upper_arm`/`lower_arm` mask, prompt, overlay, descended PNG, or provenance
sidecar for any panel is touched, in either round. The five parts T-0423
already found usable are reproduced unchanged in the table above:
`back_tpose/head`, `back_tpose/right_lower_arm`,
`back_tpose/left_lower_arm`, `side_left_forward/left_lower_arm`,
`side_neutral/head`. `legs`' own six T-0417 verdicts are not reproduced by
this card and were never touched.

## Separate SAM3 call structure, isolation/overlap machinery: unmodified

Every part, torso included, is still requested via its own single
`SAM3_Detect` call (`TestSeparateSam3CallStructurePreservedForTorsosMultiPointRequest`
in the test module) — torso's five positive points (three centerline, two
lateral) are five coordinates *within* that one call, never separate calls,
and never batched with any sibling part. `char_gen.part_isolation` and
`char_gen.part_suitability` are imported and called exactly as T-0417/
T-0423 left them; neither module's own source changed.

## Output geometry: no new resolution

`PANEL_SIZE` (the 1024×1024 high-res crop SAM3 operates on, established by
T-0337) is unchanged. `box_descend_part`'s own target size for this
evidence tool's demonstration descend — `(32, 32)`, set by T-0417's
`_run_one_part` and reused here unmodified — is unchanged; asserted
directly against the newly-committed descended PNGs on disk by
`TestOutputGeometryUnchangedByThisCard` in the test module, not assumed.
**This 32×32 is a pre-existing evidence-only convention, distinct from the
production 48×48 curated-sprite-cell size named in
`docs/design/13-asset-pipeline.md:139`** — this tool never promotes to
`assets/final/` (this card's own "do not promote" rule), so the production
cell size is never actually exercised by this evidence pipeline. No new
generation or descend resolution was introduced anywhere in this card, in
either round.

## Thermal gate / checkpoint gate / SAM3 availability

Every request in both rounds went through `ComfyUIClient.submit()` exactly
like any other caller — no gate was touched, weakened, or retried around.
The ComfyUI host (`172.18.192.1:8188`, SAM3 checkpoint from T-0337) was
reachable and the GPU had free VRAM for the whole run; no `ThermalGateRefused`
or mid-run SAM3 unavailability was hit in either round, so the existing
`_record_mid_run_sam3_failure` driver-boundary handling (T-0423's own FIX
ROUND 1) was never exercised here. No checkpoint outside the SAM registry
entry already approved for T-0337 was used.

## gitleaks

No agent persona currently holds a grant to execute `~/.local/bin/gitleaks`
— consistent with every prior card's own honest statement of this gap. This
round's own new content (one Python module's findings data, one test
module addition, evidence PNGs/JSON, this README, the `ASSET_PROVENANCE.md`
update) was written with no secret-shaped strings; reported honestly as an
un-run scan, not claimed.

## What T-0338 may consume by name, and what it still may not

**Safe to consume today, by name — unchanged from T-0423, nothing added by
this card:**

- `back_tpose/head`, `side_neutral/head` — complete heads (T-0423, unchanged)
- `back_tpose/right_lower_arm`, `back_tpose/left_lower_arm`,
  `side_left_forward/left_lower_arm` — proportionate forearm+hand shapes
  (T-0423, unchanged)

**Still not safe to consume, with the current, specific reason:**

- **Every `torso`, on every panel.** `front_tpose/torso`, `back_tpose/torso`,
  `side_left_forward/torso`, `side_right_forward/torso` now detect and
  mechanically isolate, but every one is a partial capture of the garment
  (a narrow centerline strip on three panels, a single coat-fold panel on
  the fourth, a holey-but-wider partial on `back_tpose`) — **not** the two
  "adequate" wins round 1 of this card claimed; that claim is retracted with
  pixel evidence above. `side_neutral/torso` is mechanically rejected
  (overlaps both arms past tolerance).
- Every `upper_arm`, on every panel — **zero usable upper_arm parts exist
  after this card**, the same as before it, in both rounds.
  `front_tpose/right_upper_arm` is anatomically combined with the forearm;
  `back_tpose/right_upper_arm`, `side_right_forward/right_upper_arm` are
  mechanically rejected on stray/overreach grounds unrelated to torso;
  `side_left_forward/left_upper_arm` and `side_neutral/right_upper_arm` are
  anatomically fine (0.0% beyond their own elbow) but mechanically
  blocked — by a pre-existing head overlap in one case (confirmed fixed on
  the torso axis specifically), and a torso overlap that never improved in
  the other.
- `front_tpose/right_lower_arm`, `front_tpose/left_upper_arm`,
  `front_tpose/left_lower_arm`, `back_tpose/left_upper_arm` — still empty
  detections, unaffected by this card.
- All `head` parts other than `back_tpose`/`side_neutral` — still
  mechanically rejected or incomplete, unaffected by this card.

**T-0338 still has zero usable `torso` and zero usable `upper_arm` parts to
build arm opposition from, after two full rounds of this card.** The empty-
T-pose-detection problem is genuinely fixed and the `side_left_forward`
torso/arm overlap coupling is genuinely resolved, but neither translated
into a part T-0338 can safely consume by name. This remains open work for a
follow-on card — most plausibly one that treats the coat as a
segmentation-model problem (e.g. prompting each visible coat panel/fold as
its own region and compositing) rather than a single joint-anchored point
set, since this card's own evidence now shows that approach has been tried
twice and plateaus well short of anatomical completeness on every panel.
