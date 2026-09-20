# Tier-1 master-sheet attempt log (T-0336, docs/decision-log.md DL-30)

Every attempt is recorded here whether or not it is promoted. Tier-1 generates ONCE per entity at 1024px -- style LoRA + IP-Adapter on the approved concept sheet, explicitly no ControlNet. Budget is ~25-50 GPU-seconds; this is a small job, not a sweep, so the attempt cap stays at 5.

| Attempt | Entity | Seed | Style LoRA weight | Identity LoRA weight | IP-Adapter weight | Width | Height | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | player | 246813579 | 0.7 | 0.5 | 0.35 | 6144 | 1024 | 477.4 | no | T-0356 attempt 1: reuse T-0351 attempt-19 recipe unchanged for front_tpose/back_tpose/side_neutral/legs; side_left_forward/side_right_forward now condition on FORWARD_LIMB_REFERENCE_PATH instead of T-0317; legs panel negative prompt gets forward-limb coat-flap ban. |
