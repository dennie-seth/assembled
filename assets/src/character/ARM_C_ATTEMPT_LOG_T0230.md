# Arm C attempt log (T-0230, HANDOFF §23-f, DL-21)

Every attempt is recorded here whether it passes the mechanical gate or not, so attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the frame-silhouette delta check (DL-21 criterion 2's mechanical half); the human silhouette-read (criterion 1) and human drift verdict (criterion 2's other half) are judged later, in §23-g, against the promoted sheet. `determinism` re-renders the same seed a second time and compares bytes -- this arm's own defining claim.

| Attempt | Seed | Mechanical gate | Determinism | Promoted | Notes |
|---|---|---|---|---|---|
| 1 | 23230 | PASS | PASS | yes |  |
