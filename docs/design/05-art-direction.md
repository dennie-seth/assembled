# 05 — Art Direction

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v1, direction locked · numbers open
> Related: `01-vision.md` §8, `PLAN.md` Phase 6

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

**Exact hex set is open (V-5).** The direction determines the family; the count and values still need fixing before Phase 6.

### Foreign universes — chroma

Anything that bled in renders in **its own palette**, and further travel means more chromatic violence (`01-vision.md` §8).

Against a concrete-and-oxide home, even mild saturation reads as *wrong*. The reference makes the mechanic louder for free — a foreign object does not need to be neon to be alarming, which leaves headroom for late-game chaos.

Implementation: palette-index shader, `origin_palette` on the row. One dial serves fiction, readability, and threat display simultaneously.

---

## 4. Asset Strategy

- **Archetype-first.** Each archetype gets a coherent asset set generated as one `art/*` branch, merged whole (`PLAN.md` §2 binary policy).
- **Variants are dressing, not rebuilds.** A second Hospital reuses the archetype's tileset with different props, decay state, palette weighting, and hazard placement. This is what keeps variant count affordable — variants must be cheap or the population-scaled variety model (`01-vision.md` §7) is unaffordable.
- **Anchor tags are authored, not generated.** Tag placement is level design; the generator supplies surfaces.

---

## 5. Open

**Resolved — V-4: internal resolution is `384×216`, 16:9, integer-scaled.** Chosen over 320×180 for horizontal sightline, which side-on avoidance play needs more than most genres. Scales cleanly to 1920×1080 (×5) and 3840×2160 (×10).

| # | Question | Blocks |
|---|---|---|
| **V-5** | Palette: colour count + hex values | **Phase 6** |
| A-1 | Tile size — 16px gives 24×13.5 tiles/screen; 24px gives 16×9 | tileset generation |
| A-2 | Asset inventory estimate: tiles / props / characters / VFX / UI | Phase 6 scope |
| A-3 | Variant authoring budget — how many hours is a second Hospital? | V-9 release schedule |
| A-4 | Chroma-intensity shader ramp vs. collapse proximity (`01-vision.md` §8) | Phase 6 |

**V-5 is now the last blocker for the art pipeline.** 24px does not divide 216 evenly (9 exactly, but 384/24 = 16 — both clean); 16px gives 216/16 = 13.5, so a half-tile band. Worth deciding with the first tileset rather than in the abstract.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-01 | Initial — direction locked, numbers open | Claude (Opus 5), rev. @DennieSeth |
