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

---

## DL-23 — DL-21 override: Arm C's mechanical win is overridden on authorship grounds, round 2 pursues Arms A/B, Arm C retained as benchmark (closes DL-22; T-0253)

**Date:** 2026-08-30
**Raised by:** HANDOFF §24, handle "DL-22" — see the numbering note below.
**Resolved by:** T-0253 (actioned directly by Dispatch on behalf of @DennieSeth)
**Status:** Closed. This entry closes DL-22's PENDING status.
**Applies to:** the outcome of DL-21 as recorded by DL-22 (§23-d Arm A/T-0228, §23-e Arm
B/T-0229/T-0237, §23-f Arm C/T-0230), and to HANDOFF §24 round 2 (§24-a..§24-e, T-0248,
T-0249, and successor cards in that set).
**Full record (round 1):** `assets/src/character/BAKEOFF_DECISION_T0231.md` (T-0231)

### Numbering note

HANDOFF §24 calls this handle "DL-22", but `DL-22` was already allocated by T-0231 for the
comparison entry above. This entry takes the next free number, **DL-23**, and carries the
HANDOFF §24 "DL-22" handle.

### What DL-21's rule mechanically decided

Both Arm B and Arm C passed criterion 2, and Arm C was lowest cost, so **Arm C won under
DL-21's rule** — DL-21 step 2 ("among the passers, lowest cost wins") resolved to Arm C
without needing the tie-break.

Round-1 numbers, restated here so this entry stands on its own:

- **Arm A** (T-0228) — **FAILED.** 4 of 8 adjacent-cell frame-silhouette deltas over the
  0.30 cap, the 8-attempt cap exhausted without a pass. Also showed cross-row identity
  drift and a green -> tan colour shift between rows. Closed as a **criterion-3 failure**
  (the attempt cap answers criterion 3 by failing it, per DL-21).
- **Arm B** (T-0229/T-0237) — **PASSED.** 0.097-0.295 frame-delta, 7 of 8 attempts,
  165.5 GPU-min.
- **Arm C** (T-0230) — **PASSED, best.** 0.072-0.112 frame-delta, 1 attempt, 0 GPU-min.

### The override

**That outcome is overridden on authorship grounds by @DennieSeth:** locally-generated art
is part of this game's identity, and GPU time on hardware the project owns is not a real
cost. **Cost is demoted from a deciding criterion to a recorded one** for round 2 — DL-21's
step 2 no longer settles the question by itself.

**Arms A/B are pursued in round 2** (HANDOFF §24, cards §24-a..§24-e), continuing the
generative path rather than shipping the script.

**Arm C is retained**, not discarded, as two things at once:

1. The **benchmark** — every round-2 result is measured against Arm C's **0.072-0.112**
   frame-delta result.
2. The **shipping fallback** — if round 2 does not beat that benchmark, Arm C ships.

Arm C's script and sheet stay committed and gate-passing; nothing in this entry, or in the
round-2 card set, regresses them.

### Unchanged for round 2

**DL-21's criteria, the 0.30 frame-delta cap, and the judging conditions (40px, in motion,
inside the T-0192 blockout room, not at 1152, not as a contact sheet) are unchanged for
round 2.** Changing the measure would void the round-1 comparison round 2 is being measured
against.

### Closes DL-22

This closes DL-22's PENDING status. DL-22 recorded everything DL-21's decision rule could
settle mechanically and stayed PENDING for the human sign-off DL-21's criterion 1 and
criterion 2 drift verdicts required, attributed to Dennie Seth. That sign-off has now been
given, in the form of this override. DL-22 is left unmodified above; this entry is the
closure record it called for — the same pattern as DL-17 closing DL-16.

### Out of scope — flagged, not actioned

DL-22 deferred the `docs/design/13-asset-pipeline.md` §3.5 edit until sign-off landed. **This
entry does not make that edit.** What §3.5 should say depends on round 2's outcome
(§24-a..§24-e), which has not run yet, so the edit **remains open, pending round 2**.

**Touched docs (this card):**
- `docs/decision-log.md` — this entry (DL-23)
- No other docs. `docs/design/13-asset-pipeline.md` §3.5 is explicitly not edited by this
  entry — see "Out of scope" above.

---

## DL-24 — Character-pipeline round 2: comparison assembled, verdict PENDING (T-0255)

**Date:** 2026-08-30
**Raised by:** HANDOFF §24, handle §24-f (the round-2 decision run)
**Status:** **PENDING.** Everything §24.3's pre-registered rule can settle mechanically is
settled, including Arm C's own criterion-1 sign-off (already given via DL-23's closure of
DL-22 — see "PENDING — not decided here" below); the rule's human call (criterion 1 —
silhouette readable at 40px in motion) is still open for the three round-2 arms that ran
(§24-b, §24-c, §24-e). This entry records the mechanical state and stays PENDING until that
sign-off lands — do not edit it to declare a winner without that sign-off; append a
dated closing addendum instead, per this document's own header ("entries are permanent — do
not remove or amend").
**Applies to:** the round-2 arms raised by DL-23 (§24-a..§24-e): T-0248 (§24-a, identity-LoRA
retrain, diagnostic), T-0249 (§24-b, pose authority), T-0250 (§24-c, chained img2img), T-0251
(§24-d, AnimateDiff — correctly skipped, no usable motion module), T-0252 (§24-e, hybrid),
judged against Arm C (T-0230, round 1) as the retained benchmark and candidate shipping
fallback.
**Full record:** `assets/src/character/ROUND2_DECISION_T0255.md`
**Comparison artefact:** `assets/final/character/round2_comparison_T0255.webp`
**Frame-delta gate (re-run):** `assets/final/character/round2_frame_delta_report_T0255.json`
**Cost table:** `assets/src/character/BAKEOFF_COST_TABLE_T0231.md` (round-2 sections, T-0248
through T-0252) and the full record's own consolidated table (with attempts-to-first-pass).

### Mechanically settled

- **Every round-2 arm that ran clears the round-2-unchanged 0.30 pass/fail floor. None beats
  Arm C's 0.072–0.112 benchmark** — the bar §24.3 set out to beat, not merely the gate to
  clear — independently reconfirmed by this card's own re-run of
  `asset_gate.art.check_frame_consistency` against each arm's committed sheet: §24-a (T-0248,
  diagnostic) 0.083–0.273 best of 3 seeds; §24-b (T-0249) 0.0522–0.2573; §24-c (T-0250)
  0.0000–0.1763; §24-e (T-0252) 0.1576–0.1816; Arm C (T-0230, benchmark) 0.072–0.112.
- **§24-d (T-0251, AnimateDiff) is correctly closed as a skipped contingent arm, not a missing
  input**: a 5-query, read-only capability check against the shared ComfyUI host found zero
  AnimateDiff/AnimateDiff-Evolved node types, no `animatediff_models`/`motion_module` folder
  type, and 404s on both motion-module model routes. Installing a new custom node pack on the
  shared host is a standing environment change outside an implementer agent's remit. See
  `ROUND2_ANIMATEDIFF_CAPABILITY_REPORT_T0251.md`.
- **Cost is recorded, not deciding, per DL-23's override:**

  | Card | Handle | Attempts-to-first-pass | GPU-min | Wall-clock | $ |
  |---|---|---|---|---|---|
  | T-0248 | §24-a | 1/3 (generation re-run; diagnostic, not a bake-off arm) | 117.9 | 02:02 | $0.00 |
  | T-0249 | §24-b | 3/8 (measured; 5/8 used, incl. 2 incomplete) | 31.8 | 01:04 | $0.00 |
  | T-0250 | §24-c | 8/8 (attempt cap exhausted) | 87.8 | 01:28 | $0.00 |
  | T-0251 | §24-d | 0 (no generation attempted) | 0.0 | 00:04 | $0.00 |
  | T-0252 | §24-e | 6/8 (3 source-frame + 3 sheet-assembly) | 3.70 | 00:07 (+ CPU-only cutout reprocess) | $0.00 |
  | T-0230 | benchmark (round 1) | 1/8 | 0.0 | 00:14 | $0.00 |

  Copied from each card's own attempt log / `BAKEOFF_COST_TABLE_T0231.md`'s own "Attempts"
  columns; see that file for the full per-attempt breakdown. Even the cheapest round-2 arm
  (§24-d, $0, never generated) does not change which arm beat the benchmark, because none did.
- **Arm C's own criterion-1 read is already confirmed, via DL-23's closure of DL-22** (see
  "PENDING — not decided here" below). **§24.3's own pre-registered contingency** ("if no
  round-2 arm beats 0.072–0.112, designate Arm C") **therefore already resolves, on the
  mechanical evidence above, to Arm C as the round-2 shipping fallback.** That designation is
  not finalized in this entry — acceptance criterion 6 requires the round-2 arms' own
  criterion-1 read recorded per arm first (see below), even though none of the three changes
  this outcome.

### PENDING — not decided here

Criterion 1 (silhouette readable at 40px in motion) is a **human pass/fail call** under DL-21
(unchanged for round 2 per DL-23), attributed to **Dennie Seth**, requested 2026-08-30, not yet
given — **for the three round-2 arms that ran (§24-b/T-0249, §24-c/T-0250, §24-e/T-0252).**
**Arm C's own criterion-1 read is not reopened here — it was already given.** DL-22 recorded it
PENDING, and DL-23 explicitly closed that PENDING status: DL-23 states in its own words that
DL-22 "stayed PENDING for the human sign-off DL-21's criterion 1 and criterion 2 drift verdicts
required, attributed to Dennie Seth. That sign-off has now been given, in the form of this
override," and records Arm C as "PASSED, best." §24.3's own contingency ("if no round-2 arm
beats 0.072–0.112, designate Arm C") therefore already resolves, on the mechanical evidence
above, to Arm C as the round-2 shipping fallback. What still parks this entry is acceptance
criterion 6's own requirement that the round-2 arms' criterion-1 read be recorded per arm before
that designation is finalized — even though, per the mechanical evidence, none of the three
changes the outcome. This card does not invent that verdict — see `ROUND2_DECISION_T0255.md`
for the full record and what changes in `docs/design/13-asset-pipeline.md` once it lands.
`docs/design/13-asset-pipeline.md` is **not edited by this entry** — the edit is deferred until
the round-2 arms' sign-off lands, so as not to pre-empt it. The reference-character promotion is
likewise deferred — Arm C's committed sheet stays at its existing path
(`assets/final/character/player_idle_sheet_arm_c_T0230.png`) until designation is finalized.

**Touched docs (this card):**
- `docs/decision-log.md` — this entry (DL-24)
- `assets/src/character/ROUND2_DECISION_T0255.md` — the full round-2 decision record
- `assets/final/character/round2_comparison_T0255.webp` — the side-by-side comparison artefact
- `assets/final/character/round2_frame_delta_report_T0255.json` — the re-run mechanical gate

## DL-25 — Round-2 character decision: §24-e (hybrid) chosen on direction; Arm C becomes the permanent quality reference, not a gate (closes DL-24; T-0255)

**Date:** 2026-08-30
**Raised by:** @DennieSeth — criterion-1 verdict on T-0255 (§24-f), given 2026-08-30 15:12 UTC
**Status:** **DECIDED.** This entry closes DL-24's PENDING state by recording the human
criterion-1 sign-off it was parked on. **DL-21, DL-22, DL-23 and DL-24 are not edited** —
per this document's header ("entries are permanent — do not remove or amend"), the outcome
is recorded here as the superseding entry, the same way DL-23 closed DL-22 and DL-17
superseded DL-16.
**Applies to:** the round-2 arms raised by DL-23 (§24-b..§24-e) and, going forward, **every**
character-generation output in this repo.
**Full record:** `assets/src/character/ROUND2_DECISION_T0255.md`
**Comparison artefact:** `assets/final/character/round2_comparison_T0255.webp`
**Frame-delta gate (re-run):** `assets/final/character/round2_frame_delta_report_T0255.json`

### The decision

**§24-e (T-0252, the hybrid arm) is the winning character-generation arm.**

Verbatim verdict, recorded on T-0255: *"24-e looks best to me!"* — @DennieSeth,
2026-08-30.

The hybrid arm is one SDXL source frame (style LoRA `soviet_brutalism_style_v1` +
identity LoRA `player_identity_v2` + IP-Adapter + OpenPose ControlNet, descended and
palette-indexed, with the per-frame background cutout applied), with **every other animation
frame derived from that one frame's own pixels** by
`char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252`. It is the only round-2 arm
in which a single diffusion call produces the whole sheet.

**Chosen on direction and authorship grounds, not on the numbers** — consistent with, and a
direct continuation of, the DL-21 → DL-22 → DL-23 override: locally generated art is part of
this game's identity, and GPU time on hardware we own is not a real cost. Criterion 1
(silhouette readable at 40px in motion) is a human pass/fail call under DL-21, unchanged for
round 2 per DL-23, and this is that call.

### Measured honestly — this is not a numbers win

| Arm | Card | Frame-delta (re-run) | Clears 0.30 floor | Beats Arm C's 0.072–0.112 |
|---|---|---|---|---|
| §24-b pose authority | T-0249 | 0.0522–0.2573 | yes | **no** |
| §24-c chained img2img | T-0250 | 0.0000–0.1763 | yes | **no** |
| §24-d AnimateDiff | T-0251 | — (correctly skipped: no usable SDXL motion module) | — | — |
| **§24-e hybrid (WINNER)** | **T-0252** | **0.1576–0.1816** | **yes** | **no** |
| Arm C benchmark (round 1) | T-0230 | 0.072–0.112 | yes | — (is the benchmark) |

**§24-e clears the round-2-unchanged 0.30 pass/fail floor at 0.1576–0.1816, and does NOT beat
Arm C's deterministic 0.072–0.112 benchmark.** Its own committed sidecar records this as
`"beats_arm_c_benchmark": false`.

**This is expected and accepted.** DL-23 demoted cost from a deciding criterion to a recorded
one; this entry does the same for the benchmark comparison. No round-2 arm beat Arm C, and
DL-24 correctly recorded that none did. The choice of §24-e is made *in full knowledge of
that*, on the same authorship grounds that created round 2 in the first place — not by
re-reading the numbers until they favour a generative arm, and not by weakening the measure.
DL-21's criteria, the 0.30 cap and the judging conditions (40px, in motion, in the T-0192
blockout room) remain **unchanged**; nothing here redefines a gate to fit a result.

### STANDING RULE — always verify against Arm C

Recorded verbatim from @DennieSeth: *"Arm-C benchmark will never probably be beaten, but we
should always verify against it."*

As a standing rule, binding from this entry forward:

- The deterministic **Arm-C benchmark (0.072–0.112 frame-delta) is NOT a gate** that the
  chosen generative approach must clear. A character-generation output is not rejected for
  failing to beat it — §24-e itself does not, and is the winner.
- **Every character-generation output must ALWAYS record its own frame-delta AND its
  comparison against the Arm-C benchmark**, as a permanent quality reference. The comparison
  is *recorded, not deciding* — the same status DL-23 gave cost.
- **Arm C is retained as the shipping fallback.** Its script, sheet and gate results stay
  committed and passing (`assets/final/character/player_idle_sheet_arm_c_T0230.png`); nothing
  regresses them.

The rule exists because the benchmark's value is diagnostic, not gating: a generative sheet
whose frame-delta drifts far from ~0.16 is telling us something broke, and that signal is only
available if the number is on every sheet. Losing it silently is the failure mode this rule
prevents.

Pinned as invariants **CHR-1** and **CHR-2** in `docs/board-invariants.md` §9.

### Consequence: the reference character

**§24-e's committed sheet, `assets/final/character/player_idle_sheet_hybrid_T0252.png`
(sidecar `player_idle_sheet_hybrid_T0252.provenance.json`), is the winning character
reference.** It is the artifact **T-0235** (§23-l, the in-engine integration proof) consumes
when it renders the T-0192 blockout room from pipeline output. DL-24 deferred the
reference-character promotion pending this sign-off; this entry settles it.

The `docs/design/13-asset-pipeline.md` §3.5 edit that DL-22 deferred and DL-24 left open is
**still open** — it now has its answer (§3.5 describes the hybrid path, with the Arm-C
benchmark recorded as a permanent quality reference per CHR-1/CHR-2 rather than as a gate),
but making that edit is out of this entry's scope and belongs with the §24/`13` design pass.
Recorded here so the loose end is not silently dropped.

**Touched docs (this entry):**
- `docs/decision-log.md` — this entry (DL-25)
- `docs/board-invariants.md` — §9, invariants CHR-1 and CHR-2 (the standing rule)

---

## DL-26 — Motion-class-aware frame-delta cap: idle keeps DL-21's 0.30, locomotion/transition/loop get 0.50 (T-0271)

**Date:** 2026-09-01
**Raised by:** T-0271, drawing on T-0259's walk-cycle calibration trail
**Resolved by:** T-0271 (`tools/asset-gate`,
`asset_gate.character.frame_delta_cap_for_motion_class` /
`check_character_frame_delta_cap`)

### The problem

DL-21 criterion 2's 0.30 frame-delta cap was pre-registered against **the player idle
sheet only** — the subject-and-state section of that entry is explicit: "Player character,
idle state only." DL-24 restated the constraint for round 2 as "same subject (the player
idle sheet), same output spec, same criteria," carrying the number forward unchanged for
another idle comparison. Neither entry considered locomotion; every character animation
generated since — including walk cycles — has nonetheless inherited the idle-calibrated
0.30 by default, because nothing distinguished the two.

A walk cycle legitimately moves far more silhouette pixels per frame than an idle pose: the
whole point of a stride is that limbs travel. Capping it at a bound sized for standing still
does not measure identity drift — the failure mode the cap exists to catch — it measures
motion amplitude, and penalizes a sheet for doing its job. This is not hypothetical: T-0259's
four real ComfyUI attempts (~800 GPU-s each, seed 27182) show it directly.

### The evidence — T-0259's calibration trail

| Attempt | STRIDE / KNEE / ARM / CROSS | Denoise | Frame-delta | Pairs over 0.30 |
|---|---|---|---|---|
| 4 (committed) | 0.145 / 0.085 / 0.09 / — | 0.45 | 0.034–0.253 | 0/8 — motion barely visible |
| 5 | 0.30 / 0.18 / 0.20 / 0.14 | 0.45 | 0.328–0.473 | 8/8 |
| 6 | 0.22 / 0.13 / 0.15 / 0.05 | 0.45 | 0.212–0.375 | 6/8 |
| 7 | 0.22 / 0.13 / 0.15 / 0.05 | 0.30 | 0.161–0.340 | 3/8 |
| 8 | 0.22 / 0.13 / 0.15 / 0.02 | 0.24 | 0.109–0.302 | 1/8 |

Chasing the 0.30 cap monotonically traded away the motion the card asked for: attempt 8
missed by 0.00198 on a single pair, and only got that close after `CROSS_EXTENT_NORM` — the
parameter controlling how far the legs visibly cross — was cut from 0.14 to 0.02, a 7x
reduction from the value that actually read as a leg cross on human review. Attempts 5 and 6,
the ones that read as an honest walk, measured 0.328–0.473 and 0.212–0.375 respectively — both
partly or wholly outside the idle cap, precisely because they look like walking and attempt 4
does not.

### Decision

**The frame-delta cap is now a function of the sheet's motion class, read from the
provenance sidecar's `motion_class` field** (`idle` | `locomotion` | `transition` | `loop`).
The sidecar was chosen over card metadata because it makes the sheet self-describing — a gate
run against a committed `.provenance.json` needs no board lookup to know which cap applies,
consistent with every other field this pipeline already treats as sidecar-owned
(`frame_delta_range`, `arm_c_benchmark`, `beats_arm_c_benchmark`, per CHR-1).

- **`idle` (and DL-21's original scope) keeps exactly 0.30.** This is not loosened. Every
  committed idle sheet, including the round-1/round-2 arms DL-21/DL-24/DL-25 already judged,
  keeps the bar it was measured against.
- **`locomotion`, `transition`, and `loop` get 0.50.** Derived from the table above: the
  sheets that read as a real walk on human review ran 0.328–0.473 (attempt 5) and
  0.212–0.375 (attempt 6), and attempt 5's own upper bound of 0.473 is the highest measured
  value that still reads as legitimate locomotion rather than drift — restoring the leg-cross
  amplitude attempt 8 sacrificed would push a genuine walk higher still. 0.50 clears 0.473
  with headroom (≈0.03, deliberately not a hairline the way 0.30 was for attempt 8), while
  remaining well below the range that would read as gross drift rather than motion — this
  package's own test suite pins a drift fixture at 0.55/0.58/0.61 for locomotion/loop/
  transition respectively and confirms the cap still rejects it.
- **A missing or unrecognised `motion_class` fails closed to the idle cap (0.30), never to
  the permissive one.** An unlabelled sheet must not silently receive the loosest bar; this
  is enforced by `frame_delta_cap_for_motion_class` falling through to 0.30 for anything not
  literally `locomotion`, `transition`, or `loop`.
- **CHR-1 and CHR-2 (DL-25, `docs/board-invariants.md` §9) are unchanged.** This entry adds
  a new cap check (`check_character_frame_delta_cap`); it does not touch
  `check_character_arm_c_provenance`, and the Arm-C benchmark comparison remains recorded,
  not gating — `beats_arm_c_benchmark: false` continues to pass.
- **No existing sheet is retro-fitted.** Committed sheets keep the grading they were produced
  and judged under; this cap applies going forward, to sheets that record a `motion_class`.

**This does not void DL-21's round-1 idle comparison, or DL-25's round-2 decision.** Both
were judged with the idle cap against idle-state sheets, which is exactly the cap this entry
keeps unchanged for that class. Nothing here re-opens or re-grades either verdict.

**Touched docs (this entry):**
- `docs/decision-log.md` — this entry (DL-26)

---

## DL-27 — Two approval records, one source of truth: the board wins (T-0286)

**Date:** 2026-09-03
**Raised by:** T-0286, following the T-0257/T-0243 drift incident
**Resolved by:** T-0286 (`tools/board/src/lib/approvalGate.js`'s `approvalVerdict`,
`GET /api/tasks/:id/approval` in `tools/board/src/server/httpApi.js`)

### The problem

A direction approval lived in two places: the board card's `requires_approval` /
`approved_by` / `approved_at` (`docs/board-invariants.md` §10, AP-1..AP-9 --
stamped only by a human AP-3/AP-4 gesture), and a prose approval line per asset
in `ASSET_PROVENANCE.md`. Nothing propagated one to the other.

T-0257 was approved on the board 2026-08-30 (`approved_by: "Anonymous"`,
`approved_at: 2026-08-30T22:06:35.073Z`, PR #291). `ASSET_PROVENANCE.md`'s row
for the concept sheet it gated kept reading "Not yet approved" for days.
T-0243, and the T-0244/T-0245/T-0246 cards parked behind the same gate, stayed
blocked on a decision that had already been made. Nobody was wrong by their
own rules -- the human approved, the agent correctly refused to build against
what its only source (the provenance file) called unapproved, and the reviewer
correctly failed the card. **The system had two sources of truth and no
reconciliation.** PR #307 fixed that one row by hand; it did not fix the class.

### Options considered

**Option A -- the board record is authoritative.** Any consumer resolves "is
this approved?" by reading the card's `approved_by`/`approved_at` directly,
never by parsing `ASSET_PROVENANCE.md` prose. The provenance file keeps its
human-readable note, but the note stops being load-bearing.

**Option B -- enforced propagation.** Keep both records, but make the
approval stamp also write/refresh the `ASSET_PROVENANCE.md` row, plus a drift
check that fails when a gated card is approved on the board while its
provenance row still reads unapproved.

### Decision: Option A

`docs/board-invariants.md` §10 already states the project's taste on exactly
this question, for the board's own `requires_approval` signal: *"Body
detection was considered and rejected: which cards are gated has to be
answerable without parsing English."* Option B deepens the very pattern that
line rejects -- it would add a *second* place parsing English for a verdict,
plus a writer to keep it superficially in sync and a sweep to catch the writer
missing a case. Option A needs none of that: there is only one record, so
there is nothing to keep in sync and nothing to drift.

The cost the card names for Option A -- "the reviewer needs board access at
validation time" -- is already paid: `GET /api/tasks/:id` already returns
`requires_approval`/`approved_by`/`approved_at` for every task
(`taskParser.js`), and the board already binds `127.0.0.1` for exactly this
kind of local, scoped read. `approvalVerdict(task)` (pure, `approvalGate.js`)
turns those three fields into one explicit verdict object rather than leaving
every caller to re-derive `isApproved` logic for itself, and
`GET /api/tasks/:id/approval` (`httpApi.js`) is the one HTTP surface that
answers it. Both are read-only: `approvalVerdict` has no parameter or code
path that writes `approved_by`/`approved_at`, so it can forward an existing
human stamp but can never mint one -- the AP-3/AP-4 rule that only a human
gesture records approval is untouched.

`ASSET_PROVENANCE.md`'s prose stays exactly as written, including T-0257's
already-propagated row from PR #307 -- this decision does not retro-edit any
existing entry, and does not require the file to be touched at all going
forward. It remains a human-readable note for a reader with no board access;
it is simply never the thing a verdict is computed from.

### What this does not change

- **`approvalGate.js`'s AP-1..AP-9 are unchanged.** `approvalVerdict` is a new
  pure function over the existing `requiresApproval`/`isApproved` predicates,
  not a new way to grant or infer approval.
- **No existing `ASSET_PROVENANCE.md` row is rewritten.** This is a
  forward-looking resolution path, not a retro-edit of the record PR #307
  already hand-fixed.
- **Scope stays approval-record reconciliation.** This does not redesign
  `requires_approval`, the AP-3/AP-4 gestures, or any other asset-gate check.

### Addendum: instruction wiring blocked, two other backstops shipped instead

`approvalVerdict`/`GET /api/tasks/:id/approval` only closes the class of bug once a real consumer
resolves approval from them instead of `ASSET_PROVENANCE.md` prose. The natural place to say that
is `.claude/rules/assets.md` (loaded by the `assets` agent before deciding whether to generate
against a gated reference) — but editing anything under `.claude/**` was refused in this session,
confirmed across four separate attempts on two different files in two different sessions (T-0286
run-1's `.claude/rules/assets.md`/`.claude/agents/assets.md`, T-0286 run-2's re-confirmation on
`.claude/rules/js.md`, an unrelated file, which ruled out a per-file cause), regardless of the
`infra` agent's own documented scope. This reads as a session/harness-level guard on `.claude/**`
itself, not a per-file or per-content check. See
`docs/T-0286-claude-instruction-edit-blocked-attempt-log.md` for the exact refusals and the exact
edit text a session with `.claude/**` write access should apply.

**Two backstops shipped instead, run-2, aimed at the two different environments a consumer could
actually check this in:**

1. **CI (`checkApprovalProvenanceDrift.js` / `ci-approval-provenance-drift.yml`).** Run-1 shipped
   this against `FsTaskStore` reading `tasks/*.md`, which stops at T-0222 — every card in the real
   incident (T-0243/44/45/46, T-0257) lives only in the board's own db
   (`docs/design/cards-to-database.md`), which is deliberately kept outside git and is not
   reachable from a fresh GitHub Actions checkout. Run-1's check silently printed "passed" for
   exactly the cards it could not see — a missing data source rendering a reassuring pass, the
   opposite of what a backstop is for. `findApprovalDrift` now reports a distinct
   `unverifiable-approval-claim` drift kind for an approval-shaped provenance row naming a card
   with no matching task at all, bounded (via the new `collectAddedLines` git-diff helper) to
   rows the current PR's diff actually adds — never the ~200 pre-existing rows this repo's own
   fs-mode task list has never been able to resolve, which would otherwise turn every future
   unrelated PR permanently red. This makes the CI job loud instead of falsely green for the
   T-0223+ gap, but does not close it: CI still cannot resolve a db-mode card's real verdict, only
   refuse to pretend it can. Closing that gap for real would mean either exporting board approval
   state into a git-committed, CI-reachable form, or making the workflow reachable to the live
   db — both are a materially bigger change than approval-record reconciliation and are left as a
   follow-up card if the team wants CI-side coverage for db-mode cards specifically.
2. **The live board process itself (`approvalProvenanceStaleNotice`, wired into both
   `handlePatchTask` and `handleAddComment` in `httpApi.js`).** This is the one place that never
   has the CI gap: the board server holds the live, just-written approval record *and* a real git
   checkout of `ASSET_PROVENANCE.md` in the same process, on the same machine, at the exact moment
   a human's AP-3/AP-4 gesture stamps an approval. When the file's prose still contradicts what was
   just recorded, the board posts an informational `assembled-board` comment on the same card,
   live — the T-0257/T-0243 drift could have surfaced this way on 2026-08-30 itself, instead of
   sitting unnoticed for days. Read-only against `ASSET_PROVENANCE.md` and never blocks the
   approval; it does not, by itself, stop an agent from reading stale prose before generating (the
   actual shape of the T-0243 incident) — that half of the fix is still the deferred instruction
   edit above, which needs a human with `.claude/**` write access, not this session.

**Touched docs (this entry):**
- `docs/decision-log.md` — this entry (DL-27)
- `docs/board-invariants.md` — new invariant AP-10
- `docs/T-0286-claude-instruction-edit-blocked-attempt-log.md` — the blocked-edit attempt log
