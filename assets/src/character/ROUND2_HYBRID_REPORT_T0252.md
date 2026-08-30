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

**Mechanical gate: PASS. Arm C benchmark: NOT beaten.**

**2026-08-30 human review correction.** The number this section originally
reported (0.0660–0.0701, claimed to beat Arm C) was wrong: it was measured
over a sheet whose background was never actually cut to `background_index` —
`gen_hybrid_source_idle_T0252.py`'s original `force_cell_corner_background`
step only flooded pixels at the exact quantized background index from the
cell's corner, and left a near-black halo around the figure (a *different*
quantized index, visually indistinguishable from background) counted as
"foreground". That inflated `check_frame_consistency`'s union denominator
(measured: 1470px of a 2304px cell treated as silhouette, only 63.8%
background) so the *ratio* read low even though the *absolute* pixel change
between frames (97–103px) was larger than Arm C's own (44–70px). This is the
identical defect T-0250 already hit and fixed once (`ROUND2_CHAINED_REPORT_T0250.md`),
and the binding round-2 rule "changing the measure voids the round-1
comparison" was violated by comparing an inflated denominator against Arm
C's own background-free measurement.

The fix, reusing T-0250's own committed cutout mechanism unchanged
(`cutout_foreground_mask`/`apply_cutout_masks`/`downscale_mask` from
`gen_chained_idle_T0250.py`, applied to the source frame's own 384x384
sampled image with the fixed standing-idle pose's own keypoint bounding box,
`_POSE_KEYPOINTS_NORM`): the corrected, re-derived sheet (source-frame
attempt 3 + assembly attempt 3, seed 31416 throughout, no new GPU work — the
cutout was applied to attempt 3's already-sampled pixels on disk) measures a
frame-delta range of **0.1576–0.1816** across all 8 adjacent-cell
transitions. That clears the round-2-unchanged **0.30 cap** (mechanical gate
PASS) but sits well above **Arm C's 0.072–0.112 benchmark** — it does **not**
beat the real bar, only the pass/fail floor. Promoted to
`assets/final/character/player_idle_sheet_hybrid_T0252.png`.

Per the round-2 rules, this is a valid, reportable outcome: "a qualified/
negative finding is an acceptable outcome ... an inflated denominator is
not." The hybrid mechanism removes identity drift by construction (see
below) but, at this recipe, moves *more* silhouette pixels between adjacent
frames than Arm C's hand-authored shapes do — plausibly because
`HYBRID_*_BAND` was tuned against Arm C's own drawn shapes, not against an
organic SDXL silhouette whose head/limb pixels don't align as tightly with
the fixed band rectangles.

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

## Assembly attempts (3 of 8 used, `ARM_HYBRID_ATTEMPT_LOG_T0252.md`)

| Attempt | Frame-delta range | Mechanical gate | Notes |
|---|---|---|---|
| 1 | 0.0660–0.0667 | **FAIL** (`orphan_pixels` only — cells (1,0) and (2,1), both offset (-1,1,-1)) | Superseded: pre-cutout source frame, inflated background denominator (see Result). |
| 2 | 0.0660–0.0701 | **PASS** (all 5 checks) | Superseded: pre-cutout source frame, inflated background denominator (see Result). Fixed the orphan-pixel failure by adding `_cleanup_shift_orphans` to `transform_player_frame_from_source` (see below); that fix is unaffected by the cutout correction and remains in place. |
| **3** | **0.1576–0.1816** | **PASS** (all 5 checks) | Re-derived from the same seed against the cutout-corrected source frame (attempt 3 of `ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md`) — no new GPU work. This is the honest, currently-promoted result. |

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

**Yes.** `hybrid_judging_preview_T0252.gif` (re-rendered against the
cutout-corrected sheet) composites the figure cleanly onto the T-0192
blockout-room mockup at 40px figure height with **no background box** — the
prior committed GIF (pre-cutout) rendered a solid opaque rectangle around the
figure because `render_judging_preview_hybrid_T0252.py` only makes exact
`background_index` pixels transparent, and the halo of near-background pixels
the corner-flood missed was not `background_index`; that defect made the
motion-readability question genuinely unanswerable under DL-21's judging
conditions, not merely visually noisy. With the background actually clean,
the figure is directly judgeable: adjacent frames show a real, localised
pixel change (78–91 delta pixels over a 495–501px silhouette union, per
`check_frame_consistency`'s own `delta_pixels`/`union_pixels`), concentrated
in the head/arm/leg bands exactly as designed — not sensor noise, not a
rounding artifact. This is a small, single-pixel-band idle sway (head bob +
opposing arm/leg shift), the same amplitude class Arm C's own
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
  visually and was promoted; the 2026-08-30 human-review cutout fix
  re-derived attempt 3's *own already-sampled pixels* in place — it is not a
  new attempt against the 8-per-arm cap, no new ComfyUI call was made);
  assembly 3/8 (attempt 1 already beat both frame-delta bars but failed
  `orphan_pixels`, attempt 2 passed after the `_cleanup_shift_orphans` fix,
  attempt 3 re-derived the sheet from the cutout-corrected source frame with
  the same transform code — the honest, currently-promoted result).
- **GPU-minutes:** 3.70 (222.2 GPU-seconds total across the 3 source-frame
  attempts: 3.0 + 99.1 + 120.1, from `ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md`;
  unchanged by the cutout fix, which reprocessed attempt 3's already-sampled
  pixels with 0 additional GPU cost; assembly attempts are pure CPU/script
  work, 0 GPU cost, same as Arm C's own transform).
- **Wall-clock:** ~00:07 for the original attempts (2026-08-30 13:07–13:14
  UTC) + the 2026-08-30 human-review cutout fix and re-derivation (script +
  test changes, one CPU-only reprocess/reassembly/re-render pass, no GPU
  time).
- **$:** $0.00 (local GPU, hardware already owned — the entire premise of
  @DennieSeth's round-2 override).

See `BAKEOFF_COST_TABLE_T0231.md`'s round-2 section for this card's row,
copied verbatim from this section per that file's own convention.

## Bottom line

The hybrid mechanism **works as designed on the identity-drift question**:
exactly one SDXL generation feeds the entire sheet, so identity drift is
structurally impossible — there is nothing for a second generation to drift
away from — and the derived motion reads as a real, visible (if
intentionally subtle) idle sway at 40px in the T-0192 blockout room, now
that the background-cutout fix makes the judging preview actually
judgeable (no background box). But on the metric round 2 actually competes
on, it **does not beat Arm C**: frame-delta 0.1576–0.1816 clears the 0.30
pass/fail floor but sits above Arm C's own 0.072–0.112 benchmark, moving
*more* silhouette pixels between adjacent frames (78–91px) than Arm C's
hand-authored shapes do (44–70px), most likely because `HYBRID_*_BAND` was
tuned against Arm C's own drawn geometry, not against an organic SDXL
silhouette whose limbs don't align as tightly with the fixed band
rectangles. This keeps the authored, locally-generated SDXL look that
motivated @DennieSeth's override and removes drift by construction, but at
this recipe it is **not** the strongest candidate among the generative arms
on round 2's own pass/fail-plus-benchmark criteria — see the other round-2
cards (T-0248/T-0249/T-0250) for how it compares. A qualified, negative
finding against the benchmark is the honest result here, per the round-2
rule that an inflated denominator is not an acceptable way to clear it.
