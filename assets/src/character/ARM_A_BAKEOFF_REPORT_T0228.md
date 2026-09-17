# Arm A bake-off report (T-0228, HANDOFF §23-d)

**Author:** Claude (Opus 5)
**Card:** T-0228 -- Arm A of the T-0227 character-pipeline bake-off (DL-21, `docs/decision-log.md`)
**Cost template:** `docs/decisions/T-0227-bakeoff-cost-record-template.md` (copied below, Arm A row filled)
**Full attempt trace:** `assets/src/character/ARM_A_ATTEMPT_LOG_T0228.md`

## Result

**Criterion-3 failure.** Arm A -- `docs/design/13-asset-pipeline.md` §3.5 as written, fully equipped with the
T-0072 style LoRA, T-0209's approved concept sheet via IP-Adapter, and OpenPose ControlNet -- did not produce
a sheet passing DL-21's mechanical criterion-2 gate within the pre-registered 8-attempt cap. Per DL-21, this
is filed as a complete result, not as "no result." The best-effort candidate (attempt 8) is delivered to
`assets/final/character/player_idle_sheet_arm_a_T0228.png` for §23-g's criterion-1 inspection; its own
provenance sidecar honestly records `mechanical_gate_passed: false`.

## The table

| Arm | Criterion 1 (silhouette @ 40px in motion) | Criterion 2 (identity stable) | Attempts-to-first-pass | GPU minutes | Wall-clock | $ | Sheet | Provenance sidecar | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Arm A (§23-d) | n/a | FAIL | 8 / 8 (no pass) | 28.0 | 00:28 (GPU-attempt time only, see Notes) | $0.00 | `assets/final/character/player_idle_sheet_arm_a_T0228.png` | `assets/final/character/player_idle_sheet_arm_a_T0228.provenance.json` | Criterion-3 failure (8/8, no mechanical pass). Criterion 1 is `n/a`, not left blank by oversight: DL-21 reserves the human silhouette-read to §23-g's panel, not the implementer, and criterion 2 already fails regardless of that verdict's outcome. Criterion 2 fails on the mechanical half alone: 4 of 8 adjacent-cell silhouette-delta ratios exceed the 0.30 cap (0.32, 0.74, 0.72, 0.78), concentrated at row boundaries -- a uniform-colour shift (dark green -> medium green -> tan/khaki) row to row. This reproduces T-0218's own diagnosed "identity_drift" failure mode -- equipment/costume inconsistency across co-generated cells -- even with all three components present and correctly conditioned; see `T-0218-idle-spike-report.md`. Wall-clock is the sum of each attempt's own generation wall-clock (precisely measured, `1692.5s`), not full session time -- it excludes the code/prompt-iteration work between attempts (pose-skeleton architecture fix, descent-chain background-detection fix, prompt tuning), which was not separately instrumented; recording that as a number would be the back-filled estimate DL-21's cost-template rules explicitly forbid, so it is left out rather than guessed. GPU minutes excludes one discarded, unevaluated sub-attempt under the attempt-1 slot (returned from ComfyUI's execution cache in ~4s, corrected before being logged as a result) and one-time environment setup (ComfyUI/model already running). |

## Why this is the correct, complete result for this card

`docs/decision-log.md` DL-21 pre-registers exactly this outcome as a valid terminus: *"An arm that cannot
produce a gate-passing sheet in 8 attempts has answered criterion 3 by failing it -- that outcome is recorded
as a criterion-3 failure, not as 'no result' and not as grounds for a ninth attempt."* Forcing a ninth attempt,
or promoting a mechanically-failing sheet as if it passed, would both violate that rule -- the first by
spending un-budgeted compute, the second by fabricating a result DL-21 was pre-registered specifically to
prevent (a decision rule "written once the results are in... is a rationalisation").

Two structural fixes were necessary before cross-row identity drift became the dominant, clearly visible
failure mode:

1. **Deterministic procedural pose skeleton** (`draw_pose_skeleton_cell`, PIL, 18-keypoint COCO/OpenPose
   format) replacing an SDXL-sampled one. No DWPose/real OpenPose preprocessor is installed on this ComfyUI
   host (a limitation T-0218's own report already names); asking SDXL to draw a literal pose-keypoint image
   from text alone, tried twice (attempts 1 and its discarded predecessor), produced unusable abstract
   patterns with no real pose signal for ControlNet to use.
2. **"Contact sheet" prompt framing** (a 3x3 grid of separate square photographs) instead of "sprite sheet" --
   the latter reliably drew a multi-figure concept-sheet layout (T-0218's "wrong_subject" failure) regardless
   of how strongly ControlNet was weighted (attempts 2-4).

With both fixes in place (attempts 5-8), the grid layout and single-figure-per-cell composition became
reliable, but cross-row identity drift did not resolve across four further attempts of IP-Adapter/ControlNet
weight tuning (0.5-0.75 IP-Adapter weight, 0.9-1.0 ControlNet strength) -- suggesting this is a ceiling of the
co-generation technique itself at this attempt budget, not a parameter nobody happened to try yet.

## Judgeable output for §23-g

`assets/final/character/arm_a_judging_preview_T0228.gif` -- the delivered candidate's 9 cells, looped in
row-major reading order, each frame upscaled so the ~40px-tall figure renders at the size and (flat,
single-colour) framing described in DL-21's judging conditions. Produced with `render_judging_preview.py`
(committed alongside this report). This repo has no committed screenshot of the T-0192 blockout room
(`client/scenes/blockout_room_sideon.tscn` is a Godot scene, outside this agent's tool scope -- see
`.claude/agents/assets.md`), so the preview composites onto a flat mockup at the room's own committed pixel
dimensions (384x216, `docs/decision-log.md` DL-18) rather than an actual in-engine capture; §23-g should treat
it as a size/motion preview, not a claim of an in-engine screenshot.
