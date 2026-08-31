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
| 5 | 27182 | 0.3283-0.4732 | FAIL | no | 819.9 | no | T-0259 improvement pass: frame-0 contact pose fix + wider stride/knee/arm amplitudes + leg cross, front-facing (profile probed and reported as its own finding) |
| 6 | 27182 | 0.2119-0.3752 | FAIL | no | 801.8 | no | T-0259 improvement pass, calibrated: STRIDE 0.22/KNEE 0.13/ARM 0.15/CROSS 0.05, frame-0 contact fix, front-facing |
| 7 | 27182 | 0.1607-0.3398 | FAIL | no | 807.9 | no | T-0259 calibration: same amplitudes as attempt 6 (STRIDE 0.22/KNEE 0.13/ARM 0.15/CROSS 0.05), denoise lowered 0.45->0.30 to test whether tighter anchor conformity reduces the independent-chain noise floor observed in attempts 5-6 |
| 8 | 27182 | 0.1086-0.3020 | FAIL | no | 799.1 | no | T-0259 final DL-21 calibration: STRIDE 0.22/KNEE 0.13/ARM 0.15/CROSS 0.02, denoise 0.45->0.24, targeting the 3 remaining recoil->passing pairs that failed at denoise 0.30 |

## 2026-08-31 improvement pass -- DL-21 budget exhausted, one pair short (summary)

Four real generation attempts this session (5-8, all seed 27182, all real ComfyUI runs against
172.18.192.1:8188, ~800 GPU-seconds each), on top of the four already spent promoting the
sheet currently committed (1-4). `check_attempt_cap` refuses a 9th attempt (`attempt cap is 8
per round (DL-21)`) and DL-21's own precedent (`docs/decision-log.md` DL-22, Arm A) treats an
exhausted cap without a passing sheet as closed, not silently extended -- so attempt 8 is the
last one this card can run without a human/board decision to grant more budget.

**Calibration trail, all real generation, no synthetic shortcuts:**

| Attempt | STRIDE / KNEE / ARM / CROSS | Denoise | Frame-delta range | Pairs over 0.30 |
|---|---|---|---|---|
| 4 (pre-existing) | 0.145 / 0.085 / 0.09 / (none) | 0.45 | 0.034-0.253 | 0/8 (motion barely visible) |
| 5 | 0.30 / 0.18 / 0.20 / 0.14 | 0.45 | 0.328-0.473 | 8/8 |
| 6 | 0.22 / 0.13 / 0.15 / 0.05 | 0.45 | 0.212-0.375 | 6/8 |
| 7 | 0.22 / 0.13 / 0.15 / 0.05 | 0.30 | 0.161-0.340 | 3/8 |
| 8 | 0.22 / 0.13 / 0.15 / 0.02 | 0.24 | **0.109-0.302** | **1/8** |

Attempt 8 is a single pair, frame 1 -> frame 2 (the right-recoil-into-left-passing
transition), at **0.30198 against the 0.30 cap -- 0.00198 over**. Every other pair,
including the loop seam (0.183) and the previously-worst pairs, is comfortably under. This is
not a repeat of the original hitch (that was a 5.31x seam/interior ratio; attempt 8's spread is
2.8x max/min, and the seam itself is nowhere near the worst pair) -- it is the last residue of
the amplitude-vs-delta tradeoff this whole calibration trail has been narrowing.

**Reassembly-only check (no new GPU generation, cached attempt-8 frames):** raising the
post-quantization orphan-cleanup `size_threshold` from 4 to 8 (a legitimate noise-cleanup knob,
not a new generation) was tried to see if it removed edge-speckle noise contributing to the
delta -- it made the failing pair marginally *worse* (0.306), not better, so it was reverted;
this failure mode is genuine silhouette (limb-shape) difference between two independently
img2img-chained frames, not a cleanup artifact, and there is no free post-processing lever left
that isn't a new generation.

**Not promoted.** `promote_attempt` correctly refuses (`mechanical_gate_passed: false`) --
attempt 8's sheet is not committed to `assets/final/character/`, per this card's NO SYNTHETIC
ASSETS rule and the conduct.md rule against shipping a sheet that fails its own gate.

**Recommendation if more budget is granted:** the trend across attempts 6-7-8 (denoise
0.45 -> 0.30 -> 0.24 monotonically closing the gap, most recently by 0.038) strongly suggests
one more notch (denoise ~0.20, or KNEE_LIFT_NORM trimmed by another ~10%) closes the remaining
0.002 -- this is a converging calibration, not a stuck one. A 9th attempt at denoise 0.20 with
the same amplitudes is the concrete next step.
