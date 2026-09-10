# Tier-1 master-sheet attempt log (T-0336, docs/decision-log.md DL-30)

Every attempt is recorded here whether or not it is promoted. Tier-1 generates ONCE per entity at 1024px -- style LoRA + IP-Adapter on the approved concept sheet, explicitly no ControlNet. Budget is ~25-50 GPU-seconds; this is a small job, not a sweep, so the attempt cap stays at 5.

| Attempt | Entity | Seed | Style LoRA weight | Identity LoRA weight | IP-Adapter weight | Width | Height | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | player | 314159265 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 27.1 | no | T-0351 attempt 1: five-panel pose spec (front/back T-pose, side-left-forward, side-right-forward, side-neutral), mid-hip coat cap |
| 2 | player | 271828182 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 33.1 | no | T-0351 attempt 2: strengthened pose-reference-chart framing + mid-hip/bare-thigh reinforcement + card-specific negative prompt forbidding duplicate poses/accessory insets/long coat |
