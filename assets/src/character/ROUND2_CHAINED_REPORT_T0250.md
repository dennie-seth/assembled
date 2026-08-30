# Round-2 chained img2img report — T-0250 (HANDOFF §24-c)

**Author:** Claude (Sonnet 5)
**Card:** T-0250 — round 2 of the T-0227 character-pipeline bake-off, per
@DennieSeth's authorship override (`BAKEOFF_DECISION_T0231.md`) that continues
the generative path even though Arm C already passed and was cheaper.
§24-c's hypothesis: instead of asking the model to independently re-derive
the same character for every frame (§24-b/T-0249), **chain the frames** —
frame 1 generated fresh, frame *n* an img2img pass from frame *n-1*'s own
decoded output at low denoise with the next pose applied, so identity is
inherited rather than re-invented each frame. Composes directly on top of
§24-b: `build_chained_graph` reuses `gen_pose_authority_idle_T0249.build_graph`
unchanged for every node except the latent source and denoise.

## T-0248 contingency, checked before spending attempts here

This card's own acceptance requires checking §24-a's (T-0248) outcome first
and stopping if it alone already beats Arm C's 0.072–0.112 benchmark.
T-0248's re-run of Arm B against `player_identity_v2` was only a **partial**
improvement: 1 of 3 tested seeds passed (0.083–0.273), 2 of 3 still failed
the 0.30 cap outright, and even the one passing seed's worst transition
(0.273) is nowhere near Arm C's 0.072–0.112. §24-a alone does **not** make
this card unnecessary — proceeding with the chaining hypothesis was correct.

## Human review (2026-08-30) and the fix that followed

The result below this section (attempts 1-6) was **rejected on human review**.
@DennieSeth inspected the promoted attempt 6 sheet
(`player_idle_sheet_chained_T0250.png`, denoise 0.15, seed 31420) and found:
the character is not recognizable, and background noise **accumulates and
compounds with every successive frame** — the classic img2img-chaining
drift-accumulation failure, where frame *n* inherits and amplifies frame
*n-1*'s own noise. Measured objectively: clean background pixel count decayed
monotonically 1280 -> 832 across the sheet (non-background speckle grew
~1024px -> ~1472px, a ratio the review found nowhere in the mechanical gate's
own numbers). **The frame-delta gate passed this sheet anyway** — it measures
*inter-frame* silhouette delta (motion consistency), not identity legibility
or background cleanliness, so a sheet dissolving into speckle by row 3 can
still clear 0.30 comfortably (measured 0.0301-0.2134) if each individual step
is small. The review's directed fix, applied here: **anchor every frame to
frame 0's own decoded output** (not the immediately preceding frame, the
original hypothesis text) so there is no chain of ever-degrading inputs to
compound along, and **hold the background out of the feedback path** via a
hard pixel-space composite of the sampled figure onto frame 0's own
background (`apply_background_hold`, soft-edged mask over each frame's own
keypoint bounding box). A companion mechanical check,
`asset_gate.art.check_background_growth`, was added specifically because the
existing frame-delta gate could not have caught this on its own (measures
growth against a fixed frame-0 baseline, not step-to-step delta).

**What the fix actually produced, honestly reported (attempts 7-8, the last
two under DL-21's 8-per-arm cap):** the compounding-noise problem is
genuinely solved — background growth measured at 1.013x (attempt 7,
denoise=0.15) and 1.023x (attempt 8, denoise=0.30) of frame 0's baseline,
both comfortably inside the 1.35x bound, and both sheets are visually clean
across all 9 cells. But the frame-delta collapsed to **0.0000-0.0299**
(attempt 7) and **0.0000-0.0286** (attempt 8) — and direct visual comparison
of frame 0 against frame 4 at both values shows the pose has **not visibly
moved**. This is not a measurement artifact: holding the background static
removed the only channel (background speckle) that was previously
registering as inter-frame delta on this sheet's already-tiny idle motion
(`pose_rig_T0249.json`: `breathing_amplitude_norm` 0.012,
`weight_shift_extent_norm` 0.018). The low-denoise "motion stops reading"
failure mode this card's own sweep was designed to detect is now the
**dominant** failure mode of the fixed mechanism — it occurred at both
sampled points, including denoise=0.30, inside the mandated ~0.25-0.35 band,
not only below it. The 8-attempt cap was exhausted confirming this at two
points; whether some higher denoise (>0.35) restores legible motion before
drift returns under the *new* mechanism is genuinely untested. Per round-2
rule §23-b, this is reported as a qualified, negative finding rather than a
win: the promoted sheet mechanically clears both the 0.30 cap and Arm C's
0.072-0.112 benchmark, but only because motion has stalled, not because
chaining produced a legible-motion, drift-free result. See
`DENOISE_SWEEP_REPORT_T0250.md` / `DENOISE_SWEEP_T0250.json` for the full
per-attempt table (both mechanisms, tagged separately) and
`gen_chained_idle_T0250.py`'s `DEFAULT_DENOISE_JUSTIFICATION` for the
promoted attempt's own justification text.

## Second human review (2026-08-30) and the cutout fix that followed

@DennieSeth reviewed the anchor+hold fix above (attempt 8, denoise 0.30) and
confirmed **the drift fix worked** — character recognizable, background
noise bounded (1.013x/1.023x vs. the 1.35x cap), no accumulation trend. The
open issue: **the sheet still had a background at all.** For a game sprite
the output must be character-only, with everything else forced to
`background_index` (the game engine's transparency convention for an
indexed sheet, per DL-21's spec), and this sheet still carried a dark ground
plane, a distinct grey slab in the upper-right of every cell, and scattered
green marks — none of it character, ~44-45% of every cell by pixel count.

The review's directed fix, applied here, **additive on top of the anchor +
hold mechanism — not a redo of it**: cut the character out of its
background **per frame, before the frames are assembled into the sheet**.
`docs/design/13-asset-pipeline.md`'s prop cutout path
(`tools/comfy-client/src/comfy_client/cutout.py`, cited directly in the
review) bakes RGBA alpha at *generation* time via a full-canvas `SolidMask`
— correct for a prop LoRA'd to fill its entire canvas with no background
margin, but a uniform full-canvas alpha value cannot separate a character
from the background margin this sheet's cells still have (the two are
different problems: a full-canvas SolidMask cannot vary by pixel position at
all). Reusing that mechanism unmodified would tag the whole cell alpha=255
and remove nothing. Instead, `cutout_foreground_mask` (new,
`gen_chained_idle_T0250.py`) does the equivalent per-pixel job as a genuine
segmentation of the already-generated frame:

1. `border_flood_background_mask` — a border-connected, tolerance-chained
   region grow in Oklab space (tolerance 0.03) over that frame's own
   384x384 sampled/held image. Every border pixel seeds the background
   region; a neighbour joins if it is within tolerance of the pixel it
   grows *from* (not a single fixed seed colour), so a gradual background
   gradient connected to the frame edge is swept regardless of how many
   distinct palette indices it later quantizes to.
2. Unioned with "outside this frame's own keypoint bounding box +
   `BACKGROUND_MASK_MARGIN_FRAC` (0.14) margin" — the same constant the
   background-hold mask already uses, already proven across 8 frames not to
   clip the figure. This catches clutter that is *not* border-connected (a
   diagonal floor-plane wedge touching the bottom corners, faint symmetric
   side-ghosting) by position rather than colour.

Measured on the already-sampled attempt 8 frames before this shipped:
tolerance 0.03 recovers a foreground fraction stable across all 9 frames
(23.1-23.4% of the 384x384 frame, no visible clipping); below ~0.02 residual
background survives, above ~0.08 the fraction becomes frame-inconsistent
(0.070-0.131 across otherwise-identical frames) — a sign the flood starts
eating into the character unevenly. This is applied to each frame's own
image and downscaled to the 48x48 cell alongside it, **before** the frames
are assembled into the 144x144 sheet, per the review's explicit direction.

**No new GPU work.** `--reprocess-attempt 8` re-derives the sheet from
attempt 8's already-sampled `frame_N_main_384.png` / `frame_N_cell_48_raw.png`
files on disk — the exact same sampled pixels, same seed (31420), same
denoise (0.30), same identity re-anchoring and background-hold masking.
Only the final indexing stage changed. This is
**not** a 9th attempt against DL-21's 8-per-arm cap (already exhausted) —
it is a post-process of bytes that already exist, which is exactly why it
was possible to satisfy the review's own "additive, do not re-sweep, do not
change the fix that worked" instruction.

**Result:** `background_growth` unaffected (1.013x/1.023x-equivalent,
recomputed on the cutout sheet: counts 248→260, ratio 1.048x, well inside
1.35x). `check_orphan_pixels`/`check_cell_fit` still pass. Frame-delta,
recomputed on the cutout sheet, is **0.0000-0.1763** — higher than the
pre-cutout 0.0000-0.0286, because removing ~1000px/cell of static background
shrinks the union denominator in `check_frame_consistency`'s ratio, so the
same tiny absolute silhouette variation now reads as a larger fraction. This
**still clears the 0.30 cap** (`beats_030_cap: true`) but **does not beat**
Arm C's 0.072-0.112 benchmark (`beats_arm_c_benchmark: false`, max 0.1763 >
0.112) — reported honestly rather than silently carrying over the
pre-cutout number, per round-2 rule §23-b.

## Result (attempts 1-6, original chain-from-predecessor mechanism — superseded above)

**Mechanical gate: PASS (on attempt 6, since rejected). Arm C benchmark: NOT beaten.**

The denoise sweep proper (attempts 1–5, seed 31416, denoise 0.15/0.25/0.30/
0.35/0.45, everything else held fixed per the round-2 rules) **never
clears the 0.30 cap at any sampled value** — every point fails at the same
(0,1)->(0,2) transition, whose ratio rises **monotonically** with denoise:

| Denoise | Max adjacent-cell ratio |
|---|---|
| 0.15 | 0.308 |
| 0.25 | 0.348 |
| 0.30 | 0.366 |
| 0.35 | 0.390 |
| 0.45 | 0.417 |

This does not match the a-priori "too-low-denoise motion stops reading /
too-high-denoise drift returns" story the hypothesis predicted: the low end
is not too low to read as motion (every other transition on that sheet
stays well under the cap at every tested denoise), and the story only holds
on the high end, where more sampler freedom lets it re-invent more of the
figure at that one specific pose transition — the same drift failure mode
independent per-frame generation (§24-b/T-0249) already showed, just
concentrated on a single transition instead of spread across all eight.

A 6th attempt reran the sweep's best-performing denoise (0.15) on a
**different seed** (31420 instead of 31416), everything else unchanged —
the same seed-sensitivity diagnostic Arm B (T-0229) and T-0248's own re-run
against `player_identity_v2` both already needed. It **passes**: frame-delta
range **0.0301–0.2134**, comfortably inside the 0.30 cap. This is the
promoted attempt — `assets/final/character/player_idle_sheet_chained_T0250.png`
— but its max ratio (0.2134) is still nearly double Arm C's own worst
transition (0.112), so it **clears the gate, it does not beat the bar**.

Full sweep data/prose: `assets/src/character/DENOISE_SWEEP_REPORT_T0250.md`,
`DENOISE_SWEEP_T0250.json`. Full 6-attempt trace:
`assets/src/character/ARM_CHAINED_ATTEMPT_LOG_T0250.md`.

## §24-b composition, stated explicitly

**Yes** — every attempt in this card runs on top of §24-b (T-0249), not
instead of it. Frame 0 is generated via
`gen_pose_authority_idle_T0249.build_graph` completely unchanged; frames
1–8 patch only that same graph's latent source (EmptyLatentImage ->
VAEEncode of the previous frame) and denoise. The provenance sidecar
records this mechanically (`composes_with_pose_authority_T0249: true`,
`based_on_card: "T-0249"`), and the gate suite's
`test_composes_with_pose_authority_stated_explicitly` pins it.

## What this measures, honestly

Chaining does inherit *appearance* from the previous frame — the whole
point of the hypothesis — but the mechanical gate does not measure
"does the figure look inherited," it measures adjacent-cell silhouette
delta, and one specific pose-to-pose transition (the jump into the
second row) reproducibly exceeds the cap on the swept seed regardless of
how much freedom (denoise) the img2img pass is given. This is not the
sampler running out of freedom (low denoise) or having too much (high
denoise) in the way the hypothesis predicted — it is closer to a
seed-specific interaction between that particular pose transition and
this recipe, which a different seed (attempt 6) resolves. That the
*same* seed-sensitivity failure mode recurs across three independent
mechanisms now (Arm B/T-0229, T-0248's re-run, and this card's own sweep)
is itself a finding: whatever combination of ControlNet strength,
identity-LoRA weight and prompt is driving it is not specific to any one
generation mechanism.

## Cost (recorded, not deciding — per the round-2 override)

- **Attempts:** 8/8 (the full DL-21 cap) — 5 on the original denoise sweep
  (all failed the cap), 1 on the seed-sensitivity check that produced the
  since-rejected attempt-6 sheet, 2 on confirming the 2026-08-30 human-review
  fix (attempts 7-8) after which the cap was exhausted.
- **GPU-minutes:** 87.8 (sum of all 8 attempts' `gpu_seconds`: 627.9 + 621.9
  + 624.9 + 624.9 + 622.0 + 622.0 + 667.8 + 857.5 = 5268.9s, from
  `ARM_CHAINED_ATTEMPT_LOG_T0250.md`).
- **Wall-clock:** ~01:28 (eight sequential ComfyUI-bound generation runs, run
  back to back with no idle gap between them — measured from each attempt's
  own `gpu_seconds`, since every attempt ran to completion with no
  crashes/interruptions; the between-attempt overhead (sweep-report /
  promotion scripting, this report) is not separately instrumented and is
  not back-filled with an estimate, per DL-21's no-back-filled-estimates
  rule).
- **$:** $0.00 (local GPU, hardware already owned).
- **Second human review's cutout fix:** $0.00 GPU, 0 additional attempts.
  `--reprocess-attempt 8` re-derives the sheet from attempt 8's already-sampled
  bytes on disk — no ComfyUI call, no new seed, no re-sweep. The DL-21
  8-attempt cap for this card remains exhausted at 8/8; the cutout fix did
  not, and could not, spend a 9th.

See `BAKEOFF_COST_TABLE_T0231.md`'s round-2 section for this card's row,
copied verbatim from this report per that file's own convention.

## Bottom line

The originally-promoted result (attempt 6, chain-from-predecessor) cleared
the round-2 0.30 gate but was **rejected on human review** for compounding
background noise every frame — a real, visually-confirmed failure the
frame-delta gate could not see. The first directed fix (anchor to frame 0 +
background hold, attempts 7-8) **solved that problem**: background growth is
bounded (1.01-1.05x vs. the 1.35x cap) and the sheet is visually clean. It
traded one failure mode for another — frame-delta collapsed to near-zero
because holding the background static removed the only signal (background
speckle) that was registering this sheet's already-tiny idle motion as
inter-frame change; visually, the pose does not read as moving.

The **second** directed fix (per-frame background cutout, this section)
addressed a separate, still-open problem the first fix did not touch: the
sheet still had a background at all — a dark ground plane, a grey slab, and
scattered green marks, none of it character. Cutting the character out per
frame, before assembly, removes all of that: every cell is now genuinely
background_index outside the character's own silhouette
(`test_sheet_background_is_mostly_clean`,
`test_no_foreground_pixels_outside_keypoint_bbox`), with the character
itself intact and un-clipped (`test_character_silhouette_not_erased`). This
was a pure post-process of attempt 8's already-sampled pixels — no new GPU
work, no seed or denoise change, the anchor+hold fix untouched — exactly
what "additive, not a redo" requires.

Removing the static background as a side effect makes the frame-delta
measurement *more* sensitive (the check's denominator shrank), so the
measured range moved from 0.0000-0.0286 to **0.0000-0.1763**. This still
**clears the 0.30 cap** but now **more clearly does not beat** Arm C's
0.072-0.112 benchmark (max 0.1763, vs. 0.112) — reported as measured, not
carried over from the pre-cutout number. The underlying finding is
unchanged: a sheet that passes because motion has stalled has not
demonstrated that chaining-through-img2img can produce a legible-motion,
drift-free result, only that it can produce a drift-free, motion-free one —
now also genuinely background-clean, which is a real improvement to the
*artifact*, not to that finding. The DL-21 8-attempt cap is exhausted for
this card; whether a higher denoise resolves the motion-stalled problem is
untested and would need a fresh attempt allocation. Arm C (0.072-0.112, zero
GPU-minutes) remains both the benchmark and the shipping fallback; round 2
has now tried three distinct generative mechanisms (Arm B's identity LoRA
alone, §24-b's pose-authority per-frame generation, and this card's
chaining, across its rejected, drift-fixed, and now background-cut forms)
without closing that gap while also keeping legible motion.
