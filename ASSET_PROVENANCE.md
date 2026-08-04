# Asset Provenance

Every asset produced by the `assets` or `audio` agent gets an entry here —
`model + license + prompt + seed` (`.claude/rules/conduct.md`). The
writer that appends automatically is **T-0075**, not yet built; this file
is populated by hand until then. Full per-asset detail (workflow hash,
prompt_id, palette lineage, etc.) lives in the `.provenance.json` sidecar
next to each asset under `assets/final/` — this table is the index/summary.

| Asset | Model | License | Prompt | Seed |
|---|---|---|---|---|
| `assets/final/palette/home_palette.png` (+ `.json`) | N/A — extracted (T-0105), not generated | N/A | Clustered from `assets/src/concept/signal_tower_material_sheet.png` (N=16, see `home_palette.json`'s `_comment`/`source`) | N/A (deterministic, seed=42 in `palette_extract.extract`) |
| `assets/final/tiles/signal_tower_concrete_wall_16px.png` | `sd_xl_base_1.0.safetensors` | CreativeML Open RAIL++-M | "flat brutalist concrete wall texture, straight-on orthographic surface photograph, uniform tileable pattern, muted concrete grey with subtle oxide rust stains and institutional green patina, weathered stained surface detail, interior industrial concrete panel, even lighting, no border" | 4201 |
