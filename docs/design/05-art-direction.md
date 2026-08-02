# 05 — Art Direction

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v3, direction + tile size + palette process locked
> Related: `01-vision.md` §8, `PLAN.md` Phase 6, `13-asset-pipeline.md` §6, `14-vertical-slice.md`

---

## 1. Direction

**Abandoned Soviet constructivism and brutalism.** Pixel art, side-on, locked palette.

Concrete. Institutional geometry. Repetition as architecture. Buildings that were designed to outlast the people in them, and did.

---

## 2. Why This Fits the Pipeline

The reference was chosen for the game, but it happens to be unusually favourable to every constraint already in the plan:

| Property | Consequence |
|---|---|
| **Modular repetitive geometry** | Tiles natively. A brutalist facade *is* a tileset — the style's defining trait is what tile-based rendering is good at. |
| **Large consistent reference corpus** | Style LoRA training (T-0072) has abundant, visually coherent source material. Curating 30–50 refs is easy rather than a hunt. |
| **Inherently desaturated** | The home palette falls out of the reference instead of being imposed on it. |
| **Forgiving of generation artifacts** | Weathered concrete, stains, decay — surface noise reads as texture, not as error. Pixel art plus decay is the most artifact-tolerant combination available. |
| **Hard geometric silhouettes** | Side-on readability at low internal resolution. Clean shapes survive downsampling; organic ones do not. |

**The style and the tech agreed before we noticed.** That is worth banking rather than second-guessing.

---

## 3. Palette

### Home universe — muted

Derived from the reference, not invented:
- Concrete greys — the structural base, widest range
- Oxide and rust — the only warm notes
- Institutional green and ochre — interiors, corridors, the specific palette of a state that painted everything the same colour
- Deep shadow — near-black, not black

**Exact hex set is resolved as a process, not a fixed list (V-5, `13-asset-pipeline.md` §6).** The direction determines the family (above); the count and exact values are *extracted* from the first approved concept sheet (T-0104/T-0105) rather than chosen abstractly.

### Foreign universes — chroma

Anything that bled in renders in **its own palette**, and further travel means more chromatic violence (`01-vision.md` §8).

Against a concrete-and-oxide home, even mild saturation reads as *wrong*. The reference makes the mechanic louder for free — a foreign object does not need to be neon to be alarming, which leaves headroom for late-game chaos.

Implementation: palette-index shader, `origin_palette` on the row. One dial serves fiction, readability, and threat display simultaneously.

---

## 4. Asset Strategy

- **Archetype-first.** Each archetype gets a coherent asset set generated as one `art/*` branch, merged whole (`PLAN.md` §2 binary policy).
- **Variants are dressing, not rebuilds.** A second Hospital reuses the archetype's tileset with different props, decay state, palette weighting, and hazard placement. This is what keeps variant count affordable — variants must be cheap or the population-scaled variety model (`01-vision.md` §7) is unaffordable.
- **Anchor tags are authored, not generated.** Tag placement is level design; the generator supplies surfaces.

> **How assets are actually made lives in `13-asset-pipeline.md`.** This document decides what the game looks like; that one decides the generation chain, the descent to native resolution, the validation gate, and the indexed-PNG storage format that the chroma swap depends on.

---

## 5. Open

**Resolved — V-4: internal resolution is `384×216`, 16:9, integer-scaled.** Chosen over 320×180 for horizontal sightline, which side-on avoidance play needs more than most genres. Scales cleanly to 1920×1080 (×5) and 3840×2160 (×10).

**Resolved — A-1: tile size is `16px`.** Decided on generation arithmetic: 16 divides 1024 exactly (×64), so a tile descends from a native SDXL resolution at a clean integer factor. 24px would need 1152 (×48) and lands off SDXL's aspect buckets more often.

The cost is a half-tile band — 216 ÷ 16 = 13.5. **Rooms are authored on a 24×14 tile grid (384×224)**; the viewport shows 216 of it and the remaining 8px is non-gameplay bleed (floor thickness, ceiling shadow). Level design gets an integer grid; the band costs nothing. Full treatment in `13-asset-pipeline.md` §3.3.

| # | Question | Blocks |
|---|---|---|
| ~~**V-5**~~ | ~~Palette: colour count + hex values~~ — resolved as a process, extracted from the first approved concept sheet (`13-asset-pipeline.md` §6) | — |
| A-2 | Asset inventory estimate: tiles / props / characters / VFX / UI | Phase 6 scope |
| A-3 | Variant authoring budget — how many hours is a second Hospital? | V-9 release schedule |
| A-4 | Chroma-intensity shader ramp vs. collapse proximity (`01-vision.md` §8) | Phase 6 |
| A-5 | Bleed-alpha shader ramp — held/world timer proximity, contour-only at expiry (`07-items-economy.md` §5, `11-moment-to-moment.md` §6) | Phase 6 |

**The quantizer (T-0073) now unblocks per-archetype, on that archetype's concept approval** — not on a single global V-5 decision. The first archetype through is the Signal Tower (`14-vertical-slice.md`).

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial — direction locked, numbers open | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-02 | v2: **A-1 resolved — 16px tiles**, 24×14 authoring grid, 8px band; pipeline split out to `13-asset-pipeline.md` | Claude, rev. pending |
| 2026-08-02 | v3: **V-5 resolved as a process** — palette extracted from the first approved concept sheet rather than chosen abstractly (`13-asset-pipeline.md` §6); quantizer now unblocks per-archetype | Claude, rev. pending |
