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
- **`mask_overlap_fraction`** / overlap tolerance `0.25` — rejects a sibling pair (e.g.
  upper_leg/lower_leg sharing the knee) whose masks overlap too much to call genuinely separated.

## The real result — three parts isolate cleanly, two return nothing, one is untested by overlap

Live run against the ComfyUI host (`172.18.192.1:8188`), `sam3.1_multiplex_fp16.safetensors` via
`UNETLoader`, against T-0351's own attempt-19 `legs` panel crop
(`docs/assets/evidence/T-0337/panel_legs_before.png`, both legs genuinely exposed with wraps/coat
draping between and around them — see that file for the source crop this card segmented).

| part | present | fg_raw | fg_after_isolation | stray_fraction | degenerate | isolated |
|---|---|---|---|---|---|---|
| `right_upper_leg` | yes | 31,799 | 22,945 | 0.278 | no | **yes** |
| `right_lower_leg` | yes | 18,254 | 14,170 | 0.224 | no | **yes** |
| `right_boot` | yes | 8,673 | 6,747 | 0.222 | no | **yes** |
| `left_upper_leg` | **no** | 0 | 0 | — | — | **no** |
| `left_lower_leg` | **no** | 0 | 0 | — | — | **no** |
| `left_boot` | yes | 5,505 | 5,081 | 0.077 | no | **yes** |

Sibling overlap (only computed where both masks exist):

| pair | overlap_fraction | tolerance | exceeds |
|---|---|---|---|
| `right_upper_leg` / `right_lower_leg` | 0.091 | 0.25 | no |
| `right_lower_leg` / `right_boot` | 0.0 | 0.25 | no |

The two left-leg pairs (`left_upper_leg`/`left_lower_leg`, `left_lower_leg`/`left_boot`) are not
evaluated — one sibling in each pair has no mask, and fabricating an overlap number against an
absent mask would misrepresent what was actually measured. This is the edge case named explicitly
in the card: *"the decision is recorded per part rather than silently merged."*

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

## Left/right mirroring

Both sides are generated by the same loop over `(hip, knee, ankle)` triples in
`_build_legs_part_specs` — there is no independently hand-typed left-side spec. The left side's
anchors (`panel_legs_part_left_*_prompts.json`) are pixel-mirrors of the right side's (within 1px,
an `int()` truncation artifact on two independently-rounded midpoints — see
`test_left_right_mirroring_uses_the_same_rule`), confirming the same rule produced both, even
though the two sides' *results* differ.

## Oklab stays the selected primary path

No part of this evidence changes `cut_master_sheet_part`'s method selection or
`char_gen/cutout.py`'s Oklab border-flood, which is untouched by this card (per its own "do not
re-tune" requirement). Per-part SAM3 requests have no Oklab fallback (see
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
