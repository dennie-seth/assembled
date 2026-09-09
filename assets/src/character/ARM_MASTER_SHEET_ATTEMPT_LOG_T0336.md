# Tier-1 master-sheet attempt log (T-0336, docs/decision-log.md DL-30)

Every attempt is recorded here whether or not it is promoted. Tier-1 generates ONCE per entity at 1024px -- style LoRA + IP-Adapter on the approved concept sheet, explicitly no ControlNet. Budget is ~25-50 GPU-seconds; this is a small job, not a sweep, so the attempt cap stays at 5.

| Attempt | Entity | Seed | Style LoRA weight | Identity LoRA weight | IP-Adapter weight | Width | Height | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | player | 31416 | 0.7 | 0.5 | 0.5 | 1024 | 1024 | 81.3 | no | T-0336 attempt 1: baseline recipe, style 0.70 / identity 0.5 / ipadapter 0.5 |
| 2 | player | 8675309 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 3.1 | no | T-0336 attempt 2: exploded-parts-diagram framing, ipadapter 0.35 -- fixes attempt 1's coat-only/turnaround-only panel vocabulary, produces genuinely separated coat/leg/boot pieces |
| 2 | player | 8675309 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 3.1 | yes | promoted -- exploded-parts-diagram recipe, coherent, legs separable, coat/leg/boot pieces distinctly isolated |
| 3 | player | 20260909 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 27.1 | no | T-0336 attempt 3: fix headless mannequins + armour drift, explicit face + one-costume + anatomical rigging-sheet framing |
| 4 | player | 421337 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 27.1 | no | T-0336 attempt 4: drop rigging framing (caused robotic legs), explicit head-in-frame + human anatomy reference sheet |
| 5 | player | 314159265 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 30.1 | no | T-0336 attempt 5: crop IP-Adapter conditioning to clean green-coat block (0,0,615,615), hooded-mask-with-eye-lenses head framing, revert to round-2 exploded-parts-diagram limb framing |
| 5 | player | 314159265 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 30.1 | yes | T-0336 attempt 5 PROMOTED: cropped IP-Adapter conditioning fixes armour drift (consistent green costume in all 3 views), hooded-mask-with-eye-lenses head is legible (not blank void); script-composited row of 5 genuinely isolated crops (head, upper_arm, lower_arm_hand, torso_coat, lower_leg_boot) appended below -- upper_leg intentionally omitted, coat fully conceals the thigh in this attempt's 3 views (see evidence README), reported per this card's own escalation instruction rather than invented |
| 5 | player | 314159265 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 30.1 | yes | T-0336 attempt 5 re-promoted: provenance method field now documents the script-compositing step |
| 5 | player | 314159265 | 0.7 | 0.5 | 0.35 | 1024 | 1024 | 30.1 | yes | T-0336 attempt 5 re-promoted: clarified generation-step vs promotion-step method wording |
