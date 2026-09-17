# Arm B round-2 diagnostic attempt log (T-0248, HANDOFF §24-a Done-when)

Re-runs T-0229's exact Arm B generation recipe against `player_identity_v2` instead of `player_identity_v1`, to measure whether the single-costume identity LoRA changes the adjacent-frame drift picture under the unchanged DL-21 criteria. Not a new bake-off arm -- no attempt here is promoted to `assets/final/character/`.

| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | GPU seconds | Mechanical gate | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 31416 | 1.3/1.0 | 0.7 | 0.5 | 114.2 | PASS | reproduces T-0229 attempt 7's winning recipe (seed 31416, CN 1.3/1.0, style 0.7, identity 0.5), only the identity LoRA file swapped to player_identity_v2 -- isolates the dataset-change variable |
| 2 | 31417 | 1.3/1.0 | 0.7 | 0.5 | 96.1 | FAIL | same recipe as attempt 1, seed 31417 -- this seed badly failed for v1 (ratios 0.31-0.41, ARM_B_ATTEMPT_LOG_T0229 attempt 3): tests whether v2 fixes seed-sensitivity, not just the seed-31416 case |
| 3 | 31420 | 1.3/1.0 | 0.7 | 0.5 | 99.1 | FAIL | same recipe as attempt 1, seed 31420 -- this seed badly failed for v1 (ratios 0.42-0.63, ARM_B_ATTEMPT_LOG_T0229 attempt 5): further test of seed-sensitivity |
