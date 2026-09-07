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

**T-0315 round 4: round 3's own reviewer FAIL, closed -- and a second,
independent, mask-unrelated blocker found.** Round 3's reviewer traced its
retained background components (124px and 71px, wrongly attributed above to
"the coat's own back-edge trim") back through the pipeline and found the
opposite of what round 3's own log claimed: they are 62-63% flat grey-blue
background, not coat trim. Tracing the defect one layer further --
`extract_foreground_mask`'s component-selection logic, not
`border_flood_background_mask`'s colour classification that rounds 2 and 3
both kept re-tuning -- finds the real root cause: a plain "any overlap
counts" rule kept a large, genuinely disjoint background-panel component
(8,427 of 384x384px raw foreground pixels) in full because a mere 698px
sliver of it (8.3%) grazed the keypoints hint. `border_flood_background_mask`
itself was already correctly classifying these blobs as non-background in
rounds 2 and 3 alike; the bug was one layer up, in which components
`extract_foreground_mask` chose to keep. The fix: a component must have a
**majority** (>=50%) of its own area inside the hint to be kept on overlap
grounds, not merely `> 0` (`MIN_HINT_OVERLAP_FRACTION`, `char_gen/cutout.py`).

- **`attempt_28_cutout_mask_round4_before_384.png`** -- round 3's own
  selection rule (any overlap counts), reproduced directly and visualized the
  same way as every mask image above (green tint over the original frame,
  background dimmed to grayscale): 31,108px foreground. The diffuse green
  margin running down both sides of the coat, well outside its own
  silhouette, is the defect -- background connected to the hint by only a
  sliver, kept in full.
- **`attempt_28_cutout_mask_round4_after_384.png`** -- the majority-overlap
  fix, same frame, same visualization: 17,144px foreground, cleanly confined
  to the actual figure. The flanking margins are grayscale background again,
  with no diffuse green fringe.
- **`attempt_28_cutout_result_round4_48_zoomed.png`** -- the fixed cutout,
  palette-quantized and descended to 48x48 (8x zoomed, composited over a
  near-black backdrop): 248px, 3 connected components, 98.8% in the single
  largest one (245px) -- character-only, verified both by component-overlap
  math and by direct visual inspection (no floating background bar, unlike
  rounds 2 and 3's promotions). Mechanical gate PASS (`background_fraction`
  0.892). This *is* fewer total pixels than round 3's 452px -- round 3's own
  extra pixels were exactly the retained background this round removes, not
  recovered character detail (`test_raw_unquantized_render_is_character_only_not_merely_more_pixels`,
  which replaces the old, reviewer-flagged ">= 351px" monotone bound with
  this majority-share assertion).
- **`attempt_28_palette_index_histogram_round4.png`** -- the second, wholly
  independent finding this round surfaces once the mask is finally correct:
  of the fixed cutout's 248 foreground pixels, only 24 (10%) quantize to the
  home palette's own "green family" slots (indices 2, 3, 5, 7, 9, 11, per
  `home_palette.json`'s own `_note`); the other 224 (90%) quantize to the
  neutral ramp (8, 10, 12, 13, 14). This is not a mask defect -- it is
  measured directly on the *un-quantized* raw render too (the coat's own
  main body fill samples closer to the neutral end of Oklab space than to
  any green-family swatch) -- and it is not something a cutout-classification
  fix can move. Composited over a dark backdrop for a fair read (transparency
  against plain white washes out perceived saturation), the promoted
  candidate reads as a grey-taupe silhouette with a few dark-olive flecks
  near the collar, not "coat-wide olive colour" -- independently corroborating
  round 3's own reviewer finding on this exact point, which this round's mask
  fix does not and cannot change.

**Not promoted.** `player_profile_keyframe_hybrid_T0272.png` and its
provenance sidecar (both added by round 2, replaced by round 3) have been
removed from `assets/final/character/` rather than replaced a third time.
The mask defect that blocked rounds 2 and 3 is genuinely fixed and verified
above; attempt 28 still cannot be promoted, for a second, independent, and
unfixable-by-this-card reason -- its own recovered frame does not read as a
legible olive-green coat at 40px, per the measurement above. This matches
the card's own instruction: "If the fixed cutout still cannot rescue
attempt 28, say so with the before/after masks as evidence and stop." Doing
so returns `player_profile_keyframe_hybrid_T0272.png` to the state it was in
before T-0315 began (absent -- T-0272's own gate test never went green in
that card's original 8 attempts either); this is not a new regression, it is
this card's honest conclusion.

`.gitignore` check (re-run for round 4): `git check-ignore -v` against the
four new round-4 paths above returns nothing for any of them, so no
`.gitignore` change was needed to commit this evidence either.

## T-0317: the missing colour-bearing side reference now exists -- keyframe still not promotable

T-0317's own premise: round 4's colour finding above ("the coat's own main
body fill sits closer to the palette's neutral ramp than to any green-family
swatch") is a conditioning-input problem, not a cutout problem -- there was
no side-on reference anywhere in the repo that carried the actual green
cloth coat (`player_character_concept_sheet_v1.png`'s green panels are all
front-facing; T-0273's photographs and `player_profile_style_reference_
T0272.png` are both pose-only, explicitly not a costume match).

- **`player_profile_costume_reference_T0317.png`** (committed under
  `assets/src/concept/`, not duplicated here) -- generated through a
  genuinely different stack from this card's own §24-e (plain txt2img +
  style LoRA only, no ControlNet, no IP-Adapter, same recipe shape as
  T-0209's own concept sheet), then cropped to its own genuinely side-on
  panel out of a 3-panel front/side/back turnaround. 48,547 green pixels --
  comfortably past both round 5's 1.0-1.7% noise floor and its 6,000-6,900
  confirmed-match band. This is the reference this section's own "why this
  card exists" text said did not exist.
- **`attempt_39_coherent_but_gate_failing_T0317.png`** -- round 6's best
  *visual* result (seed 31416, the new reference in the secondary IP-Adapter
  slot at weight 0.1): a legible, coherent, vivid-green coat with a genuine
  side lean. Not promotable -- the render's own background came out
  multi-toned grey rather than solid black, so the per-pixel cutout starved
  (27-39 fg px, under the 50px mechanical-gate floor).
- **`attempt_41_gate_passing_but_incoherent_384_T0317.png`** and
  **`attempt_41_gate_passing_but_incoherent_48_T0317.png`** -- round 6's only
  attempt to pass the mechanical gate (seed 84512, secondary weight 0.15:
  265 fg px, `background_fraction` 0.885) -- but at both 384px and the
  actual 48px target resolution it reads as an incoherent cropped
  abstraction, not a legible standing figure. The same "gate passes, human
  visual call still fails" pattern rounds 1-5 already established
  repeatedly, now reproduced with a reference that finally carries the
  right colour.

**Not promoted.** 8 attempts (37-44, this round's own fresh DL-21 budget)
alternated between wrong-subject/incoherent collapses (raising the new
reference's own weight past ~0.15, visually much busier than round 4's
near-empty derived crop) and the two results captured above. No attempt
combined a clean cutout with a legible, genuinely side-facing figure.
`player_profile_keyframe_hybrid_T0272.png` remains absent from
`assets/final/character/`. Full per-attempt parameters and the round's own
write-up are in `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s "Round 6 (T-0317)"
section.

`.gitignore` check (re-run for T-0317): `git check-ignore -v` against the
three new paths above returns nothing for any of them, so no `.gitignore`
change was needed to commit this evidence either.
