# Chained img2img attempt log (T-0250, HANDOFF §24-c, round 2)

Every attempt is recorded here whether it passes the mechanical gate or not, so attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the frame-silhouette delta check (DL-21 criterion 2's mechanical half) across all 8 adjacent-cell transitions of the assembled sheet. Runs against `player_identity_v2` (T-0248) -- §24-a's contribution, not masked -- and composes on top of §24-b's per-frame pose-authority generation (T-0249): frame 0 is generated exactly as §24-b would, frames 1-8 are img2img-chained from their predecessor.

| Attempt | Seed | Denoise | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | Frame-delta range | GPU seconds | Mechanical gate | Beats Arm C (0.072-0.112) | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 31416 | 0.15 | 1.3/1.0 | 0.7 | 0.5 | 0.0507-0.3081 | 627.9 | FAIL | no | no | sweep point 1/5: below the ~0.25-0.35 band, expect motion to stop reading |
| 2 | 31416 | 0.25 | 1.3/1.0 | 0.7 | 0.5 | 0.0390-0.3481 | 621.9 | FAIL | no | no | sweep point 2/5: band low edge |
| 3 | 31416 | 0.3 | 1.3/1.0 | 0.7 | 0.5 | 0.0280-0.3664 | 624.9 | FAIL | no | no | sweep point 3/5: band midpoint |
| 4 | 31416 | 0.35 | 1.3/1.0 | 0.7 | 0.5 | 0.0271-0.3899 | 624.9 | FAIL | no | no | sweep point 4/5: band high edge |
| 5 | 31416 | 0.45 | 1.3/1.0 | 0.7 | 0.5 | 0.0262-0.4170 | 622.0 | FAIL | no | no | sweep point 5/5: above the band, drift-returns edge |
| 6 | 31420 | 0.15 | 1.3/1.0 | 0.7 | 0.5 | 0.0301-0.2134 | 622.0 | PASS | no | **yes** | seed-sensitivity check at the best-performing denoise (0.15) from the seed-31416 sweep -- tests whether the (0,1)->(0,2) transition failure is seed-specific or inherent to chaining; clears the 0.30 cap and is the attempt promoted to `assets/final/character/player_idle_sheet_chained_T0250.png` |
