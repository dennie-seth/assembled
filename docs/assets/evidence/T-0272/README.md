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
  (T-0273 profile reference) weight 0.4. At the time of round 4's initial
  regeneration (attempts 17-24), the single cleanest, most unambiguous
  side-facing silhouette this card had produced (leaning head/hood, torso, no
  front-facing symmetry at all) -- and carries no costume colour whatsoever
  (pure black/white/grey). Passes the mechanical gate at 200 foreground px.
  Since superseded by attempt 25 below as the card's overall best facing
  result, but kept here as the round-4-proper baseline it was judged against.
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
- **`attempt_25_secondary_reference_side_lean.png`** -- the round-4
  defect-fix continuation's own secondary reference
  (`assets/src/concept/player_profile_style_reference_T0272.png`, a
  same-render-style crop derived from T-0209's concept sheet, weight 0.45),
  replicating attempt 24's other weights. The single most confidently
  side-facing result this card has produced across all 28 attempts -- a
  clean leaning silhouette, hood turned, one visible arm and leg, no
  front-facing symmetry at all -- but almost no costume colour (a faint
  multicolour rim-light glow only) and a very small surviving silhouette
  (101 fg px, ~4% of the cell). Passes the mechanical gate
  (`background_fraction=0.956`) but is not promotable on the card's own
  colour-legibility requirement.
- **`attempt_28_secondary_reference_colour_lean.png`** -- same derived
  secondary reference as attempt 25, weight dropped to a light 0.15 (the
  control for "is it the render style or the competing tactical costume
  design that fights the green"). At 384px this is the most promising-looking
  frame of the round-4 continuation -- a genuine olive-green coat silhouette
  with a plausible side lean -- but it fragments into scattered disconnected
  debris at the 48x48 cutout/quantize step; the mechanical gate passes on the
  raw pixel count (345 fg px) but the visual call the card requires is a
  clear fail.

Every image here is a raw 384x384 `main_384.png` (pre-cutout, pre-descent,
pre-quantization) -- none has been cropped, retouched, or otherwise altered
beyond the file copy itself. Full parameters (seed, every LoRA/ControlNet/
IP-Adapter weight, `comfyui_prompt_id`, `gpu_seconds`) for each attempt are
recorded in `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s round-4 table rows
(attempts 19, 21, 24, 25, 28) and provenance JSON (not committed here -- the
gitignored `assets/out/hybrid_profile/attempt_<N>/provenance_candidate.json`
per attempt).

`.gitignore` check (round-4 addendum): `git check-ignore -v` against every
path added to this directory, including the two frames above, returns
nothing -- none of them are caught by `**/assets/out/` or any other rule, so
no `.gitignore` change was needed to commit this evidence. The images were
missing from this directory only because they were never copied out of
gitignored `assets/out/` scratch, not because git refused to track them.
