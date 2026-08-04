# Key Art

Composed scenes that establish mood/direction for humans — not a pipeline
input. Full distinction: `docs/design/13-asset-pipeline.md` §6.8.

- Committed and versioned, same as concept sheets, but for a different
  reason: there's no downstream consumer to regenerate it from a recipe,
  it's kept as direction reference.
- **Does not feed generation.** No IP-Adapter/img2img conditioning reads
  from this directory.
- **Does not feed palette extraction (T-0105).** Key art is typically in
  perspective and carries atmospheric elements (sky, fog, treeline) that
  would skew colour clustering.
- **No provenance hash.** Sidecars here (`*.provenance.json`,
  `*.recipe.json`) are kept for regeneration convenience only — nothing
  reads `concept_hash` from this directory the way `13-asset-pipeline.md`
  §6's coherence guard (T-0106) reads it from `assets/src/concept/`.

For sheets that actually condition generation — flat side-on, one asset
set, feeds the pipeline — see `assets/src/concept/` and §6.9.

## Current contents

`signal_tower_exterior.*` / `signal_tower_interior.*` — Signal Tower
direction key art, direction-approved 2026-08-02. See
`13-asset-pipeline.md` §6.10 for why these are key art rather than
concept sheets, and what a real Signal Tower concept sheet still needs.
