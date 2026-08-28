# Arm B bake-off report, stage 1/2 -- training (T-0237, HANDOFF §23-e)

**Author:** Claude (Sonnet 5)
**Card:** T-0237 -- stage 1 of Arm B of the T-0227 character-pipeline bake-off (DL-21,
`docs/decision-log.md`), split out of T-0229 after that card failed five consecutive runs
trying to train *and* generate inside a single implementer phase.
**Cost template:** `docs/decisions/T-0227-bakeoff-cost-record-template.md` (copied below,
Arm B's training-only cells filled; the generation-only cells are `n/a` here by design --
see "Why this is a partial row" below)
**Stage 2 (generation):** T-0229, which depends on this card and does not re-train -- it
consumes `assets/final/lora/player_identity_v1.safetensors` directly and will fill this
row's Criterion 1 / Criterion 2 / Attempts-to-first-pass / Sheet cells once a candidate
idle sheet exists.

## Result

**Training complete, no generation attempted on this card.** T-0237's whole deliverable is
the trained LoRA itself: `assets/final/lora/player_identity_v1.safetensors`, trained via
the shared WSL-native kohya sd-scripts stack (`assets/src/lora/src/lora_train/train.py`,
unchanged) against the curated 12-image `identity_refs/` dataset and
`training_config_player_identity_T0229.toml`, both already committed on `feature/T-0229`
and reused here rather than rewritten. Training ran foreground/blocking end to end,
2026-08-27 23:04 UTC -> 2026-08-28 01:14 UTC, 6/6 epochs, 72/72 steps, per-epoch
checkpoints confirmed writable (`save_every_n_epochs=1`). Full provenance:
`assets/final/lora/player_identity_v1.provenance.json`; narrative entry:
`ASSET_PROVENANCE.md`.

No idle sheet exists yet for Arm B -- generation is explicitly out of scope for this card
(see the card's Acceptance: "No generation is attempted on this card; the pose sheet
belongs to T-0229"), so Criterion 1 and Criterion 2 cannot be evaluated from this card's
own work and are recorded as `n/a` below, not guessed at or left blank.

## The table

| Arm | Criterion 1 (silhouette @ 40px in motion) | Criterion 2 (identity stable) | Attempts-to-first-pass | GPU minutes | Wall-clock | $ | Sheet | Provenance sidecar | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Arm B (§23-e), stage 1/2 (training) | n/a | n/a | n/a (0/8 -- no generation attempted this card) | 129.7 | 02:10 | $0.00 | n/a -- no sheet produced by this card, see T-0229 | `assets/final/lora/player_identity_v1.provenance.json` | Criterion 1/2/attempts-to-first-pass are `n/a` because this card trains only; T-0229 (depends on this card) performs generation and will complete those three cells and the Sheet cell once a candidate exists -- this is a two-stage split of one arm, not a result being withheld. **GPU minutes (129.7)** = training-run GPU-busy time exactly as recorded in `player_identity_v1.provenance.json`'s `gpu_seconds` field (7783.5s), cross-checked against the trained weights' own safetensors metadata (`ss_training_started_at` 1787871870.98 -> `ss_training_finished_at` 1787879638.60 = 7767.6s/129.5min, matching to within checkpoint-load/optimizer-setup overhead not captured by the training-loop-only metadata field). Excludes the SDXL base checkpoint's own one-time load (~7min, same exclusion basis as Arm A's environment-setup exclusion) and the shared kohya stack's one-time network build (~3min) -- both are amortised per-run environment cost, not per-arm training cost, same treatment as Arm A's excluded one-time ComfyUI/model startup. **Wall-clock (02:10)** = the training phase's own elapsed time, 2026-08-27 23:04 UTC start to 2026-08-28 01:14 UTC finish, run foreground/blocking as HANDOFF §23-e's rule (a) requires. **Curation time is explicitly excluded, not silently absent:** `curate_identity_panels_T0229.py` (the scripted curation pass that produced the 12-image `identity_refs/` set from T-0209's concept sheet) contains no timing instrumentation -- no wall-clock or GPU-time capture anywhere in the script or in `identity_curation_manifest_T0229.json` -- and it ran earlier, on `feature/T-0229`, before this card existed, with no timestamp recorded at the time. Per DL-21's cost-template rule ("no back-filled estimates -- a number nobody measured is recorded as `n/a` with a reason, not guessed"), that time is not reconstructed after the fact; this is the same treatment Arm A gave its own un-instrumented prompt-iteration time between attempts (`ARM_A_BAKEOFF_REPORT_T0228.md`'s Notes cell). Note that curation is CPU-only PIL cropping/mirroring/padding of an already-generated concept sheet image -- it has no GPU cost regardless, so this exclusion affects only the Wall-clock column, not GPU minutes. |

## Why this is a partial row, and why that is correct

`docs/decisions/T-0227-bakeoff-cost-record-template.md` defines one row per arm covering
both the verdict columns (Criterion 1/2, Attempts-to-first-pass) and the cost columns (GPU
minutes, Wall-clock, $). Arm B was pre-split into two cards after T-0229 failed five
consecutive runs trying to do both halves in one implementer phase (training alone costs
~127 minutes end to end -- see the card's own "Measured cost" table) -- so no single card
produces a complete row by itself anymore. Filling the verdict columns with a fabricated
`PASS`/`FAIL` or a guessed attempt count to make this look like a complete row would
misrepresent work that has not happened yet; recording them as `n/a` with the reason given
in Notes is the template's own prescribed handling for a column an arm genuinely cannot
fill ("recorded as `n/a` with a one-line reason ... never left blank and never replaced
with a different measure"). The cost columns this card *can* fill -- GPU minutes and
wall-clock for training, the half of Arm B's cost this card is actually responsible for --
are filled with directly measured numbers, and the row explicitly says what is deferred to
T-0229 and why, so §23-g does not have to go looking for the other half of this arm's cost.
