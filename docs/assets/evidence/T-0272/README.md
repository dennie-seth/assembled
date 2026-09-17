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

## T-0317 round 7: the reviewer's two named levers, both tried; a reproducibility defect found underneath them

- **`attempt_45_prompt_edit_regression_T0317.png`** -- attempt 39's exact
  recipe (seed 31416, secondary weight 0.10) with a "no grey background, no
  multi-tone background" term added to the prompt, the reviewer's own named
  Lever 2. Gate-passing (124 fg px) but a black-outlined, neon-rim-lit
  abstraction, not a legible figure -- a regression from attempt 39's own
  coherent visual. Attempts 46 (trimmed, truncation-safe rewording), 47
  (secondary weight lowered to 0.05), and 48 (secondary reference removed
  entirely) all rendered this same shape, proving the prompt edit itself,
  not token length or the secondary reference's weight, was responsible.
  This lever is retracted; `PROFILE_PROMPT`/`PROFILE_NEGATIVE` are reverted
  to the exact wording that produced attempt 39's result.
- **`attempt_50_reproduction_diverges_T0317.png`** -- attempt 39's recipe
  re-run **exactly** (seed 31416, secondary weight 0.10, prompt confirmed
  byte-identical to the reverted baseline), as a sanity check before trusting
  attempt 49's fine-stepped-weight result (the reviewer's Lever 1). This did
  not reproduce attempt 39's own recorded coherent visual, or attempts
  45-49's shared totem shape -- a third, distinct composition from
  byte-identical graph inputs. This is the round's real finding: this
  pipeline's seed does not guarantee cross-session reproducibility, which
  every round's methodology since round 3 has implicitly assumed. See
  `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s "Round 7 (T-0317)" section for the
  full isolation and the VRAM-pressure hypothesis for why.

**Not promoted.** Both of the round-6 reviewer's named levers are now
exhausted (one retracted with evidence, one undermined by the
reproducibility finding), and `player_profile_keyframe_hybrid_T0272.png`
remains absent from `assets/final/character/`. The costume reference this
card exists to produce is unaffected -- it does not depend on §24-e's own
sampling behaviour -- and remains committed, provenanced, and measured.

## T-0317 round 8: the reviewer's own suggested precondition tried, and it does not rescue the frame either

Round 7's reviewer asked for exactly one more thing before any further
descope decision: spend the single remaining budgeted attempt (52) on the
determinism precondition itself, not another weight value -- get real VRAM
headroom, re-run attempt 39/50's exact recipe, and see if seed 31416
reproduces.

- `POST /free` (`{"unload_models": true, "free_memory": true}`) was issued
  to the ComfyUI instance directly. `system_stats` before: `torch_vram_free`
  ~25-77MB against an ~8.5GB card (matching round 7's own ~28MB reading).
  After: `torch_vram_total` dropped to 33MB (all models unloaded) and
  `vram_free` (the OS-level figure) rose to ~7.36GB -- a genuine, large
  headroom change, not a marginal one.
- **`attempt_52_free_vram_still_diverges_T0317.png`** -- attempt 39/50's
  recipe re-run a third time, byte-identical inputs (seed 31416, secondary
  weight 0.10, reverted prompt, same LoRA/ControlNet/IP-Adapter weights),
  immediately after the `/free` call and with `gpu_seconds` 51.1 (a full
  recompute, not a cache hit -- ruling out the round-7 concern that a fast
  return means nothing happened). The mechanical gate now passes (144 fg
  px, `background_fraction` 0.9375) -- more foreground than either attempt
  39 (gate-failed) or attempt 50 (gate-failed) -- but the image itself is a
  fourth **distinct** composition: neither attempt 39's coherent green-coat
  figure, nor attempts 45-49's shared totem/glow-outline shape, nor attempt
  50's own divergent render. It reads as an abstract glowing silhouette with
  a green fragment near the top and no legible head/torso/leg structure --
  not a person, and not promotable on the "legible side-facing figure with
  green visible at 40px" standard this card has held throughout.

**Finding: real VRAM headroom does not fix the reproducibility defect.**
Round 7 hypothesized VRAM-pressure-driven fallback code paths (chunked vs.
resident attention) as the likely cause of seed 31416 producing different
outputs run to run. This round tested that hypothesis directly by removing
the pressure (`/free`, ~7.36GB headroom vs. round 7's own ~28MB) and running
the identical recipe again. The output still diverged -- a fourth distinct
result, not a reproduction of any prior one. VRAM pressure may still be *a*
contributing factor, but it is not the whole explanation, and this was the
specific, scoped test the round-7 reviewer asked for before any further
attempt. The attempt-cap budget opened for this card (1-52) is now fully
spent; `check_attempt_cap` refuses a 53rd attempt without an explicit new
budget grant, and this card's own "Do not" section forbids sweeping further
regardless.

**Not promoted, and no further attempts remain in this card's own budget.**
`player_profile_keyframe_hybrid_T0272.png` stays absent from
`assets/final/character/`. The reviewer's own two proposed routes forward
were (a) spend attempt 52 on the determinism precondition, then promote only
if it reproduces cleanly, or (b) a human descope decision banking the
reference (already delivered, unaffected by any of this) against T-0272
directly. Route (a) has now been tried in full and did not yield a
promotable frame -- the remaining path is (b), which is outside this card's
own authority to decide.

`.gitignore` check (re-run for round 7): `git check-ignore -v` against the
two new round-7 paths above returns nothing for either, so no `.gitignore`
change was needed to commit this evidence either.

## T-0317 round 9: T-0319's background fix is correctly wired, but it does not rescue this card's own defect

PR #350/T-0319 merged into this branch (`6c5143d`), adding
`char_gen.cutout.force_border_background_to_fill`. Measured before this
round's own code change: `gen_hybrid_walk_T0259.py` already called it 6
times; `gen_hybrid_profile_T0272.py` called it 0 times directly (the
primary identity-reference crop inherited the fix for free via the shared
`crop_identity_reference` import, but this generator's own rendered frame
never had its background corrected before segmentation).
`build_indexed_cell` now applies it to `main_384` before
`extract_foreground_mask` runs, TDD RED/GREEN (test committed first).

- **No-GPU-cost check first:** attempt 39's own preserved
  `attempt_39_coherent_but_gate_failing_T0317.png` was re-cut in-process
  through the fixed path -- 36 fg px before, 34 after, materially
  unchanged and still under the 50px floor. The fix cannot rescue pixel
  content already baked into an already-sampled frame, the same honest
  conclusion T-0319 reached for the walk generator's own preserved
  attempts.
- **`attempt_53_54_fixed_background_still_diverges_T0317.png`** -- a live
  re-run of attempt 39/50/52's exact recipe (seed 31416, secondary weight
  0.10, `--secondary-no-invert`), now against the fixed cutout path.
  Mechanical gate **passed** (74 fg px, `background_fraction` 0.9679), but
  the image is a **fifth** distinct composition: an abstract vertically
  striped shape with white/green fragments, no legible head, torso, arm,
  or leg structure. Not a person, not promotable, despite passing the
  mechanical gate -- the same "gate-passing but incoherent" trap attempts
  41 and 52 already demonstrated.
- **Attempt 54** re-ran the identical recipe after `POST /free`
  (`torch_vram_free` ~97MB -> ~1.89GB). `gpu_seconds` 54.1 confirms a full
  recompute, not a cache hit. Its `main_384.png` is **byte-identical**
  (`sha256` match) to attempt 53's.

**Finding: the nondeterminism is session-scoped, not seed-scoped.** Rounds
7-8 established that repeated runs of the identical recipe diverge from
each other across separate implementer sessions, and that freeing VRAM
does not restore reproducibility. This round adds the missing control:
*within* one continuous ComfyUI server lifetime, the identical recipe
reproduces itself deterministically (53 == 54, byte-identical, one before
and one after a `/free` call). The seed alone does not pin this pipeline's
output -- the server process's own lifetime does too, and that cannot be
pinned from the HTTP API this agent has (no shell access to the Windows
host to restart the process or set determinism env vars).

**Not promoted. No further attempts spent sweeping.** The card's own stop
condition -- "if attempt 39's recipe still will not reproduce ... stop and
report that as the finding ... rather than sweeping" -- is met, confirmed
twice (attempts 53 and 54). `player_profile_keyframe_hybrid_T0272.png`
remains absent from `assets/final/character/`. Six of this round's eight
budgeted attempts (55-60) are deliberately unspent, per the card's own
"Do not" instruction against sweeping for a coherent result. Whether to
descope the keyframe to T-0272 or spend a further round investigating the
session-scoped determinism itself (a concrete next probe: ComfyUI/PyTorch
determinism settings, `torch.use_deterministic_algorithms` /
`cudnn.benchmark` / `CUBLAS_WORKSPACE_CONFIG`, none of which this agent can
set remotely) is, as in rounds 7-8, a human call.

`.gitignore` check (re-run for round 9): `git check-ignore -v` against
`attempt_53_54_fixed_background_still_diverges_T0317.png` returns nothing,
so no `.gitignore` change was needed to commit this evidence either.

## T-0317 round 10: determinism proven within-session, but every fresh seed under `--deterministic` converges on a new, consistent failure mode

ComfyUI was restarted with `--deterministic` and `CUBLAS_WORKSPACE_CONFIG=:4096:8`
set (`GET /system_stats`'s `argv` confirms this), per round 9's own named next
probe. `check_attempt_cap` opened a fresh 61-68 budget. Attempt 39's recipe
was deliberately **not** reproduced -- round 9 already showed the defect is
session-scoped, so restarting pins *future* sessions, not the one that
produced attempt 39's coherent visual.

- **`attempt_61_first_fresh_seed_deterministic_striped_T0317.png`** -- the
  first fresh-seed attempt (61023), secondary weight held at 0.10 (attempt
  39's own value). A vertical white/green architectural totem with fine
  horizontal ribbing; mechanical gate correctly reports 0 fg px. Not a
  person.
- **Attempts 62-64** (seeds 200601, 771001, 305092) -- not committed
  individually, but each is the same shape of failure: black background cut
  by regular horizontal green/white/cyan bars, a narrow vertical spine.
  None read as a human figure.
- **`attempt_65_gate_passing_but_incoherent_striped_T0317.png`** -- seed
  918273. Mechanical gate **passed** (53 fg px, `background_fraction`
  0.977) -- the same "gate-passing but incoherent" trap attempts 41, 52 and
  53 already demonstrated. Striped/barred pattern, no legible head, torso,
  arm or leg.
- **Attempt 66** (seed 445566) -- sixth and last fresh sample before
  stopping the sweep. Same striped failure mode.

**Six seeds, six for six the same new failure signature** -- a regular
horizontal-banding artifact, distinct in character from rounds 6-9's totems
and glowing-silhouette abstractions. Likely mechanism (inference, not
confirmed root cause from this agent's HTTP-only access): `--deterministic`
forces PyTorch/cuDNN onto non-fused, deterministic kernel paths, changing
this dual-IPAdapter + ControlNet graph's actual numerical output, not just
its reproducibility -- determinism and this graph's prior fragile coherence
may be in tension.

- **`attempt_66_67_68_determinism_proof_T0317.png`** (attempt 68's frame,
  representative of 66/67/68 -- all three are byte-identical) -- the "prove
  the pin" deliverable. Attempt 67 repeated attempt 66's exact recipe and
  matched by `sha256`, but at `gpu_seconds` 3.1 (a ComfyUI node-cache hit,
  the same signature attempt 51 showed) -- not independent evidence. `POST
  /free` was issued and attempt 68 repeated the recipe a third time:
  `gpu_seconds` 60.1 (a genuine full recompute) and **still byte-identical**
  to 66 and 67. This is the meaningful claim: the seed now pins the render
  within a session, confirmed by an independent, non-cached recompute. A
  cross-restart check remains untested and belongs to a determinism-infra
  card, not this one.

**Not promoted. Budget (61-68) fully spent, no extension taken**, per the
round's own stop condition once six seeds converged on the same failure
signature. `player_profile_keyframe_hybrid_T0272.png` remains absent from
`assets/final/character/`. The costume-bearing side reference itself
(`player_profile_costume_reference_T0317.png`) remains sound and unaffected
by any of this. Whether to descope the keyframe to a follow-up and bank the
reference, or investigate the specific `--deterministic`/graph interaction
further, is a human call.

`.gitignore` check (re-run for round 10): `git check-ignore -v` against all
three of this round's evidence frames returns nothing, so no `.gitignore`
change was needed to commit them either.

## T-0317 round 11: bounded probe under a partial-determinism regime, then a bounded seed reroll -- still not promotable, but the finding narrows the cause

`@DennieSeth`'s decision on T-0324: a narrow probe first, then ship if it
works. ComfyUI was restarted again with `--deterministic` **removed** while
`CUBLAS_WORKSPACE_CONFIG=:4096:8` stayed set (`GET /system_stats`'s `argv`
confirms this: `["main.py", "--listen", "0.0.0.0", "--port", "8188"]`, no
`--deterministic`). `check_attempt_cap` opened a fresh 69-76 budget.

**Step 1 -- the bounded probe (attempts 69-70), exactly as scoped.** The
established recipe (secondary reference `player_profile_costume_reference_T0317.png`
at weight 0.10, primary front sheet 0.6, pose LoRA 0.6, ControlNet 1.0/1.0,
`--secondary-no-invert`) was rendered twice at a fresh seed (271828):

- **`attempt_69_70_probe_reproducible_but_incoherent_T0317.png`** (attempt
  69's frame, representative of both -- byte-identical `sha256`). Mechanical
  gate **passed** (54 fg px, `background_fraction` 0.977). Visually: a
  blocky, bilaterally-symmetric front-facing figure with glitch-like white
  fragmentation and only faint green flecks -- not side-facing, not the
  green coat, not a coherent person.
- Attempt 70 re-ran the identical recipe after `POST /free` (`torch_vram_free`
  33MB after unload). `gpu_seconds` 39.1 for both, and `GET /history/<id>`'s
  own `execution_cached` message lists **zero** cached nodes for attempt 70 --
  a genuine, independently-confirmed full recompute, not a cache hit (unlike
  attempt 67's 3.1s cache-hit signature). Result: **byte-identical** to
  attempt 69.

**Probe answer: coherent = NO, reproducible = YES** (confirmed by a
non-cached recompute, the same bar round 10 set for its own determinism
claim). This is a real result in its own right: the seed pins the render
under this partial regime too, not just under round 10's full
`--deterministic` regime -- but it does not rescue coherence, which is the
whole point of running the probe before spending the rest of the budget.

**Step 2 -- the bounded seed reroll (attempts 71-76), stopped exactly at
budget per the round's own instruction ("stop the moment you have one usable
frame... do not extend").** Six fresh seeds (100003, 100019, 100043, 100057,
100069, 100103), secondary weight held at 0.10, everything else unchanged.
Every one judged by opening the image, not by the mechanical gate alone:

- Attempt 71 (100003): abstract green/red/cyan circuit-board pattern. Gate
  **failed** (2 fg px).
- Attempt 72 (100019): banded architectural shape with light-green blocks and
  horizontal rules. Gate **failed** (23 fg px).
- **`attempt_73_seed_reroll_best_case_still_incoherent_T0317.png`** (100043):
  the round's highest foreground count (242 px) and the most green content of
  the six, but a bilaterally-symmetric striped abstraction against a light
  background, not a figure. Gate **passed** on pixel count alone -- another
  instance of the "gate-passing but incoherent" trap attempts 41/52/53/65
  already demonstrated.
- Attempt 74 (100057): vertical striping with green fragments threaded
  through it, no legible head/torso/limb structure. Gate **passed** (151 fg
  px) but not a person.
- Attempt 75 (100069): a colourful, machine-like abstraction (blues, reds,
  yellows, an incidental "F"-shaped fragment) -- the least figure-like result
  of the six. Gate **passed** (91 fg px).
- **`attempt_76_seed_reroll_final_still_incoherent_T0317.png`** (100103,
  final attempt in this round's budget): a symmetric, robot-like cyan/white
  form, still front-facing-symmetric rather than side-on, no green. Gate
  **failed** (3 fg px).

**Zero of eight attempts (69-76) produced an attempt-39-class coherent,
side-facing, green-legible figure.** Budget fully spent; no extension taken,
per the round's own stop condition. `player_profile_keyframe_hybrid_T0272.png`
remains absent from `assets/final/character/`.

**What this round narrows down.** Three regimes have now been tried against
this graph: (0) the original unpinned regime (rounds 1-8) -- nondeterministic
across sessions, but the one session that produced attempt 39's coherent
result came from here; (1) round 10's full `--deterministic` +
`CUBLAS_WORKSPACE_CONFIG` -- reproducible, uniformly incoherent
(horizontal-banding failure); (2) this round's partial regime,
`CUBLAS_WORKSPACE_CONFIG` alone -- also reproducible (at least for the one
seed tested), also uniformly incoherent, in a *different* failure family
(architectural/circuit abstractions rather than banding). Removing
`--deterministic` changed the failure's character but not its presence,
which weighs against round 10's own hypothesis that `--deterministic`
specifically (via non-fused kernel paths) was excluding coherence. The
regime shared by both failing determinism attempts, and absent from the one
regime that ever produced attempt 39, is `CUBLAS_WORKSPACE_CONFIG` itself --
now the more specific suspect. Recommended permanent config, pending a
dedicated determinism-infra investigation: for this graph specifically, do
not set `CUBLAS_WORKSPACE_CONFIG` at generation time; treat coherent output
as something to catch and bank when it appears under the original unpinned
regime, rather than something to reproduce on demand under a pinned one.

`.gitignore` check (round 11): `git check-ignore -v` against all three of
this round's evidence frames returns nothing, so no `.gitignore` change was
needed to commit them either.

## Round 12 (T-0317, attempts 77-84): baseline regime restored, full 8-seed reroll spent -- zero coherent frames

`@DennieSeth`'s decision: restore ComfyUI to the exact regime that produced
attempt 39 (no `--deterministic`, no `CUBLAS_WORKSPACE_CONFIG` at all) and
spend a bounded 8-seed reroll, stopping at the first usable coherent frame.
Confirmed before generating: `GET /system_stats` `argv` carries no
`--deterministic` flag, `vram_free` 7.44GB (model unloaded). `check_attempt_cap`
opened a fresh 77-84 budget.

Eight fresh seeds (500009, 500017, 500023, 500029, 500041, 500051, 500063,
500077), the established recipe otherwise (secondary reference
`player_profile_costume_reference_T0317.png` at weight 0.10, primary 0.6,
pose LoRA 0.6, ControlNet 1.0/1.0, `--secondary-no-invert`). Every one judged
by opening the image, not by the mechanical gate alone:

- Attempt 77 (500009): vertical black/green/white striped abstraction, the
  same failure family rounds 10-11 saw repeatedly. Gate **failed** (29 fg px).
- **`attempt_78_gate_passing_but_incoherent_T0317.png`** (500017): a
  colourful red/yellow/cyan circuit-board pattern, no legible head/torso/limb
  structure. Gate **passed** (88 fg px) -- another instance of the
  "gate-passing but incoherent" trap attempts 41/52/53/65/73 already
  demonstrated.
- Attempt 79 (500023): a symmetric, front-facing blue/red/white block
  abstraction -- dominant colour blue, not green, bilaterally symmetric
  rather than side-facing. Gate **passed** (68 fg px).
- Attempt 80 (500029): horizontal-banded dark olive/black abstraction, no
  figure. Gate **failed** (11 fg px).
- Attempt 81 (500041): a symmetric, robot-like white/green form, front-facing,
  not a side profile. Gate **failed** (13 fg px).
- Attempt 82 (500051): front-facing symmetric shape with a large flat green
  rectangle and orange/teal accents, no recognisable figure. Gate **failed**
  (4 fg px).
- Attempt 83 (500063): vertical striped blue/green/black abstraction, same
  failure family as attempt 77. Gate **failed** (5 fg px).
- **`attempt_84_seed_reroll_final_still_incoherent_T0317.png`** (500077,
  final attempt in this round's budget): the round's highest foreground count
  (124 fg px), a black/white striped abstraction against a blue-teal
  background with only faint green accents -- still no legible head, torso,
  or limb structure, still not side-facing. Gate **passed**.

**Zero of eight attempts produced an attempt-39-class coherent, side-facing,
green-legible figure.** Budget fully spent; no extension taken, per the
round's own stop condition. `player_profile_keyframe_hybrid_T0272.png`
remains absent from `assets/final/character/`.

**What this round adds.** Three of eight seeds passed the mechanical gate
(78, 79, 84), a higher pass rate than either pinned regime's own sweep, but
every gate-passing frame was, on inspection, the same "gate-passing but
incoherent" failure mode documented seven times now across four regimes --
the gate screens blank renders, not incoherent ones. More importantly, this
weakens rather than confirms round 11's own `CUBLAS_WORKSPACE_CONFIG`
hypothesis: restoring the exact regime that produced attempt 39 did not
reproduce anything like its coherence across 8 fresh seeds, the same outcome
as both pinned regimes before it. Four regimes now sampled (uncontrolled
baseline: 1 coherent hit across rounds 1-8; full determinism: 0/6; partial
determinism: 0/8; restored baseline: 0/8) suggest attempt 39 was a rare draw
from an inherently fragile graph (dual-IPAdapter + ControlNet + two stacked
LoRAs), not evidence of a reliably-coherent regime waiting to be restored.

`.gitignore` check (round 12): `git check-ignore -v` against both of this
round's evidence frames returns nothing, so no `.gitignore` change was
needed to commit them either.
