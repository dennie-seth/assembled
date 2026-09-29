# T-0417 evidence — genuinely independent per-part SAM3 requests, honest mixed result

## What this card fixes

Chat's round-3 re-review of #419 (`c5d07fcc`, T-0337 merged) found that T-0337's FIX ROUND 2 put
valid hip/knee/ankle-derived points on the `legs` panel, but all six positive points went into
**one** `positive_coords` list through **one** `SAM3_Detect` call:

> These are constraints on one segmentation, not six separately identified part requests.

This card (`gen_master_sheet_part_cutouts_T0417.py`, `char_gen/part_isolation.py`) replaces that
with a bounded, explicit set of six SEPARATE part requests for the `legs` panel — right/left ×
{upper_leg, lower_leg, boot} — each with its own single positive point and its own negative points
on every sibling part's own anchor, each reaching its **own** `SAM3_Detect` call. T-0337's own
whole-figure comparison (`docs/assets/evidence/T-0337/`) is untouched and stays the record of that
separate experiment — this evidence set never re-presents it as the part result.

## Isolation judged on more than total area

Two mechanical checks, both in `char_gen/part_isolation.py`, both stated and justified against
this run's own real numbers (see that module's docstrings for the full justification):

- **`keep_components_containing_points`** — a part request that returns several disconnected
  components keeps only the component(s) its own positive point falls inside; everything else is
  a stray fragment, reported as `stray_fraction`.
- **`exceeds_stray_fraction_tolerance`** (tolerance `0.35`) — rejects a part whose raw detection
  scattered too much of itself into disconnected fragments.
- **`mask_overlap_fraction`** — measured for **every distinct pair of present parts** in the panel
  (`_evaluate_overlaps`, FIX ROUND finding 3), not only the anatomically-adjacent pairs. A pair that
  shares a joint (e.g. upper_leg/lower_leg at the knee) keeps the `0.25` joint-blur tolerance
  (`PART_OVERLAP_FRACTION_TOLERANCE`); every other pair — cross-side, or a non-adjacent same-side
  pair like upper_leg/boot — has no anatomical reason to overlap at all and gets `0.0`
  (`PART_OVERLAP_FRACTION_TOLERANCE_NON_ADJACENT`). Before this fix, only the same-side
  upper_leg/lower_leg and lower_leg/boot pairs were ever checked — a pair of identical
  right_upper_leg/left_upper_leg masks (overlap `1.0`) would have passed unevaluated.

## The real result — four parts isolate cleanly, two return nothing

Live run against the ComfyUI host (`172.18.192.1:8188`), `sam3.1_multiplex_fp16.safetensors` via
`UNETLoader`, against T-0351's own attempt-19 `legs` panel crop
(`docs/assets/evidence/T-0337/panel_legs_before.png`, both legs genuinely exposed with wraps/coat
draping between and around them — see that file for the source crop this card segmented).

| part | present | fg_raw | fg_after_isolation | stray_fraction | degenerate | overlap_exceeds_tolerance | isolated |
|---|---|---|---|---|---|---|---|
| `right_upper_leg` | yes | 31,799 | 22,945 | 0.278 | no | no | **yes** |
| `right_lower_leg` | yes | 18,254 | 14,170 | 0.224 | no | no | **yes** |
| `right_boot` | yes | 8,673 | 6,747 | 0.222 | no | no | **yes** |
| `left_upper_leg` | **no** | 0 | 0 | — | — | no | **no** |
| `left_lower_leg` | **no** | 0 | 0 | — | — | no | **no** |
| `left_boot` | yes | 5,505 | 5,081 | 0.077 | no | no | **yes** |

`isolated` is `_apply_overlap_rejection`'s final per-part verdict: this part's own
present/not-degenerate/not-stray-rejected result (`isolated_before_overlap` in `part_comparison.json`)
AND-ed against `overlap_exceeds_tolerance` below, folded back in once every part in the panel has run.
No pair in this run exceeded tolerance, so no part is overlap-rejected here — see
`test_apply_overlap_rejection_*` in `tests/test_gen_master_sheet_part_cutouts_T0417.py` for the case
where a pair does exceed it and both siblings get `isolated=False`.

Overlap, every distinct pair of the four **present** parts (FIX ROUND finding 3 — recomputed against
these same already-committed masks via `_evaluate_overlaps`/`_apply_overlap_rejection`, the same
production functions `main()` calls; no re-run against the host was needed because no verdict
changed — see below):

| pair | overlap_fraction | tolerance | adjacent | exceeds |
|---|---|---|---|---|
| `right_upper_leg` / `right_lower_leg` | 0.091 | 0.25 | yes | no |
| `right_lower_leg` / `right_boot` | 0.0 | 0.25 | yes | no |
| `right_upper_leg` / `right_boot` | 0.0 | 0.0 | no | no |
| `right_upper_leg` / `left_boot` | 0.0 | 0.0 | no | no |
| `right_lower_leg` / `left_boot` | 0.0 | 0.0 | no | no |
| `right_boot` / `left_boot` | 0.0 | 0.0 | no | no |

Every pair involving `left_upper_leg` or `left_lower_leg` is still excluded, for the same reason as
before — those two parts are absent (no mask at all), and fabricating an overlap number against an
absent mask would misrepresent what was actually measured. This is the edge case named explicitly in
the card: *"a part legitimately absent... is excluded from overlap evaluation rather than counted as
a 0-overlap pass."* The four *present* parts sit far enough apart in the source crop (right leg vs.
left boot) that none of the newly-evaluated non-adjacent pairs measure any real overlap — recomputing
with the FIX ROUND's all-pairs logic left every `isolated`/`overlap_exceeds_tolerance` verdict in
`part_comparison.json` unchanged from what round 1 originally recorded.

**The right leg is a genuine, evidenced success**, not merely a non-degenerate whole-figure
fraction: `right_upper_leg`/`right_lower_leg`/`right_boot` each reached their own separate
`SAM3_Detect` call, each isolated to the single connected component containing that part's own
positive point, each within both the stray-fragment and (where checked) overlap tolerance. See
`panel_legs_part_right_*_sam3_after.png` — three progressively lower leg segments, magenta
background, no torso/coat bleed, mild jagged-edge noise around wrap/boot decorations accounting
for the ~0.22–0.28 stray fraction (see `PART_STRAY_FRACTION_TOLERANCE`'s own justification for why
that range is not itself a failure).

**The left leg's upper/lower segments are a genuine, evidenced negative result.** SAM3 returned an
all-empty mask (`foreground_px_raw=0`) for both `left_upper_leg` and `left_lower_leg`'s exact point
configurations — see `panel_legs_part_left_upper_leg_sam3_after.png` /
`panel_legs_part_left_upper_leg_mask.png`, both entirely background. This is not an occlusion in
the source image (the crop shows both thighs clearly) and not a code-path defect (`left_boot`,
built by the exact same derivation rule and the exact same sibling-negative-point construction as
`left_upper_leg`/`left_lower_leg`, succeeds cleanly). The most plausible reading is that this
panel's particular combination of a single positive point plus ten negative points — including
both of the *other* left-leg part's own anchors, which sit close along the same limb — oversuppressed
the detector for these two specific requests. This was not chased further (re-tuning point counts
or positions per part would cross into the sweep/tuning this card's own scope excludes); it is
reported as evidence, per the card's own allowance that *"an evidenced limitation remains an
acceptable outcome... What is not acceptable is concluding either way from a combined mask."* This
is exactly the kind of finding a combined six-point mask could never have surfaced — the withdrawn
combined `legs` mask (T-0337, both legs together) was always non-empty, because five of six points
still had a real target somewhere in that single shared segmentation.

## FIX ROUND (2026-09-29, PR #423 review) — two failure-path fixes with no visible effect here

Chat's review of PR #423 found two more P2 defects on the failure path, neither of which changes
anything in the table above (this run's own upload/probe/inference all succeeded) but both matter
for a future run that doesn't:

- **Finding 1** — `_run_one_part` used to catch an `UploadError` on the crop upload, print it, and
  submit the SAM3 graph anyway against the fixed `T0417_panel_{panel}.png` filename, risking
  segmentation of stale pixels ComfyUI still held under that name. It now raises
  `Sam3SegmentationUnavailable` immediately and never builds the runner — no submit, no mask, no
  overlay, no descended PNG, no provenance for that part.
- **Finding 2** — `main()` never caught `Sam3SegmentationUnavailable` around `_run_one_part`, so
  SAM3 failing mid-run (after the initial probe passed — a submission/execution/timeout/fetch error,
  or finding 1's own abort) crashed the script with no recorded prerequisite, leaving
  `sam3_availability.available=true` standing next to whatever was already on disk. `main()` now
  catches it, writes `sam3_mid_run_failure` (which part, which panel, why) and `panels_historical:
  true`, and never deletes or silently re-presents prior evidence.

See `TestUploadFailureAbortsThePartRequest` and `TestMainCatchesMidRunSam3Unavailable` in
`tests/test_gen_master_sheet_part_cutouts_T0417.py` — both reproduced offline, no ComfyUI/GPU
required, driven against the production `_run_one_part`/`main()` functions rather than a local
stand-in.

## Left/right mirroring

Both sides are generated by the same loop over `(hip, knee, ankle)` triples in
`_build_legs_part_specs` — there is no independently hand-typed left-side spec. The left side's
anchors (`panel_legs_part_left_*_prompts.json`) are pixel-mirrors of the right side's (within 1px,
an `int()` truncation artifact on two independently-rounded midpoints — see
`test_left_right_mirroring_uses_the_same_rule`), confirming the same rule produced both, even
though the two sides' *results* differ.

## SAM3 stays the attempted-first path in code, unchanged; Oklab stays the untouched fallback

No part of this evidence changes `cut_master_sheet_part`'s method selection: `char_gen/cutout_sam3.py`
still defaults to `method="sam3"` (SAM3 attempted first), exactly as T-0337 established and this
card's own "do not re-tune" requirement preserves. `char_gen/cutout.py`'s Oklab border-flood is
untouched by this card too, and remains the documented, selectable fallback (`method="oklab"`).
Per-part SAM3 requests have no Oklab fallback (see
`gen_master_sheet_part_cutouts_T0417.py`'s own module docstring for why a whole-image content
flood can't stand in for "this specific limb segment") — when SAM3 is unavailable, the script
reports the prerequisite and performs no part decomposition, the same shape as
`gen_master_sheet_cutout_compare_T0337.main`'s own availability short-circuit.

## Files

- `panel_legs_part_{part}_prompts.json` — every point used for that part, `{x, y, polarity,
  derivation}`.
- `panel_legs_part_{part}_sam3_after.png` — that part's own cutout after the isolation policy,
  magenta marking background.
- `panel_legs_part_{part}_mask.png` — the raw boolean mask (0/255), for exact reconstruction (used
  by the overlap check).
- `panel_legs_part_{part}_descended.png` (+ `.provenance.json`) — box-descended to 32x32 game
  scale, only written when the part is present.
- `part_comparison.json` — the full structured record: availability probe, every part's prompts,
  isolation diagnostics, degenerate/stray/isolated verdicts, and the sibling overlap table.
