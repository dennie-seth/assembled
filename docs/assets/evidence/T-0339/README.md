# T-0339 evidence -- side_neutral profile keyframe, 3-attempt hard cap spent

## Status (2026-09-11): STOP AND REPORT per the card's own pre-registered escape hatch

The card's governing section ("SOURCE RE-SCOPED 2026-09-11") authorised exactly three
`side_neutral` generation attempts, reusing T-0351's proven attempt-19-21 recipe unchanged, then a
mandatory stop-and-report if none converged. All three attempts ran to completion against live
ComfyUI (`172.18.192.1:8188`), no denials, no timeouts, no GPU errors -- **generation itself is not
the blocker.** What follows corrects an overclaim this card's own history made about attempt 3
before this pass, and reports where the actual failure sits.

**A live GPU call was required** for all three generation attempts (`generate_side_neutral_panel`,
ComfyUI txt2img + ControlNet/OpenPose + style/identity LoRA + IP-Adapter). The descent step itself
(`descend_accepted_panel`) is pure/local, no GPU.

## Correction to the prior "ACCEPTED AND PROMOTED" verdict on attempt 3

`ARM_MASTER_SHEET_ATTEMPT_LOG_T0339.md`'s row for attempt 3 called it "ACCEPTED AND PROMOTED
... descended to a legible, taller-than-wide, unmistakably green 48x48 silhouette." Opened directly
at both native 48x48 and the zoomed evidence (`after_keyframe_48_zoomed_v2.png`), that does not
hold up: the descended result reads as a mottled olive/khaki column with no recoverable silhouette
features (no distinguishable hood, coat edge, or boots at a glance) -- not "vivid green legible at
40px" by this card's own acceptance bar. This matches this pipeline's own recurring failure
signature named in this card's history: *"numbers passing while the image does not."*

Mechanically the promoted keyframe does clear every automated gate (280 foreground px against a
50px floor; ~90% of foreground px fall in the palette's own green-family index set
`{2,3,5,7,9,11}`) -- which is exactly why this needed a human/agent open-the-image judgment call,
not just a green test suite, to catch.

**Calibration check against this pipeline's own already-promoted bar:** side-by-side against
`assets/final/character/player_idle_sheet_hybrid_T0252.png` (accepted, same palette, same descent
primitives), T-0252's torso/chest reads as an unambiguous solid green block at a glance. Attempt 3's
descended profile does not reach that bar.

## Why -- diagnosed root cause, generation vs. descent

**Generation succeeded, three for three:** every attempt produced a genuine, uncropped,
single-figure true 90-degree side profile in the canonical hooded coat -- confirming T-0351's own
`side_neutral` finding holds. Pose/composition is not the problem.

**Descent is where all three attempts actually fail, for two distinct reasons:**

1. **Attempts 1 and 3 -- palette quantization desaturates a continuous lighting gradient.**
   T-0351/T-0336's `side_neutral` recipe renders the coat with continuous, painterly
   highlight-to-shadow shading (a soft light gradient down the centre fold), not the flat,
   solid-block cel-shading `player_profile_costume_reference_T0317.png` itself uses (see
   `before_source_T0317_reference.png` -- large flat medium-saturated green panels, almost no
   gradient). `home_palette.json`'s green family has exactly two saturated slots
   (index 2 `#0b2d18`, index 3 `#123c23`, both dark) and four higher-lightness slots
   (5/7/9/11) that read as muddy olive/khaki rather than vivid green
   (`#4c553a`, `#5a6042`, `#616747` all have R and G within ~10 of each other -- weak green
   dominance). Nearest-Oklab quantization of a continuous gradient scatters pixels across this
   whole family instead of landing on one or two coherent saturated blocks, which is what produces
   the mottled read. Sampled attempt-3 coat pixels: `(76,94,51)->index 9 (muddy)`,
   `(42,72,20)->index 5 (good)`, `(73,92,50)->index 7 (muddy)` -- the same raw coat, three
   different palette neighbours, no dominant block.
2. **Attempt 2 -- cutout mask shredded by background bleed, unrelated failure mode.** The most
   visually vivid and highest-contrast raw panel of the three (see
   `side_neutral_attempt_2_1024.png` -- distinct light cape vs. dark legs/boots, much closer in
   spirit to T-0252's own flat-block shading). Its background is a dark vignette close enough to
   the coat's own shadow folds in Oklab space that `char_gen.cutout`'s border-connected flood
   classifier ate through large parts of the figure before palette quantization ever ran -- a
   different pipeline stage than (1), and the one place all three attempts is genuinely the "best
   raw material, worst descent outcome" case. Measured directly (running the existing, unmodified
   `build_descended_cell` against the committed `attempt_2/side_neutral_1024.png`, output
   discarded, not promoted -- a descent-only re-run of an already-generated panel, not a 4th
   generation attempt): `char_gen.cutout` itself warns at runtime that this frame's border colours
   span "32.10x the classification tolerance ... too wide to trust", and the result confirms it --
   2228 of 2304 cells (the near-entirety of the 48x48 canvas) come back flagged foreground, i.e.
   the flood classifier fails open into treating almost the whole frame, background included, as
   figure. This is not a marginal edge fray, it is a nearly total mask inversion for this specific
   frame's background.

**Conclusion: the failure is in descent, not generation**, and it is not one bug but two
independent descent-stage interactions -- palette-vs-continuous-gradient (attempts 1, 3) and
cutout-vs-background-vignette (attempt 2) -- neither of which a fourth generation attempt would
fix, since attempt 3 already avoided (2)'s failure mode and still hit (1)'s.

## Why this card stops here rather than iterating

- **Hard cap of 3 generation attempts is spent** (card's own instruction). A 4th attempt is not
  authorised.
- **Prompt tuning is explicitly out of scope** ("Do not tune prompt weights") -- and prompt tuning
  is the wrong lever regardless: the gradient-vs-flat-shading difference looks like a rendering
  style property of this recipe, not a wording fix, and chasing it would be exactly the kind of
  seed/prompt sweep this card was scoped to avoid.
- **The locked `home_palette.json` is out of scope** for this card to change (T-0105/DL-1: slot
  indices are load-bearing, not to be reordered or renumbered without its own process) -- and
  widening its green family would affect every other keyframe in the pipeline, not just this one.
- **The shared `char_gen.cutout` primitives are meant to be reused unchanged** ("existing cutout +
  descent path"); loosening the Oklab tolerance to rescue attempt 2 is a pipeline-wide change, not
  a fix scoped to this card.

Per this card's own pre-registered escape hatch: *"A stop-and-report naming which stage failed is a
valid PASS for this card."* Stage: **descent** (both the palette-quantization step for attempts 1/3,
and the cutout step for attempt 2). Generation is not implicated.

## What's committed

- `side_neutral_attempt_{1,2,3}_1024.png` -- all three raw 1024 panels, as generated.
- `before_source_T0317_reference.png` -- the original T-0317 crop, for the flat-vs-gradient shading
  comparison above.
- `after_keyframe_48_zoomed.png` -- stale, from this card's first (superseded, crop-descent) route;
  kept for historical before/after continuity, not representative of the current route.
- `after_keyframe_48_zoomed_v2.png` -- the current route's actual descended result (attempt 3,
  promoted as best-of-3, not as a criterion-clearing result -- see correction above).
- `assets/final/character/player_profile_keyframe_hybrid_T0272.png` -- left in place as the best
  real, non-synthetic result available from this card's authorised attempts. It is a genuine
  improvement over the superseded crop-descent artifact (no hollow head artefact, correct side
  facing, clears every mechanical floor) but does **not** confidently clear this card's own "vivid
  green legible at 40px" acceptance bar. A human call is needed on whether to accept it as a
  stopgap, or scope a follow-up card against the diagnosis above (most promising angle: get
  attempt 2's flat, high-contrast raw shading through descent by addressing the cutout/background
  interaction specifically, since its generation-stage output is the closest of the three to
  T-0252's own accepted style).

## Recommendation for whoever picks this up next

Not this card's call to make (scope questions are @DennieSeth's per this card's own history), but
for the record: the cheapest next step is probably **not** a new generation recipe -- it's revisiting
attempt 2's cutout failure specifically (e.g. a locally-scoped background-fill pass before the flood
classifier runs, rather than a pipeline-wide tolerance change), since that attempt's raw material is
already the best match for this palette's descent behaviour.
