# 13 — Asset Pipeline

> **Author:** Claude · **Reviewed:** pending · **Status:** v5, art + audio + concept locked
> Related: `05-art-direction.md` (direction), `01-vision.md` §8 (chroma), `PLAN.md` Phase 6/7, `14-vertical-slice.md` (first concept subject)
> **Purpose:** how generated assets get from a prompt to a shipped file. `05` decides what it looks like; this decides how it is made.

---

## 1. Common Structure

Art and audio share the same skeleton. Only the middle differs. For art,
the chain now starts with **concept** (§6) — the home palette (V-5) is
extracted from an approved concept sheet, not chosen in the abstract, so
generation cannot begin until a concept exists and is approved.

```
[art only] concept    full-colour SDXL sheet -> human approves direction (§6)
kanban card (agent: assets|audio)
  -> recipe          workflow JSON + prompt + seed + model hash
  -> generate        ComfyUI /prompt -> poll /history -> fetch /view
  -> descend         to native format (§3.1 art, §4 audio)
  -> validate        machine-checkable gate (§2)
  -> provenance      ASSET_PROVENANCE.md row
  -> art/* branch    -> review -> human accepts -> done
```

### Three rules that constrain everything below

| # | Rule | Consequence |
|---|---|---|
| **P-1** | **Output ships as-is.** No hand editing, ever. | Rejection means *regenerate with an adjusted recipe*. A hand-edited PNG is unregenerable from seed, which would break both `ASSET_PROVENANCE.md` and the `assets/out/` gitignore policy (`PLAN.md` §2). |
| **P-2** | **One card = one set = one `art/*` branch**, merged whole. | Matches `PLAN.md` §2 binary policy. A set is a tileset, a prop pack, or one character. |
| **P-3** | **Anything regenerable is not committed.** | Sources (`assets/src/` recipes) and curated finals (`assets/final/`) are committed. Intermediates and **atlases** are not — see §3.6. |

P-1 is the demanding one. It relocates all quality burden onto the validation gate, because there is no manual repair step.

---

## 2. The Validation Gate

Since nothing is fixed by hand, acceptance must be machine-checkable. These are unit tests over output files and they should exist **before** the generation chain does — then generation becomes red→green rather than a taste argument.

| Check | Asserts |
|---|---|
| **Palette membership** | Output uses *only* colours in the locked palette. Exact set equality, no near-misses. |
| **Index semantics** | Index `N` means palette slot `N` in every asset. See P-4 below. |
| **Tile seamlessness** | Base-field tiles: left edge column == right edge column, top row == bottom row. Pixel equality. |
| **Transition adjacency** | Declared tile pairs match on their shared edge. |
| **Cell fit** | Sprite fits its cell, no bleed into neighbours. |
| **Orphan pixels** | Isolated single pixels below a count threshold. Downscale artifacts read as noise at 16px. |
| **Frame consistency** | Silhouette delta between adjacent frames within bounds. Catches identity drift. |
| **Atlas determinism** | Same input set → byte-identical atlas layout. |
| **Indexed preservation** | Packed atlas is still PIL mode `P` with the expected palette. Pillow silently converts to RGB on several operations. |

**Human review remains the terminal gate.** The agent takes a set to `review`; a person accepts or rejects. `done` stays human-only (`PLAN.md` Phase 2). The automated checks decide whether a set is *eligible* for review, not whether it is good.

---

## 3. Art

### 3.0 The load-bearing invariant

> **P-4 — Uniform index semantics.** Index `N` means palette slot `N`, at the same value-ramp position, in every tile, prop, and character frame in the game.

The chroma mechanic (`01` §8) renders foreign objects by swapping the palette LUT at runtime, keyed on `origin_palette`. A foreign object is *the same indices through a different palette strip*. If one asset's index 3 is mid-shadow and another's is a highlight, palette swapping produces garbage on some sprites and not others — and it will present as a shader bug for weeks before anyone suspects the assets.

Build-time check: every asset's index histogram falls inside the canonical slot set. Same class of check as INV-12, same place in CI.

**Consequence for storage:** assets are indexed PNGs. The palette is a separate 1D LUT texture, not baked into the image.

### 3.1 Descent chain

```
generate (SDXL + style LoRA, integer multiple of target)
  -> box/area downscale (exact integer factor)
  -> quantize to locked palette (Oklab/CIELAB, dithering OFF)
  -> cleanup (orphan pixels, edge repair)
  -> validate (§2)
  -> commit sprite to assets/final/
```

**Downscale is box/area averaging.** Nearest-neighbour discards ~99% of pixels and aliases badly; Lanczos rings and its halos quantize into visible garbage. Box averaging preserves the most information for the quantizer to work with.

**Dithering is off.** Dithering breaks index semantics and destroys the swap mechanic (P-4).

### 3.2 Palette enforcement

**Post-hoc quantization, palette-agnostic LoRA.**

The style LoRA (T-0072) trains on the reference corpus in its natural colour. Brutalist reference is already concrete, oxide, and institutional green, so output lands near the home palette without being instructed to. Quantization then assigns indices.

The practical win: **this decouples T-0072 from V-5.** The LoRA can be trained before the palette hex set is decided.

*Escalation path, if quantization error proves high on the first tileset:* retrain the LoRA on palette-quantized training data. Documented as a fallback, not the default.

### 3.3 Resolution

| | |
|---|---|
| Internal | **384×216**, 16:9 (V-4) |
| Tile | **16px** — divides 1024 exactly (×64) |
| Screen | 24 × 13.5 tiles |

**The half-tile band.** 216 ÷ 16 = 13.5. Author rooms on a **24×14 tile grid (384×224)**; the viewport shows 216 of it and the remaining 8px is non-gameplay bleed — floor thickness, ceiling shadow. Level design gets an integer grid; the band costs nothing.

**Display scaling is a runtime concern, never an asset one.** One native resolution, integer-scaled. Generating asset variants per display resolution would multiply the art budget and break the aesthetic.

> **Fixed viewport, integer scale, letterbox the remainder.** 1440p does not scale cleanly (×6 = 2304×1296), and the tempting fix — widening the viewport on non-integer ratios — is a **fairness problem**. In a side-on avoidance game, more horizontal sightline means seeing threats sooner. An ultrawide player would be mechanically advantaged. Never widen the viewport.

### 3.4 Tiles

| Kind | Strategy |
|---|---|
| **Base fields** (wall, floor, concrete) | Circular-pad / seamless sampling. Self-seamless for infinite repeat. |
| **Transitions** (corners, edges, wall→floor) | Generate as one sheet, slice. |

**Circular padding only makes a tile seamless with itself** — it does nothing for tile A abutting tile B. A brutalist interior is mostly transitions, so the sliced-sheet path carries most of the tileset.

Generation: **1024×1024 for a 16px tile (×64)**, or a sheet at an integer multiple.

### 3.5 Props and Characters

**Props:** grid sheet for small props (co-generation keeps style consistent across a pack); individual generations for large or hero props. Cutout via BiRefNet before descent.

**Characters — the hard class.** At 384×216 a figure is **40px tall**, so the pipeline optimizes for *silhouette clarity and stable proportion*, not detail. Nearly all generated detail is destroyed in the descent; what survives is shape and a few value blocks.

> **The player idle sheet ships from a deterministic script, not a diffusion model** (`docs/decision-log.md` DL-21/DL-24, scope: player idle state only — move/crouch-hide/die and foreign-entity states are unaffected and still follow this section's generative pipeline as written). A two-round bake-off (HANDOFF §23/§24) raced a co-generated-grid SDXL arm, a per-frame identity-LoRA arm, an img2img-chained arm, and a hybrid SDXL-plus-script arm against a hand-authored, seeded script drawing directly into palette-indexed arrays. The script won round 1 on cost; round 1's mechanical outcome was overridden on authorship grounds (locally-generated art is part of this game's identity, GPU time on owned hardware is not a real cost) and round 2 re-ran the generative path on a retrained single-costume identity LoRA — four independent mechanisms, none of which beat the script's own 0.072–0.112 frame-silhouette-delta result (DL-24). For the player idle state specifically, **deterministic synthesis is what handles it**, not a diffusion model stacked with pose conditioning and an identity LoRA; a generative path was pursued in good faith and did not close the gap. The committed reference sheet lives at `assets/final/character/player_idle_sheet_reference.png`.

| | |
|---|---|
| Figure height | **40px** (~5.4 on screen) |
| Cell | **48×48** (3 tiles; die state sprawls and needs the width) |
| Grid | **3×3** — 8 frames + 1 spare |
| Native sheet | 144×144 — **square, which matters** |
| Generation | **1152×1152 (×8)**; fallback **1008 (×7)** if 8GB strains |
| Per-cell generation | 384×384 (or 336×336 at ×7) |

Square grid keeps SDXL on its native aspect bucket. The 2:1 layouts a linear frame strip implies land off-bucket and degrade output.

**One sheet per animation state, not per character.** Co-generation guarantees identity *within* a state, which is where drift is most visible — a player will catch 1px head drift between adjacent walk frames and will not catch it between idle and die. Subsequent state sheets seed img2img from the idle sheet. ControlNet pose grid guides layout.

**Frame budget is a ceiling, not a uniform rule:**

| State | Frames | Note |
|---|---|---|
| idle | 4–6 | subtle drift |
| move | 6–8 | — |
| crouch-hide | 2–3 | a transition plus a held pose, not a cycle |
| die | 6–8 | — |

**Foreign entities use the same class and pipeline** — they are characters. They never die (`07` §8), so that state does not exist for them; they need idle, move, and a trapped/delayed pose. ~3 states × 6 ≈ 18 frames each.

Vertical-slice character volume: player 28 + three entities ~54 = **~82 frames**. Real input for A-2.

### 3.6 Atlas

**Per archetype** (Hospital tiles + props together), plus **one global character atlas** — the player exists in every archetype and entities come from a global roster, so characters are not archetype-scoped.

> **Atlases are build artifacts and are not committed.** Per-archetype atlases would otherwise be written by two different `art/*` branches — the tileset branch and the prop-pack branch — which violates `PLAN.md` §2 rule 3 (branches strictly additive, never touching the same binary). Committing individual sprites and packing in CI resolves it: branches only ever add files.

This moves **T-0074** from an authoring-time tool to a build step, and adds a determinism requirement — same inputs must produce byte-identical layout, or dev and CI disagree on sprite coordinates. Stable input sort; tested.

---

## 4. Audio

`AudioAgent` shares the base class with `AssetAgent` (`PLAN.md` T-0082). §1 and §2 apply unchanged; only the middle of the chain and the gate's assertions differ.

### 4.0 Audio is a mechanic, not ambience

The design has no HUD. Chroma carries the clock (`01` §8); sound carries the rest.

| Role | Why it is load-bearing |
|---|---|
| **Entity telegraph** | You cannot fight, only avoid. For an entity with no line-of-sight check (The Still Air, `11` §1), sound is the *only* warning. Unannounced arrival is unfair. |
| **Player noise feedback** | Running triggers The Sound's radius. The player must *hear* their own noise state or the mechanic is invisible. |
| **Foreignness** | Chroma says an object came from elsewhere. Sound must agree or the channels contradict. |
| **Collapse proximity** | Same parameter, same story. |

### 4.1 Layer stack

```
music cue        rare, room-anchored, ducks the bed
collapse layer   global, 4 stages, crossfade on collapse proximity
archetype bed    one per archetype, looping
SFX              procedural one-shots + generative textures
  -> foreign DSP applied per-source where origin_palette != home
```

> **P-5 — Gameplay SFX are never ducked.** Music ducks the ambience bed. It must not touch entity telegraph or player-noise feedback.
>
> Those cues are the fairness channel (§4.0). A player killed because a music cue masked an approach is a bug that will present as bad luck and be very hard to diagnose. Bus split is mandatory: **Ambience** (duckable), **Music**, **World SFX** (lightly duckable), **Gameplay SFX** (priority, never ducked).

*Suggestion for level design:* rooms tagged `music_cue` are probably the low-pressure ones — set-piece, discovery, breath. Music marking safety rather than competing with threat sidesteps the conflict entirely.

### 4.2 Music

Rare and deliberate. In a game that is otherwise ambient dread, music arriving should mean something happened — the same way the design spends every other scarce thing (1–3 tears per run, fixed-count uniques).

- **Placement: a room declares a `music_cue` anchor tag.** Same mechanism as notes, items, and tears. No new system, and INV-12's build check covers it for free.
- Level design places it. Not tear-triggered, not automatic.
- Ducks the archetype bed; bed stays audible underneath.
- Purely a level-asset property — **no schema impact, no server involvement.**

**Open (AU-1): per-run density cap.** A run assembles exactly 3 archetypes. If more than one carries `music_cue` rooms, music stops being rare. Same class of problem as note density; likely wants a cap or weighting in the assembler.

### 4.3 Archetype bed

One looping ambience per archetype. 12–15 total at full scope, 1 for the vertical slice.

### 4.4 Collapse layer

**Global, not per-archetype.** One drone/texture element, **4 generated stages**, crossfaded on collapse proximity — the same value that drives chroma intensity.

Per-archetype collapse variants would have meant 12–15 × 4 = **48–60 beds**. Global means **4 assets**.

It also reads better: the collapse is not the Hospital dying, it is the *universe* dying. It should sound the same everywhere, because it is the same thing.

Only two stages are audible at once (the crossfade pair) — stream, do not preload all four.

### 4.5 SFX

| Kind | Method | Tool |
|---|---|---|
| **Textures** — entity vocalizations, room events, drones | Generative | Stable Audio Open |
| **Short one-shots** — footsteps, switches, doors, item pickup | **Deterministic synthesis script** | numpy/scipy in `assets/src/` |

Generative models are weak at very short percussive one-shots; a 0.2 s footstep is harder for a diffusion model than a 30 s pad.

**"Procedural" means a seeded script rendering WAVs offline** — not runtime synthesis, not hand-designed sounds. This keeps one-shots inside P-1 and P-3: the recipe is the script plus its parameters, fully reproducible, no model, no licence question.

Use physically-inspired synthesis (noise burst → resonant filter → envelope for concrete footsteps), **not sfxr/Bfxr-style chiptune** — that aesthetic fights the brutalist realism.

### 4.6 Foreign transform

Runtime DSP keyed on `origin_palette`: pitch shift, ring mod, filter. The audio equivalent of the palette swap.

Because both read the same parameter, a foreign object's *sound* travels exactly as far as its colour does, and the two channels cannot drift out of sync.

### 4.7 Descent chain

```
generate (ACE-Step music | Stable Audio Open textures)
   or synthesize (deterministic script, one-shots)
  -> trim silence, remove DC offset
  -> loop-fold (deterministic crossfade at the seam)
  -> loudness normalize (EBU R128)
  -> encode
  -> validate ON THE ENCODED FILE
```

**Automated deterministic processing is not hand-editing.** The loop-fold step is to audio what palette quantization is to art: a reproducible transform inside the chain, not a manual repair. P-1 forbids the latter, not the former.

**Validate the encoded output, not the source.** Ogg Vorbis encoder padding changes the seam — a source that loops cleanly can encode into one that clicks.

| Format | Use |
|---|---|
| **WAV** 44.1 kHz | short one-shots; sample-accurate loop points |
| **Ogg Vorbis** | music, ambience, collapse layer (streamed, with explicit loop offset) |

### 4.8 Validation gate — audio

| Check | Asserts |
|---|---|
| **Loop seam** | Encoded file's start and end match within threshold. The audio analog of tile seamlessness. |
| **Integrated loudness** | EBU R128 target, per bus class |
| **True peak** | ≤ −1 dBTP |
| **Sample rate / bit depth** | Matches the format table |
| **Length bounds** | Within the recipe's declared range |
| **Leading/trailing silence** | Trimmed below threshold |
| **DC offset** | ~0 |
| **Determinism** | Same recipe + seed → byte-identical output (one-shots especially) |

---

## 6. Concept Art

> Full Notion doc is canonical; this is a concise repo summary.

**V-5 and P-A are RESOLVED, as a process rather than a fixed hex list.**
The home palette is *extracted* from an approved concept sheet, not chosen
in the abstract: cluster the sheet's colours to N, build a value ramp,
emit a LUT (**T-0105**). This unblocks the quantizer (T-0073) without
ever having debated a hex table directly — the palette is downstream of
the art, which is the more defensible ordering anyway.

**Concept art is a SOURCE, not output — the opposite of P-1/P-3 for every
other asset in this pipeline:**

| | Normal assets | Concept art |
|---|---|---|
| Colour | Indexed, locked palette | **Full-colour, never indexed/quantized** |
| Resolution | Descended to native (16px tiles, etc.) | **Full-res, as SDXL generated it** |
| Committed? | Only `assets/final/` (curated) | **Yes — `assets/src/concept/`, always** |

It is committed *because* it is a source: the palette-extraction step
(T-0105) and the archetype's LoRA/style conditioning both read back from
it later, so it has to persist past generation time the way a recipe does.

**Two human gates, not one:**
1. **Concept review** — before any recipe is written against an
   archetype, a human approves its concept sheet's direction (this is
   the gate T-0104's first output goes through).
2. **Set review** — the existing §2 gate, after descent, for conformance.

**The chain, per archetype:**
```
concept prompt -> base SDXL (T-0104, no descent, no quantize)
  -> human approves direction
  -> palette extraction (T-0105): cluster -> value ramp -> LUT
  -> [unblocks T-0073 quantizer for this archetype]
recipe -> generate -> descend -> validate -> provenance   (§1, as usual)
```

**Archetype-first coherence guard:** the first approved concept sheet
conditions the ones that follow (T-0106: IP-Adapter/img2img on the
approved sheet, not a bare prompt) — so an archetype's second and third
concept sheets stay visually coherent with the first instead of each
independently drifting. `concept_hash` (sha256 of the approved sheet)
rides in provenance for every downstream asset conditioned on it, the
same way `workflow_hash` already does for recipes.

**First subject: Signal Tower**, the vertical-slice archetype
(`14-vertical-slice.md`).

### 6.8 Key art vs. concept sheet

Two different things live under `assets/src/`, and conflating them stalls
the pipeline — key art doesn't condition generation, and a concept sheet
drawn in perspective doesn't produce a usable palette.

| | Key art | Concept sheet |
|---|---|---|
| **Purpose** | Establishes mood/direction, for humans | Conditions generation for one asset set |
| **Framing** | Composed scene, any angle | Flat side-on, matching the game camera |
| **Scope** | A place or a feeling | One set — a tileset, prop pack, or character |
| **Committed to** | `assets/src/keyart/` | `assets/src/concept/` |
| **Feeds the pipeline?** | No | Yes — IP-Adapter/img2img conditioning, `concept_hash` in provenance |
| **Feeds palette extraction (T-0105)?** | No | Yes — interior material sheets only, see §6.10 |

Both are worth producing. Key art sells the direction before an archetype
has any generation infrastructure behind it; a concept sheet is a poor
substitute for that because it's deliberately flat and un-atmospheric.
But only a concept sheet is a pipeline *input* — key art is reference for
people, not for the model.

### 6.9 Concept-sheet requirements

**Framing.** Flat side-on elevation, matching the game's fixed camera
(§3.3). No vanishing point, no receding walls, no three-quarter view — a
sheet that reads as a scene has already committed to a camera the game
doesn't have.

**No atmospheric depth.** No haze, no depth-of-field, no sky gradient.
Those sell mood in key art; in a concept sheet they're noise a value
study then has to fight through.

**Reference layout, not composition.** The sheet is panels of material
and object, laid out to be *read*, not a scene to be looked at: wall
surface, floor surface, a wall→floor transition, and 3–4 props.
Composition is a key-art concern.

**Legibility — the squint test.** What survives downscale to 16px is what
the sheet has to get right; by ordinary illustration standards it will
look underdetailed at full res, and that's correct. Downscaling the sheet
to ~10% scale and checking it still reads is a fast manual proxy for this
(automated proxy: T-0109).

**Detail density targets the tile, not the canvas.** A control panel is
~32×16px in the shipped game — three value blocks and a silhouette, not a
hundred switches. Draw detail for the size it will actually render at,
not the size it's generated at.

**Deliberate value separation.** Push darks dark and lights light. Value
study first, colour study second — palette extraction (§6.10) clusters
value-separated regions far more cleanly than a sheet sitting in one
narrow mid-value band.

### 6.10 Palette extraction (T-0105) — interior only

**Extract from interior material sheets only.** Exteriors introduce sky,
cloud, and foliage values that consume LUT slots the home palette
(concrete, oxide, institutional green, deep shadow) doesn't want. If an
exterior sheet must be used, mask sky and vegetation out before
clustering.

**Round-1 assessment (2026-08-02).** The two Signal Tower images produced
this round are **direction-approved** — the palette they imply lands in
the `05-art-direction.md` §3 family — but they are **key art, not concept
sheets**: perspective framing, detail density above what survives to
16px, a narrow mid-value band on the interior, and a sky/treeline on the
exterior that would skew clustering if fed to T-0105 as-is. They've been
relocated to `assets/src/keyart/` (§6.8) and do not feed palette
extraction.

**Next round, for the Signal Tower tileset:** a flat side-on sheet of
concrete wall surface, floor surface, a wall→floor transition, and 2–3
props at real relative scale — squint-legible, value-separated, interior
only.

### 6.11 Stitching — when and why not

Whether to stitch multiple references into one sheet depends on whether
the *arrangement* carries information, not on convenience.

| Use | Stitch? | Why |
|---|---|---|
| **Style conditioning** (IP-Adapter) | **No** — supply 2–4 curated references as separate weighted inputs | Stitching makes the model read grid seams and layout as content, not style |
| **Layout base** (img2img/ControlNet) | **Yes** | The arrangement *is* the information — a 3×3 character sheet, a sliced transition sheet, a tileset reference sheet |
| **LoRA training** | **Never** | Concept art doesn't train the LoRA at all — see below |

**Rule of thumb: stitch when the arrangement carries information; don't
when you only want style.**

**Concept art does not train the style LoRA.** Generated output amplifies
whatever artifacts are already in it, and a stitched collage would teach
the model to produce grids. T-0072 trains on the real reference corpus
(30–50 curated images), not on concept-art output. A later
project-specific LoRA fine-tuned on 30–50 *approved* concept sheets is a
documented escalation path, not something v1 does.

---

## 7. Open

| # | Question | Blocks |
|---|---|---|
| ~~**V-5**~~ | ~~Palette: colour count + hex values~~ — resolved above, extracted via T-0105 | — |
| ~~**P-A**~~ | ~~Slot count and value-ramp semantics for P-4~~ — resolved above, follows from the extracted ramp | — |
| **A-2** | Full asset inventory *(owned by `05` §5)* | Phase 6 scope |
| **A-3** | Variant authoring budget *(owned by `05` §5)* | V-9 |
| **A-4** | Chroma-intensity shader ramp vs. collapse proximity | Phase 6 |
| **A-5** | Bleed-alpha ramp (`07` §5) | Phase 6 |
| **P-B** | Orphan-pixel and silhouette-delta thresholds | tune on first set |
| **P-C** | ControlNet model choice for the pose grid | first character test |
| **AU-1** | Per-run music density cap (§4.2) | assembler |
| **AU-2** | LUFS targets per bus class | T-0083 |
| **AU-3** | Does audio carry *puzzle* information, or only threat/state? | `11` §3 puzzles |
| **AU-4** | Foreign-DSP transform curve vs. `origin_palette` distance | Phase 7 |
| **AU-5** | SFX inventory count | Phase 7 scope |

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | Initial — art pipeline locked; ships-as-is, indexed output, descent chain, character sheets, atlas as build artifact | Claude, rev. pending |
| 2026-08-02 | v2 — audio pipeline: layer stack, P-5 no-duck rule, global collapse layer, procedural one-shots, loop-fold chain, audio gate | Claude, rev. pending |
| 2026-08-02 | v3: tile size (A-1) recorded as resolved in `05` §5; ownership of A-2/A-3 clarified to avoid duplicate tracking | Claude, rev. pending |
| 2026-08-02 | v4: **V-5/P-A resolved as a process** — palette extracted from an approved concept sheet (cluster -> value ramp -> LUT, T-0105), not a fixed hex list; new §6 Concept Art (concept is a committed full-colour source, P-1/P-3 inverted, two human gates, archetype-first coherence guard); §1 chain now starts with concept for art | Claude, rev. pending |
| 2026-08-02 | v5: §6.8–§6.11 added, synced from canonical Notion doc 13 — key art vs. concept sheet split (`assets/src/keyart/` vs. `assets/src/concept/`, only the latter feeds the pipeline/palette extraction); concept-sheet framing/legibility/value-separation requirements; palette extraction is interior-only (mask sky/veg on exteriors); round-1 assessment of the two 2026-08-02 Signal Tower sheets as key art, not concept sheets; stitching rules (stitch layout, never style, never LoRA training) | Claude, rev. pending |
| 2026-08-08 | v5.1: §4.2 (AU-1) archetype-count corrected — a run assembles **exactly 3** archetypes (was “5–7”), matching `01` §7 and `12`; density-cap wording adjusted to “more than one” accordingly | Claude, rev. pending |
