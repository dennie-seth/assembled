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
