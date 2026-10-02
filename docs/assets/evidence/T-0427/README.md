# T-0427: Untangling the coupled torso/upper_arm overlap, and the empty T-pose torso

Retunes the torso's own SAM3 request from T-0423's figure-panel part machinery
(`gen_master_sheet_part_cutouts_T0417.py`'s `_build_figure_part_specs`/
`part_prompt_points`), per T-0423's own evidence
(`docs/assets/evidence/T-0423/README.md`): the torso and `upper_arm` failures
were recorded as coupled (a shared cause, four `upper_arm` rejections
measuring **0.0% beyond their own elbow** -- anatomically fine, failed only
on torso overlap), and the torso's single-point anchor found nothing at all
on either T-pose coat (an empty detection, a separate problem).

**This document reports a mixed, honest result, not a clean win.** The torso
retune is a genuine, verified improvement on several axes and an outright
regression on one. Nothing here retunes `PART_STRAY_FRACTION_TOLERANCE`,
either overlap tolerance, or relabels a bad part as good — every verdict
below is exactly what `char_gen.part_isolation`/`char_gen.part_suitability`
compute from the masks actually produced this run.

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
`_TORSO_EXTRA_NEGATIVE_JOINTS`, the `joint_b_pair` branch in
`part_prompt_points`). Tests:
`tests/test_gen_master_sheet_part_cutouts_T0427.py` (new, offline, pins the
prompt-structure change), plus the two T-0423 tests this card's own change
necessarily supersedes
(`tests/test_gen_master_sheet_part_cutouts_T0423.py`'s
`TestTorsoAnchorDesignDecision`/`TestSeparateSam3CallPerFigurePart`) and
three T-0423 suitability-report regression pins
(`tests/test_part_suitability_T0423.py`'s
`TestCommittedRecordsUnchangedByThisRound`/`TestFigurePartSuitabilityReport`)
updated to the new live-evidence reality — see each test's own comment for
why. Report script: `assess_figure_part_suitability_T0427.py` (produced the
table below; T-0423's own `assess_figure_part_suitability_T0423.py` and its
README are left completely unmodified as history).

## What changed in the torso's own request

1. **Positive set: one point → a three-point run.** T-0423's torso anchored
   on a single `midpoint(NECK, midpoint(R_HIP, L_HIP))` point, which found
   nothing on either T-pose coat. `_TORSO_POSITIVE_RUN_FRACTIONS = (0.3, 0.5,
   0.7)` now places three points along that same NECK→hip-midpoint
   centerline — t=0.5 is the exact original anchor, kept as the run's middle
   point, not discarded.
2. **Negative set: +2 raw shoulder joints.** `_TORSO_EXTRA_NEGATIVE_JOINTS`
   adds `_R_SHOULDER`/`_L_SHOULDER` (COCO-18 indices 2/5) as explicit
   negatives on the torso's own request, beyond the generic one-point-per-
   sibling negative every part already gets (which, for torso, already
   included the sibling `upper_arm`'s own shoulder-elbow-midpoint anchor).
   The raw shoulder joint sits closer to the actual torso/sleeve seam than
   that midpoint does.

Neither change touches `head`'s, any `upper_arm`'s, or any `lower_arm`'s own
request — `part_prompt_points` still emits exactly one positive point for
every part except `torso`, pinned by
`TestNonTorsoPartsUnaffected`/`TestOutputGeometryUnchangedByThisCard` in the
new test module. The all-pairs overlap mechanism
(`_evaluate_overlaps`/`_apply_overlap_rejection`), the stray-fragment/
degenerate-mask isolation checks, and the `upper_arm` beyond-elbow
suitability metric are all reused unmodified — this card changed the torso's
prompt only and let the existing machinery re-judge everything from the new
masks.

## Criterion 2 first: do the two EMPTY T-pose torsos detect now?

**Yes, both do.**

| panel | before (T-0423) | after (T-0427) |
|---|---|---|
| `front_tpose` | empty detection (0px) | present, 13092px after isolation, **mechanically isolated**, stray 4.3% |
| `back_tpose` | empty detection (0px) | present, 5955px after isolation, **mechanically isolated**, stray 29.9% |

The three-point positive run fixes the empty-detection problem outright on
both panels. **But neither is anatomically a complete torso** — see the
suitability table below: both are a narrow vertical strip down the coat's
own center seam, not the full torso width. The literal acceptance wording
("must return a non-empty torso mask") is satisfied; a *usable* torso is
not, on either T-pose panel.

## Criterion 1: does a usable torso now exist anywhere?

**Yes — two panels, both new wins.**

| panel | before (T-0423) | after (T-0427) |
|---|---|---|
| `side_right_forward` | mechanically isolated, but **partial** ("a strip of coat fold, not the complete torso/coat") | still mechanically isolated (108815px, stray 1.2%, down from 126159px/2.0%), and visually a **fuller profile silhouette with visible fold lines — now adequate** |
| `side_left_forward` | overlap-rejected (coat mask extends into the swallowed `left_upper_arm`, overlap 0.392) | overlap with `left_upper_arm` drops to **0.009** (well under the 0.25 joint-blur tolerance) — now mechanically isolated, and visually a **complete-looking triangular coat/cloak silhouette — adequate** |

`side_right_forward/torso` and `side_left_forward/torso` are both now usable
by the same two-axis test T-0423 established (mechanically isolated **and**
anatomically complete under its own name). **These are the two torsos
T-0338 may now consume** — see the consumption statement at the end of this
document.

## Criterion 3 and the coupling hypothesis: did the implicated upper_arms recover?

T-0423's own evidence named four `upper_arm` rejections that measured 0.0%
beyond their own elbow and failed only on torso overlap. Two of those four
are on the panels this card retuned (`side_left_forward/left_upper_arm`,
`side_neutral/right_upper_arm`); the hypothesis under test is whether fixing
the torso recovers them.

**The hypothesis is confirmed on the torso-overlap axis specifically, and
refuted on the overall mechanical-isolation outcome, for both arms — for two
different reasons.** Neither arm newly became usable.

### `side_left_forward/left_upper_arm`

| | before | after |
|---|---|---|
| overlap with `torso` | 0.392 (over the 0.25 tolerance) | **0.009** (now well under tolerance — recovered) |
| overlap with `head` | 0.008 (over the 0.0 non-adjacent tolerance) | 0.008 (**unchanged** — T-0423's own README already recorded this exact overlap, see its own per-panel table) |
| mechanically isolated | no | **still no** |
| beyond-elbow fraction | 0.0% | 0.0% (mask untouched by this card, unchanged) |

T-0423's own README headlined this rejection as "failure is the torso
overlap," but its own per-panel table already recorded a SECOND,
independent `head`/`left_upper_arm` overlap (0.008) at the same time — it
was simply overshadowed by the larger torso overlap. Fixing the torso
exposes that pre-existing second cause: `left_upper_arm` is still rejected,
but the reason changed from "torso overlap" to "head overlap." The arm
itself remains anatomically fine (0.0% beyond its own elbow, unchanged,
since this card never touched the arm's own mask).

### `side_neutral/right_upper_arm`

| | before | after |
|---|---|---|
| overlap with `torso` | 0.369 (over the 0.25 tolerance) | **0.577** (worse, still over tolerance) |
| overlap with `right_lower_arm` (torso vs. lower_arm, separately) | 0.194 | 0.754 (much worse) |
| torso's own stray fraction | 68.4% (torso itself stray-rejected) | 1.3% (torso's OWN stray problem is fixed) |
| mechanically isolated | no | **still no** |
| beyond-elbow fraction | 0.0% | 0.0% (mask untouched by this card, unchanged) |

Here the retune is a genuine net regression on overlap: fixing the torso's
stray-fragment problem (68.4% → 1.3%) retained far more of the raw SAM3
detection as a single connected mask, and that larger mask now overlaps
*both* arms more, not less. `right_upper_arm` did not recover — it is
blocked by a worse version of the same torso-overlap problem, not a new
cause.

**Net result on the coupling hypothesis, stated plainly for both:** fixing
the torso's bleed into the arm region is necessary but was not independently
sufficient for either implicated arm — one (`side_left_forward`) was blocked
by a second, previously-overshadowed cause once the torso cause was removed;
the other (`side_neutral`) saw its torso-overlap problem worsen as a
side-effect of fixing a different torso defect (stray fragments). Neither
`PART_OVERLAP_FRACTION_TOLERANCE`/`PART_OVERLAP_FRACTION_TOLERANCE_NON_ADJACENT`
nor `PART_STRAY_FRACTION_TOLERANCE` were retuned to reach this conclusion —
both numbers above are read directly from `_evaluate_overlaps`' own output
against the masks this run actually produced.

### The other two upper_arm failures, for completeness (unaffected by this card)

- `back_tpose/right_upper_arm` — still rejected on its own 0.606 stray
  fraction (unrelated to torso; this card never re-ran this arm's own
  request). The card's own edge-case wording asks specifically whether "the
  closest near-miss in the set" flips to passing from a torso change alone —
  **it does not**: 0.606 is unchanged (this arm's mask was never touched),
  and 0.606 is nowhere near the 0.35 tolerance regardless, so "near-miss" is
  not an accurate characterization of this specific number (the
  beyond-elbow suitability metric separately reads 1.3% for this arm, a
  different measurement from the stray fraction; neither one was close to
  flipping).
- `front_tpose/right_upper_arm` — still "combined" at 46.9% beyond its own
  elbow, unaffected (this is an arm-prompt/over-reach issue, not a
  torso-overlap issue, and this card did not touch any arm's own request).

## Edge case: did tightening the torso trade one failure for another?

**Yes, in one place (`side_neutral`), reported honestly above rather than
glossed over.** `side_neutral/torso` went from "stray- AND overlap-rejected"
to "overlap-rejected only" — the stray problem is fixed, but it remains
unusable, and its overlap with both arms got measurably worse, not better.
This is exactly the edge case the card calls out ("tightening the torso
makes it PARTIAL instead of overlapping — trading one failure for another is
not progress") — here it's not partial, it traded one *flavor* of
overlap-and-stray failure for a purer overlap failure, still a failure. No
tolerance was adjusted in response; the result is reported as-is.

`front_tpose/torso` and `back_tpose/torso` also fit this pattern from a
different angle: fixing the empty-detection problem produced a mechanically
clean but anatomically **partial** mask (a narrow coat-seam strip) on both —
progress on one axis, no progress on the other.

## Full per-panel, per-part table (this run)

Reused computation (`char_gen.part_suitability.beyond_distal_joint_fraction`/
`is_combined_with_next_segment` for `upper_arm`; a visual judgement, cited by
file, for `head`/`torso`) — produced by `assess_figure_part_suitability_T0427.py`.
`head` rows are **unchanged by this card** (not re-run) and reproduce
T-0423's own recorded findings verbatim, cited back to
`docs/assets/evidence/T-0423/README.md`.

| panel | part | present | isolated | suitability | reason |
|---|---|---|---|---|---|
| front_tpose | head | yes | yes | incomplete | unchanged by T-0427 — face/goggles retained, surrounding hood omitted |
| front_tpose | torso | yes | yes | **partial** | a narrow vertical strip down the coat's own center seam, not the full torso width; empty-detection problem fixed, completeness is not |
| front_tpose | right_upper_arm | yes | yes | combined | 46.9% beyond its own elbow — unaffected by this card |
| front_tpose | right_lower_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| front_tpose | left_upper_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| front_tpose | left_lower_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| back_tpose | head | yes | yes | adequate | unchanged by T-0427 |
| back_tpose | torso | yes | yes | **partial** | same narrow center-seam strip as front_tpose |
| back_tpose | right_upper_arm | yes | no | mechanically rejected | 0.606 stray fraction (unaffected by this card) |
| back_tpose | right_lower_arm | yes | yes | adequate | unaffected by this card |
| back_tpose | left_upper_arm | no | n/a | n/a | not present (empty detection, unaffected) |
| back_tpose | left_lower_arm | yes | yes | adequate | unaffected by this card |
| side_right_forward | head | yes | no | mechanically rejected | unchanged by T-0427 |
| side_right_forward | torso | yes | yes | **adequate** | fuller profile silhouette with fold lines — improved from T-0423's "partial/coat-fold strip" finding |
| side_right_forward | right_upper_arm | yes | no | mechanically rejected | 21.8% beyond its own elbow (unaffected by this card) |
| side_right_forward | right_lower_arm | yes | no | mechanically rejected | unaffected by this card |
| side_left_forward | head | yes | no | mechanically rejected | unchanged by T-0427 |
| side_left_forward | torso | yes | yes | **adequate** | complete-looking triangular coat/cloak silhouette — recovered from T-0423's overlap rejection |
| side_left_forward | left_upper_arm | yes | no | mechanically rejected | 0.0% beyond its own elbow — torso overlap fixed (0.009), now blocked by a pre-existing head overlap (0.008) instead |
| side_left_forward | left_lower_arm | yes | yes | adequate | unaffected by this card |
| side_neutral | head | yes | yes | adequate | unchanged by T-0427 |
| side_neutral | torso | yes | no | mechanically rejected | stray fixed (68.4%→1.3%) but now overlaps BOTH arms more than before — net regression on overlap |
| side_neutral | right_upper_arm | yes | no | mechanically rejected | 0.0% beyond its own elbow — torso overlap got WORSE (0.369→0.577), did not recover |
| side_neutral | right_lower_arm | yes | no | mechanically rejected | torso overlap got worse (0.194→0.754); unaffected otherwise |

**Totals: 24 requested, 11 mechanically isolated (up from 8), 7 anatomically
usable by name (up from 5).** The net gain is exactly two parts:
`side_right_forward/torso` and `side_left_forward/torso`. The other
mechanically-isolated gains (`front_tpose/torso`, `back_tpose/torso`) are
**not** counted usable — both are partial.

## Legs and T-0423's five already-usable parts: unregressed

`git diff` against this card's starting commit touches only
`panel_<panel>_part_torso_*` (five figure panels) and `part_comparison.json`
— no `legs` file, no `head`/`upper_arm`/`lower_arm` mask, prompt, overlay,
descended PNG, or provenance sidecar for any panel is touched. The five
parts T-0423 already found usable are reproduced unchanged in the table
above: `back_tpose/head`, `back_tpose/right_lower_arm`,
`back_tpose/left_lower_arm`, `side_left_forward/left_lower_arm`,
`side_neutral/head`. `legs`' own six T-0417 verdicts are not reproduced
by this card and were never touched.

## Separate SAM3 call structure, isolation/overlap machinery: unmodified

Every part, torso included, is still requested via its own single
`SAM3_Detect` call (`TestSeparateSam3CallStructurePreservedForTorsosMultiPointRequest`
in the new test module) — torso's three positive points are three
coordinates *within* that one call, never three separate calls, and never
batched with any sibling part. `char_gen.part_isolation` and
`char_gen.part_suitability` are imported and called exactly as T-0417/
T-0423 left them; neither module's own source changed.

## Output geometry: no new resolution

`PANEL_SIZE` (the 1024×1024 high-res crop SAM3 operates on, established by
T-0337) is unchanged. `box_descend_part`'s own target size for this
evidence tool's demonstration descend — `(32, 32)`, set by T-0417's
`_run_one_part` and reused here unmodified — is unchanged; asserted
directly against the newly-committed descended PNGs on disk by
`TestOutputGeometryUnchangedByThisCard` in the new test module, not assumed.
**This 32×32 is a pre-existing evidence-only convention, distinct from the
production 48×48 curated-sprite-cell size named in
`docs/design/13-asset-pipeline.md:139`** — this tool never promotes to
`assets/final/` (this card's own "do not promote" rule), so the production
cell size is never actually exercised by this evidence pipeline. No new
generation or descend resolution was introduced anywhere in this card.

## Thermal gate / checkpoint gate / SAM3 availability

Every request this round went through `ComfyUIClient.submit()` exactly like
any other caller — no gate was touched, weakened, or retried around. The
ComfyUI host (`172.18.192.1:8188`, SAM3 checkpoint from T-0337) was reachable
and the GPU had free VRAM for the whole run; no `ThermalGateRefused` or
mid-run SAM3 unavailability was hit this round, so the existing
`_record_mid_run_sam3_failure` driver-boundary handling (T-0423's own FIX
ROUND 1) was never exercised here. No checkpoint outside the SAM registry
entry already approved for T-0337 was used.

## gitleaks

No agent persona currently holds a grant to execute `~/.local/bin/gitleaks`
— consistent with every prior card's own honest statement of this gap. This
round's own new content (two Python modules, one test module, one test-file
diff, evidence PNGs/JSON, this README) was written with no secret-shaped
strings; reported honestly as an un-run scan, not claimed.

## What T-0338 may consume by name, and what it still may not

**Safe to consume today, by name:**

- `back_tpose/head`, `side_neutral/head` — complete heads (T-0423, unchanged)
- `back_tpose/right_lower_arm`, `back_tpose/left_lower_arm`,
  `side_left_forward/left_lower_arm` — proportionate forearm+hand shapes
  (T-0423, unchanged)
- **`side_right_forward/torso`, `side_left_forward/torso` — NEW this round.**
  Both mechanically isolated and anatomically usable torso/coat silhouettes.

**Still not safe to consume, with the current, specific reason:**

- `front_tpose/torso`, `back_tpose/torso` — now detect (no longer empty),
  but are a narrow center-seam strip, not a usable torso width.
- `side_neutral/torso` — mechanically rejected (overlaps both arms past
  tolerance; got worse, not better, this round).
- Every `upper_arm`, on every panel — **zero usable upper_arm parts exist
  after this card**, the same as before it. `front_tpose/right_upper_arm`
  is anatomically combined with the forearm; `back_tpose/right_upper_arm`,
  `side_right_forward/right_upper_arm` are mechanically rejected on
  stray/overreach grounds unrelated to torso; `side_left_forward/
  left_upper_arm` and `side_neutral/right_upper_arm` are anatomically fine
  (0.0% beyond their own elbow) but mechanically blocked — by a pre-existing
  head overlap in one case, and a worsened torso overlap in the other.
- `front_tpose/right_lower_arm`, `front_tpose/left_upper_arm`,
  `front_tpose/left_lower_arm`, `back_tpose/left_upper_arm` — still empty
  detections, unaffected by this card.
- All `head` parts other than `back_tpose`/`side_neutral` — still
  mechanically rejected or incomplete, unaffected by this card.

**T-0338 still has zero usable `upper_arm` parts to build arm opposition
from.** This card recovered a torso — the anchor T-0338 needs — on two
panels, but did not clear the second named blocker (a usable `upper_arm`)
on any panel. That remains open work.
