# Round-2 hybrid report — T-0252 (HANDOFF §24-e)

**Author:** Claude (Sonnet 5)
**Card:** T-0252 — round 2 of the T-0227 character-pipeline bake-off, per
@DennieSeth's authorship override (`BAKEOFF_DECISION_T0231.md`) that continues
the generative path even though Arm C already passed and was cheaper. The
hypothesis: take the part each approach is good at — **SDXL for the look**
(one high-quality idle frame through the full generative stack: style LoRA +
identity LoRA + IP-Adapter + ControlNet) and **Arm C's deterministic script
for the motion** (T-0230's own committed head/arm/leg offset machinery,
reused unchanged, now transforming the generated frame's own pixels instead
of a hardcoded shape). Because there is only ever one generated figure,
identity drift is structurally impossible — this card measures whether the
derived motion still reads as motion at 40px when the source is generated
rather than constructed.

## T-0248 contingency (checked before spending attempts here)

Per this card's own gate, T-0248's outcome had to be checked first:
`ROUND2_BAKEOFF_REPORT_T0248.md` records T-0248's re-run of Arm B against
`player_identity_v2` as only a **partial** improvement — 1 of 3 seeds passed
(0.083–0.273), 2 of 3 still failed, and even the passing seed's 0.273 does
not approach Arm C's 0.072–0.112. §24-a alone does not settle round 2, so
this card was not unnecessary; proceeding was correct.

## Result

**Mechanical gate: PASS. Arm C benchmark: BEATEN.**

The promoted sheet (source-frame attempt 3 + assembly attempt 2, seed 31416
throughout) measures a frame-delta range of **0.0660–0.0701** across all 8
adjacent-cell transitions — inside the round-2-unchanged **0.30 cap** *and*
inside **Arm C's 0.072–0.112 benchmark** (max 0.0701 < Arm C's own floor of
0.072). This is the first round-2 card to beat the real bar, not merely clear
the pass/fail floor. Promoted to
`assets/final/character/player_idle_sheet_hybrid_T0252.png`.

## Source-frame attempts (3 of 8 used, `ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md`)

| Attempt | Recipe | Result |
|---|---|---|
| 1 | seed 31416, ControlNet 1.0/1.0, style 0.7, identity 0.5, IP-Adapter 0.6 (this script's own untuned defaults) | Unrecognisable: no coherent figure, textured non-black background clearly showing the concept sheet's own multi-panel reference layout bleeding through (composition bleed from a high-weight IP-Adapter reference that is itself a busy multi-panel sheet, not a single clean portrait). |
| 2 | seed 31416, ControlNet **1.3**/1.0 (T-0249's already-validated recipe), same LoRA/IP-Adapter weights | Legible figure shape emerged, but the background bleed persisted (dark panel bars, faint ghost text visible at the bottom edge). |
| **3** | seed 31416, ControlNet 1.3/1.0, style 0.7, identity 0.5, **IP-Adapter 0.3** (lowered from 0.6) | **Clean, legible, solid-black-background silhouette** — a recognisable green/white figure with a clear head/torso/leg silhouette at 48px. Promoted. |

Diagnosis: stacking IP-Adapter on top of two chained LoRAs at full IP-Adapter
weight over-weighted the reference image's own *composition* (the concept
sheet is a flat side-on multi-panel reference layout, T-0209, not a single
clean portrait) rather than only its style — halving the IP-Adapter weight
resolved it without touching ControlNet/LoRA weights that were already
working (T-0249 precedent). No prior round-2 card had combined IP-Adapter
with the identity LoRA, so this failure mode was previously unobserved.

## Assembly attempts (2 of 8 used, `ARM_HYBRID_ATTEMPT_LOG_T0252.md`)

| Attempt | Frame-delta range | Mechanical gate | Notes |
|---|---|---|---|
| 1 | 0.0660–0.0667 | **FAIL** (`orphan_pixels` only — cells (1,0) and (2,1), both offset (-1,1,-1)) | Already beat both bars on frame-delta alone; failed only the orphan check. |
| **2** | 0.0660–0.0701 | **PASS** (all 5 checks) | Fixed by adding `_cleanup_shift_orphans` to `transform_player_frame_from_source` (see below). Promoted. |

**The bug and fix.** Attempt 1's frame-delta already beat both bars, but 2 of
the 8 assembled cells (both using offset triple (-1, 1, -1)) failed
`asset_gate.art.check_orphan_pixels`: shifting a head/arm/leg band left 2-3px
disconnected slivers of source content just outside the band's own
swept-clear rectangle. Arm C's hardcoded shapes never hit this because they
are drawn to fit their offset boxes exactly by construction; a real SDXL
figure's silhouette does not align that precisely with the fixed
`HYBRID_*_BAND` rectangles (tuned against Arm C's own drawing, not against
organic generated pixels). The fix is new, hybrid-transform-specific code —
`char_gen.synth_entities._cleanup_shift_orphans`, a connected-component
cleanup (mirrors the existing source-frame `cleanup_orphans` in
`gen_arm_a_idle_T0228.py`, reimplemented locally to avoid a script->package
reverse import) applied to a derived frame's own array after the band shifts,
before it is composited into the sheet. **It does not touch Arm C's own
`_make_sheet` or `_player_pose_offsets`** — both are reused completely
unchanged, per this card's own constraint. All 10 of
`test_hybrid_transform_T0252.py`'s existing tests still pass unmodified after
the fix.

## The real question: does the derived motion still read as motion at 40px?

**Yes.** `hybrid_judging_preview_T0252.gif` renders all 9 frames at 40px
figure height inside the T-0192 blockout-room mockup, per DL-21's judging
conditions. Direct pixel comparison between a neutral frame (offset 0,0,0)
and an adjacent offset frame (±1,∓1,±1) shows a real, non-trivial, confined
change: 22534–23265 summed absolute RGB difference over the ~2000px figure
region, localised to the arm/leg bands exactly as designed — not sensor
noise, not a rounding artifact. This is a small, single-pixel-band idle sway
(head bob + opposing arm/leg shift), the same amplitude class Arm C's own
`_player_pose_offsets` already selects and that round 1 judged as reading as
motion. It is subtle by design (Arm C's whole premise is a small,
identity-safe offset pool), not a dramatic walk-in-place, but it is a real,
visible, structural pixel change every cycle, not a static sheet with a
diagnostic-only frame-delta number.

## Recipe (committed end to end)

- **Source frame** (the one SDXL generation): seed 31416, checkpoint
  `sd_xl_base_1.0.safetensors`, style LoRA `soviet_brutalism_style_v1.safetensors`
  weight 0.70, identity LoRA `player_identity_v2.safetensors` weight 0.50,
  IP-Adapter `ip-adapter-plus_sdxl_vit-h.safetensors` weight 0.30 (PLUS high
  strength preset, T-0209 concept sheet reference), ControlNet
  `controlnet-openpose-sdxl-1.0_xinsir.safetensors` strength 1.3/end 1.0,
  euler/normal, steps 30, cfg 7.0, denoise 1.0, 384x384. Full graph:
  `gen_hybrid_source_idle_T0252.build_graph`. Full recipe:
  `player_idle_frame_hybrid_source_T0252.provenance.json`.
- **Derived frames** (the deterministic transform, zero GPU cost): seed
  31416 drives `_player_pose_offsets` (T-0230, unchanged) to select
  (head, arm, leg) pixel offsets per frame; each frame is
  `transform_player_frame_from_source(source_arr, head_off, arm_off, leg_off)`
  — five fixed raster bands (`HYBRID_HEAD_BAND` etc.) translated by those
  offsets, cleaned of shift-edge orphans, composited over the untouched
  source elsewhere. Full recipe: `player_idle_sheet_hybrid_T0252.provenance.json`.

## Provenance (P-7-compliant, both halves resolvable)

- **Generated half**: `model_hash` non-null
  (`31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`),
  `concept_hash` resolves to T-0209's committed, hash-verified concept sheet.
  Generator: `assets/src/character/gen_hybrid_source_idle_T0252.py`
  (committed, re-runnable).
- **Derived half**: `generator` resolves to committed code —
  `assets/src/character/gen_hybrid_idle_T0252.py` calling
  `char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252`, both in
  this repo, both under test.
- See `ASSET_PROVENANCE.md`'s two new rows for the full model+license+prompt+seed
  entries (source frame and assembled sheet).

## Cost (recorded, not deciding — per the round-2 override)

- **Attempts-to-first-pass:** source frame 3/8 (attempts 1-2 diagnosed and
  fixed the IP-Adapter composition-bleed failure mode, attempt 3 passed
  visually and was promoted); assembly 2/8 (attempt 1 already beat both
  frame-delta bars but failed `orphan_pixels`, attempt 2 passed after the
  `_cleanup_shift_orphans` fix).
- **GPU-minutes:** 3.70 (222.2 GPU-seconds total across the 3 source-frame
  attempts: 3.0 + 99.1 + 120.1, from `ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md`;
  assembly attempts are pure CPU/script work, 0 GPU cost, same as Arm C's own
  transform).
- **Wall-clock:** ~00:07 (2026-08-30 13:07–13:14 UTC, from the first
  source-frame attempt's provenance write to the rendered judging-preview
  GIF's write time; excludes the code-authoring time that produced this
  card's earlier RED/prior-session commits).
- **$:** $0.00 (local GPU, hardware already owned — the entire premise of
  @DennieSeth's round-2 override).

See `BAKEOFF_COST_TABLE_T0231.md`'s round-2 section for this card's row,
copied verbatim from this section per that file's own convention.

## Bottom line

The hybrid mechanism **works as designed**: exactly one SDXL generation feeds
the entire sheet, identity drift is structurally impossible because there is
nothing for a second generation to drift away from, and the derived motion
reads as a real, visible (if intentionally subtle) idle sway at 40px in the
T-0192 blockout room — the same amplitude class Arm C's own script already
uses. Frame-delta (0.0660–0.0701) **beats Arm C's own 0.072–0.112
benchmark**, not merely the 0.30 pass/fail floor, on the first fully-promoted
attempt. This keeps the authored, locally-generated SDXL look that motivated
@DennieSeth's override while inheriting Arm C's consistency guarantee by
construction — per the card's own framing, this is now the strongest
candidate among the generative arms for what round 2 ships, contingent on
the human silhouette-read this report's judging preview enables.
