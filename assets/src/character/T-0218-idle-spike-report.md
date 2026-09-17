# T-0218 Idle Spike Report — Method Spike: Player Idle Sheet at Game Scale

**Date:** 2026-08-24
**Status:** ambiguous → default to script — stage-3 run completed
**Card:** T-0218 (HANDOFF §22.2)

---

## Hard Prerequisite Check

| Item | Result |
|---|---|
| WSL2 → ComfyUI reachability (172.18.192.1:8188) | **REACHABLE** |
| Tool used | `node tools/board/scripts/agentCurl.js GET http://172.18.192.1:8188/system_stats` |
| ComfyUI version | 0.29.0 |
| GPU | NVIDIA GeForce RTX 3070 Ti Laptop GPU (CUDA 12.1) |
| ControlNet models available | **YES** — `controlnet-openpose-sdxl-1.0_xinsir.safetensors` |
| IP-Adapter models available | **YES** — `ip-adapter-plus_sdxl_vit-h.safetensors`, others |
| IP-Adapter nodes available | **YES** — ComfyUI_IPAdapter_plus (IPAdapterUnifiedLoader, IPAdapterAdvanced, etc.) |

All stage-3 dependencies installed and confirmed working. Ops smoke test (prompt_id `ebc48c2e-0abe-4d01-92fc-0ecdf47e05df`) verified the full pipeline on this host.

---

## Generation Run — Stage-3

### Pass 1: Pose Grid Generation

| Parameter | Value |
|---|---|
| Purpose | OpenPose ControlNet conditioning image |
| prompt_id | `a65b8383-9999-4795-babf-b29bb5953a89` |
| Checkpoint | `sd_xl_base_1.0.safetensors` (no LoRA) |
| Seed | 77777 |
| Steps / CFG | 20 / 3.5, euler/normal |
| Resolution | 1008×1008 |
| Output | `assets/final/character/pose_grid_stage3_T0218.png` |
| Note | DWPose/OpenPose preprocessor not installed. Skeleton generated via SDXL txt2img with anatomical diagram prompt. Produces skeleton-like visualization (detailed anatomical skeletons on dark background) that the ControlNet can process as pose reference. |

**Pose grid result:** SDXL generated a 3×3 grid of anatomical skeleton figures (skull, ribcage, pelvis, limbs visible on dark background). Figures vary somewhat in exact pose but are all upright humanoid forms facing mostly forward. The ControlNet model processed this to extract rough standing-figure pose constraints.

### Pass 2: Main Stage-3 Idle Sheet Generation

| Parameter | Value |
|---|---|
| prompt_id | `d2c526a6-f395-4774-b674-988ebbd43d71` |
| Stage | **Stage-3** (LoRA + IP-Adapter + ControlNet) |
| Checkpoint | `sd_xl_base_1.0.safetensors` |
| LoRA | `soviet_brutalism_style_v1.safetensors` (weight 0.70) |
| IP-Adapter | `ip-adapter-plus_sdxl_vit-h.safetensors` — PLUS preset, weight=0.65 |
| IP-Adapter reference | `player_character_concept_sheet_v1.png` (T-0209 concept, concept_hash `4f82e3c4…`) |
| ControlNet | `controlnet-openpose-sdxl-1.0_xinsir.safetensors` (strength=0.45, end=0.7) |
| ControlNet pose input | `pose_grid_stage3_T0218.png` (SDXL-generated skeleton) |
| Seed | 31415 |
| Steps / CFG | 30 / 7.0, euler/normal |
| Resolution generated | 1008×1008 |
| Descent | ImageScale area filter 1008→144 inside ComfyUI |
| Generation time | ~50 seconds |
| Output | `assets/final/character/player_idle_sheet_stage3_sdxl_T0218.png` (144×144) |

---

## Four-Question Evaluation

Visual inspection at 2× scale (96×96 per cell) in room-scene comparison image.

### Q1: Is the silhouette readable at 40px?

**YES.**

At 2× review scale (each 48×48 game cell displayed at 96×96), the military figure is clearly readable: helmet dome, olive-green jacket/coat, trousers with gear, boots. The IP-Adapter concept conditioning gave the figure real equipment detail visible at display scale. Dramatically more characterful than the synthetic geometric placeholder.

The LoRA style (muted olive-green/grey military palette, flat illustration) descends well. Descent (1008→144, area filter) does not destroy the figure — this was confirmed in the stage-1 run and holds here.

**Q1: PASS**

### Q2: Does identity hold across adjacent frames?

**NO (mixed by row).**

The 9 cells show two distinct "sub-identities":
- **Row 1 (top 3 cells):** Consistent front-facing figure in olive-green trench coat/jacket style. Same camera angle. Same basic equipment layout. These 3 cells could form a 3-frame idle loop.
- **Row 3 (bottom 3 cells):** Consistent front-facing figure in heavy tactical armor (more complex equipment, knee pads, vest). Same camera angle. Different costume variant from row 1.
- **Row 2 (middle 3 cells):** Equipment variation and some angle deviation. Less consistent. Acts as a transition between the two costume variants.

**Cross-row identity fails:** a player cycling all 9 frames would see jarring costume changes. The issue is not camera angle drift (solved by ControlNet) but equipment/costume inconsistency across the generation (identity_drift).

**Q2: FAIL** (for full 9-cell idle animation; individual rows hold internally)

### Q3: Does it beat the synthetic sheet at game scale?

**NO** (for complete pipeline use).

The synthetic sheet (`player_idle_sheet_v1.png`) has 4 frames with correct animation format: same character, same camera angle, same costume, same basic pose with 1px head-bob variation. The stage-3 output cannot replace it for idle animation use without manual curation (selecting only rows 1 or 3 as a 3-frame loop).

On purely visual quality per cell: YES — individual cells show a detailed, stylistically correct military figure that reads as the game character. But game-scale USE requires format correctness, and the full 9-cell sheet has format issues.

**Q3: FAIL** (for complete replacement; PASS for visual quality per cell)

### Q4: What is the failure mode?

**identity_drift** (costume/equipment inconsistency across rows).

This is a DIFFERENT failure from stage-1:
- **Stage-1 failure:** wrong_subject — model generated multi-angle character reference sheet instead of animation frames (8 viewing angles). ControlNet was absent.
- **Stage-3 failure:** identity_drift — model generates front-facing figures (ControlNet working!) but with equipment variation across rows.

The ControlNet OpenPose conditioning successfully resolved the orientation problem from stage-1. The IP-Adapter conditioned the character TYPE correctly (military figure with consistent style). The remaining problem is that the SDXL-generated skeleton grid (not a true DWPose output) provided rough body-shape guidance but did not enforce identical costume/pose per cell. Each cell's equipment loadout drifted independently during diffusion.

- NOT "mush at 40px" — figure reads clearly ✓
- NOT "wrong subject" — character is a military figure as expected ✓
- NOT "wrong viewing angle" — front-facing across most cells ✓ (ControlNet resolved stage-1's issue)
- IS "identity_drift" — equipment/costume varies across rows ✗

**Root cause:** DWPose preprocessor not installed → approximate SDXL skeleton used → less precise pose constraint → diffusion sampled varied equipment loadouts per cell.

---

## Visual Comparison at Game Scale — In a Game Room

**Stage-3 vs synthetic comparison:** `assets/final/character/T0218-stage3-room-comparison.png` (1184×768)
**Attached to card as:** `T0218-stage3-room-comparison.png`

Room layout (592×384 native canvas → 2× upscale → 1184×768):
- **Top strip (wall):** `signal_tower_concrete_wall_16px.png` stretched to 592×48
- **Character zone (384−48−48=288px):** Dark floor (#1a1a1a).
  - **LEFT (288×288):** Synthetic `player_idle_sheet_v1.png` at 2× scale — 9 cells (4 animation frames + 5 dark/spare), each 96×96 at display scale. Shows the 40px geometric placeholder figure at game context.
  - **RIGHT (288×288):** Stage-3 `player_idle_sheet_stage3_sdxl_T0218.png` at 2× scale — 9 cells, each 96×96. Shows the military figure: rows 1+3 front-facing and consistent, row 2 with some variation.
- **Bottom strip (floor):** `signal_tower_concrete_wall_floor_transitions_16px.png` stretched to 592×48

**What the comparison shows:**
- **LEFT (synthetic):** 4 simple geometric placeholder frames visible. Dark with minimal detail. Same camera angle and position in each frame — correct animation format. At game scale: readable but artistically crude.
- **RIGHT (stage-3):** 9 cells showing military figures. Top row: 3 front-facing jacket figures (consistent). Middle row: mixed with some variation. Bottom row: 3 front-facing heavy-armor figures (consistent). At game scale: high visual quality individual cells, but cross-row inconsistency visible in the 9-cell grid.

---

## Comparison Table

| Metric | Synthetic (player_idle_sheet_v1.png) | Stage-1 SDXL (player_idle_sheet_sdxl_T0218.png) | Stage-3 SDXL (player_idle_sheet_stage3_sdxl_T0218.png) |
|---|---|---|---|
| Generation | Procedural (synth_sheet.py) | SDXL + LoRA only | SDXL + LoRA + IP-Adapter + ControlNet |
| Size | 144×144 indexed PNG | 144×144 RGB PNG | 144×144 RGB PNG |
| Cells | 3×3, 4 frames + 5 spare | 3×3, 8 multi-angle views | 3×3, 9 cells (rows 1+3 front-facing, row 2 varied) |
| Silhouette at 40px | Readable (simple blocks) | Readable (detailed soldier) | Readable (detailed military figure) |
| Camera angle | CONSISTENT ✓ | INCONSISTENT ✗ (8 angles) | MOSTLY CONSISTENT ✓ (rows 1+3), varied ✗ (row 2) |
| Costume per cell | IDENTICAL ✓ | Varies (different angles) | VARIES ACROSS ROWS ✗ |
| Usable as idle animation | YES (correct format) | NO (wrong format) | NOT YET (cross-row drift) |
| Visual quality | Low (geometric) | High (styled soldier) | High (styled military figure) |
| Palette | Home palette (indexed) | RGB (not quantized) | RGB (not quantized) |

---

## Decision

**`ambiguous` → default to deterministic synthesis** per §6.14 decision tree.

Stage-3 is technically validated:
- ControlNet OpenPose: **WORKS** — enforces front-facing orientation
- IP-Adapter PLUS: **WORKS** — enforces character type/style
- LoRA style: **WORKS** — consistent Soviet brutalist military aesthetic
- Descent quality: **WORKS** — figure readable at 48×48

The remaining failure is equipment/costume identity drift across rows, caused by approximate skeleton conditioning (no DWPose). This is a solvable problem — not a fundamental pipeline limitation.

**Per the §6.14 rule:** `ambiguous ⇒ default to the script`. Deterministic synthesis (`synth_sheet.py`) remains the active approach for idle animation.

---

## How to Reach generation_wins

**Option A: Install DWPose on ComfyUI Windows host**
1. Install `ComfyUI-Advanced-ControlNet` or DWPose preprocessor extension
2. Generate true OpenPose skeleton grid (exact keypoints, identical pose in all 9 cells)
3. Re-run stage-3 with this DWPose grid → should enforce same-costume-per-cell via tighter pose constraint
4. Expected outcome: `generation_wins` based on the confirmed quality of LoRA+IP-Adapter at stage scale

**Option B: img2img with tiled single-frame reference**
- T-0212's tiled img2img method (same standing figure × 9 cells as init image, denoise=0.7)
- Add IP-Adapter for character conditioning
- This is the method described in `gen_idle_v3_tiled.py` and already partially validated

---

## Structured Artifacts

| Artifact | Path | Format |
|---|---|---|
| Stage-3 idle sheet (144×144) | `assets/final/character/player_idle_sheet_stage3_sdxl_T0218.png` | 144×144 RGB PNG |
| Stage-3 provenance | `assets/final/character/player_idle_sheet_stage3_sdxl_T0218.provenance.json` | JSON |
| Pose grid (1008×1008) | `assets/final/character/pose_grid_stage3_T0218.png` | 1008×1008 RGB PNG |
| Pose grid provenance | `assets/final/character/pose_grid_stage3_T0218.provenance.json` | JSON |
| Stage-3 room comparison | `assets/final/character/T0218-stage3-room-comparison.png` | 1184×768 RGB PNG |
| Decision log | `assets/src/character/T-0218-spike-decision.json` | JSON |
| Spike report | `assets/src/character/T-0218-idle-spike-report.md` | Markdown |
| Skeleton workflow | `assets/src/character/comfyui_stage3_skeleton_T0218.json` | ComfyUI workflow JSON |
| Main stage-3 workflow | `assets/src/character/comfyui_stage3_main_submit_T0218.json` | ComfyUI workflow + submit JSON |
| Comparison workflow | `assets/src/character/comfyui_stage3_room_compare_submit_T0218.json` | ComfyUI workflow + submit JSON |
| Tests | `assets/src/character/tests/test_idle_spike_T0218.py` | pytest |

---

## Blocker History

| Attempt | Blocker |
|---|---|
| T-0198 (2026-08-18) | Python + ComfyUI unreachable from WSL |
| T-0212 (multiple) | WSL→ComfyUI HTTP access; ComfyUI tool path blocked |
| T-0218 runs 1–5 (2026-08-23) | `curl` and `node` denied in automated runner permission model |
| T-0218 (2026-08-24, run A) | agentCurl.js unblocked; ran; stage-3 blocked by missing ControlNet/IP-Adapter on ComfyUI host |
| T-0218 (2026-08-24, run B — this run) | **STAGE-3 COMPLETED.** Outcome: ambiguous (identity_drift — cross-row costume inconsistency; DWPose not installed). |
