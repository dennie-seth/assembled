# Forward-limb ControlNet img2img attempt log (T-0382)

Re-run of T-0380 attempt 2's recipe (seed 380002, denoise 0.87, ControlNet strength/end 1.5/1.0, attempt-2-era prompt) against the corrected (far-arm-collapsed) skeleton in `pose_rig_forward_limb_controlnet_T0380`. Hard cap of 3 attempts, pre-registered; see `docs/assets/evidence/T-0382/README.md` for the finding.

| Attempt | Seed | Denoise | ControlNet strength/end | GPU seconds | Whole-frame green px | Centred-crop green px | Border max channel | Skeleton sha256 | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 380002 | 0.87 | 1.5/1.0 | 87.1 | 80288 | 20434 | 45 | 13ce712c626657738881cd6f43cc681ecb0fb01e1e5a942181337af40d31ae10 | no | T-0382 attempt 1: T-0380 attempt 2's recipe verbatim, corrected far-arm-collapsed skeleton |
| 2 | 382002 | 0.87 | 1.5/1.0 | 114.1 | 431971 | 19157 | 22 | 13ce712c626657738881cd6f43cc681ecb0fb01e1e5a942181337af40d31ae10 | no | T-0382 attempt 2: same recipe as attempt 1, seed varied only (attempt 1 produced a back/three-quarter view, no visible lens, legs not raised, border max 45) |
