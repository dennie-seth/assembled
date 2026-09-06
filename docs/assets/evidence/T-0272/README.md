# T-0272 round 4 evidence

Round 3's decisive frames (attempts 13-15) were gitignored scratch under
`assets/out/` and were reaped when the card parked, so the best images that
investigation produced no longer exist anywhere reviewable. This directory
commits a small, representative set from round 4's regeneration instead, so
the evidence behind `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s round-4 findings
survives worktree cleanup and is visible in the PR diff itself. None of
these are a promoted deliverable -- no attempt this round satisfied
"genuinely side-facing AND costume-colour legible AND passing the mechanical
gate simultaneously," so `assets/final/character/` carries no T-0272 file.
See the attempt log's own "Round 4" section for the full analysis.

- **`pose_skeleton_384.png`** -- the profile-topology ControlNet input
  (`pose_rig_profile_T0272.py`), unchanged since round 1: legs collapsed to
  one fore-aft line, near-coincident shoulders/hips, one arm reaching
  forward, head turned. Identical across every attempt in this card; shown
  once here as the conditioning input every other image in this directory
  shares.
- **`attempt_19_front_facing_colour_baseline.png`** -- front IP-Adapter
  weight raised to 0.7 (secondary/profile-reference weight lowered to
  0.25). The only round-4 attempt with genuinely legible institutional-green
  costume colour, and the clearest demonstration of the round's trade-off:
  raising the front concept-sheet's conditioning strength enough to recover
  colour pulls the figure back to the same bilaterally-symmetric,
  front-facing failure mode rounds 1-2 already named -- despite the profile
  skeleton and pose LoRA both being active underneath it.
- **`attempt_21_best_profile_silhouette.png`** -- front weight 0.6, secondary
  (T-0273 profile reference) weight 0.4. The single cleanest, most
  unambiguous side-facing silhouette this card has produced across 21
  attempts (leaning head/hood, torso, no front-facing symmetry at all) --
  and carries no costume colour whatsoever (pure black/white/grey). Passes
  the mechanical gate at 200 foreground px.
- **`attempt_24_best_colour_and_pose_balance.png`** -- a bootstrap attempt:
  the secondary IP-Adapter reference is attempt 20's own output (pre-inverted
  so the pipeline's unconditional invert restores its original tone), not
  the T-0273 photograph. The best balance of side-facing pose and costume
  colour this round produced -- a visible olive-green chest patch and hem --
  but still muted/olive rather than the vivid saturated green the acceptance
  criterion requires, and still a small fraction of the frame (69 fg px).
  Demonstrates that bootstrapping the pose reference from the pipeline's own
  output does not manufacture colour beyond what was already present in its
  source.

Every image here is a raw 384x384 `main_384.png` (pre-cutout, pre-descent,
pre-quantization) -- none has been cropped, retouched, or otherwise altered
beyond the file copy itself. Full parameters (seed, every LoRA/ControlNet/
IP-Adapter weight, `comfyui_prompt_id`, `gpu_seconds`) for each attempt are
recorded in `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s round-4 table rows
(attempts 19, 21, 24) and provenance JSON (not committed here -- the
gitignored `assets/out/hybrid_profile/attempt_<N>/provenance_candidate.json`
per attempt).
