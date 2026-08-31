# Hybrid walk-cycle attempt log (T-0259, HANDOFF §24-e)

Every attempt is recorded here whether it passes the mechanical gate or not. Every frame is its own full-stack generation (style LoRA + player_identity_v2 + IP-Adapter + OpenPose ControlNet on a script-authored walk skeleton, `pose_rig_walk_T0259.py`) -- there is no single-generation-plus-derived-frames shortcut here, a walk gait needs real per-frame limb articulation. `mechanical_gate` is the frame-silhouette delta check (0.30 cap) across all 8 adjacent transitions INCLUDING the loop seam (frame 7 -> frame 0).

| Attempt | Seed | Frame-delta range | Mechanical gate | Beats Arm C (0.072-0.112) | GPU seconds | Promoted | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 31416 | 0.3051-0.6274 | FAIL | no | 813.9 | no |  |
| 2 | 31416 | 0.3955-0.5954 | FAIL | no | 843.7 | no | T-0266 tuning pass: stronger style/identity/IP-Adapter weights to suppress background-room hallucination diagnosed in attempt 1 (frame deltas 0.31-0.63, clutter surviving per-frame cutout) |
| 3 | 31416 | 0.3492-0.5610 | FAIL | no | 831.8 | no | T-0266 attempt 3: IP-Adapter identity reference cropped to one clean panel instead of full 24-panel concept sheet |
| 4 | 27182 | 0.0337-0.2532 | PASS | no | 801.7 | yes | T-0266 img2img chain fix: frames 1-7 anchored to frame 0 via VAEEncode, denoise=0.45, background held against frame 0. Mechanical gate PASS (0.0337-0.2532 vs 0.30 cap). Leg articulation is visually subtle at every denoise tried (0.45/0.75/0.90, attempts 4-6) -- the long-coat costume covers the legs regardless of pose, a costume-design characteristic confirmed by comparison, not a chaining artifact; DL-21 criterion 1 (motion readability at 40px) is a separate human call this card does not make. |

## 2026-08-31 improvement pass -- profile-view finding (not a numbered attempt)

Before spending a numbered attempt on it, ran a single-frame feasibility probe (frame 0's
skeleton, ~100 GPU-seconds, seed 99001, `assets/out/profile_probe_T0259/` -- gitignored scratch,
not promoted) with the prompt changed to request "true side profile view, character facing
right, walking to the right, orthographic side view" and a matching negative
("front view, facing camera, facing viewer, three-quarter view"), everything else identical to
the standard §24-e stack (same front-facing OpenPose-topology skeleton, same IP-Adapter/identity
LoRA/style LoRA weights).

**Result: the model ignored the profile framing entirely and rendered a front-facing figure**,
visually indistinguishable in camera angle from every other frame this card has produced. The
ControlNet skeleton is drawn from `_POSE_KEYPOINTS_NORM`'s front-facing anatomical topology
(shoulders side-by-side, both hips/knees/ankles visible, arms symmetric about the spine) --
ControlNet's structural conditioning dominates the text prompt's camera-angle request, so a
prompt-only attempt to reframe the SAME skeleton into profile cannot work by construction, not
just by bad luck on this seed.

**Finding for the card: a genuine side-profile walk needs (1) a profile-topology pose skeleton**
(legs on a single fore-aft line rather than side-by-side, one arm forward/one back, head turned
sideways -- a different keypoint layout, not a reframed version of this rig) **and (2) very
likely a profile identity keyframe**, since `player_identity_v2` and every committed reference
(`player_idle_sheet_hybrid_T0252.png`, the T-0209 concept sheet) are front-facing only -- there is
no evidence the identity LoRA generalises to a profile silhouette without one. Both are
substantial scope (a new pose-rig topology module plus a new generation-and-approval cycle for a
profile keyframe), matching this card's own stated risk that profile "most likely needs a profile
identity keyframe generated first, rather than reskinning the front view." Per this card's
acceptance criteria, this is reported as a finding rather than forced or faked (no squash/shear/
mirror of the front view was attempted) -- the profile view is out of scope for T-0259 and should
be its own card if wanted, seeded by this finding.
