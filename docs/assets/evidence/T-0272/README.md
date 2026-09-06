# T-0272 evidence

Round 3's decisive frames (attempts 13-15) were gitignored scratch under
`assets/out/` and were reaped when the card parked, so the best images that
investigation produced no longer exist anywhere reviewable. This directory
commits a small, representative set from each subsequent generation round
instead, so the evidence behind `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s findings
survives worktree cleanup and is visible in the PR diff itself. Rounds 1-5
produced no promotable frame -- no attempt satisfied "genuinely side-facing
AND costume-colour legible AND passing the mechanical gate simultaneously"
with a correct cutout. **T-0315 (below) fixes the cutout defect round 5
isolated and promotes attempt 28 through it** -- see the attempt log's own
"Round 4", "Round 5", and "T-0315" sections for the full analysis.

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
- **`attempt_33_vivid_green_wrong_facing.png`** -- round 5 Lever 2, a fresh
  seed (84512, untried before this round) on attempt 21's clean recipe. The
  first attempt across all 36 to produce genuinely vivid, saturated
  institutional green (a bright green torso/chest region, unlike every prior
  attempt's muted olive or absent colour) -- but the figure reads as
  bilaterally symmetric with two visible legs carrying a geometric,
  circuit-board-like dot pattern, not the coat's actual silhouette or a
  profile stance. Colour and correct facing still do not co-occur here.
- **`attempt_35_outline_negation_worse.png`** -- round 5 Lever 2, attempt
  24's recipe plus a green-emphasis prompt whose negative also names "heavy
  black outline, thick black border, neon rim light, glowing outline,
  vignette" -- an attempt to suppress the hard-outlined/rim-glow rendering
  collapse seen whenever colour signal increases. It made the collapse more
  pronounced instead: a flat, hard-black-outlined abstraction with a
  multicolour (red/blue/yellow) glowing rim, the largest and least legible
  frame of the round (432 fg px of colour blocks, not a coat).
- **`attempt_36_lower_controlnet_cleanest_colour_lean.png`** -- round 5
  Lever 2, final attempt of the round: attempt 21's clean-recipe secondary
  with the same outline-negating emphasis prompt as attempt 35, but
  ControlNet strength lowered to 0.85 (never tried below 1.0 in 35 prior
  attempts). The clearest single-lean silhouette with the least rim-glow of
  any colour-bearing round-5 attempt, but the surviving costume colour is
  still a small yellow-green patch (78 fg px total), not a coat-wide vivid
  green.

Every attempt-numbered image above is a raw 384x384 `main_384.png`
(pre-cutout, pre-descent, pre-quantization) -- none has been cropped,
retouched, or otherwise altered beyond the file copy itself. Full
parameters (seed, every LoRA/ControlNet/IP-Adapter weight,
`comfyui_prompt_id`, `gpu_seconds`) for each attempt are recorded in
`ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s round-4 table rows (attempts 19, 21,
24, 25, 28) and round-5 table rows (attempts 33, 35, 36) and provenance
JSON (not committed here -- the gitignored
`assets/out/hybrid_profile/attempt_<N>/provenance_candidate.json` per
attempt).

**T-0315 cutout-fix before/after, round 1 (see `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s
own "T-0315 step 3" section for the full write-up -- corrected below by
round 2, kept here rather than deleted so the regression is visible, not
erased):**

- **`attempt_28_cutout_mask_before_fix_384.png`** -- `border_flood_
  background_mask`'s foreground (green), pre-T-0315, over
  `attempt_28_secondary_reference_colour_lean.png` above: a mostly-solid
  24,300px fill that nonetheless comes apart into several
  background-separated islands once descended (round 5's own diagnosis).
- **`attempt_28_cutout_mask_after_fix_384.png`** -- round 1's fix (classify
  by absolute distance to *every distinct* border colour, no clustering):
  5,184px. **Correction (round 2, below): this is not the "clean, coherent,
  correctly-traced outline" round 1's own log entry described** -- it is a
  fragmented, hole-riddled mask. Round 1's reviewer FAIL isolated why: this
  raw, un-quantized 384px render has 511 distinct border colours (the
  figure's own black outline genuinely touches the frame edge in several
  places), and using every one of them as an independent classification
  anchor reproduces the exact hop-to-hop bridging defect T-0315 exists to
  close, just relocated from spatial adjacency to the border's own sample
  list.
- **`attempt_28_cutout_result_after_fix_48_zoomed.png`** -- round 1's mask,
  descended to 48x48 (10x zoomed, nearest-neighbour): scattered specks and
  slivers, 55px total -- *below* the pre-T-0315 original algorithm's 351px
  on this same frame through the same pipeline, not an improvement on it.
  Round 1's own log entry attributed this to a second, independent blocker
  ("this frame's silhouette is too thin at 384px to survive
  `downscale_mask`'s descent regardless of mask correctness") -- **round 2
  found that diagnosis unsound**: the identical descent on the identical
  frame yields 351px from the pre-T-0315 mask, so the descent was never the
  blocker. The mask was.

**T-0315 round 2 (this fix): minimum-separated border-colour clustering,
and the promoted result.** `border_flood_background_mask` now reduces the
border's distinct colours to a small set of representatives, each at least
`BORDER_COLOR_MIN_SEPARATION` (2.5x the classification tolerance) from
every other -- greedy, most-frequent-colour-first -- so two representatives
can never have overlapping matching balls, closing the round-1 regression
without reintroducing the original hop-to-hop chain. A frame whose border
spread exceeds the tolerance (this one: 33x) now also raises a `UserWarning`
-- a loud, observable signal that the frame's own border isn't a single
clean colour, rather than a silent guess in either direction.

- **`attempt_28_cutout_mask_round2_384.png`** -- the fixed mask (green) over
  the same frame: 36,392px, a solid, legible hooded-coat-with-strap
  silhouette -- both the round-1 regression (511-colour over-sweep) and the
  original outline-leak defect (hop-to-hop bridging) are closed.
- **`attempt_28_cutout_result_round2_48_zoomed.png`** -- the actual promoted
  `player_profile_keyframe_hybrid_T0272.png`, palette-quantized and
  descended to 48x48 (10x zoomed, nearest-neighbour): 557px raw before
  orphan-speck cleanup, **529px in the actually-committed PNG** (this
  caption originally said "557px" for the file itself -- round 3's reviewer
  correctly flagged that as a disagreement with the provenance sidecar,
  which always recorded the true post-cleanup 529px). 4 connected
  components, mechanical gate PASS (`background_fraction` 0.770). Legible
  at 48px as a hooded coat with a strap -- matching attempt 28's own logged
  description ("an olive coat body with a hood and a visible strap") well
  enough to promote, per this card's own instruction.

**T-0315 round 3: round 2's own reviewer FAIL, closed.** Round 2's fix chose
representatives by a minimum SEPARATION (>= 2.5x tolerance apart), which
guarantees the accepted set is spread out but not that every rejected colour
ends up within classification range of one of them. Measured on this exact
frame: 222 of 511 sampled border colours (259 of 1,532 actual border pixels)
sat strictly between 1x and 2.5x tolerance from every accepted
representative -- too close to survive the separation floor as their own
representative, but too far to classify as background under any survivor.
Round 2's own promoted PNG has exactly this defect: its 529 opaque pixels
split into 4 components, and the second-largest (129px, 24.4% of the
foreground) is a background-coloured region that the round-1-fix's
tolerance-chained predecessor correctly swept but round 2's own algorithm
failed to connect back to the border-seeded flood.

`border_flood_background_mask` now reduces the border's distinct colours to
representatives chosen by GREEDY SET COVER over border pixel MASS (not
distinct-colour count, and not a fixed separation floor): repeatedly take
the most-frequent still-uncovered colour, mark every colour (and the
pixels it accounts for) within tolerance of it as covered, and stop once
`BORDER_COLOR_COVERAGE_TARGET` (95%, not literal 100%) of the frame's own
border pixels are covered. Literal 100% coverage was tried first and
measured, on this exact frame, to be actively worse: this frame's figure
legitimately touches the frame border along most of one edge with a wide,
gradual anti-aliased blend (border spread 33x tolerance), and chasing every
last, most-blended border sample into coverage produces representatives
close enough in Oklab space to the coat's own pale hood/shoulder fill to
sweep it into background -- reproducing this module's original hop-to-hop
leak defect via absolute distance instead of connectivity (measured: 48px
foreground collapsed to 117px, *below* even the pre-T-0315 351px baseline,
with the hood visibly swept). Targeting a strong pixel-mass majority instead
closes round 2's actual regression -- the frame's dominant true-background
tone is always covered within the first handful of representatives, since
coverage proceeds most-frequent-colour-first -- without chasing the rarest,
most-blended samples that caused the sweep.

- **`attempt_28_cutout_mask_round3_384.png`** -- the round-3 mask (green
  tint over the original frame, background dimmed to grayscale) over the
  same frame: 31,108px foreground, a solid, coherent hooded-coat-with-strap
  silhouette. Directly comparable to `attempt_28_cutout_mask_round2_384.png`
  above (36,392px) -- round 3 correctly reclassifies some of round 2's
  erroneous foreground as background (the true border pixel classification
  rate rises from an unmeasured, gapped rate under round 2's algorithm to a
  measured 95.2% under round 3's, verified by
  `test_border_coverage_meets_its_own_target_on_the_real_diagnostic_frame`).
- **`attempt_28_cutout_result_round3_48_zoomed.png`** -- the actual promoted
  `player_profile_keyframe_hybrid_T0272.png` (this round's replacement),
  palette-quantized and descended to 48x48 (10x zoomed, composited over a
  mid-grey backdrop for visibility -- the true file is a transparent RGBA
  cutout): 452px, 6 connected components, mechanical gate PASS
  (`background_fraction` 0.804). The two largest secondary components
  (124px and 71px) were checked directly against the raw frame's own pixel
  colours -- `test_no_surviving_raw_component_is_background_coloured` --
  and are the coat's own back-edge trim (a black outline with the render's
  own neon rim-glow, a white accent shape, and a row of blue rivet-like
  dots), not background clutter; round 2's specific 129px background-
  coloured component does not reproduce. Legible at 40px as a leaning,
  hooded, olive-drab coat with a visible strap, matching attempt 28's own
  logged description closely enough to promote.

**Promoted:** `assets/final/character/player_profile_keyframe_hybrid_T0272.png`
+ `.provenance.json`, from this card (round 3's re-cut supersedes round 2's).
The 384px source is attempt 28's own frame (the already-committed,
sha256-verified evidence copy above, re-cut with the fixed mask) -- a fresh
same-seed regeneration attempted first (T-0315 step 3) did not reproduce it
bit-exactly and was discarded, per this card's own instruction not to
substitute a different attempt.

`.gitignore` check (re-run for round 3): `git check-ignore -v` against the
two new round-3 paths above returns nothing for either; neither is caught by
`**/assets/out/` or any other rule, so no `.gitignore` change was needed to
commit this evidence either.
