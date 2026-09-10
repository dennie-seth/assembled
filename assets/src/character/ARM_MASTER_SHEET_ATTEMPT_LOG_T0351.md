# Tier-1 master-sheet attempt log (T-0336, docs/decision-log.md DL-30)

Every attempt is recorded here whether or not it is promoted. Tier-1 generates ONCE per entity at 1024px -- style LoRA + IP-Adapter on the approved concept sheet, explicitly no ControlNet. Budget is ~25-50 GPU-seconds; this is a small job, not a sweep, so the attempt cap stays at 5.

| Attempt | Entity | Seed | Style LoRA weight | Identity LoRA weight | IP-Adapter weight | Width | Height | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | player | 314159265 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 27.1 | no | T-0351 attempt 1: five-panel pose spec (front/back T-pose, side-left-forward, side-right-forward, side-neutral), mid-hip coat cap |
| 2 | player | 271828182 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 33.1 | no | T-0351 attempt 2: strengthened pose-reference-chart framing + mid-hip/bare-thigh reinforcement + card-specific negative prompt forbidding duplicate poses/accessory insets/long coat |
| 3 | player | 161803398 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 27.1 | no | T-0351 attempt 3: pose-first restructure + CLIP emphasis syntax on panel/pose and mid-hip clauses, negative prompt extended to forbid six-figure grid layout |
| 4 | player | 141421356 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 30.1 | no | T-0351 attempt 4: pose-clause emphasis raised 1.3->1.5, head/footwear wording folded into emphasised clauses, negative prompt extended against heels/split-leg-row |
| 5 | player | 173205080 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 27.1 | no | T-0351 attempt 5 (final, 5-attempt cap): pose emphasis dialed back to 1.3, shortened keyword-only pose clauses, costume repeated unweighted to fight attempt-4 drift |
| 6 | player | 223606797 | 0.7 | 0.5 | 0.35 | 5120 | 1024 | 174.2 | no | T-0351 attempt 6: lever 2, five separate single-pose generations composited by script |
| 7 | player | 244948974 | 0.7 | 0.5 | 0.35 | 5120 | 1024 | 231.3 | no | T-0351 attempt 7: lever 2 + CLIP-emphasized isolation/pose clauses, dropped positive-prompt text negation, negative prompt bans reference-sheet composition |
| 11 | player | 356237921 | 0.7 | 0.5 | 0.35 | 5120 | 1024 | 444.7 | no | T-0351 attempt 11: real execution of attempt-10 prompt rebalance (coat-length weight isolated 1.3->1.5) |
