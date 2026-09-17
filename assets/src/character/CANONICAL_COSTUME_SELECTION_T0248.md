# Canonical costume selection — T-0248 (HANDOFF §24-a, round 2)

**Author:** Claude (Sonnet 5)

## Decision

**Selected design: the institutional green coat costume**, the same design
already curated (out of T-0209's ~20-panel sheet) for `player_identity_v1`'s
6 front/back panels (`identity_curation_manifest_T0229.json`), and already
the established player silhouette elsewhere in the shipped pipeline (T-0212's
`player_idle_sheet_v2.png` prompt: *"institutional green coat/clothing"*;
T-0230's Arm C script draws the same green-coat/white-glove figure by
construction).

**Anchor reference panel: `ref_002`** (`identity_curation_manifest_T0229.json`
crop_box `[205, 245, 410, 500]`, view "front view, arms at sides") — already
committed at `assets/src/character/identity_refs/ref_002.png`. This is the
single panel used as the IP-Adapter conditioning image for every new view
generated in this card (`gen_identity_views_T0248.py`). One fixed anchor,
not several, is deliberate: round 1's diagnosis is that multiple panels
*read by the model as reference material* (T-0209's own sheet, several
designs) is what let the distribution drift; conditioning every new
generation off exactly one panel removes that degree of freedom for this
round's dataset the same way DL-21 pinned one shared IP-Adapter reference
across all three bake-off arms.

## Why this design, not the other two on the sheet

T-0209's sheet contains at least three visually distinct designs (see
`identity_curation_manifest_T0229.json`'s own `selection_rationale`):

1. **Institutional green coat, hooded, white gloves** — rows y≈245-755,
   panels 1-3 (front) and 1 (back). **Selected.**
2. **Tan/khaki wrap-and-satchel costume** — rows y≈500-1010, remaining
   front/back panels. Rejected: not used anywhere else in the shipped
   pipeline, and mixing it in is exactly the cross-design drift this card
   exists to eliminate.
3. **Grey/tan heavy-armour variant** — bottom row, y≈1010-1024. Rejected:
   same reason as (2); also the least "flat side-on concept" of the three,
   most likely to bias new IP-Adapter generations toward invented plating
   detail rather than the game's established silhouette.

Choosing (1) is not a fresh aesthetic judgement call made from scratch for
this card — it is continuity with what `player_identity_v1`, T-0212's
shipped idle sheet, and T-0230's Arm C generator already committed to. A
different choice here would silently fork the player's in-game identity
across the very pipeline stages this bake-off is trying to reconcile.

## What "one canonical design" means for this dataset vs. v1's

`player_identity_v1`'s 12 refs were *already* single-costume (all curated
from the same green-coat design) — see round-1 note above. What v1's
dataset lacked was **view diversity**: 6 base panels reduce to only two real
camera angles (front, back), each with minor pose variation, before
horizontal mirroring. This card's dataset (`identity_refs_v2/`) targets the
same one costume but real angle coverage: front, 3/4 front, profile, 3/4
back, back, plus pose variation (standing, slight crouch, walking
mid-stride, arm raised) at each — newly generated via SDXL + the T-0072
style LoRA + IP-Adapter conditioned on `ref_002`, not just cropped/mirrored
from the source sheet (which has no such angle coverage to crop from in the
first place). See `identity_curation_manifest_T0248.json` for the realized
set and what was dropped.
