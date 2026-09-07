# Walk background fix -- root cause + re-cut evidence (T-0319)

Card scope: diagnose why T-0259's walk frames render on a mid-grey
background instead of the prompt's requested black, fix the root cause, and
re-cut the preserved attempt 5/7 frames against the fix before spending any
new GPU. **This card is the fix, not the promotion** -- T-0259 owns any
future regeneration/promotion.

## 1. Root cause (measured, not guessed)

`gen_hybrid_walk_T0259.py`'s `IDENTITY_REFERENCE_CROP_BOX` (line 194, added
T-0266 attempt 3) crops one panel out of the committed concept sheet
(`assets/src/concept/player_character_concept_sheet_v1.png`, T-0209) and
uploads that crop to `IPAdapterAdvanced` as the identity reference. That
crop's OWN panel background is mid-grey, not black:

| Source | Modal border RGB (top color) |
|---|---|
| Identity reference crop (`IDENTITY_REFERENCE_CROP_BOX`) | **(144, 143, 145)** |
| Preserved attempt 5, frames 0/2/4 raw `main_384.png` | (142, 142, 146) |
| Preserved attempt 7, frames 0/2/4 raw `main_384.png` | (147, 144, 145) |
| T-0252's promoted idle keyframe (the black-background anchor) | (18, 17, 14) |
| Currently-promoted walk sheet (attempt 4) | (18, 17, 14) |

The generated frames' own modal border colour matches the identity
reference's modal background almost exactly -- not the black `WALK_PROMPT`
asks for ("solid flat black background"), and not merely "close to" the
negative prompt's "grey background" term, which is already present in
`WALK_NEGATIVE` (inherited unchanged from the idle recipe's `MAIN_NEGATIVE`)
and evidently made no difference. That is consistent with IP-Adapter's own
conditioning pathway: it conditions on the whole reference image, background
included, through an image-embedding path independent of the CLIP text
encoder the positive/negative prompts run through -- so a background baked
into the reference image is not something a text negative prompt can
suppress.

Visual confirmation (`identity_reference_crop.png`, attempt 7): a green-coat
figure on a visibly grey panel background with a bright divider line at one
edge -- not the black IP-Adapter is meant to reinforce.

This is the same class of defect T-0272 round 3's Test D diagnosed for its
own side-profile reference (an off-white photographic background bleeding
through) -- confirmed there by inverting the reference's tone
(`invert_reference_for_conditioning`). A plain invert does not apply here
(inverting a *mid-grey* ~144 gives ~111 -- still mid-grey, not black), so
this card's fix instead forces the crop's own background to a genuinely dark
fill via the pipeline's own already-tested border-flood segmentation
(`char_gen.cutout.border_flood_background_mask`, T-0315), the same
"find background, force it dark" tool used everywhere else in this pipeline.

**Caveat, stated plainly:** the currently-*promoted* walk sheet (attempt 4,
`assets/final/character/player_walk_sheet_hybrid.png`) already lands on
(18, 17, 14) despite using the identical (buggy) reference crop -- so this
defect is a real, evidenced *risk factor* the reference crop introduces, not
a deterministic guarantee that every attempt fails the same way. Sampling
noise / seed / other weights modulate how strongly IP-Adapter's background
conditioning shows up in a given attempt. The fix below removes the risk
factor unconditionally for every future attempt, regardless of which other
parameters are chosen.

## 2. Fix

`char_gen/cutout.py` gains `force_border_background_to_fill(img, tolerance,
fill_rgb=DARK_BACKGROUND_FILL)` -- reuses `border_flood_background_mask`
(no new segmentation logic) and paints whatever it classifies as background
to a genuinely dark fill (`DARK_BACKGROUND_FILL = (18, 17, 14)`, T-0252's own
promoted idle background).

`gen_hybrid_walk_T0259.crop_identity_reference` now applies this to the
identity crop before it is ever uploaded to ComfyUI -- the generation-time
fix. Every future attempt uploads a reference whose own background is
already dark, removing this bleed vector regardless of seed/weights.

## 3. Re-cut: preserved attempt 5/7 frames against the fix

`gen_hybrid_walk_T0259.reprocess_attempt_background_fix(out_dir)` re-derives
an already-sampled attempt's sheet twice from its already-written
`frame_{i}_main_384.png` + `frame_{i}_keypoints.json` -- **no new ComfyUI
calls**:

- **before**: the existing per-frame cutout (`cutout_foreground_mask`,
  `CUTOUT_OKLAB_TOLERANCE=0.03`, `BACKGROUND_MASK_MARGIN_FRAC`), exactly as
  a fresh generation already runs it, on the original (grey-background) raw
  frame.
- **after**: `force_border_background_to_fill` applied to each frame's own
  detected background first, then the SAME cutout re-run on the corrected
  image.

Both paths go through the full assembly the real gate uses (quantize to
palette -> apply cutout masks -> enforce 2px cell margin -> orphan cleanup),
and background fraction is computed identically to
`test_player_walk_hybrid_T0259_gate.py::test_sheet_background_is_mostly_clean`
(`MIN_BACKGROUND_FRACTION = 0.65`).

Run against the preserved attempt 5 and attempt 7 directories (308 artifact
files that survived their own worktree's removal, per this card's own
scope note):

### Attempt 5 (seed carried in that attempt's own provenance)

| Cell | Before | After | Delta | Before | After |
|---|---|---|---|---|---|
| 0_0 | 0.6159 | 0.6168 | +0.0009 | FAIL | FAIL |
| 0_1 | 0.5516 | 0.5525 | +0.0009 | FAIL | FAIL |
| 0_2 | 0.9744 | 0.9757 | +0.0013 | PASS | PASS |
| 0_3 | 0.9253 | 0.9249 | -0.0004 | PASS | PASS |
| 1_0 | 0.5825 | 0.5816 | -0.0009 | FAIL | FAIL |
| 1_1 | 0.6107 | 0.6441 | +0.0334 | FAIL | FAIL |
| 1_2 | 0.8880 | 0.8876 | -0.0004 | PASS | PASS |
| 1_3 | 0.5694 | 0.5699 | +0.0004 | FAIL | FAIL |

### Attempt 7

| Cell | Before | After | Delta | Before | After |
|---|---|---|---|---|---|
| 0_0 | 0.7943 | 0.7999 | +0.0056 | PASS | PASS |
| 0_1 | 0.7643 | 0.7652 | +0.0009 | PASS | PASS |
| 0_2 | 0.9158 | 0.9158 | +0.0000 | PASS | PASS |
| 0_3 | 0.8338 | 0.8338 | +0.0000 | PASS | PASS |
| 1_0 | 0.6719 | 0.6719 | +0.0000 | PASS | PASS |
| 1_1 | 0.8125 | 0.8312 | +0.0187 | PASS | PASS |
| 1_2 | 0.9128 | 0.9128 | +0.0000 | PASS | PASS |
| 1_3 | 0.6463 | 0.6484 | +0.0022 | **FAIL** | **FAIL** |

(Attempt 7's cell 1_3 measurement, 64.6-64.8%, lines up with the range the
T-0316 escalation originally cited, 63.5-64.3%, for the residual dirty
cells -- same defect, same order of magnitude.)

## 4. Honest conclusion

**The fix does not clear the preserved attempts' failing cells.** Every
delta is small (at most +3.3 percentage points, most well under +1pp) and
never crosses a FAIL cell into PASS in either attempt. Visual comparison of
attempt 7's before/after assembled sheets confirms this -- the two are
nearly indistinguishable; the residual non-background content in the
failing cells is not primarily a background-tone/classification-tolerance
problem for these specific already-sampled frames (that hypothesis is
falsified by this measurement), it is baked into the sampled pixel content
itself in a way a post-hoc background recolour cannot undo. That is
consistent with IP-Adapter's conditioning influence extending beyond just
the reference's border pixels into the sample's overall tonal distribution.

**No new GPU spend is justified by this alone** -- per the card's own scope,
stop here rather than sweep the fringe/denoise axes again (T-0259 already
spent that budget). The generation-time fix (§2) still stands on its own
merits: it removes a real, evidenced defect from every *future* attempt,
independent of whether it would have saved these two already-sampled ones.
Whether a fresh regeneration through the corrected reference clears the
locomotion-cap/background gates is for T-0259's own next round to measure --
this card is the fix, not the promotion.

## 5. No regression to the already-promoted sheets

- `player_walk_sheet_hybrid.png` (attempt 4, currently promoted) already
  lands on (18, 17, 14) and is untouched by this card -- its own gate suite
  (`test_player_walk_hybrid_T0259_gate.py`, 38 tests) passes unchanged.
- `player_idle_sheet_hybrid_T0252.png` (T-0252, the identity anchor) is
  untouched; `force_border_background_to_fill` is new code, not a change to
  any function an existing promoted sheet's provenance depends on.
- T-0272's profile-cutout suite (`test_cutout_T0272.py`,
  `test_cutout_absolute_background_distance_T0315.py`) passes unchanged --
  every existing `char_gen.cutout` function is untouched; this card only
  adds a new one.
