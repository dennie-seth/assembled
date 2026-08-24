# T-0226 — Signal Tower concept-sheet audit

Machine-readable source: `assets/src/concept/signal_tower_concept_audit.json`
(validated by `tests/test_signal_tower_concept_audit.py`).

Per `docs/design/13-asset-pipeline.md` §6, nothing generates without an
approved concept sheet. This audits every Signal Tower asset set the
deciding run needs — enumerated from the seven rooms in
`docs/design/14-vertical-slice.md` §10 — against that requirement, and
generates only what was genuinely missing.

## Audit table

| Asset set | Rooms | Sheet | `concept_hash` | Approved | Note |
|---|---|---|---|---|---|
| `base_wall_floor_tiles` | all 7 | `signal_tower_material_sheet.png` | `9660a2c6…036460` | **pending** | DL-15 is an agent's own analytical confirmation, not a human sign-off. Downstream generation already happened. `concept_hash` bug found + fixed by this card (was the *template's* hash, not the sheet's). |
| `tile_material_detail` | all 7 | `signal_tower_concept_sheet_v3.png` | `275cb63c…60660b` | **pending** | Present on develop but missing from this card's own "what already exists" list — the card's own enumeration was incomplete. |
| `player_character` | all 7 | `player_character_concept_sheet_v1.png` (T-0209) | `4f82e3c4…22c9c0251b` | **pending** | Parent card's prose says "approved" but no decision-log entry records an actual human verdict. |
| `foreign_entities` | power_substation, equipment_floor, antenna_shaft | `entities_concept_sheet_v1.png` (T-0210) | `77b03788…50ec1244ce` | **pending** | No decision-log entry recording approval. |
| `cover_and_hiding_props` | power_substation, equipment_floor, storage_cache | `signal_tower_props_concept_sheet_v1.png` (T-0211) | `da676d79…c254415fbe87a4` | **pending** | No decision-log entry recording approval. |
| `power_substation_panel_and_housing` | power_substation | `signal_tower_concept_sheet_v3.png` (panel) + `props` sheet (equivalence) | `275cb63c…60660b` | **pending** | Breaker panel is directly covered. "Transformer housing" is treated as equivalent to the props sheet's relay cabinet — a judgment call needing human confirmation. |
| `records_room_shelving` | records_room | **new** `signal_tower_structure_concept_sheet_v1.png` | `ac90458c…624a1a9f9372` | **pending** | Was missing. Generated this card via real ComfyUI SDXL, img2img+LoRA conditioned on the material sheet (T-0104 workflow), not a placeholder. |
| `ladder_traversal` | all 7 | **new** `signal_tower_structure_concept_sheet_v1.png` | `ac90458c…624a1a9f9372` | **pending** | Was missing. Generated this card. |
| `power_substation_catwalk_grating` | power_substation | **new** `signal_tower_structure_concept_sheet_v1.png` | `ac90458c…624a1a9f9372` | **pending** | Was missing. Generated this card. |
| `doors` | ground_relay, records_room, equipment_floor, storage_cache | **new** `signal_tower_structure_concept_sheet_v1.png` | `ac90458c…624a1a9f9372` | **pending** | Was missing from this card's own first pass — `14` line 142 makes doors a required branch-dressing element. Generated this card as panel four of the structure sheet. |
| `broadcast_deck_tear_centerpiece` | broadcast_deck | N/A — no sheet | — | N/A | The chroma-lit tear is a runtime palette-swap shader (A-4, Phase 6), not a static art asset. No concept sheet required. |

## What this card did

1. Enumerated every Signal Tower asset set against the seven rooms (`14` §10).
2. Found and generated the four genuinely-missing sets: Records Room shelving,
   the ladder, the Power Substation catwalk/grating, and doors (`14` line 142
   — "Branches are single doors") — one new sheet,
   `signal_tower_structure_concept_sheet_v1.png`, generated for real through
   ComfyUI (not a synthetic placeholder), with `.provenance.json` and
   `.recipe.json` siblings.
3. Found and fixed a real provenance bug: `signal_tower_material_sheet`'s
   `concept_hash` (and its LoRA-handshake sibling's) held the sha256 of the
   *input template*, not the actual output sheet.
4. Backfilled a `generator` field (P-7: resolves to committed code) on every
   pre-existing sheet's provenance that was missing one, including writing
   the base material sheet's never-committed `recipe.json`.
5. Regenerated the structure sheet a second time after review: the first
   submission was a bare txt2img+LoRA prompt with no conditioning image at
   all, which violated the archetype-first coherence guard
   (`13` §6, lines 313-319 — "the first approved concept sheet conditions the
   ones that follow ... not a bare prompt") and rendered a receding-perspective
   interior room scene instead of the required flat side-on elevation panels.
   The current sheet is img2img+LoRA (denoise 0.88), conditioned on
   `signal_tower_material_sheet.png` — the Signal Tower archetype's first
   approved sheet — with `conditioning_source`/`base_concept_hash` recorded in
   its provenance and mechanically checked by
   `test_structure_provenance_obeys_archetype_first_coherence_guard` and
   `test_structure_conditioning_source_resolves_and_matches_base_concept_hash`
   rather than only by prompt-text matching.

## What this card did *not* do

**No row above is approved.** Direction approval is a human gate (§6: "two
human gates, not one") — this audit records that a verdict is pending for
every row, never asserts one. Several sheets already have downstream
generation against them (palette extraction, tile bakes, sprite sheets) with
no decision-log record of an actual human approval ever having happened —
that gap is surfaced here, not resolved by this card. **This card parks for
that verdict.** A human must review each row and record the approval verdict
on this card before §23-d/e/f (Track 1) or §23-i/§23-j (Track 2) generate
anything against it.
