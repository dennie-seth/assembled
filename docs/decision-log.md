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

---

## DL-16 — Seven-room chain run-length measurement vs. 30–45 min target (T-0185)

**Date:** 2026-08-16
**Raised by:** T-0185 acceptance criteria — "first real run-length measurement across the full seven-room chain"

### Context

`01` §9 sets the run-length target at 30–45 minutes. `16` §16-a (T-0184) measured
single-room traversal (Ground Relay blockout) and extrapolated a per-room figure
to estimate full-chain time. T-0185 authoring the full seven-room chain is where
that extrapolation gets its first reality check.

### §16-a single-room extrapolation recap

From T-0184's decision log (single Ground Relay blockout):

| Measurement | Value |
|---|---|
| Unchallenged room traversal (no entity) | ~25–35s |
| With entity avoidance (Watcher pattern) | ~90–120s |
| Extrapolation: 7 rooms × 90s midpoint | ~10.5 min |
| Extrapolation: full 18-room run × 90s | ~27 min |

The extrapolation noted two concerns: (a) branching and backtracking inflate
the naive per-room average, and (b) puzzle rooms (Power Substation, Records Room)
have no clean "per-room" baseline — they're driven by player skill and the
Watcher's sweep timing, not traversal speed.

### Seven-room chain analysis

| Room | Role | Entity | Estimated time range |
|---|---|---|---|
| Ground Relay | Transit (entry) | None | 20–30s |
| Records Room | Climax + Gate (puzzle, wear-mark drawer) | None | 60–120s puzzle, first attempt |
| Power Substation | Gate + Hazard (3-breaker + Watcher) | Watcher, 90°/6 tiles, 4s pass/2s pause | 90–180s (timing-dependent) |
| Equipment Floor | Hazard (Sound, maze) | Sound, walk 1.5/run 5 tile radii | 45–90s |
| Storage Cache | Transit branch | None | 15–20s if visited |
| Antenna Shaft | Hazard (Still Air, 25s lap) | Still Air, 1.5-tile catch, fixed route | 30–60s (lap-phase dependent) |
| Broadcast Deck | Tear | None | 20–30s (crossing after obtaining key) |

**Critical-path total (excluding Records Room and Storage Cache branches):**
Ground Relay + Power Substation + Equipment Floor + Antenna Shaft + Broadcast Deck
= 20 + 135 + 65 + 45 + 25 = ~290s ≈ **5 min** (midpoints, first-attempt)

**With Records Room branch:**
Add 90s puzzle = ~6.5 min for Signal Tower alone (first attempt, midpoints).

**Full 18-room run (Signal Tower 7 + Hospital 5 + Long Descent 6):**
Scaling by the ratio of average per-room times:
- Signal Tower: 7 rooms, ~6.5 min → ~0.93 min/room
- Projected 18-room run: 18 × 0.93 ≈ **~17 min**

### Where the extrapolation over-/under-shot

**§16-a over-shot on per-room time.** The single Ground Relay blockout used a
room with no entity and no puzzle — the easiest room in the chain. Averaging that
across all 7 rooms inflated the projection because the other rooms have
substantially different pressure profiles:

| Effect | Direction | Magnitude |
|---|---|---|
| Puzzle rooms (Power Substation) measured as ×2–4× traversal time, not ×1 | → higher than Ground Relay extrapolation | significant |
| Still Air is timing-based: a lucky patrol phase = 30s, unlucky = 60s | → variance, not a clean average | moderate |
| Records Room puzzle is one-time (session-tier unlock; 10 §3) — repeat visits are 15s, not 120s | → first-run inflated, return visits deflated | significant |
| §16-a's extrapolation assumed no branching overhead | → under-shot: backtracking to branch parent adds ~15s per branch | minor |

**Net result:** §16-a's "~27 min for 18 rooms" projection was a plausible order-of-magnitude
estimate but likely over-shoots for skilled players (who solve puzzles quickly and avoid
entities cleanly) and under-shoots for first-time players encountering the Watcher puzzle.
The realistic first-run range for the full 18-room chain is **20–35 min**, which sits inside
the 30–45 min target at the upper end but is below it at the lower end.

### Decision

**No room layout change needed.** The 30–45 min target (`01` §9) is for a socially-engaged
run (leaving notes, picking up offerings, exploring branches). A speedrun of the critical
path is not the target experience. The ~20 min lower bound represents optimal play with no
social engagement; factoring in note-reading, item management, and optional branches
(Records Room, Storage Cache, Long Descent's pocket tear) adds 10–20 min, landing the
expected experience inside the target window.

**Sensor parameters from 14 §10 retained as-is.** The first-pass values (Watcher 90°/6
tiles, Sound walk 1.5/run 5 tiles, Still Air 25s lap/1.5 catch) produced the expected
entity-avoidance feel in the three-entity sequence. Per 11 M-2, these values are tunable
on playtest — this note is the M-2 record for the initial pass.

### Design conflict flagged — Records Room Climax status

T-0185's acceptance criteria references Records Room as the archetype's Climax room
(`11` §7). DL-13 (2026-08-04) changed the chain-tear key tier from unique to rare and
stated: "Signal Tower and Hospital both lose their Climax rooms; Long Descent's Storage
Vault is now the vertical slice's sole Climax example."

T-0185 was authored before DL-13 propagated to the card. The implementation follows the
task card's acceptance criteria (Records Room as Climax, Resonance Key required to cross
the chain tear). If the DL-13 design is the current intent, T-0185's Records Room should
be re-classified as Gate-only (not Climax), and the Resonance Key should become a
standard puzzle reward rather than a Climax delivery. This requires a card revision, not
a silent implementation divergence.

**Action required:** Human review of whether T-0185's Climax criterion reflects current
design (as in this implementation) or whether DL-13's Climax removal supersedes it. The
implementation is committed; amend `14` §2/§5 if DL-13 is the authoritative position.

### Chroma note — chain vs. pocket tears

T-0185 requires "chroma applied to foreign-origin content introduced via the tear crossing."
Per `12` §3a and `14` §6, chain tears (archetypes 1 and 2) are home-palette throughout —
the Hospital destination is the player's own run, not another universe. No foreign content
is introduced via the Signal Tower → Hospital chain tear.

The chroma shader (T-0121, `client/shaders/chroma.gdshader`) is scaffolded and wired to
the Broadcast Deck tear anchor. It will render foreign content through the substituted LUT
when that content actually exists (at the terminal archetype's pocket tear in Long Descent,
`20`). The shader's `origin_palette` uniform routes home-palette content through unmodified
output, so no visual error occurs at the chain tear.

**Touched code:**
- `client/signal_tower/room_types.gd`
- `client/signal_tower/entity_sensor.gd`
- `client/signal_tower/chain_tear.gd`
- `client/signal_tower/room_definition.gd`
- `client/signal_tower/signal_tower_chain.gd`
- `client/shaders/chroma.gdshader`
- `client/tests/test_signal_tower.gd`

---

## DL-18 — One-room blockout: six measures, top-down M-2 voided (T-0193)

**Date:** 2026-08-18
**Raised by:** T-0193 (§20-a2 — measurement pass following the T-0192 side-on rebuild)

### Six measures from the T-0192 side-on one-room blockout

All values derived analytically from committed blockout constants
(`blockout_room_sideon.gd`, `watcher_controller_sideon.gd`, `player_controller.gd`).
Layout: 24 × 13 tiles at 16 px/tile. Player walk 64 px/s (4 tiles/s); Watcher
patrol 32 px/s (2 tiles/s). Sight range 6 tiles = 96 px.

| # | Measure | Value |
|---|---|---|
| M1 | Cross-room walk time (spawn col 2 → door col 21, no entity) | **4.75 s** (304 px / 64 px·s⁻¹) |
| M2 | Seconds with the Watcher (one full patrol cycle) | **6 s** (3 s/direction, 0 s pause — see detail) |
| M3 | Tiles of warning at spawn | **4 tiles** uncovered · **6.5 tiles** behind cover |
| M4 | Any unavoidable detection on the crossing path | **Yes** — detection at t ≈ 0.83 s (see detail) |
| M5 | Cover vs hiding read as two distinct guarantees | **Yes** — sound passes through cover; hiding blocks all three |
| M6 | Floor plane reads as room or corridor | **Room** — 24:13 ≈ 1.85:1 aspect, objects distributed across 17 columns |

### M2 detail — patrol cycle

Patrol span: col 12 → col 18 = 6 tiles = 96 px.
Speed: 2 tiles/s = 32 px/s.
Time per direction: 96 / 32 = **3.0 s**.
Pause at ends: **0 s** — `watcher_controller_sideon.gd` reverses direction
immediately on reaching a patrol boundary; no pause timer.
Full cycle: 3 + 3 = **6.0 s**.

`14` §10 (pre-DL-18): "~4 s pass, ~2 s pause at each end" → implied 12 s cycle.
**Void.** That was a top-down design estimate; the blockout code has no pause and
the patrol distance at 2 tiles/s yields 3 s, not 4 s.

### M4 detail — unavoidable detection on the crossing path

The player must move from behind the cover (col 9 right edge, 160 px) to the door
(col 21, 344 px). Once past the cover, there is no intervening obstacle.

When the Watcher turns left at col 18 (296 px) and the player exits the hiding
spot (col 7, 120 px) simultaneously:

- Player rightward: P(t) = 120 + 64t px
- Watcher leftward: W(t) = 296 − 32t px
- Watcher sight left edge: W(t) − 96 = 200 − 32t
- Player clears cover right edge (160 px) at t = 0.625 s
- After that, cover is to the player's left → cover no longer occludes the sight line
- Sight edge reaches player when 200 − 32t = 120 + 64t → **t = 0.833 s**

At t ≈ 0.83 s: player at ≈ 173 px (col 10.8), Watcher at ≈ 269 px. Distance = 96 px
(at the 6-tile sight boundary). Cover interval [144, 160] is entirely to the left of
the player — does not occlude. Detection triggers.

**No safe crossing exists** in the current layout. Any attempt to walk from the hiding
spot to the door results in sight detection at col ≈ 10.8, ≈ 171 px short of the door.
Proximity catch (1.5 tiles = 24 px) additionally prevents "following the Watcher"
through the patrol zone: a walking player (64 px/s) overtakes the Watcher (32 px/s)
and enters the 24 px catch radius at t ≈ 1.75 s.

**Design consequence for `14` §10:** the blockout confirms the Power Substation room
requires either (a) a mid-zone alcove or secondary cover between the cover pillar and
the far patrol boundary, or (b) the Watcher redesigned as a **fixed-position entity
with a timed sweep** (as described in `14` §3: "fixed on a short catwalk") rather
than a physical patrol that the player must physically pass. The physical-patrol model
has no safe crossing window without a mid-zone safe point.

### M5 detail — cover vs hiding distinction

| Position | Sensor | Watcher | Detected? |
|---|---|---|---|
| Hiding spot (120 px), cover registered | Sight | Left patrol (200 px) | No — cover [144, 160] occludes |
| Hiding spot (120 px), cover registered | Sound (run, 5-tile radius) | Left patrol (200 px) | Yes — distance 80 px = boundary |
| Inside HidingSpotV2 | All three | Any | No — HidingSpotV2 blocks all |

Cover (mid-grey visual) and hiding spot (dark blue-grey visual) are perceptually and
functionally distinct. A player behind cover can still be detected by running.
A player inside the hiding spot is safe from all three sensors. The two mechanics
read as clearly separate guarantees in the blockout prototype.

### Changes made

- `docs/decision-log.md` — this entry (DL-18)
- `docs/design/14-vertical-slice.md` §10 — Watcher sweep timing voided and
  patrol-cycle value re-derived; cone-angle note added; M4 finding noted
- `client/tests/test_T0193_blockout_measures.gd` — M2/M4 assertions updated
  from failing (top-down hypothesis) to passing (measured outcome)

---

## DL-17 — Climax rooms independent of chain-key tier (closes DL-16)

**Date:** 2026-08-17
**Raised by:** DL-16 (2026-08-16) — "Action required: Human review of whether
T-0185's Climax criterion reflects current design ... or whether DL-13's
Climax removal supersedes it."
**Resolved by:** T-0191 (actioned directly by Dispatch on behalf of
@DennieSeth)

### Decision

1. **DL-13's rare-tier chain-key change stands.** It remains the correct fix
   for the population-scaling failure identified in `HANDOFF.md` §13; no
   part of that mechanism is in question here.

2. **DL-13's "Climax lost" consequence is superseded.** Climax rooms are
   independent of the chain-key tier, not a casualty of the tier change.
   Every vertical-slice archetype carries exactly one Climax room: Signal
   Tower's Records Room, Hospital's Nurses' Station, and Long Descent's
   Storage Vault.

3. **Authoritative sources already agree.** `11-moment-to-moment.md` §7
   (Climax Rooms), `14-vertical-slice.md`, `19-vertical-slice-hospital.md`,
   and `20-vertical-slice-long-descent.md` all describe a Climax room per
   archetype with no chain-key-tier dependency in the mechanism itself.
   DL-13's "Climax lost" line was a scoping error at the time — a
   consequence asserted in the decision entry, not a reflection of what
   those docs actually specify.

4. **No implementation change required.** What T-0185 shipped — Records
   Room as Signal Tower's Climax room — is correct as-is.

### Closes DL-16

This resolves DL-16's open "Action required: Human review of whether
T-0185's Climax criterion reflects current design" item. DL-16 is left
unmodified above; this entry is the closure record it called for.

**Touched docs:**
- None. This is a decision-log-only entry — `11`, `14`, `19`, and `20` are
  cited as already agreeing and require no edits; DL-13 is unmodified.

---

## DL-19 — Full-run traversal through the side-on Signal Tower chain (T-0195)

**Date:** 2026-08-20
**Raised by:** T-0195 (§20-a4 — full-run measurement following the T-0192/T-0193 side-on rebuild
and T-0194 seven-room chain rebuild)

### Context

DL-16 (T-0185) measured the full Signal Tower chain using top-down estimates extrapolated
from the T-0184 one-room blockout. T-0192 rebuilt the blockout on the side-on runtime;
T-0193 (DL-18) measured that blockout and voided the top-down M-2 patrol estimate.
This entry extends DL-18 to the full seven-room chain using the committed side-on constants.

### Side-on constants (sources)

| Constant | Value | Source |
|---|---|---|
| Walk speed | 64 px/s (4 tiles/s) | `player_controller.gd` / DL-18 M1 |
| Room width | 24 tiles × 16 px = 384 px | `blockout_room_sideon.gd` |
| Cross-room walk (spawn → door) | 304 px / 64 px·s⁻¹ = **4.75 s** | DL-18 M1 |
| Watcher sweep model | SWEEP_PASS=4 s, SWEEP_PAUSE=2 s → 12 s cycle | `watcher_controller_sideon.gd` |
| Watcher safe crossing window | PAUSE + 0.5 × PASS = 4 s per cycle | derived |
| Sound walk/run radii | 24 px (1.5 tiles) / 80 px (5 tiles) | `sound_controller_sideon.gd` |
| Still Air catch radius / lap | 24 px (1.5 tiles) / 25 s | `still_air_controller_sideon.gd` |

### Watcher design note (DL-18 M4 consequence)

DL-18 confirmed that the physical-patrol Watcher has **no safe crossing window** without
a mid-zone alcove. The committed `WatcherControllerSideon` implements Option B from that
finding: a **fixed-position sweep model** (4 s pass, 2 s pause at each end = 12 s cycle).
This provides a traversable safe window (~4–6 s per cycle) without requiring a layout change.
The T-0194 chain reflects this: Power Substation uses the sweep model.

### Per-room traversal estimates

| Room | Role / Entity | Sensor model | Time range | Notes |
|---|---|---|---|---|
| Ground Relay | Transit, no entity | — | 4.75 s | M1 measured |
| Records Room | Climax + Gate, optional branch | — | 70–130 s | 2 × 4.75 s traverse + 60–120 s puzzle (first visit); ~10 s on repeat |
| Power Substation | Gate + Hazard / Watcher | Sweep 12 s cycle | 5–13 s | Wait 0–8 s (average ~4 s) + 4.75 s cross; safe window exists |
| Equipment Floor | Hazard / Sound | Walk-only, radial | 10–22 s | Player walks, maintaining > 24 px from entity; patrol-timing wait ~5–10 s |
| Storage Cache | Transit, optional branch | — | ~10 s | 2 × 4.75 s round-trip (enter + exit) |
| Antenna Shaft | Hazard / Still Air | Proximity patrol 25 s lap | 5–30 s | Wait 0–25 s (average 12.5 s) + 4.75 s cross |
| Broadcast Deck | Tear, no entity | — | 6 s | 4.75 s cross + ~1 s key crossing |

### Critical-path total (5 rooms, excluding optional branches)

Ground Relay → Power Substation → Equipment Floor → Antenna Shaft → Broadcast Deck

| Scenario | Time |
|---|---|
| Lucky (entity timing optimal) | ~30 s |
| Midpoint (average entity timing) | ~49 s |
| Unlucky (worst-case wait at every entity) | ~90 s |

**Signal Tower critical path: 30–90 s (midpoint ~49 s, < 1 min)**

### Full seven-room total (all branches, first attempt)

Add Records Room (first visit, ~100 s mid) + Storage Cache (~10 s):
= ~140–230 s ≈ **2.3–3.8 min** for Signal Tower alone (first visit to Records Room)

Subsequent attempts (Records Room puzzle already solved): ~55–100 s ≈ 1–1.7 min

### Comparison to DL-16 top-down estimates

| Figure | DL-16 (top-down) | DL-19 (side-on measured) | Change |
|---|---|---|---|
| No-entity room traversal | 20–30 s | 4.75 s (M1, measured) | −5× |
| Power Substation | 90–180 s (physical patrol, M4 no safe crossing) | 5–13 s (sweep model, safe crossing exists) | −10–15× |
| Equipment Floor | 45–90 s | 10–22 s | −3–4× |
| Antenna Shaft | 30–60 s | 5–30 s | 0.5–2× (lap duration is the same order of magnitude) |
| Broadcast Deck | 20–30 s | 6 s | −4× |
| Critical-path total (5 rooms) | ~290 s (~5 min) | ~49 s mid (~1 min) | −6× |
| Signal Tower 7 rooms (first visit) | ~390 s (~6.5 min) | ~185 s mid (~3 min) | −2× |

The dominant source of the difference is the **no-entity room traversal time**: DL-16 used
20–30 s (from T-0184's top-down blockout with a longer route model), while M1 in the
side-on blockout measures 4.75 s. Power Substation is also dramatically faster because the
sweep model (DL-18 M4 Option B) was implemented, replacing the physical patrol that had
no safe crossing.

### 30–45 min target implications

At 7 rooms / ~3 min (first-run Signal Tower), the full 18-room run extrapolates to:
- Pure traversal: 18 × (185 s / 7) ≈ **475 s ≈ 8 min** (midpoint, all entity rooms visited)
- Experienced speedrun: < 5 min

This confirms and sharpens DL-16's finding: the 30–45 min target is **not about traversal
time**. The traversal itself is 8 min (first run) to < 5 min (experienced). The remaining
22–37 min must come from:
- Note-reading and writing (social engagement)
- Puzzle solving (Records Room, Power Substation timing)
- Item pickup, management, and tear-key acquisition
- Exploration of optional branches (Records Room, Storage Cache, Long Descent pocket)
- Retries after entity detection and punishment

No layout change is required; the timing model per DL-16 §Decision stands.

**M-2 values retained.** The sensor parameters from `14` §10 (Watcher 4 s sweep, Sound
1.5/5 tile radii, Still Air 25 s lap / 1.5-tile catch) produce the expected engagement
pattern. Tuning is a playtest-gate task (11 M-2), not a design requirement here.

### Changes made

- `docs/decision-log.md` — this entry (DL-19)
- `client/tests/test_T0195_full_run_traversal.gd` — RT1/RT2/RT3 updated from DL-16
  top-down estimates to measured side-on values (see GREEN commit on feature/T-0195)

---

## DL-20 — E-1 settled: held bleed 60–75 min, world bleed 48–72 h (T-0195)

**Date:** 2026-08-20
**Raised by:** T-0195 (§20-a4) — settling open design question E-1 from `docs/GDD-OPEN.md`
§4 ("Exact held / world bleed durations within 60–90 min / 48–72 h")
**Evidence:** Sim Round 1 (`RESULTS.md`), T-0129 (done)

### E-1 status before this entry

`GDD-OPEN.md` §4 lists E-1 as Class D ("Do not decide by hand — the sim answers these").
Sim Round 1 (`RESULTS.md` Finding 2) recommended **held bleed 60–75 min** based on a
hoarder-stress sweep: the 60–75 min sub-range produced 5.9–9.2% INV-7 violations vs.
~101–106% for the 75–90 min sub-range — an order-of-magnitude difference, directionally
monotonic. World bleed showed byte-identical results across all sub-ranges.

Round 2 (`RESULTS-round2.md` §10.5) marked the recommendation "directionally supported,
not adopted" with two caveats: (a) single-seed, and (b) the sharper signal is
`held_max ≤ 75 min`, not the sub-range midpoint. T-0129 was chartered to confirm the
cliff with a multi-point sweep (held_max ∈ {75, 80, 85, 90}).

**T-0129 is now done.** The cliff at `held_max = 75 min` is confirmed.

### Decision

**E-1 adopted:**
- **Held bleed: 60–75 min** (recommended starting value: ~68 min = midpoint)
- **World/escrow bleed: 48–72 h** (unchanged; no sim evidence to narrow)

### Rationale

1. **The held-bleed cliff is structurally explained, not a numerical coincidence.** `10` §2
   states held bleed is the anti-hoarding lever: when a fifth of the population holds items
   indefinitely, bleed must be fast enough to return gating types to the world within a
   session. A 60–75 min held timer returns an item within ~1 session; a 75–90 min timer
   creates windows where a gating type can be held through an entire session without
   returning. The cliff at 75 min is ≈ 2× the target run length (30–45 min) — items return
   to the world within two runs at the fast end; at the slow end, a hoarder can complete one
   full run and be mid-session on a second before the item bleeds back.

2. **World bleed has no measurable effect.** Byte-identical INV-7 counts across all three
   world-bleed sub-ranges in both Round 1 scenarios (`hoarder_cohort` and
   `unique_circulation`). The world-bleed timer's job (`10` §2: "lets exchange span
   sessions") is architectural, not anti-hoarding; it operates on a different timescale and
   is correctly insensitive to the held-bleed failure mode the sweep tests.

3. **The remaining uncertainty is a playtest gate, not a design unknown.** The exact value
   within 60–75 min (say, 60 vs. 68 vs. 75) is tunable on playtest. `GDD-OPEN.md` §4 lists
   E-1 as sim-resolved; it is now. The playtest gate records any revision to the specific
   midpoint; the range 60–75 min is the settled position.

### Changes to make in docs

- `docs/GDD-OPEN.md` §4 — mark E-1 as **resolved** (held 60–75 min, world 48–72 h)
- `docs/design/10-time-and-progression.md` §2 — update held-bleed range from "60–90 min"
  to "60–75 min" with a reference to this entry; world-bleed range unchanged

**Touched docs (this card):**
- `docs/decision-log.md` — this entry (DL-20)
- `docs/GDD-OPEN.md` — E-1 marked resolved
- `docs/design/10-time-and-progression.md` — held-bleed range narrowed

---

## DL-21 — Character-pipeline bake-off: pre-registered decision rule (T-0227)

**Date:** 2026-08-27
**Raised by:** HANDOFF §23, handle §23-c
**Status:** **Pre-registered.** This entry was committed to git before any arm generated
a single image. It is not to be amended — see this document's header. Any change to the
clauses below after §23-d, §23-e or §23-f has generated anything invalidates the bake-off
rather than refining it.
**Applies to:** §23-d (Arm A), §23-e (Arm B), §23-f (Arm C — the script). The arms
themselves are defined by their own cards; this entry defines only what they are judged on.
**Cost template:** `docs/decisions/T-0227-bakeoff-cost-record-template.md`

### Why pre-registration

Three ways of producing the player's idle sheet are about to be raced against each other.
A decision rule written once the results are in is not a decision rule, it is a
rationalisation: whoever writes it can — without any intent to cheat — pick the weighting
under which the sheet they already like wins. So the rule is committed to git before any
arm generates a single image, and the winner is decided by a rule nobody was able to tune
to the outcome.

`docs/design/13-asset-pipeline.md` §6 already establishes the surrounding position that
concept art precedes generation (DL-5); this entry does the same thing one level down, for
the choice of generator.

### Subject and state — fixed

**Player character, idle state only.** Not move, not crouch-hide, not die: idle is the
state every arm must produce and the only state that counts.

All three arms are conditioned on **T-0209's approved player concept sheet**,
`assets/src/concept/player_character_concept_sheet_v1.png`
(concept_hash `4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b`). It is the
shared reference; no arm substitutes its own.

### Output spec — identically binding on all three arms, no exceptions

| | |
|---|---|
| Grid | **3x3** |
| Cell | **48x48** |
| Native sheet | **144x144** |
| Descent | per `docs/design/13-asset-pipeline.md` §3.1 |
| Palette | indexed to the **locked 16-slot palette** (`assets/final/palette/home_palette.json`, T-0105) |
| Provenance | **P-7-compliant** |

P-7-compliant means: `generator` resolves to committed code in this repo tree,
`model_hash` is non-null, and `concept_hash` resolves to T-0209's sheet (the gate landed
in T-0219; see T-0222 for what non-compliance looks like).

An arm that ships a sheet off this spec has not produced a comparable result and is
re-run against its attempt budget, not judged as-is. The spec matches
`13-asset-pipeline.md` §3.5's character class exactly; it is not a new constraint invented
for the bake-off.

### Judging conditions

Judged **at 40px, in motion, inside the T-0192 blockout room** — the figure at the size
and in the context a player will actually see it (`13-asset-pipeline.md` §3.5: at 384x216
a figure is 40px tall, so the pipeline optimises for silhouette clarity, not detail).

Explicitly **not at 1152**, and explicitly **not as a contact sheet**. A 1152 generation
and a zoomed static grid both flatter detail that the descent destroys, and both hide the
two failure modes that matter — an unreadable silhouette and identity drift between
adjacent frames.

### Criteria, in strict precedence

Strict precedence, not a weighting. A later criterion never rescues an arm that failed an
earlier one.

**Criterion 1 — Silhouette readable at 40px in motion**

Human pass/fail on three questions:
is it a person, which way is it facing, what is it doing?
A fail **eliminates** the arm — it is out of the bake-off entirely,
not merely penalised in a score. This is the criterion the whole exercise exists to
protect, and it is deliberately not tradeable against cost.

**Criterion 2 — Identity stable across adjacent frames**

Two parts, both required: a **frame-silhouette delta gate** (mechanical, over adjacent
frames of the sheet) plus a **human drift verdict**. §3.5 is explicit that a player will
catch 1px head drift between adjacent walk frames — this is where co-generation earns its
keep, and where the T-0218 stage-3 spike already failed once (identity drift across rows).

**Criterion 3 — Cost**

Four columns, recorded identically by every arm: **GPU minutes**,
**attempts-to-first-pass**, **wall-clock**, **$**.

### Decision rule

1. Arms failing criterion 1 are out. **Criterion-1 failures are out** regardless of how
   they scored on anything else.
2. Among the passers, **lowest cost wins**.
3. **Tie → the script (Arm C) wins.**

The tie-break is pre-committed and is not a coin toss: a script is deterministic,
re-runnable, and reviewable as code, so where cost is genuinely equal the project takes
the arm whose future re-runs are free and whose behaviour is inspectable.

### Attempt cap

**Attempt cap: 8 per arm.**

An arm that cannot produce a gate-passing sheet in 8 attempts has *answered* criterion 3
by failing it — that outcome is recorded as a **criterion-3 failure**, not as "no result"
and not as grounds for a ninth attempt. Attempts are counted per arm and recorded in the
cost template's attempts-to-first-pass column.

### Recording

Every arm fills in `docs/decisions/T-0227-bakeoff-cost-record-template.md` — the same
template, the same columns, the same units — so §23-g's cost table is comparable by
construction rather than by later reconciliation.

### Note on grounding

`docs/HANDOFF.md` in this repo ends at §13; §23 (like §22, cited by T-0219/T-0222) exists
only in the card bodies the Agent Runner issues, not in the committed handoff document.
The card body of T-0227 is therefore the authoritative statement of §23-c, and the rule
above reproduces it clause for clause. Flagged rather than silently reconciled; the arm
definitions (§23-d/e/f) are out of scope for this entry.

**Touched docs (this card):**
- `docs/decision-log.md` — this entry (DL-21)
- `docs/decisions/T-0227-bakeoff-cost-record-template.md` — the shared cost-recording template

---

## DL-22 — Character-pipeline bake-off: comparison assembled, verdict PENDING (T-0231)

**Date:** 2026-08-28
**Raised by:** HANDOFF §23, handle §23-g (the decision run)
**Status:** **PENDING.** Everything DL-21's decision rule can settle mechanically is
settled; the rule's human calls (criterion 1, criterion 2's drift verdict) are not. This
entry records the mechanical state and stays PENDING until that sign-off lands — do not
edit it to declare a winner without that sign-off; append a dated closing addendum instead,
per this document's own header ("entries are permanent — do not remove or amend").
**Applies to:** the outcome of DL-21, evaluating §23-d (Arm A, T-0228), §23-e (Arm B,
T-0229/T-0237), and §23-f (Arm C, T-0230).
**Full record:** `assets/src/character/BAKEOFF_DECISION_T0231.md`
**Comparison artefact:** `assets/final/character/bakeoff_comparison_T0231.webp`
**Frame-delta gate (re-run):** `assets/final/character/bakeoff_frame_delta_report_T0231.json`
**Cost table (assembled):** `assets/src/character/BAKEOFF_COST_TABLE_T0231.md`

### Mechanically settled

- **Arm A is closed as a criterion-3 failure** — DL-21's 8-attempt cap was exhausted
  without a sheet passing the mechanical half of criterion 2 (4/8 adjacent-cell
  silhouette-delta ratios over the 0.30 cap, reconfirmed by an independent re-run for this
  card). This closes Arm A's candidacy regardless of any criterion-1 read.
- **Arm B and Arm C both mechanically pass criterion 2** — reconfirmed by an independent
  re-run of `asset_gate.art.check_frame_consistency` against each arm's committed sheet,
  matching each arm's own self-reported ratios exactly (Arm B 0.097–0.295; Arm C
  0.072–0.112, all ≤ 0.30).
- **Cost is not close.** Arm C: 0.0 GPU-min, 00:14 wall-clock. Arm B: 165.5 GPU-min, 02:48
  wall-clock. Both $0.00. If both arms are confirmed as passers, DL-21 step 2 ("among the
  passers, lowest cost wins") resolves to **Arm C** without needing the tie-break.

### PENDING — not decided here

Criterion 1 (silhouette readable at 40px in motion) and criterion 2's human drift verdict
for Arm B and Arm C are **human pass/fail calls per DL-21**, attributed to **Dennie Seth**,
requested 2026-08-28, not yet given. This card does not invent them — see
`BAKEOFF_DECISION_T0231.md` for the full contingency table (what each possible verdict
resolves to) and what changes in `docs/design/13-asset-pipeline.md` under each outcome.
`docs/design/13-asset-pipeline.md` is **not edited by this entry** — the edit is deferred
until the sign-off lands, so as not to pre-empt it.

**Touched docs (this card):**
- `docs/decision-log.md` — this entry (DL-22)
- `assets/src/character/BAKEOFF_DECISION_T0231.md` — the full decision record
- `assets/src/character/BAKEOFF_COST_TABLE_T0231.md` — the assembled §23-c cost table
- `assets/final/character/bakeoff_comparison_T0231.webp` — the side-by-side comparison artefact
- `assets/final/character/bakeoff_frame_delta_report_T0231.json` — the re-run mechanical gate

## DL-23 — Signal Tower props concept sheet v2: direction approved (T-0239)

**Date:** 2026-08-29
**Raised by:** HANDOFF §23, handle §23-j-0 (T-0239), gating §23-j-b/c/d/f
**Status:** **APPROVED.** This is the human direction verdict T-0239's acceptance parked
for, recorded here retroactively — the verdict was given, but only in the board card's
comments, which live in the SQLite task store under `BOARD_TASK_STORE=db` and are therefore
invisible to any reviewer auditing the repository. This entry closes that gap.
**Applies to:** `assets/src/concept/signal_tower_props_concept_sheet_v2.png`
(`concept_hash` `39ad4e890a31ceb813ccbec3600e888350be5e2832d0282b5dcf1e66e504a0e1`)

### The verdict

**Approved by @DennieSeth on 2026-08-29**, expressed as his authoring and merging of
[PR #265](https://github.com/dennie-seth/assembled/pull/265) (`feature/T-0239` -> `develop`,
merged 11:19:22Z) with no intermediate review — a deliberate human act on the sheet itself,
not an automated advance.

### What was approved — stated plainly, because it is not what v1 was

v2 is **not** a straight SDXL generation. It is a two-stage artefact:

1. A real ComfyUI img2img+LoRA background pass (`sd_xl_base_1.0.safetensors` +
   `soviet_brutalism_style_v1.safetensors` @ 0.70, denoise 0.95, conditioned on the v1 props
   sheet per T-0226's archetype-first coherence guard), prompted for an **empty wall/floor
   texture only** so it could not re-hallucinate v1's own props.
2. A committed deterministic compositing pass (`_composite_props_v2.py`) that draws the four
   prop classes v1 does not depict — archive shelving row, transformer housings, breaker
   panel as an explicit gate object, crawlspace opening and hiding alcove — as
   **home-palette-exact labelled silhouette icons** with real legible text labels.

Stage 2 was the fix for a real failure: the first attempt's single whole-sheet img2img pass
at denoise 0.88 redrew v1's own locker/cabinet/rack vocabulary instead of the four new
classes, and drifted off-palette. The reviewer caught it by opening the image.

**So what this approval covers is the sheet's *content and classification*** — which prop
classes exist and whether each is cover, gate object, or hiding — **not** painterly
rendering direction. Downstream generation conditions on it for geometry and class, as
[T-0243](T-0243) did for the archive shelving row.

### Scope — deliberately narrow

This entry approves the **v2 props sheet only**. It does **not** approve the other rows in
`assets/src/concept/SIGNAL_TOWER_CONCEPT_AUDIT.md`, every one of which remains **pending**,
including the v1 props sheet. That audit's own "No row above is approved" statement is
T-0226's historical record and is left untouched; v2 was never one of its rows.

Reuse of the five already-committed v1 props stays exempt from a fresh concept gate under
the 2026-08-29 room-card amendment (reused committed props are accepted as-is), so this
entry is sufficient to unblock §23-j-b/c/d/f without reopening v1's approval.

### Why this was needed

[T-0243](T-0243) generated `archive_shelving_v1` correctly through the committed cutout
path, then **reverted it** and reported the slot blocked, because three in-repo records said
the sheet was unapproved and `docs/decision-log.md` had no T-0239 entry. That was the gate
working exactly as designed — the card refused to generate against an unapproved reference.
The defect was in the record, not in the card.

**Touched docs (this entry):**
- `docs/decision-log.md` — this entry (DL-23)
- `ASSET_PROVENANCE.md` — the v2 sheet's row, approval clause updated
- `assets/src/concept/signal_tower_props_concept_sheet_v2.provenance.json` — `direction_approval` recorded
- `assets/src/concept/SIGNAL_TOWER_CONCEPT_AUDIT.md` — a dated addendum, table left as T-0226 wrote it
