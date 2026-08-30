# Chained img2img attempt log (T-0250, HANDOFF §24-c, round 2)

Every attempt is recorded here whether it passes the mechanical gate or not, so attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the frame-silhouette delta check (DL-21 criterion 2's mechanical half) across all 8 adjacent-cell transitions of the assembled sheet. Runs against `player_identity_v2` (T-0248) -- §24-a's contribution, not masked -- and composes on top of §24-b's per-frame pose-authority generation (T-0249): frame 0 is generated exactly as §24-b would. Attempts 1-6 chained frames 1-8 img2img from their immediate predecessor; the 2026-08-30 human review found this let background speckle compound frame over frame until the figure dissolved into noise, so attempts 7-8 instead anchor every frame to frame 0's own output and hold the background out of the feedback path (see the module docstring and `chaining_method` in the provenance sidecar).

| Attempt | Seed | Denoise | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | Frame-delta range | GPU seconds | Mechanical gate | Beats Arm C (0.072-0.112) | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 31416 | 0.15 | 1.3/1.0 | 0.7 | 0.5 | 0.0507-0.3081 | 627.9 | FAIL | no | no | sweep point 1/5: below the ~0.25-0.35 band, expect motion to stop reading |
| 2 | 31416 | 0.25 | 1.3/1.0 | 0.7 | 0.5 | 0.0390-0.3481 | 621.9 | FAIL | no | no | sweep point 2/5: band low edge |
| 3 | 31416 | 0.3 | 1.3/1.0 | 0.7 | 0.5 | 0.0280-0.3664 | 624.9 | FAIL | no | no | sweep point 3/5: band midpoint |
| 4 | 31416 | 0.35 | 1.3/1.0 | 0.7 | 0.5 | 0.0271-0.3899 | 624.9 | FAIL | no | no | sweep point 4/5: band high edge |
| 5 | 31416 | 0.45 | 1.3/1.0 | 0.7 | 0.5 | 0.0262-0.4170 | 622.0 | FAIL | no | no | sweep point 5/5: above the band, drift-returns edge |
| 6 | 31420 | 0.15 | 1.3/1.0 | 0.7 | 0.5 | 0.0301-0.2134 | 622.0 | PASS | no | no | seed-sensitivity check at the best-performing denoise (0.15) from the seed-31416 sweep -- tests whether the (0,1)->(0,2) transition failure is seed-specific or inherent to chaining; clears the 0.30 cap, but 2026-08-30 human review rejected this sheet for unrecognizable identity and compounding background noise (clean background pixels decayed 1280->832 across the sheet) -- **no longer the promoted attempt** |
| 7 | 31420 | 0.15 | 1.3/1.0 | 0.7 | 0.5 | 0.0000-0.0299 | 667.8 | PASS | yes | no | human-review fix: anchor to frame 0 + background hold, re-run of aborted attempt 7 |
| 8 | 31420 | 0.3 | 1.3/1.0 | 0.7 | 0.5 | 0.0000-0.1763 (post-cutout; see note below) | 857.5 | PASS | no (post-cutout) | **yes** | human-review fix mechanism, band midpoint: attempt 7 at denoise=0.15 stalled (frame-delta 0.0-0.0299, visually static) -- last attempt under the 8-cap, testing whether motion reads at 0.30 with background held; clears the 0.30 cap and is the attempt promoted to `assets/final/character/player_idle_sheet_chained_T0250.png` |

**Note (2026-08-30 second human review, no new attempt spent):** the sheet
still shipped a visible background (dark ground, grey slab, scattered green
marks) after attempt 8's fix. `--reprocess-attempt 8` re-derived the sheet
from attempt 8's already-sampled per-frame images with a per-frame
background-cutout step added before assembly -- no new ComfyUI call, same
seed/denoise/GPU-seconds as the row above, the identity re-anchoring and
background-hold masking unchanged. Frame-delta on the cutout sheet is
**0.0000-0.1763** (up from 0.0000-0.0286 pre-cutout, since cutting the
static background out shrinks `check_frame_consistency`'s union denominator,
making the same tiny absolute variation read as a larger ratio): still
clears the 0.30 cap, now more clearly does **not** beat Arm C's 0.072-0.112
(the "Beats Arm C" cell above reflects the post-cutout, currently-promoted
measurement, not the pre-cutout 0.0000-0.0286 this row originally recorded).
`background_growth` is unaffected by the cutout (1.048x, well inside 1.35x).
See `ROUND2_CHAINED_REPORT_T0250.md`'s "Second human review" section for the
full account.
