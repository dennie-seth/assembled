# [FIX ROUND 2] Archived -- the withdrawn single-neck-point experiment

This directory holds the exact evidence produced by the prior round's SAM3-vs-Oklab comparison,
which queried every panel -- including the legs-only panel -- with a single fixed positive point on
that panel's own NECK keypoint (`_neck_pixel`/`_NECK_JOINT`, removed from
`gen_master_sheet_cutout_compare_T0337.py` this round).

**This is not deleted and it is not presented as the anatomical-part result.** The round-2 review
found that a single neck-only query is invalid for the legs panel (whose neck is a collapsed,
placeholder point by T-0351's own design -- there is no real neck to click on a waist-down crop) and
insufficient for the five whole-figure panels (a T-pose spreads both arms/legs well clear of the
torso, so one torso point does not reliably grow to cover the whole figure). See the parent
directory's `README.md` for the current, corrected six-panel comparison using panel/part-aware
prompts (`panel_prompt_points`), and `comparison.json`'s own `prompt_strategy` field.

## What is archived here

- `panel_{key}_sam3_after.png` -- SAM3's single-neck-point mask overlay, one per panel (6 panels)
- `comparison.json` -- the full per-panel record from that run (`sam3_foreground_px` /
  `oklab_foreground_px` / before-after paths), copied here unmodified before the live rerun
  overwrote the parent directory's own `comparison.json`

`panel_{key}_before.png` and `panel_{key}_oklab_after.png` are **not** duplicated here: the Oklab
flood is untouched by this card (`char_gen/cutout.py`'s own tests are unmodified) and the panel crop
is the same T-0351 sheet either way, so those files in the parent directory remain valid for both the
initial experiment and this round's corrected run.
