# T-0275 — Enemy Redesign Concept Art Audit

Design + concept-art-only card. Real SDXL generation via
`assets/src/character/gen_enemy_concept_T0275.py` (txt2img +
`soviet_brutalism_style_v1` LoRA, weight 0.70, no img2img/ControlNet — concept
art is a fresh design study, not a conditioned re-run). No LoRA training, no
sprite sheets, no animation, and no downstream pipeline cards were created by
this card, per scope discipline.

## The three designs

| Enemy | Sensor role | Design | File |
|---|---|---|---|
| The Watcher | Sight cone | Humanoid with an owl head | `watcher_concept_sheet_v1.png` |
| The Sound | Sound radius | Non-human robot | `sound_concept_sheet_v1.png` |
| The Still Air | Proximity / patrol | Eyeless spider | `still_air_concept_sheet_v1.png` |

## Sensor-role reasoning, per enemy

- **The Watcher (sight cone).** The generated figure is an upright humanoid in
  plain institutional coveralls topped with an unmistakable owl head — large
  forward-facing eyes and a pronounced facial disc dominate the head silhouette
  from the front *and* the side view the sheet renders. An owl is the
  acute-vision predator; putting a head that is mostly eyes on an otherwise
  ordinary body telegraphs "this thing sees you" before a player reads any
  other detail, matching the GDD's "stationary or slow patrol, telegraphed,
  avoidable by routing" behaviour — a sight-cone hazard should look like it's
  looking.
- **The Sound (sound radius).** The generated figure has no face, no eyes, and
  no organic features at all — a boxy green-and-grey machine with an array of
  antenna/dish sensors and instrument panels where a head would be. It reads
  immediately as a machine, not a character with an expression to read,
  matching "hunts by sound alone" — there is nothing to make eye contact with,
  which is the entire point of a sensor role that isn't sight.
- **The Still Air (proximity / patrol).** The regenerated figure (see
  Iteration note below) is a giant spider with a smooth, rounded, blank head —
  no eyes, no eye clusters, no pupils anywhere on its body. Eight long
  segmented legs and thin sensory pedipalps read as built for feeling
  vibration, not seeing. This is the one design where "no eyes" is not a
  stylistic choice but the entire mechanic: the GDD's "you're not spotted,
  you're just there when it arrives" only reads as *inevitable* rather than
  *hostile* if the creature visibly has no way to notice you coming.

## Stealth-obstacle framing (GDD `07-items-economy.md` — no combat)

All three prompts describe a passive, unarmed figure in a neutral/relaxed
posture; the shared negative prompt excludes weapon/armor/combat-pose language
across all three generations (`weapon, gun, sword, blade, knife, rifle, armor,
armour, aggressive combat pose, battle stance, fighting stance`). None of the
three generated images show a weapon, aggressive stance, or bared
fangs/claws — verified visually against each PNG, not asserted from the prompt
text alone.

## Legibility check at game scale (~20px)

Each 1024×1024 sheet was downscaled to 64×64 (a rough exaggeration of the
~20px-tall in-sheet target, since these are single-figure studies rather than
cropped-to-figure crops) and inspected:

- **Watcher** — the owl-head silhouette against the humanoid body remains
  distinct at reduced scale; the head reads as non-human even when facial
  detail is lost.
- **Sound** — the boxy green machine silhouette and head-unit block stay
  legible; no ambiguity with a humanoid figure at reduced scale.
- **Still Air** — the wide, many-legged silhouette against a narrow round head
  is unambiguous even heavily downscaled; nothing else in the roster has this
  silhouette.

All three pass the "reads as itself in silhouette, not just at generation
resolution" bar this card's acceptance criteria set.

## Iteration note — Still Air, attempt 1 rejected

The first generation attempt for Still Air (seed 27503, prompt built the same
way as Watcher/Sound with the shared `_SHEET_FRAMING` string leading) produced
a *wrong-subject* failure: SDXL rendered a set of vehicle/trailer technical
blueprints (buses, vans, a delivery truck) instead of a creature — the
"orthographic elevation... reference sheet" framing language, without a strong
enough subject anchor ahead of it, pulled the model toward automotive
blueprint imagery it had clearly seen more of in training. This was **not**
committed or treated as acceptable; the card was **not** parked on it. The
prompt was rewritten to lead with "a single giant spider creature, arachnid
monster concept art" *before* the shared sheet-framing language, and the
negative prompt gained explicit `vehicle, truck, bus, van, car, trailer,
blueprint, technical drawing, engineering schematic, wheels` exclusions.
Attempt 2 (seed 27510) produced the committed, on-brief spider design. Both
attempts used the same checkpoint/LoRA pair and settings; only the prompt text
and seed changed. `gen_enemy_concept_T0275.py`'s committed `ENEMY_SPECS["still_air"]`
reflects the working attempt 2 recipe — attempt 1's failed prompt/seed
(27503) is not committed anywhere as a usable recipe.

## Supersession record

- **v1 (T-0200)** — synthetic. Provenance: `model: "N/A — synthetic reference
  image, procedurally generated (not AI-generated)"`, `model_hash: None`,
  produced by `tests/conftest.py`'s `_ensure_entity_sheets` fixture. Never real
  art. **Retired by this redesign** — not deleted (retirement lands with the
  replacement sprites, per this card's own edge-case note), but no longer the
  design direction.
- **v2 (T-0214)** — real SDXL, but of the abstract orb/field/presence forms
  (surveillance orb, wave-band, atmospheric column). Right pipeline, wrong
  visual direction. **Retired by this redesign.**
- The nine `test_{watcher,still_air,sound}_{idle,move,trapped}_gate_v2` suites
  under `assets/src/character/tests/` test the superseded v2 art and are
  **flagged as a follow-up candidate, not actioned here** (per the card's own
  scope-discipline note) — skipping/marking those gates superseded deserves
  its own review, not a side effect of this concept-art card.

## Downstream (explicitly NOT scoped here)

Per-pose reference sourcing (T-0276) → per-enemy per-pose identity LoRA →
§24-e hybrid sprites (idle/move/trapped + animations under T-0271's
motion-aware cap) → GIF previews. Those cards are authored only after
@DennieSeth approves these three designs.

## Approval

This card parks in `review` for @DennieSeth's approval per
`requires_approval: true` — no approval record is written by this card (no
`approved_by`/`approved_at`, no decision-log entry). The human approves by
moving the card to Done or commenting `APPROVED`.
