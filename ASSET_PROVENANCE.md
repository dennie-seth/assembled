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
| `assets/final/lora/soviet_brutalism_style_v1.safetensors` (Git LFS) | SDXL style LoRA, base `sd_xl_base_1.0.safetensors`, trained via the WSL-native kohya sd-scripts stack (see `docs/lora-training-env.md`); rank=16, alpha=8, target modules `to_q`/`to_k`/`to_v`/`to_out.0` (`assets/src/lora/training_config.toml`) | CreativeML Open RAIL++-M (base checkpoint) + CC-BY-SA-4.0/3.0 (44-image reference corpus, `assets/src/lora/corpus.json`) | Trained (not prompted) — style LoRA fit to the full 44-image Soviet brutalist/constructivist reference corpus, 10 epochs / 440 steps, `1.0e-4` learning rate, `AdamW8bit`, resolution 1024, `fp16` | N/A (training run, not a single-seed generation) |

**Trained and deployed (2026-08-12):** `assets/final/lora/soviet_brutalism_style_v1.safetensors`
(T-0072) completed a full training run — 10/10 epochs, 440/440 steps,
2026-08-12 11:15–14:15 UTC — producing a valid 218MB SDXL LoRA (2958
tensors), verified by loading it. Deployed to
`F:\ComfyUI\models\loras\soviet_brutalism_style_v1.safetensors`. The file
is tracked via Git LFS (`.gitattributes`: `assets/final/lora/*.safetensors`)
since it exceeds GitHub's 100MB per-blob limit — the earlier `blocked`
status on T-0072 was solely this push-size rejection, not a training
failure; no re-train was needed once LFS was set up.
