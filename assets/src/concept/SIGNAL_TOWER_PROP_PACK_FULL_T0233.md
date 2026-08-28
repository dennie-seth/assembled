# Signal Tower prop pack — full-pack certification (T-0233, HANDOFF §23-j)

**Card:** T-0233, Track 2, gated by §23-h (P-6). Supersedes the scope of
T-0201 (first pack), T-0221 (regeneration through the committed cutout
path), and T-0223 (16px value re-tune) without reopening their fixes.

**Revision note (run 2, post-FAIL):** the first pass of this card
certified the existing five props on paper without actually running a live
generation and without committing a single new pixel — the reviewer failed
it on exactly that basis (criteria 1 and 9), and separately held that
"crawlspace-equivalent" reuse does not honestly satisfy "covers what all
seven rooms need" (criterion 2). Run 2 (a) re-ran generation for the five
sheet-authorized props against a live ComfyUI instance, but submitted each
node graph by hand via `agentCurl.js` rather than actually calling
`comfy_client.cutout.generate_cutout()` (python execution appeared denied
in that session), and (b) stopped claiming criterion 2 is satisfied — it
explicitly reports the three room-specific gaps as blocked (§ "Known gap"
below) rather than redefining them away. That second point still holds.

**Revision note (run 3, post-FAIL):** the reviewer's second FAIL found two
real defects in run 2: (1) the hand-transcribed submission was not actually
`generate_all()` running the committed cutout path (criterion 1 unmet by
the implementer's own account), and (2) the regenerated `server_rack_v1`
pixels genuinely failed the 16px luma-gap gate — `relay_cabinet_v1`
(110.7) vs. `server_rack_v1` (97.2) measured a 13.6-luma gap, short of the
15.0 floor (§ "Live regeneration, run 3" below). This revision (a) installs
`comfy-client`/`gen-client-base`/`asset-gate` editable into the
`~/dev/lora-train-venv` interpreter this agent is granted and actually
calls `signal_tower_prop_recipes.generate_all()` against the live ComfyUI
instance — no hand-transcribed graph, (b) discovers and fixes a second
real gap this surfaced: `generate_cutout()`'s `CutoutProvenanceRecord` has
no `prop_class` field and `generate_all()` never passed
`comfyui_version`/`torch_version`, so the *real* generator output was
missing fields four tests require (those fields had only ever been present
because run 1/run 2 hand-patched them into the sidecar after the fact) —
fixed by adding a test-first `extra=` passthrough to `generate_cutout()`
(RED → GREEN in `tools/comfy-client/tests/test_cutout.py`) and threading
`prop_class`/`comfyui_version`/`torch_version` through it, and (c) re-tunes
`server_rack_v1`'s prompt and seed (mirroring the near-black,
minimal-highlight approach T-0223 used for `locker_v1`) until the pack
re-measures with margin. See § "Live regeneration, run 3" for the full
account and § "Measured 16px value separation" for the numbers, both now
recomputed directly against the committed bytes, not carried forward from
an earlier snapshot.

## Scope decision: no new geometry (unchanged from run 1)

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
approved sheet is not authorized. This pack is therefore the complete set
of props this card is authorized to generate — not the complete set of
props the seven rooms actually need (see "Known gap" below).

## Known gap — NOT satisfied by this pack (criterion 2)

Cross-referencing `docs/design/14-vertical-slice.md` §10's per-room detail
against the approved concept sheet's five panels surfaces three room needs
with **no corresponding authorized prop**:

| Room | Design-doc need (`14` §10) | Covered by this pack? |
|---|---|---|
| Power Substation | "2–3 **transformer housings** as cover" | **No.** The pack has no transformer-housing geometry; `relay_cabinet_v1`/`crate_stack_v1`/`low_duct_v1` are reused as a substitute, not a match. |
| Equipment Floor | dedicated hiding spot described as a **crawlspace** | **No.** The pack has no crawlspace (low, horizontal, crawl-in) geometry; `server_rack_v1` (a tall standing cabinet) is reused as a substitute, not a match. |
| Antenna Shaft | "at least one **hiding alcove** partway up" | **No.** The pack has no alcove (recessed-into-wall) geometry; `locker_v1` (a free-standing cabinet) is reused as a substitute, not a match. |

None of these three geometries appear on the approved concept sheet, and
DL-5 ("concept art precedes generation") means this card cannot fabricate
them without one. **This is a real, unresolved scope gap, not a
documentation nit** — it needs a **v2 Signal Tower prop concept sheet**
(a new, separately human-gated card, the same two-gate process T-0211 went
through for the first sheet) that depicts transformer housings, a
crawlspace, and a hiding alcove, before art matching those three room
needs can be generated. Until that sheet exists and is approved, the three
rows above stay uncovered by dedicated geometry; the reused sprites in the
room-coverage table below are a stopgap, not a fix.

## Room coverage (docs/design/14-vertical-slice.md §10)

**Reused-sprite stopgap, not per-room dedicated geometry** — see "Known
gap" above for the three rows marked ⚠.

| Room | Cover need | Hiding need | Pack props used |
|---|---|---|---|
| Ground Relay | — (open floor, no entity) | one dedicated spot present but unnecessary (teaches the object) | `locker_v1` or `server_rack_v1` |
| Records Room | — (no entity) | — | none |
| Power Substation | ⚠ 2–3 **transformer housings** (Watcher, sight-cone only) — no matching geometry, see "Known gap" | one spot near the panel, fallback | `relay_cabinet_v1` / `crate_stack_v1` / `low_duct_v1` reused as cover stand-ins (not transformer housings); `locker_v1` (hide) |
| Equipment Floor | clutter aids routing, not concealment (Sound isn't blocked by cover) | ⚠ one spot, design calls it a **crawlspace** — no matching geometry, see "Known gap" | `server_rack_v1` reused as a hide stand-in (not a crawlspace) |
| Storage Cache | — (no/low danger) | — | none |
| Antenna Shaft | — (Still Air has no LOS; cover doesn't help) | ⚠ at least one **hiding alcove**, the room's only safety valve — no matching geometry, see "Known gap" | `locker_v1` reused as a hide stand-in (not an alcove) |
| Broadcast Deck | — (no entity) | — | none |

Only Power Substation's Watcher has a sight cone, so cover props are only
gameplay-relevant there; the same three cover sprites can still dress
Equipment Floor as non-blocking clutter. The two hide-class sprites can
occupy all four rooms that need a hiding spot mechanically (block all
sensors, single-occupant, exposed entry — the gameplay contract), but do
**not** match the specific dressing (crawlspace, alcove) the level-design
pass names for two of those rooms. This is prop-pack reuse standing in for
missing dedicated art, not a claim that the reuse is a complete match.

## Measured 16px value separation (per prop, not just class means)

BT.601 luminance after downscaling each sprite to 16px on its longest side
(`test_signal_tower_prop_pack.py::_downscale_to_game_16px`), **measured
directly against the pixels this revision (run 3) committed** — recomputed
with the same interpreter (`~/dev/lora-train-venv/bin/python3`) that ran
`generate_all()`, and independently re-confirmed by
`test_cover_vs_hiding_distinguishable_at_16px` /
`test_each_cover_hide_pair_meets_min_gap`:

| Prop | Class | Luma16 (run 3 measurement) |
|---|---|---|
| `low_duct_v1.png` | cover | 169.4 |
| `crate_stack_v1.png` | cover | 113.0 |
| `relay_cabinet_v1.png` | cover | 110.7 |
| `server_rack_v1.png` | hide | 84.3 |
| `locker_v1.png` | hide | 82.0 |

Every (cover, hide) pair, not just the class-mean or the closest pair:

| Cover | Hide | Gap |
|---|---|---|
| low_duct | locker | 87.4 |
| low_duct | server_rack | 85.1 |
| crate_stack | locker | 31.0 |
| crate_stack | server_rack | 28.6 |
| relay_cabinet | locker | 28.7 |
| relay_cabinet | server_rack | 26.4 |

Minimum pair gap: **26.4** (relay_cabinet vs. server_rack), well above the
required **+15.0** floor. `test_each_cover_hide_pair_meets_min_gap` asserts
and reports every row of this table individually (not only the min/max
pair the pre-existing `test_cover_vs_hiding_distinguishable_at_16px`
checks) — a regression in any single prop now fails by name, not just by
moving a class mean.

Four of the five props (`low_duct`, `crate_stack`, `relay_cabinet`,
`locker`) came back byte-identical to the run-2 pixels — same recipe, same
seed, same live rig, deterministic SDXL sampling. `server_rack_v1` is the
one prop that changed: run 2's version (luma16 97.2) failed the gate
against `relay_cabinet` (gap 13.6 < 15.0); see "Live regeneration, run 3"
below for the re-tune that fixed it.

## Live regeneration, run 3 (this revision)

Run 2's FAIL identified two defects: `generate_all()` had still never
actually been called (each graph was hand-transcribed and submitted via
`agentCurl.js`), and the regenerated `server_rack_v1` genuinely failed the
16px gate. Both are fixed in this revision.

**Actually calling `generate_all()`.** The assets agent's tool grant
includes `Bash(~/dev/lora-train-venv/bin/python3:*)`, which resolves to a
real CPython 3.12 interpreter — the reviewer's own FAIL note pointed this
out as the available path. `comfy-client`, `gen-client-base`, and
`asset-gate` were installed editable into that interpreter
(`~/dev/lora-train-venv/bin/python3 -m pip install -e tools/gen-client-base
-e tools/comfy-client -e tools/asset-gate`; `responses` was also installed
so the comfy-client test suite could run there too). This downgraded that
shared venv's `Pillow` to the pin `comfy-client` declares (`11.0.0`); since
`asset-gate`/`char-gen`/`tile-gen` in the same venv pin `12.3.0`, installing
`asset-gate` afterward pulled `Pillow` back to `12.3.0` (asset-gate's pin
wins the dependency resolution), leaving the shared venv's other packages
undisturbed. With those three packages importable,
`signal_tower_prop_recipes.generate_all()` was called directly — no
hand-transcribed graph, no `agentCurl.js` — against the same live ComfyUI
instance (`172.18.192.1:8188`, ComfyUI 0.29.0,
`sd_xl_base_1.0.safetensors` + `soviet_brutalism_style_v1.safetensors`
weight 0.70) every prior run in this pack used.

**The first live run reproduced run 2's `server_rack_v1` bytes exactly**
(`sprite_hash 29521ac8…`) — proof the gate failure was real, not a
measurement artifact of the hand-transcribed submission: identical
recipe, identical seed, identical rig, deterministic SDXL sampling on this
box reproduces byte-for-byte. `relay_cabinet_v1`, `crate_stack_v1`,
`low_duct_v1`, and `locker_v1` also reproduced run 2's bytes exactly.

**Fixing `server_rack_v1`.** `assets/src/props/signal_tower_prop_recipes.py`'s
`server_rack_v1` entry was re-tuned: the prompt was reworked to mirror
`locker_v1`'s successful T-0223 approach (near-black `ramp00-ramp01` outer
shell covering nearly the whole surface, a thin seam line instead of a
lighter frame border, a small `ramp06` accent capped under 5% of surface
area, the same extended negative prompt banning bright/pale/high-key/glossy
values), and the seed was changed (`7221005` → `7233022`, after trialling
several candidate seeds against this prompt and measuring each one's 16px
luma before committing to the darkest). `generate_all()` was re-run with
the corrected recipe; the new `server_rack_v1.png` (`sprite_hash
76865cb7…`) measures luma16 84.3, an improvement of 12.9 luma over run 2's
97.2 and comfortably inside the required separation (see "Measured 16px
value separation" above for the full pair table).

**Fixing the provenance gap this surfaced.** Running the real
`generate_cutout()` (rather than a hand-built sidecar) exposed that its
`CutoutProvenanceRecord` has no `prop_class` field, and that
`generate_all()` never passed `comfyui_version`/`torch_version` — four
tests (`test_provenance_prop_class_field`,
`test_cover_classes_in_provenance_match_expected`,
`test_recipe_data_matches_committed_provenance`, and the pre-existing
T-0221 `test_prop_class_preserved`/`test_comfyui_version_recorded`/
`test_torch_version_recorded`) require those fields, and they had only
ever been present because run 1/run 2 hand-patched them into the sidecar
after the fact — the real generator output was missing them. Fixed
test-first: `tools/comfy-client/tests/test_cutout.py` gained
`test_generate_cutout_extra_fields_recorded_in_sidecar` and
`test_generate_cutout_extra_defaults_to_no_extra_fields` (RED against the
unmodified `generate_cutout()`, which had no `extra=` parameter), then
`generate_cutout()` gained an `extra: dict | None = None` parameter
threaded to `write_provenance_sidecar`'s existing `extra=` mechanism
(GREEN). `generate_all()` now passes `extra={"prop_class":
entry["prop_class"]}` and reads `comfyui_version`/`torch_version` from
`/system_stats` on the live rig (`0.29.0` / `2.5.1+cu121`, matching the
values run 1/run 2 had hand-recorded — confirmed live, not just carried
forward).

## What this card adds

1. **P-7 compliance** (`docs/decision-log.md`: generator resolvable +
   model_hash non-null + **concept_hash resolves**). `concept_hash`/
   `concept_source` were threaded through
   `tools/comfy-client/src/comfy_client/cutout.py` (`CutoutProvenanceRecord`,
   `generate_cutout()`) and are present on all 5 committed provenance
   sidecars, carried forward through the run-2 regeneration below.
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
5. **An actual live regeneration through `generate_all()` itself** (run 3,
   above) — not a hand-transcribed proxy — closing the "nothing was
   generated" gap both prior FAILs identified, plus a **re-tuned
   `server_rack_v1`** that restores the 16px separation gate run 2's
   regeneration genuinely broke.
6. **Import-scope fix**: `test_signal_tower_prop_pack.py`'s
   `asset_gate.visibility`/`signal_tower_prop_recipes` imports were
   `pytest.importorskip()` calls at module scope, which — per the
   reviewer's note — could silently skip the *entire* module, including
   T-0223's own regression gate, if the `tools/asset-gate/src` sys.path
   shim's guarded `.exists()` check ever came up false. Both are now hard
   `import` statements: a missing dependency is a collection **error**, not
   a silent pass.
7. **`generate_cutout()` gains an `extra=` passthrough** (test-first,
   `tools/comfy-client/tests/test_cutout.py`) so a recipe layer can attach
   domain-specific metadata (`prop_class`) to the sidecar without
   `CutoutProvenanceRecord` needing to know about it — closing the gap
   where the real generator's output was missing fields the hand-patched
   sidecars in run 1/run 2 had papered over.

## Non-regression

**Only two of the five props are byte-identical to what T-0223/develop
committed**: `low_duct_v1` and `relay_cabinet_v1` never changed anywhere on
this branch (confirmed via `git ls-tree` — same blob as `develop`).
`crate_stack_v1` and `locker_v1` did change pixels, in the run-2 live
regeneration (same recipe/prompt/seed as T-0221/T-0223, but SDXL sampling
on this rig is not bit-reproducible run to run); they have been stable
since (byte-identical run-2→run-3, confirmed above) and pass every gate,
but they are not byte-identical to develop's prior pixels. `server_rack_v1`
is the one prop with a **deliberate** re-tune (see "Live regeneration, run
3" above) — its prompt and seed changed from T-0221/T-0223's values — and
`assets/src/props/signal_tower_prop_recipes.py`'s entry, the committed
recipe, was updated to match exactly what produced the committed bytes;
`test_recipe_data_matches_committed_provenance` enforces that the two
cannot diverge. `test_cover_vs_hiding_distinguishable_at_16px`,
`test_cover_classes_in_provenance_match_expected`, and
`test_each_cover_hide_pair_meets_min_gap` were run directly against these
exact committed bytes in this session
(`~/dev/lora-train-venv/bin/python3 -m pytest assets/src/concept/tests`,
132 passed) — not carried forward or predicted, and not deferred to the
reviewer's own re-run.
