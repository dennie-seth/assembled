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
| `assets/final/tiles/signal_tower_concrete_wall_floor_transitions_16px.png` | N/A — procedurally generated (T-0153), not AI-generated | N/A | 64×32 indexed PNG (mode P), 8 transition tiles (wall, floor, wall→floor vertical/horizontal, corners TL/TR/BL/BR) composed from home palette indices using `assets/src/tiles/src/tile_gen/transition_sheet.py`. All tiles satisfy T-0102's seamlessness and transition-adjacency gate checks (12/12 pass). | Deterministic — seed N/A; output is fully determined by palette slot indices (WALL=8, FLOOR=13, JOINT=4 from `assets/final/palette/home_palette.json`) and tile layout constants in `transition_sheet.py` |

**Not yet produced:** `assets/final/lora/soviet_brutalism_style_v1.safetensors`
(T-0072) has **not been trained**. The curated 44-image reference corpus
(`assets/src/lora/corpus.json`, CC-BY-SA-4.0/3.0) and the committed
training config (`assets/src/lora/training_config.toml`) both exist, but
no training run has produced weights and no file exists under
`assets/final/lora/`. T-0072 is reopened (`ready`); this row will be
added back, with real model/license/prompt/seed fields, once an actual
training run commits real weights.
