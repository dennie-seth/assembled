# Round-2 cost record — T-0248 (HANDOFF §24-a)

**Author:** Claude (Sonnet 5)
**Card:** T-0248 — round 2 of the T-0227 character-pipeline bake-off, opened by
@DennieSeth's override of DL-21's "lowest cost wins" step (see
`BAKEOFF_DECISION_T0231.md`). Trains `player_identity_v2` on a single canonical
costume and re-measures Arm B's generation against it, per HANDOFF §24-a's
Done-when. Per the round-2 override, **cost is recorded here, not deciding**.

## Result

Training: PASS (produced a valid, committed LoRA). Re-run against Arm B's
generation: **partial improvement, not a full fix** — see
`ASSET_PROVENANCE.md`'s "Re-run against Arm B, measured" entry for the full
per-attempt breakdown. Full detail on both is in `ASSET_PROVENANCE.md`; this
file exists only to carry the numbers into `BAKEOFF_COST_TABLE_T0231.md` per
its own "copied verbatim from the arm's own report" convention.

## The row

| Stage | Criterion 2 (identity stable) | Attempts | GPU minutes | Wall-clock | $ | Notes |
|---|---|---|---|---|---|---|
| Training (`player_identity_v2.safetensors`) | n/a (training, not a generation) | 1/1 (no failed/aborted attempts) | 103.4 | 01:44 (2026-08-29 18:29–20:13 UTC) | $0.00 | 2/2 epochs, 58/58 steps against the 29-view single-costume dataset. See `player_identity_v2.provenance.json`. |
| Acceptance-5 checkpoint/resume evidence (scratch run, not the deliverable) | n/a | 2/2 (both completed; proves the mechanism, not a pass/fail generation) | 9.3 | 00:12 | $0.00 | Two short invocations against a gitignored 2-image scratch config, proving `--save_state` + `find_resume_state`'s bare-last-state fix actually work end to end. See `CHECKPOINT_RESUME_EVIDENCE_T0248.md`. |
| Arm B re-run vs. `player_identity_v2` (diagnostic, not a new bake-off arm) | 1 of 3 attempts PASS (0.083–0.273); 2 of 3 FAIL (seed-sensitive, 0.068–0.401 / 0.068–0.318) | 1/3 | 5.2 | 00:06 | $0.00 | Same recipe as T-0229's promoted attempt 7, only the identity LoRA swapped, across 3 seeds (1 known-good, 2 that badly failed for v1). See `ARM_B_V2_ATTEMPT_LOG_T0248.md`. |
| **Card total** | — | — | **117.9** | **02:02** | **$0.00** | Sum of the three rows above. No exploratory search was needed for training (1/1); the generation re-run intentionally reused T-0229's already-tuned recipe rather than repeating v1's own blind search, so this attempt count is not directly comparable to v1's own 7/8 — see caveat in ASSET_PROVENANCE.md. |
