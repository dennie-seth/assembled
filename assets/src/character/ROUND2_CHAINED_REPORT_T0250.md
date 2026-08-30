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

See `BAKEOFF_COST_TABLE_T0231.md`'s round-2 section for this card's row,
copied verbatim from this report per that file's own convention.

## Bottom line

The originally-promoted result (attempt 6, chain-from-predecessor) cleared
the round-2 0.30 gate but was **rejected on human review** for compounding
background noise every frame — a real, visually-confirmed failure the
frame-delta gate could not see. The directed fix (anchor to frame 0 +
background hold, attempts 7-8) **does solve that problem**: background
growth is now bounded (1.01-1.02x vs. the 1.35x cap) and both re-run sheets
are visually clean. But it trades one failure mode for another: frame-delta
collapsed to near-zero (0.0000-0.0299 / 0.0000-0.0286) because the fix also
removed the only signal (background speckle) that was registering this
sheet's already-tiny idle motion as inter-frame change — visually, the pose
does not read as moving at either sampled denoise. This **mechanically
clears both the 0.30 cap and Arm C's 0.072–0.112 benchmark**, promoted here
per the card's "done when" clause (artifact + recipe + provenance + sweep
table must exist, win or not), but per round-2 rule §23-b this is reported
as a **qualified, negative finding**, not a win: a sheet that passes because
motion has stalled has not demonstrated that chaining-through-img2img can
produce a legible-motion, drift-free result, only that it can produce a
drift-free, motion-free one. The DL-21 8-attempt cap is now exhausted for
this card; whether a higher denoise resolves both problems simultaneously is
untested. Arm C (0.072–0.112, zero GPU-minutes) remains both the benchmark
and the shipping fallback; round 2 has now tried three distinct generative
mechanisms (Arm B's identity LoRA alone, §24-b's pose-authority per-frame
generation, and this card's chaining, in both its rejected and fixed forms)
without closing that gap while also keeping legible motion.
