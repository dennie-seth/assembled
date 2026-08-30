# Hybrid assembly attempt log (T-0252, HANDOFF §24-e, round 2)

Every attempt is recorded here whether it passes the mechanical gate or not. Assembly is a deterministic, zero-GPU-cost script run against the one promoted SDXL source frame (see ARM_HYBRID_SOURCE_ATTEMPT_LOG_T0252.md for that frame's own attempt history) -- `mechanical_gate` is the frame-silhouette delta check (DL-21 criterion 2's mechanical half); the human silhouette-read and drift verdict are judged separately against the promoted sheet's judging preview.

| Attempt | Seed | Frame-delta range | Mechanical gate | Beats Arm C (0.072-0.112) | Promoted | Notes |
|---|---|---|---|---|---|---|
| 1 | 31416 | 0.0660-0.0667 | FAIL | yes | no |  |
| 2 | 31416 | 0.0660-0.0701 | PASS | yes | no |  |
| 2 | 31416 | 0.0660-0.0701 | PASS | yes | yes |  |
