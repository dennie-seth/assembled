# Hybrid source-frame attempt log (T-0252, HANDOFF §24-e, round 2)

Every attempt is recorded here whether it passes or not. There is exactly one SDXL generation per attempt -- this is the *only* diffusion-model call in the entire hybrid pipeline; the assembled sheet's frame-consistency is measured separately, downstream, in ARM_HYBRID_ATTEMPT_LOG_T0252.md once gen_hybrid_idle_T0252.py derives the other 8 frames from whichever attempt here is promoted.

| Attempt | Seed | ControlNet strength/end | Style LoRA weight | Identity LoRA weight | IP-Adapter weight | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 31416 | 1.0/1.0 | 0.7 | 0.5 | 0.6 | 3.0 | no | round-2 hybrid, first attempt |
| 2 | 31416 | 1.3/1.0 | 0.7 | 0.5 | 0.6 | 99.1 | no | controlnet strength raised to 1.3 per T-0249's working recipe |
| 3 | 31416 | 1.3/1.0 | 0.7 | 0.5 | 0.3 | 120.1 | no | lower ipadapter weight 0.6->0.3, keep T-0249 CN/LoRA recipe, to reduce concept-sheet composition bleed |
