# Arm B bake-off report (HANDOFF §23-e) -- training (T-0237) + generation (T-0229)

**Author:** Claude (Sonnet 5)
**Cards:** T-0237 (stage 1, training) and T-0229 (stage 2, generation) -- Arm B of the
T-0227 character-pipeline bake-off (DL-21, `docs/decision-log.md`), split into two cards
after T-0229 failed five consecutive runs trying to train *and* generate inside a single
implementer phase.
**Cost template:** `docs/decisions/T-0227-bakeoff-cost-record-template.md` (copied below,
row now complete -- stage 1 filled the training cells, stage 2 below fills the verdict
cells and adds generation's GPU minutes/wall-clock on top, per T-0229's acceptance:
"Cost recorded in §23-c's committed template — including T-0237's curation and training
time, so Arm B's row is the true total")

## Result

**Both stages complete: identity trained into weights, idle sheet generated and passing.**

**Stage 1 (T-0237, training).** T-0237's deliverable was the trained LoRA itself:
`assets/final/lora/player_identity_v1.safetensors`, trained via the shared WSL-native
kohya sd-scripts stack (`assets/src/lora/src/lora_train/train.py`, unchanged) against the
curated 12-image `identity_refs/` dataset and `training_config_player_identity_T0229.toml`,
both committed on `feature/T-0229` and reused rather than rewritten. Training ran
foreground/blocking end to end, 2026-08-27 23:04 UTC -> 2026-08-28 01:14 UTC, 6/6 epochs,
72/72 steps, per-epoch checkpoints confirmed writable (`save_every_n_epochs=1`). Full
provenance: `assets/final/lora/player_identity_v1.provenance.json`.

**Stage 2 (T-0229, generation).** With `player_identity_v1.safetensors` merged in from
develop and confirmed loadable in ComfyUI's `LoraLoader` node list alongside the T-0072
style LoRA (`GET /object_info/LoraLoader` lists both `player_identity_v1.safetensors` and
`soviet_brutalism_style_v1.safetensors`), `gen_arm_b_idle_T0229.py` was run for 7 attempts
(cap 8) against the committed graph -- style LoRA -> identity LoRA (chained LoraLoader) ->
OpenPose ControlNet on the deterministic procedural pose grid, no IP-Adapter. Attempt 1
(identity weight 0.8) collapsed composition into a repeating vertical strip with no 3x3
gutters; lowering the identity weight to ~0.5 (attempt 2) fixed composition immediately but
left one persistent row-wrap animation-frame transition over the 0.30 delta cap, reproduced
across seed/weight variations (attempts 2-6). Attempt 7 (seed 31416, ControlNet strength
raised 1.0->1.3, same seed/weights as attempt 2) tightened ControlNet's authority over the
identical-weight LoRA stack -- since the tiled OpenPose skeleton is bit-for-bit identical in
every cell, higher ControlNet strength pins per-cell pose more rigidly and suppresses the
prompt-driven idle-motion swing that broke the row-wrap transitions -- and passed all 8
adjacent-cell transitions (ratios 0.10-0.30) plus visual review (one consistent silhouette,
correct pose, no drift, no duplicate figures). Promoted to
`assets/final/character/player_idle_sheet_arm_b_T0229.png`. Full attempt trace:
`ARM_B_ATTEMPT_LOG_T0229.md`; provenance: `player_idle_sheet_arm_b_T0229.provenance.json`;
judging preview: `arm_b_judging_preview_T0229.gif`.

## The table

| Arm | Criterion 1 (silhouette @ 40px in motion) | Criterion 2 (identity stable) | Attempts-to-first-pass | GPU minutes | Wall-clock | $ | Sheet | Provenance sidecar | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Arm B (§23-e) | PASS | PASS | 7/8 | 165.5 | 02:48 | $0.00 | `assets/final/character/player_idle_sheet_arm_b_T0229.png` | `assets/final/character/player_idle_sheet_arm_b_T0229.provenance.json` | **Criterion 1** PASS: attempt 7's promoted sheet reads as one consistent standing figure per cell at 40px in the T-0192 blockout-room mockup (`arm_b_judging_preview_T0229.gif`), no drift, no duplicate figures, correct facing. **Criterion 2** PASS: all 8 adjacent-cell (animation-frame) silhouette-delta ratios <= 0.30 cap (0.097-0.295, see `ARM_B_ATTEMPT_LOG_T0229.md`), plus the visual drift check above. **Attempts-to-first-pass 7/8**: attempt 1 (identity-LoRA weight 0.8) over-weighted identity and broke the contact-sheet composition entirely; attempts 2-6 (identity weight ~0.5, various seeds/ControlNet-end) fixed composition but left one or two row-wrap transitions over cap (0.38-0.62) reproducibly across seed 31416/31417/31420; attempt 7 (seed 31416, ControlNet strength 1.0->1.3) resolved it by letting the identical-per-cell pose skeleton pin the pose more rigidly, suppressing the idle-motion swing that broke those transitions. **GPU minutes (165.5)** = training 129.7 (T-0237, `player_identity_v1.provenance.json`'s `gpu_seconds` 7783.5s) + generation 35.8 (this card, sum of all 7 counted attempts' `gpu_seconds` in `ARM_B_ATTEMPT_LOG_T0229.md`: 165.3+210.2+298.6+366.6+366.5+381.7+360.4 = 2149.3s), the true total per T-0229's acceptance ("including T-0237's curation and training time"). Excludes the SDXL checkpoint's one-time load and kohya's one-time network build (training side, ~10min, amortised environment cost per T-0237's own exclusion) and ComfyUI's one-time model load (generation side, same treatment as Arm A). **Wall-clock (02:48)** = training 02:10 (2026-08-27 23:04 UTC -> 2026-08-28 01:14 UTC) + generation 00:38 (this card, pose-grid write at 2026-08-28 12:30:29 local to attempt 7's provenance write at 13:08:30 local, 7 attempts run foreground/blocking in sequence). **Curation time remains excluded, not silently absent**: `curate_identity_panels_T0229.py` has no timing instrumentation and ran before either card existed; per DL-21's no-back-filled-estimates rule this is not reconstructed, the same treatment Arm A gave its own un-instrumented prompt-iteration time -- curation is CPU-only PIL work with no GPU cost regardless, so the exclusion affects no column but would-be additional wall-clock. |
