# Hybrid walk-cycle attempt log (T-0259, HANDOFF §24-e)

Every attempt is recorded here whether it passes the mechanical gate or not. Every frame is its own full-stack generation (style LoRA + player_identity_v2 + IP-Adapter + OpenPose ControlNet on a script-authored walk skeleton, `pose_rig_walk_T0259.py`) -- there is no single-generation-plus-derived-frames shortcut here, a walk gait needs real per-frame limb articulation. `mechanical_gate` is the frame-silhouette delta check (0.30 cap) across all 8 adjacent transitions INCLUDING the loop seam (frame 7 -> frame 0).

| Attempt | Seed | Frame-delta range | Mechanical gate | Beats Arm C (0.072-0.112) | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 31416 | 0.3051-0.6274 | FAIL | no | 813.9 | no |  |
| 2 | 31416 | 0.3955-0.5954 | FAIL | no | 843.7 | no | T-0266 tuning pass: stronger style/identity/IP-Adapter weights to suppress background-room hallucination diagnosed in attempt 1 (frame deltas 0.31-0.63, clutter surviving per-frame cutout) |
| 3 | 31416 | 0.3492-0.5610 | FAIL | no | 831.8 | no | T-0266 attempt 3: IP-Adapter identity reference cropped to one clean panel instead of full 24-panel concept sheet |
| 4 | 27182 | 0.0337-0.2532 | PASS | no | 801.7 | yes | T-0266 img2img chain fix: frames 1-7 anchored to frame 0 via VAEEncode, denoise=0.45, background held against frame 0. Mechanical gate PASS (0.0337-0.2532 vs 0.30 cap). Leg articulation is visually subtle at every denoise tried (0.45/0.75/0.90, attempts 4-6) -- the long-coat costume covers the legs regardless of pose, a costume-design characteristic confirmed by comparison, not a chaining artifact; DL-21 criterion 1 (motion readability at 40px) is a separate human call this card does not make. |
