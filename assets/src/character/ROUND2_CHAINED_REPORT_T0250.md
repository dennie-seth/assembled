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

## Result

**Mechanical gate: PASS (on the promoted attempt). Arm C benchmark: NOT beaten.**

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

- **Attempts-to-first-pass:** 6/8 — 5 spent on the denoise sweep proper (all
  failed, informative), 1 on the seed-sensitivity check that produced the
  first and only passing, promoted attempt.
- **GPU-minutes:** 62.4 (sum of all 6 attempts' `gpu_seconds`:
  627.9 + 621.9 + 624.9 + 624.9 + 622.0 + 622.0 = 3743.6s, from
  `ARM_CHAINED_ATTEMPT_LOG_T0250.md`).
- **Wall-clock:** ~01:04 (six sequential ComfyUI-bound generation runs, each
  ~622–628s, run back to back with no idle gap between them — measured from
  each attempt's own `gpu_seconds`, since every attempt ran to completion
  with no crashes/interruptions this round; the between-attempt overhead
  (sweep-report/promotion scripting, this report) is not separately
  instrumented and is not back-filled with an estimate, per DL-21's
  no-back-filled-estimates rule).
- **$:** $0.00 (local GPU, hardware already owned).

See `BAKEOFF_COST_TABLE_T0231.md`'s round-2 section for this card's row,
copied verbatim from this report per that file's own convention.

## Bottom line

Chaining frames through low-denoise img2img **clears the round-2 0.30 gate**
on its first passing attempt (6th overall, after a 5-point denoise sweep
that never passed on its own seed), but **does not beat Arm C's
0.072–0.112 benchmark** — the same outcome §24-b (T-0249) already reached
by a different mechanism. The denoise sweep itself did not surface a
sweet spot: every sampled value failed on the seed it was run against, and
the actual pass came from a seed-sensitivity check outside the swept
variable, the same failure mode already documented for Arm B/T-0229 and
T-0248. Arm C (0.072–0.112, zero GPU-minutes) remains both the benchmark
and the shipping fallback; round 2 has now tried three distinct generative
mechanisms (Arm B's identity LoRA alone, §24-b's pose-authority per-frame
generation, and this card's chaining) without closing that gap.
