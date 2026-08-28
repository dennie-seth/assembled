# Signal Tower prop pack — full-pack certification (T-0233, HANDOFF §23-j)

**Card:** T-0233, Track 2, gated by §23-h (P-6). Supersedes the scope of
T-0201 (first pack), T-0221 (regeneration through the committed cutout
path), and T-0223 (16px value re-tune) without reopening their fixes.

## Scope decision: no new geometry

The approved prop concept sheet
(`assets/src/concept/signal_tower_props_concept_sheet_v1.png`, T-0211,
`concept_hash da676d79…c254415fbe87a4`) depicts exactly **five** props —
three cover, two hiding-spot — and nothing else:

| Panel | Prop | Class |
|---|---|---|
| Left half | relay junction cabinet | cover |
| Left half | equipment crate stack | cover |
| Left half | low HVAC duct segment | cover |
| Right half | standing locker | hide |
| Right half | server rack cabinet | hide |

Per `docs/design/13-asset-pipeline.md` §6 ("concept art precedes
generation" — DL-5), generating a prop with no corresponding panel on an
approved sheet is not authorized. §23-j's "full pack for all seven rooms"
is therefore satisfied by certifying this same 5-prop set as complete and
mapping how it dresses every room that needs one (below) — not by adding
prop types the sheet never depicted.

## Room coverage (docs/design/14-vertical-slice.md §10)

| Room | Cover need | Hiding need | Pack props used |
|---|---|---|---|
| Ground Relay | — (open floor, no entity) | one dedicated spot present but unnecessary (teaches the object) | `locker_v1` or `server_rack_v1` |
| Records Room | — (no entity) | — | none |
| Power Substation | 2–3 transformer housings (Watcher, sight-cone only) | one spot near the panel, fallback | `relay_cabinet_v1` / `crate_stack_v1` / `low_duct_v1` (cover); `locker_v1` (hide) |
| Equipment Floor | clutter aids routing, not concealment (Sound isn't blocked by cover) | one spot (crawlspace-equivalent) | `server_rack_v1` (hide) |
| Storage Cache | — (no/low danger) | — | none |
| Antenna Shaft | — (Still Air has no LOS; cover doesn't help) | at least one alcove, the room's only safety valve | `locker_v1` (hide) |
| Broadcast Deck | — (no entity) | — | none |

Only Power Substation's Watcher has a sight cone, so cover props are only
gameplay-relevant there; the same three cover sprites can still dress
Equipment Floor as non-blocking clutter. Hiding spots (block *all*
sensors) are needed in four rooms and are satisfied by reusing the two
hide-class sprites — this is standard prop-pack reuse, not per-room unique
art, and matches P-2 (one card = one set = one `art/*` branch).

## Measured 16px value separation (per prop, not just class means)

BT.601 luminance after downscaling each sprite to 16px on its longest side
(`test_signal_tower_prop_pack.py::_downscale_to_game_16px`), as measured
by T-0223 (commit `b326876`, `ASSET_PROVENANCE.md`'s locker row):

| Prop | Class | Luma16 |
|---|---|---|
| `low_duct_v1.png` | cover | 169.4 |
| `crate_stack_v1.png` | cover | 112.9 |
| `relay_cabinet_v1.png` | cover | 110.7 |
| `locker_v1.png` | hide | 82.0 |
| `server_rack_v1.png` | hide | 81.6 |

Every (cover, hide) pair, not just the class-mean or the closest pair:

| Cover | Hide | Gap |
|---|---|---|
| low_duct | server_rack | 87.8 |
| low_duct | locker | 87.4 |
| crate_stack | server_rack | 31.3 |
| crate_stack | locker | 30.9 |
| relay_cabinet | server_rack | 29.1 |
| relay_cabinet | locker | 28.7 |

Minimum pair gap: **28.7** (relay_cabinet vs. locker), well above the
required **+15.0** floor. This card adds
`test_each_cover_hide_pair_meets_min_gap`, which asserts and reports every
row of this table individually (not only the min/max pair the pre-existing
`test_cover_vs_hiding_distinguishable_at_16px` checks) — a regression in
any single prop now fails by name, not just by moving a class mean.

## What this card adds

1. **P-7 compliance** (`docs/decision-log.md`: generator resolvable +
   model_hash non-null + **concept_hash resolves**). `concept_hash`/
   `concept_source` were threaded through
   `tools/comfy-client/src/comfy_client/cutout.py` (`CutoutProvenanceRecord`,
   `generate_cutout()`) and backfilled onto all 5 committed provenance
   sidecars — metadata only, no pixel changes, so T-0223's measured values
   above are unaffected.
2. **P-3 compliance** ("anything regenerable is not committed... sources
   (`assets/src/` recipes)... are committed"). Neither T-0221 nor T-0223
   committed the script/data that built the per-prop `Recipe` that was
   submitted to ComfyUI — only the reusable engine (`cutout.py`) was
   committed. `assets/src/props/signal_tower_prop_recipes.py` closes this:
   it transcribes each prop's exact prompt/negative_prompt/seed/dimensions
   from the committed provenance, and
   `test_recipe_data_matches_committed_provenance` keeps the two from
   drifting apart.
3. **T-0215 visibility gate wired in for real.** `test_signal_tower_prop_pack.py`
   now imports and calls the actual `asset_gate.visibility.check_rendered_visibility`
   (via the same `tools/asset-gate/src` sys.path shim `assets/src/tiles`
   and `assets/src/character` already use), rather than only checking full
   opaque-pixel coverage as the pre-existing tests did.
4. **Per-prop, not just class-mean, value-separation reporting** (this doc's
   table above, backed by `test_each_cover_hide_pair_meets_min_gap`).

## Non-regression

No pixel data changed. `test_cover_vs_hiding_distinguishable_at_16px`,
`test_cover_classes_in_provenance_match_expected`, and every other
T-0221/T-0223 test are untouched and still assert against the same 5 PNGs.
