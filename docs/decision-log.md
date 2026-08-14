# Decision Log

> **Author:** Claude (Opus 5)
> Records design/asset decisions made during implementation, particularly
> where an asset/doc mismatch is resolved. Entries are permanent — do not
> remove or amend after the PR that introduced them is merged.

---

## DL-1 — Home palette green weighting and missing oxide/rust (T-0152)

**Date:** 2026-08-08
**Raised by:** 2026-08-06 Asset Pipeline E2E Review (HANDOFF.md §12.2, item §12-b)
**Resolved by:** T-0152

### Observation

`assets/final/palette/home_palette.json` (locked by T-0105) has 16 slots ordered
by Oklab lightness. Six slots fall in the green hue family:

| Index | Hex | Approx. character |
|---|---|---|
| 2 | `#0b2d18` | deep institutional green |
| 3 | `#123c23` | dark institutional green |
| 5 | `#224d32` | mid institutional green |
| 7 | `#4c553a` | desaturated olive |
| 9 | `#5a6042` | muted olive-green |
| 11 | `#616747` | muted olive-yellow |

**No warm-hue slot exists** (no oxide, no rust, no orange-brown). This
contradicts the `05-art-direction.md` §3 pre-T-0152 language which listed
"oxide and rust — the only warm notes" as a component of the home palette.

The review note flagged a mechanical consequence: `01-vision.md` §8 states
the chroma swap mechanic depends on the home palette being *desaturated*
relative to foreign objects. Six moderately saturated green slots were
claimed to "spend headroom" the mechanic depends on.

### Options considered

**Option A — Re-extract from a new oxide-bearing concept sheet.**
Would require generating a new material sheet whose prompt produces visible
rust/oxide clusters large enough for the clustering algorithm to isolate as
a distinct palette family. The existing concept sheet prompt
(`signal_tower_material_sheet.provenance.json`) did include "oxide" in the
prompt, but the generated image did not produce a distinct warm-hue cluster
at extraction time.

**Option B — Accept the shipped palette and amend `05` §3.**
Accept that the Signal Tower interior — the first extracted archetype — is
architecturally a painted-concrete interior with no oxide/rust surface
material. Amend the spec to reflect this.

### Decision

**Option B selected.** Rationale:

1. **The palette is correct for the archetype.** The Signal Tower is an
   interior institutional building. Painted concrete walls with institutional
   green are architecturally accurate; oxide and rust are surface/exterior
   phenomena that appear on uncovered steel, weathered concrete joints, and
   industrial fixtures — not inside a sealed operational tower.

2. **Re-extraction from the same sheet would produce the same result.** To
   get oxide/rust into the home palette the generation must be seeded from a
   concept sheet whose subject genuinely contains those materials (e.g. a
   warehouse, a surface facility, an exterior stairwell). That is a different
   archetype, not a corrected version of this one.

3. **The design spec was too broad.** `05` §3 described the home universe
   palette as if all archetypes would share the same colour families. The
   extraction process (V-5) was always per-archetype; the language did not
   reflect that. Oxide/rust is a valid home-universe hue family — it will
   appear in surface/industrial archetypes — but it is not universally
   present across every archetype.

4. **The chroma mechanic calibration holds.** The green slots in the Signal
   Tower palette have chroma values of 27–43 (RGB max–min). Foreign objects
   whose palette slots exceed this threshold will read as visibly different
   from home. The mechanic's *calibration point* shifts (concrete-and-oxide
   baseline → muted-green baseline), but its *mechanism* is unchanged: the
   palette-index shader reads origin palette, substitutes the foreign LUT,
   saturation difference does the perceptual work. No shader code change is
   required; the foreign palettes simply need to be authored with chroma
   values clearly above ≈45 at similar lightness.

### Changes made

- `assets/final/palette/home_palette.json` — added `"character"` block
  (`dominant_family: "green"`, `warm_notes: false`) for machine-readable
  palette characterisation and alignment testing.
- `docs/design/05-art-direction.md` §3 — amended to reflect the shipped
  palette character: oxide/rust noted as archetype-dependent (not universal),
  Signal Tower palette described accurately, chroma calibration note added.
- `assets/src/palette_check/` — new minimal pytest package with three tests
  that enforce palette/doc alignment going forward (T-0152 TDD).

### Follow-up

When a surface or industrial archetype's concept sheet is approved and
extracted, that palette will carry warm slots. At that point, verify:
- The clustering output contains at least one oxide/rust cluster.
- The chroma mechanic calibration note in `05` §3 remains consistent with
  that archetype's palette character.

No blocker on current Phase 6 work — the Signal Tower vertical slice palette
is correct for its archetype.

---

## DL-2 — Localization mechanism (17)

**Date:** 2026-08-02

**Localization mechanism** (`17`). `FText`-style type split — `LocId` cannot
render, display text cannot travel the wire; seed-phrase wordlist is
structurally exempt. **Templates take named arguments** (positional cannot
survive translation — change needed in `02` §2). ICU replaced by two rules:
**no numbers inside sentences**, and a **telegraphic, grammatically inert
register**. **V-6 resolved: English + Russian**

**Touched docs:**
- `docs/design/02-notes-system.md`
- `docs/design/03-net-protocol.md`
- `docs/design/07-items-economy.md`
- `docs/design/13-asset-pipeline.md`
- `docs/design/17-localization.md`

---

## DL-3 — Climax rooms

**Date:** 2026-08-02

**Climax rooms.** A room type carrying a rare or unique. Framed as a
**delivery point, not a source** — draws from the capped pool, same precedent
as puzzle rewards and tear pockets, so INV-6 holds. Surfaces the highest-tier
item currently hosted in your universe; guaranteed-if-available. Suggested
cap: one per archetype. **First named room type** — seed for the level-design
doc

**Touched docs:**
- `docs/design/07-items-economy.md`
- `docs/design/11-moment-to-moment.md`
- `docs/design/13-asset-pipeline.md`
- `docs/design/14-vertical-slice.md`

---

## DL-4 — Run structure

**Date:** 2026-08-02

**Run structure.** 5–8 rooms per archetype; **3 archetypes per run** (floor
and ceiling both 3); assembler caps the run at **18 rooms**, selecting
size-aware. Run length stays 30–45 min because held bleed is defined as ≈2× it

**Touched docs:**
- `docs/design/01-vision.md`
- `docs/design/03-net-protocol.md`
- `docs/design/08-invariants.md`
- `docs/design/12-tears.md`
- `docs/design/13-asset-pipeline.md`
- `docs/design/14-vertical-slice.md`
- `docs/HANDOFF.md`

---

## DL-5 — Concept art precedes generation

**Date:** 2026-08-02

**Concept art precedes generation.** Source not output, one sheet per asset
set, conditions inference, two human gates. **V-5 resolved** — palette is
extracted from an approved sheet (T-0105), not chosen. P-A resolves with it

**Touched docs:**
- `docs/design/05-art-direction.md`
- `docs/design/13-asset-pipeline.md`
- `docs/GDD-OPEN.md`
- `docs/HANDOFF.md`

---

## DL-6 — Item hosting

**Date:** 2026-08-02

**Item hosting.** An anchored instance lives in exactly one universe
(`hosted_by`); offerings stay globally visible. Escrow becomes the only
genuine contention point. NP-2 resolved

**Touched docs:**
- `docs/design/03-net-protocol.md`
- `docs/design/04-data-model.md`
- `docs/design/07-items-economy.md`

---

## DL-7 — Server topology

**Date:** 2026-08-02

**Server topology.** Federation seams built now, single deployment until
after the slice. Sweep worker is a per-shard singleton. Uniques centrally
brokered; forks fully independent — **answers 7.5**

**Touched docs:**
- `docs/design/04-data-model.md`
- `docs/design/15-server-ops.md`

---

## DL-8 — Copy-on-write

**Date:** 2026-08-02

**Copy-on-write.** Volume snapshots for all shards; **append-only custody log
for uniques only**, affordable because uniques do not scale. `custody_depth`
becomes derived rather than incremented

**Touched docs:**
- `docs/design/07-items-economy.md`
- `docs/design/15-server-ops.md`

---

## DL-9 — Offline runs persist nothing

**Date:** 2026-08-02

**Offline runs persist nothing.** A security position, not a simplification —
sync-on-reconnect would mean accepting client-asserted progress from an
open-source client

**Touched docs:**
- `docs/design/01-vision.md`
- `docs/design/03-net-protocol.md`

---

## DL-10 — Level design framework (16)

**Date:** 2026-08-03

**Level design framework** (`16`). Room-type taxonomy — Climax, Tear own
dedicated system-facing tags; Gate, Hazard, Transit are author-facing roles
on ordinary room tags. Placement budget: Tear exactly 1/archetype, Climax ≤1,
Gate recommended ≥1, Hazard/Transit flexible. **Entities are rolled
per-universe onto authored sensor-category slots**, not fixed per variant.
Variant authoring split into fixed (tag set, room count) vs. free
(connectivity, dressing, role placement) — unblocks A-3's cost estimate

**Touched docs:**
- `docs/design/01-vision.md`
- `docs/design/11-moment-to-moment.md`
- `docs/design/12-tears.md`
- `docs/design/14-vertical-slice.md`
- `docs/design/16-level-design.md`

---

## DL-11 — First-run experience (18)

**Date:** 2026-08-03

**First-run experience** (`18`). Phrase auto-saved to a local text file on
generation, no manual export (**S-3 resolved**); reveal screen requires
explicit acknowledgment, names phrase-loss and collapse as distinct endings.
Chroma-clock explained once, in text, only after a baseline exploration
window — first-universe grace multiplier stays invisible to the player.
Offline signaling required pre-play, during, and at session end. Core loop
taught by room design (Ground Relay pattern), never by tutorial popups

**Touched docs:**
- `docs/design/09-identity.md`
- `docs/design/18-first-run.md`

---

## DL-12 — Vertical-slice walkthrough: tears now chain archetypes

**Date:** 2026-08-03

**Full vertical-slice walkthrough review surfaced a real gap: tears now chain
archetypes.** Records Room (`14`) switched from item-locked to puzzle-locked,
resolving an entry circularity; its climax reward (renamed **Resonance Key**)
now opens Broadcast Deck's tear — reclassified a **chain tear**. `12` §3a
formalizes chain vs. pocket tears: archetypes 1–2 in a run's sequence chain
onward via a unique-keyed unlock (home palette, not foreign); the terminal
archetype gets a free pocket tear (genuinely foreign). Vertical slice expanded
to all 3 archetypes — **Signal Tower (7) → Hospital (5, `19`) → Long Descent
(6, `20`)**, summing to exactly 18 rooms. Trap/lock demoed for the first time
(Hospital's Stairwell). Dead Frequency Room and its foreign Watcher reused
wholesale as Long Descent's terminal pocket. Also: V-7 resolved (vertical
slice now spans `14`/`19`/`20`); **Try Again/New Game** post-run screen added
to `01` §6 (Try Again re-assembles the same archetype selection); solo-testing
scope note added to `14`

**Touched docs:**
- `docs/design/01-vision.md`
- `docs/design/12-tears.md`
- `docs/design/14-vertical-slice.md`
- `docs/design/16-level-design.md`
- `docs/design/19-vertical-slice-hospital.md`
- `docs/design/20-vertical-slice-long-descent.md`

---

## DL-13 — Chain-tear key changed unique → rare-tier

**Date:** 2026-08-04

**Chain-tear key changed unique → rare-tier.** The pipeline chat flagged that
a 3-archetype run spends two unique-tier keys, competing with the exit
condition's own fixed pool (`01` §5); T-0099 round 2 confirmed the pool
doesn't drain either way but couldn't confirm simultaneous-possession still
works. Rare-tier removes the risk at the source rather than waiting on round
3, and — since rares participate in the ordinary spawn pool — lets Records
Room/Nurses' Station drop the Climax/hosting-model mechanism entirely in favor
of ordinary puzzle rewards, fully retiring the debug-grant dependency.
Persistence confirmed ~1 week, identity/variant-scoped, not per-run. Transfer
semantics (vs. destroy) stated explicitly, backed by simulation: destroy
exhausts a 5-instance pool in ~1 hour/5 crossings, transfer sustained 2,032.
Two leftover contradictions in `12` (§3 trip-type table, §4 "always
crossable") fixed. Signal Tower and Hospital both lose their Climax rooms;
Long Descent's Storage Vault is now the vertical slice's sole example

**Touched docs:**
- `docs/design/12-tears.md`
- `docs/design/14-vertical-slice.md`
- `docs/design/16-level-design.md`
- `docs/design/19-vertical-slice-hospital.md`

---

## DL-14 — Propagation gap closed + INV-9 wording synced from git

**Date:** 2026-08-08

**Propagation gap closed + INV-9 wording synced from git.** `01` §7 still said
chain tears need a "held unique" four days after the tier changed to rare —
the one place the 08-04 fix never landed, and the premise `HANDOFF` §13's
independent population-scaling analysis (raised 08-06) was built on. Fixed;
population-scaling rationale folded into §7 directly. Separately, `08` §2/§3
synced to match `docs/design/08-invariants.md` (T-0157): INV-9 restated as
*distribution*-stability across `P`, not per-player similarity — wide
within-population variance is explicitly compatible, only a shift of the
distribution with `P` is a violation. Unblocks sim round 3's population-sweep
reporting (§13-a)

**Touched docs:**
- `docs/design/01-vision.md`
- `docs/design/08-invariants.md`

---

## DL-15 — LoRA handshake: Signal Tower material sheet direction confirmed (T-0167)

**Date:** 2026-08-09
**Raised by:** T-0167 (13-asset-pipeline.md §6.5)
**Resolved by:** T-0167

### Background

The Signal Tower material sheet (`assets/src/concept/signal_tower_material_sheet.png`),
from which T-0105 extracted `home_palette.json`, was generated with base SDXL
before the T-0072 style LoRA (`soviet_brutalism_style_v1.safetensors`) existed.
Per 13 SS6.5, the approved direction must be checked against the LoRA before
the transition tileset (T-0153, already done) bakes it in unexamined.

### Visual inspection of the original sheet

The material sheet was generated via img2img (denoise=0.9) conditioned on
`signal_tower_material_template.png` with this prompt:
> "brutalist concrete wall texture, worn concrete floor surface, wall-to-floor
> trim, muted concrete grey and oxide and institutional green, flat side-on
> reference sheet, no perspective, value-separated material panels, interior,
> weathered surface detail, rough stained concrete"

The generated output shows:
- **Wall panel:** Mid-grey ribbed concrete surface (~6–8 vertical ribs), highlight
  at top-centre fading to charcoal at lower-left — strong value separation ✓
- **Green accent stripe:** Deep institutional green running vertically on the wall,
  matching the `#123c23`–`#224d32` band of the extracted palette ✓
- **Wall-to-floor trim:** Near-black horizontal strip at the base of the wall,
  reads as a deliberate structural boundary ✓
- **Floor:** Muted olive-green (`#5a6042` range), flat, low-detail ✓

Overall: flat side-on framing, no atmospheric depth, strong value separation.
The sheet reads correctly as a surface-material reference rather than a scene.

### LoRA training-corpus characteristics

The T-0072 LoRA (`soviet_brutalism_style_v1`) was trained on 40 curated Wikimedia
Commons photographs of Soviet brutalist/constructivist architecture (CC-BY-SA).
The corpus is dominated by:
- Concrete grey surfaces (wall cladding, poured-in-place slab, precast panels)
- Institutional green paint (interior corridor walls, stairwells, equipment bays)
- Near-black shadow recesses (joints, overhangs, recesses)
- High value contrast — harsh directional light from above

This is the same color/material family as the approved concept sheet. The LoRA
trains on the reference corpus's *natural colour* (13 §3.2); it does not need to
be instructed toward the palette, it naturally produces output in that range
because the training subjects are in that range.

### Analytical direction assessment

Running the same prompt and conditioning source through the LoRA at weight 0.75
would shift the generation as follows:

| Feature | Expected LoRA effect | Direction risk |
|---|---|---|
| Concrete grey wall texture | **Strengthened** — concrete is the LoRA's primary training signal; texture reads closer to real material | None — same value range |
| Institutional green stripe | **Preserved or deepened** — green is well-represented in corridor/interior shots | None — already in palette |
| Wall-to-floor trim boundary | **Preserved** — strong structural boundaries common in brutalist construction photography | None |
| Floor olive-green | **May shift slightly warmer/darker** — floors in the corpus tend toward stained concrete, not uniform green | Low — still within the extracted palette family |
| Overall value contrast | **Unchanged or improved** — harsh value separation is characteristic of the training corpus | None |
| Illustration flatness | **Slightly reduced** — LoRA pulls toward photographic realism; img2img at denoise=0.9 retains strong structural template | Low — does not affect palette or direction |

**Verdict: direction CONFIRMED.** The approved concept direction (concrete grey +
institutional green + near-black trim + muted floor, flat side-on, value-separated)
is fully within the LoRA's training distribution. The LoRA cannot diverge from
this direction without diverging from its own training data.

**Palette re-extraction not required.** Even under the most pessimistic scenario —
the LoRA shifts the floor tone toward stained concrete rather than uniform
olive-green — the shift would remain within the green/grey family that T-0105
already extracted. The palette's 16 slots, ordered by Oklab lightness, cover this
range. The dominant green family (DL-1) is exactly what the LoRA reinforces.

### T-0153 (transition tileset) impact assessment

T-0153's transition tiles are **procedurally generated** using `home_palette.json`
index slots (WALL=8, FLOOR=13, JOINT=4). They do not reference any pixel values
from the concept sheet directly — only the palette indices it produced. Since:

1. The LoRA direction is confirmed (no divergence)
2. The palette was already locked by T-0105 prior to T-0153
3. The tile generator uses index mapping, not color sampling from the concept sheet

**No impact on T-0153.** The transition tileset does not need revision. If future
archetype sheets are generated through the LoRA and produce a palette that
diverges significantly from `home_palette.json`, that would be caught by the
palette-doc alignment gate (T-0152 / `assets/src/palette_check/`) — not by
revisiting T-0153.

### Visual comparison: original vs LoRA-conditioned output

**Both images (`signal_tower_material_sheet.png` and `signal_tower_material_sheet_lora.png`)
were inspected side by side after actual generation through ComfyUI
(`prompt_id: 437d1d57-0543-4e81-9384-5da7a5f5ce43`, ComfyUI 0.29.0, RTX 3070 Ti).**

The two files are byte-distinct (SHA-256 differ:
- original:  `9660a2c64d5695cb8657c76cd4e29fb0fc4c992435140047f8b0dca910036460`
- LoRA run:  `0366e6c1176b5f0cbd61e234e5fe44ba097472db855d260ca485ed041bf4880d`

Key observations:

| Feature | Original (base SDXL) | LoRA-conditioned output | Change |
|---|---|---|---|
| Concrete grey wall panels | Cool silver-grey, fine ribbed texture (~6–8 ribs), strong highlights | Warmer/slightly brownish-grey, broader panels with fewer fine ribs, more matte surface | Subtle warm shift; same value range ✓ |
| Institutional green accent stripe | Deep green, sharp vertical accent on right third | Preserved — same hue family, marginally less saturated, approximately same width | Within approved palette ✓ |
| Wall-to-floor trim (near-black strip) | Dark structural horizontal band | Preserved — same dark tone and structural read | No change ✓ |
| Floor surface | Uniform muted olive-green | Two distinct tonal zones side by side (left: olive-green, right: cooler grey-green) with a visible seam | Tonal variation; both tones within the extracted palette range ✓ |
| Flatness / no perspective | Flat side-on, no depth | Flat side-on, no depth | No change ✓ |
| Value separation (squint test) | Reads clearly at 10% downscale | Reads clearly at 10% downscale | No change ✓ |
| Shadow ghost (left panel) | Subtle dark vertical smear on left wall panels | Preserved — same compositional element | No change ✓ |

**Direction: CONFIRMED — no divergence.** The LoRA-conditioned output remains within
the approved material vocabulary (concrete grey + institutional green + near-black trim
+ muted floor, flat side-on, value-separated). The LoRA subtly warms and flattens the
concrete texture and introduces slight floor tonal variation — both shifts are within
the range already represented in `home_palette.json`.

**Palette re-extraction not required.** The floor tonal split (olive-green + cooler
grey-green) lies within the grey-green cluster already extracted by T-0105. The green
and near-black values are unchanged. `home_palette.json` remains valid as the pipeline
palette input.

### Changes made

- `assets/src/concept/signal_tower_material_sheet_lora.recipe.json` — LoRA-conditioned
  recipe for the handshake generation (same prompt/seed/conditioning as original,
  plus `lora_name`, `lora_weight`, `conditioning_source`)
- `assets/src/concept/signal_tower_material_sheet_lora.png` — LoRA handshake artifact
  (generated via ComfyUI 0.29.0, prompt_id: `437d1d57-0543-4e81-9384-5da7a5f5ce43`)
- `assets/src/concept/signal_tower_material_sheet_lora.provenance.json` — provenance
  sidecar with LoRA metadata, hashes, and generation note
- `assets/src/lora_handshake/` — TDD gate tests gating on recipe + PNG + provenance
  existence and structural correctness
- `ASSET_PROVENANCE.md` — provenance row for `signal_tower_material_sheet_lora.png`
- This decision log entry

### Generation details

- **ComfyUI version:** 0.29.0 (Windows host, RTX 3070 Ti Laptop GPU)
- **ComfyUI URL:** `http://172.18.192.1:8188` (WSL2 gateway to Windows host)
- **LoRA file:** `soviet_brutalism_style_v1.safetensors` confirmed present in `models/loras/`
- **prompt_id:** `437d1d57-0543-4e81-9384-5da7a5f5ce43`
- **Workflow:** `assets/src/lora_handshake/submit_payload.json`
- **Template sha256:** `61de4b16d30b8b61edc33109a4007ade5453565a183a67d195184371a8c13540`
- **Output sha256:** `0366e6c1176b5f0cbd61e234e5fe44ba097472db855d260ca485ed041bf4880d`

### Follow-up

- [x] Start ComfyUI on Windows host (accessible via WSL2 gateway `172.18.192.1:8188`)
- [x] Run the handshake recipe (`signal_tower_material_sheet_lora.recipe.json`)
- [x] Write provenance sidecar (`signal_tower_material_sheet_lora.provenance.json`)
- [x] Update `ASSET_PROVENANCE.md` pending row with actual `prompt_id`
- [x] Visually confirm the generated sheet matches the analytical verdict above
- [x] Run `assets/src/lora_handshake/` tests to green
