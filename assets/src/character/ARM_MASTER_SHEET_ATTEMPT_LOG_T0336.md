# Tier-1 master-sheet attempt log (T-0336, docs/decision-log.md DL-30)

Every attempt is recorded here whether or not it is promoted. Tier-1 generates ONCE per entity at 1024px -- style LoRA + IP-Adapter on the approved concept sheet, explicitly no ControlNet. Budget is ~25-50 GPU-seconds; this is a small job, not a sweep, so the attempt cap stays at 5.

| Attempt | Entity | Seed | Style LoRA weight | Identity LoRA weight | IP-Adapter weight | Width | Height | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | player | 31416 | 0.7 | 0.5 | 0.5 | 1024 | 1024 | 81.3 | no | T-0336 attempt 1: baseline recipe, style 0.70 / identity 0.5 / ipadapter 0.5 |
| 2 | player | 8675309 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 3.1 | no | T-0336 attempt 2: exploded-parts-diagram framing, ipadapter 0.35 -- fixes attempt 1's coat-only/turnaround-only panel vocabulary, produces genuinely separated coat/leg/boot pieces |
| 2 | player | 8675309 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 3.1 | yes | promoted -- exploded-parts-diagram recipe, coherent, legs separable, coat/leg/boot pieces distinctly isolated |
