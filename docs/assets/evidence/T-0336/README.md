# T-0336 evidence

Tier-1 master-sheet generation (`docs/decision-log.md` DL-30): txt2img at
**1024px** with style LoRA + IP-Adapter on the approved T-0209 concept sheet,
no ControlNet. All five attempts here are real ComfyUI samples against the
`172.18.192.1:8188` host (`sd_xl_base_1.0.safetensors` +
`soviet_brutalism_style_v1.safetensors` + `player_identity_v2.safetensors`),
not synthetic placeholders. Full recipe/weights for each are in
`ARM_MASTER_SHEET_ATTEMPT_LOG_T0336.md` and each attempt's own
`provenance_candidate.json`. **Attempt 5 is promoted** (the 5-attempt cap is
now fully spent).

## Round 1 -- coherence proven, garment separation only

- **`attempt_1_baseline_coherent_but_coat_only_panels.png`** (seed 31416,
  style 0.70 / identity 0.5 / IP-Adapter 0.5) -- the first real test of this
  card's central claim: sampling at 1024, the resolution the LoRAs were
  actually trained at, instead of 384. Genuinely coherent, identity
  consistent, coat clearly legible. Resolves the coat/legs risk *for this
  specific coat length*: the whole-figure side-profile panels show the coat
  ending at the upper thigh with distinct, separated legs and boots below
  it. Does not separate individual limb parts -- IP-Adapter conditioning on
  the T-0209 concept sheet pulled the panel vocabulary toward that
  reference's own coat-only/whole-figure composition regardless of the
  prompt's per-limb request.

## Round 2 (originally promoted, since superseded) -- garment separation, but headless and drifting

- **`attempt_2_promoted_exploded_parts_diagram.png`** (seed 8675309,
  IP-Adapter lowered to 0.35) -- reframing the ask as an *exploded parts
  diagram* fixed the panel vocabulary: coat, trousers, and boots appear as
  genuinely separated, non-overlapping pieces. **Reviewer FAIL** on this
  attempt found two defects opening the file: every whole-figure panel is
  headless (a blank white mannequin void, not a face), and the bottom row
  drifts to a heavier armour-plated costume instead of holding the single
  green-coat identity. The "separated parts" are garments (coat/trousers/
  boots), not the anatomical limb segments the card asks for.

## Round 3 -- rigging framing backfires

- **`attempt_3_headless_and_robotic_legs.png`** (seed 20260909, IP-Adapter
  0.35) -- tried an explicit visible-face requirement plus a "rigging
  reference sheet" framing for the limb panels. Made things worse: the hero
  figure's head came out cropped off the top of frame (still no face), and
  "rigging" itself pulled the bottom-row legs toward robotic/mechanical
  armour instead of the intended cloth-and-boot costume -- a new defect.

## Round 4 -- costume drift gets worse

- **`attempt_4_cropped_head_and_costume_drift.png`** (seed 421337,
  IP-Adapter 0.35) -- dropped "rigging" for "anatomy reference sheet" and
  asked for a literal human face. Heads are still blank/cropped, and most
  panels drifted to a cream/white coat instead of green -- costume
  consistency regressed rather than improved.

**Root cause, found by opening the concept sheet itself
(`assets/src/concept/player_character_concept_sheet_v1.png`) after three
failed prompt-only rounds:** its own panel grid mixes the intended
institutional-green costume (left columns) with a heavier armour-plated
variant (right columns and bottom rows), and shows a blank white oval for
every single head with no eyes anywhere. IP-Adapter conditions on whatever
region of that grid it is given -- no positive- or negative-prompt wording
was ever going to out-compete pixels the model is being shown directly.

## Round 5 (promoted) -- fix the conditioning image itself

- **`attempt_5_raw_generation_before_compositing.png`** (seed 314159265,
  style 0.70 / identity 0.5 / IP-Adapter 0.35) -- `EntitySpec.concept_crop_box`
  now restricts IP-Adapter to the concept sheet's own clean, single-costume
  top-left block (`(0, 0, 615, 615)`) instead of the whole mixed grid, and
  the prompt asks for a hooded mask with visible dark eye lenses (a head
  marker consistent with the costume's own hood) instead of fighting the
  source material for a literal face it never shows. Result: **all three
  turnaround views hold the same green costume with no armour drift**, and
  every head is legible (goggles + mask, not a blank void) -- the model even
  drew its own isolated head/hood panel. This is the best coherence +
  identity + head result across all five attempts.
- **`attempt_5_promoted_with_composited_parts.png`** -- what's actually
  committed to `assets/src/character/master_sheets/`. `promote_attempt`
  (`compose_master_sheet_with_parts`) appends a row below the raw generation
  with five parts cropped straight out of that same coherent image: `head`,
  `upper_arm`, `lower_arm_hand`, `torso_coat`, `lower_leg_boot`. DL-30
  sanctions script arrangement of diffusion-sampled pixels, and reusing
  pixels from one internally-consistent generation (rather than blending
  crops across different attempts/seeds) is what keeps every part's costume
  and lighting matching the whole-figure views above it -- unlike the
  mismatched-parts failure mode the original review warned about.

## Open finding, reported per this card's own instruction, not silently resolved

**`upper_leg` is not on the composited sheet.** Round 5's coat is longer than
round 1's (it now falls to roughly mid-calf instead of the upper thigh), and
it fully conceals the thigh in **all three** views:

- **`attempt_5_coat_front_slit_no_leg_visible.png`** -- the only gap in the
  coat's front is the narrow V where it hangs open; zoomed in, that gap
  shows dark coat lining and interior shadow, not trouser fabric or a leg.
- **`attempt_5_side_back_legs_coat_covers_thigh.png`** -- the side and back
  views likewise show only lower calf and boot below the coat hem; nothing
  above it is leg.

This is exactly the scenario this card's own acceptance criteria names:
*"if the legs are not separable, say so and stop -- that is a costume
decision for @DennieSeth."* One caveat worth recording honestly: round 1's
shorter coat *did* expose separable legs, so this is not a fixed property of
the costume design -- it is coat-length variance between generations that
happened to land long in the attempt with the best head/costume-consistency
result. The 5-attempt budget cap (`check_attempt_cap`, this card's own
guardrail against T-0272/T-0317's 84-attempt sweep failure) was fully spent
reaching that result, so a further attempt aimed specifically at a
shorter-coat seed was not available this round. Reported here with evidence
rather than invented around; @DennieSeth's call whether to spend a future
card's budget chasing a shorter-coat seed, accept a coat-length costume
decision, or treat `lower_leg_boot` as sufficient leg coverage for Tier 2.
