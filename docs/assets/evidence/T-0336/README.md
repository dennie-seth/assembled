# T-0336 evidence

Tier-1 master-sheet generation (`docs/decision-log.md` DL-30): txt2img at
**1024px** with style LoRA + IP-Adapter on the approved T-0209 concept sheet,
no ControlNet. Both images here are real ComfyUI samples against the
`172.18.192.1:8188` host (`sd_xl_base_1.0.safetensors` +
`soviet_brutalism_style_v1.safetensors` + `player_identity_v2.safetensors`),
not synthetic placeholders. Full recipe/weights for each are in
`ARM_MASTER_SHEET_ATTEMPT_LOG_T0336.md` and each attempt's own
`provenance_candidate.json`.

- **`attempt_1_baseline_coherent_but_coat_only_panels.png`** (seed 31416,
  style 0.70 / identity 0.5 / IP-Adapter 0.5) -- the first real test of this
  card's own central claim: sampling at 1024, the resolution the LoRAs were
  actually trained at, instead of 384. The result is genuinely coherent --
  a real character, not a striped/circuit-board artefact -- with the
  institutional green costume clearly legible and identity consistent with
  the T-0252 anchor. It resolves this card's named risk (**does the coat
  hide the legs?**): the whole-figure side-profile panels show the coat
  ending at the upper thigh with distinct, clearly separated articulated
  legs and boots below it -- legs are separable, so no costume escalation is
  needed. What it does *not* do is separate individual limb parts into their
  own isolated panels: IP-Adapter conditioning on the T-0209 concept sheet
  (which itself only contains coat-only product shots and whole-figure
  turnarounds, never an isolated single-limb crop) pulled the panel
  vocabulary toward that same composition regardless of the prompt's
  explicit "upper arm, lower arm, upper leg, lower leg, head, torso, each
  isolated" request -- the top-right coat-only panels crop the legs out of
  frame entirely rather than isolating them.
- **`attempt_2_promoted_exploded_parts_diagram.png`** (seed 8675309, style
  0.70 / identity 0.5 / IP-Adapter lowered to 0.35) -- **promoted.** Reframing
  the ask as an *exploded parts diagram* (disassembled equipment breakdown),
  a genre with its own strong visual convention of physically separated,
  non-overlapping component pieces, plus lowering the IP-Adapter weight so
  the text has more influence over composition, fixed attempt 1's panel
  vocabulary: the coat, the trousers/legs, and the boots now appear as
  genuinely distinct, non-overlapping pieces alongside three whole-figure
  turnaround views (front, side, back), all on a flat neutral background.
  Small strap/cuff pieces stand in for isolated arm segments. Identity
  (institutional green coat, hood, white gloves, orange accents) stays
  consistent with the T-0252 anchor throughout, including in the
  bottom-row variants where the model drifted toward heavier armour
  plating -- a real but minor inconsistency, noted here rather than hidden.

**Open finding, not silently resolved:** neither attempt produces a literal
isolated single-limb-only crop (just an upper arm, nothing else) the way an
isolated coat or boot piece is produced -- this model/conditioning
combination, with ControlNet deliberately out of scope for Tier 1, appears to
separate *garments* cleanly but not *anatomical limb segments* on their own.
Given DL-30 explicitly allows script arrangement of diffusion-sampled
pixels, the practical path to literal per-limb crops is likely a Tier-2
scripted crop from this sheet's own coherent whole-figure panels, not a
further Tier-1 prompt-engineering attempt against the same conditioning
image.
