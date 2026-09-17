# Green-costume side-profile reference attempt log (T-0317)

Every attempt is recorded here whether promoted or not. This generator carries neither ControlNet nor IP-Adapter (see the generator module's own docstring for why that is the whole point) -- plain txt2img + style LoRA only, same stack as T-0209's own concept sheet. `green_content` measures both the whole frame and a centred crop the same size as T-0272 round 5's own front-panel calibration crop (187x200), against that round's recorded 6,000-6,900 green-pixel band.

| Attempt | Seed | Style LoRA weight | GPU seconds | Whole-frame green px | Centred-crop green px | Promoted | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 31700 | 0.7 | 33.1 | 213421 | 21658 | no |  |
| 2 | 31700 | 0.7 | 24.1 | 4516 | 128 | no | revised prompt: closer to T-0209's own working phrasing, explicit no-background/no-scene, profile facing right, back/rear view added to negative |
| 3 | 31700 | 0.7 | 24.0 | n/a | 48547 | yes | promoted: middle panel of the 3-panel front/side/back turnaround sheet -- genuine strict side profile, vivid green cloth coat, hood, near-matches CANONICAL_COSTUME_SELECTION_T0248 (gloves render black here, not white) |
