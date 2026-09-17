# Forward-limb ControlNet img2img attempt log (T-0380)

Every attempt is recorded here whether promoted or not. Pose is supplied by an OpenPose ControlNet skeleton (`pose_rig_forward_limb_controlnet_T0380`, reused from the committed T-0351 `side_right_forward` rig), not the prompt -- see the generator module's own docstring for why (T-0355's prompt-only route was falsified). img2img from the T-0317 base, denoise/ControlNet strength tuned per attempt within this card's own 4-attempt cap.

| Attempt | Seed | Denoise | ControlNet strength/end | GPU seconds | Whole-frame green px | Centred-crop green px | Border max channel | Promoted | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 380001 | 0.78 | 1.4/1.0 | 48.1 | 48531 | 9992 | 4 | no | Strict profile, single arm, black background all correct, but denoise 0.78 was too low: the base image's own straight floor-length coat silhouette survived nearly unchanged and completely concealed the raised near leg -- no crop can show a leg pose that isn't drawn. Fixed in attempt 2 by raising denoise to 0.87 and adding an explicit coat-drape/swept-hem clause. See `docs/assets/evidence/T-0380/attempt_1_torso_leg_crop_no_leg_visible.png`. |
| 2 | 380002 | 0.87 | 1.5/1.0 | 51.1 | 70230 | 13180 | 4 | yes | Pass: strict profile, single visible arm + single goggle lens, faces right, black background (border max 4), raised near leg visible (boot lifted clear of the ground under a swept coat hem), hood/mask/gloves/boots all visible, coat past the knee. See docs/assets/evidence/T-0380/. |
