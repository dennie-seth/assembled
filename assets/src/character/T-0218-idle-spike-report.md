# T-0218 Idle Spike Report — Method Spike: Player Idle Sheet at Game Scale

**Date:** 2026-08-24
**Status:** generation_loses — real run, stage-1 conditions (ControlNet/IP-Adapter not installed on host)
**Card:** T-0218 (HANDOFF §22.2)

---

## Hard Prerequisite Check

| Item | Result |
|---|---|
| WSL2 → ComfyUI reachability (172.18.192.1:8188) | **REACHABLE** |
| Tool used | `node tools/board/scripts/agentCurl.js GET http://172.18.192.1:8188/system_stats` |
| ComfyUI version | 0.29.0 |
| GPU | NVIDIA GeForce RTX 3070 Ti Laptop GPU (CUDA 12.1) |
| ControlNet models available | **NONE** (`/models/controlnet` returned `[]`) |
| IP-Adapter nodes available | **NONE** (not in object_info) |

ComfyUI is reachable via the `agentCurl.js` wrapper. Prior automated runner sessions were blocked because `curl` (plain) was denied; `node` was also denied. In this session, `node tools/board/scripts/agentCurl.js` succeeded.

**Stage-3 per §6.14 is NOT achievable on this host:** ControlNet and IP-Adapter are both absent. Stage-1 (SDXL + LoRA only) is the maximum achievable without installing additional extensions and models.

---

## Generation Run

| Parameter | Value |
|---|---|
| prompt_id | `2c6877df-303f-410c-9bc6-3671829acfb8` |
| Queue number | 38 |
| Stage | Stage-1 (LoRA only; no ControlNet, no IP-Adapter) |
| Checkpoint | `sd_xl_base_1.0.safetensors` (hash `31e35c80...893f7e5b`) |
| LoRA | `soviet_brutalism_style_v1.safetensors` weight 0.70 |
| Seed | 31415 |
| Resolution generated | 1008×1008 (fallback; VRAM was near-full, model cached from prior session) |
| Steps / CFG | 30 / 7.0, euler/normal |
| Descent | ImageScale area filter 1008→144 inside ComfyUI |
| Generation time | ~28 seconds |
| Output | `assets/final/character/player_idle_sheet_sdxl_T0218.png` (144×144) |

---

## Four-Question Evaluation

Visual inspection performed via Read tool at 144×144 and 1008×1008.

### Q1: Is the silhouette readable at 40px?

**YES.**

At 144×144 (3×3 grid, 48×48 cells, ≈40px figure height), the armored Soviet soldier figure is clearly readable. Helmet dome, shoulder armor, torso plate, legs and boots are all distinct. The LoRA's pixel art style produces excellent hard value separation — exactly what game scale needs.

Comparison with synthetic (`player_idle_sheet_v1.png`): the SDXL figure is dramatically more detailed and stylistically convincing. The descent (1008→144, area filter) does NOT destroy the figure. **Descent is not the failure mode here.**

### Q2: Does identity hold across adjacent frames?

**NO.**

The 8–9 panels show the character from different viewing angles: front-facing (visor visible), rear view (x2), three-quarter, side profile. These are concept reference sheet angles, not idle animation frames. A player cycling through cells would see the character rotate through multiple views rather than observe a subtle breathing motion. Cells cannot be looped as idle animation.

This is exactly the ControlNet-absent failure documented in T-0209 and MANUAL_GENERATION.md: "Without it SDXL produces frontal concept-art studies, not animation frames."

### Q3: Does it beat the synthetic sheet at game scale?

**NO** (for animation use).

The synthetic sheet (`player_idle_sheet_v1.png`) has 4 frames in correct animation format — same camera angle, 1px head-bob variation between cells. The SDXL output has no consistent camera angle: it cannot be used for animation as-is.

On purely visual quality: the SDXL soldier is far richer and more styled than the synthetic. But game-scale animation use is the criterion, and the format mismatch means the synthetic is currently more useful for its intended purpose.

### Q4: What is the failure mode?

**wrong_subject** (wrong output type).

The character identity is correct (Soviet armored pixel-art soldier, LoRA style applied, palette appropriate). The OUTPUT TYPE is wrong: the model interprets "sprite sheet" as "character reference sheet" (multiple viewing angles) rather than "animation frame sheet" (same angle, subtle pose variation).

- NOT "mush at 40px" — the figure reads cleanly at 40px
- NOT "identity drift" — the character TYPE is consistent across panels
- IS "wrong subject" in the sense of wrong output category

**Root cause:** No ControlNet pose grid to constrain cell layout to same-angle standing poses with subtle variation.

---

## Visual Comparison at Game Scale — In a Game Room

**Room-scene comparison image:** `assets/final/character/T0218-room-scene-comparison.png` (1440×480)
**Attached to card as:** `T0218-room-scene-comparison.png`

This image places both sprites inside a signal_tower game-room environment at 3× pixel-art scale (each 48×48 game cell rendered at 144×144px, the 40px figure rendered at ~120px height — clearly readable at review scale).

**Room layout:**
- **Top strip (wall):** `signal_tower_concrete_wall_16px.png` tile stretched across the full width — concrete grey mottled texture, clearly identifies the signal tower interior environment.
- **Middle (character zone):** Dark floor (#1a1a1a). Left 4 columns: the synthetic idle animation frames 0→1→2→3 in sequence (read left-to-right = one animation cycle). Right column (separated by background shift): SDXL stage-1 front-facing soldier cell.
- **Bottom strip (floor):** `signal_tower_concrete_wall_floor_transitions_16px.png` tile stretched across — concrete floor/wall junction, grounds the characters to the floor plane.

**What the image shows:**
- **Left 4 columns (synthetic idle, frames 0–3):** Simple geometric placeholder figure (home palette geometric blocks, very dark). Reading left-to-right the 4 idle frames show subtle pose variation — this is the head-bob animation cycle. Each frame has the same camera angle and character position, confirming correct animation format. At game scale the silhouette is readable but the figure is a geometric block-man, not a characterful soldier.
- **Right column (SDXL stage-1):** Richly-detailed armored pixel-art soldier in the same room context. Far superior artistic quality — helmet dome, shoulder armor, belt, boots are all legible at this scale. However this is a single reference cell (front-facing), not a loopable animation frame — the wrong-subject failure mode is evident from the fact that we can only show one cell as a representative view, while the synthetic yields 4 distinct animation frames.

At 1440×480 (2× final upscale of the 720×240 composite), the concrete wall texture and floor tile are clearly recognizable as signal_tower interior. The 4-frame animation strip makes the motion progression readable by eye without requiring actual GIF playback.

*Room-scene produced via ComfyUI compositing (no diffusion) — prompt_id `9d3f8812-0f88-4a32-b528-38880d8604b4`. Workflow: `assets/src/character/comfyui_room_scene_T0218.json`.*

---

## Side-by-Side Sheet Comparison (Full Sheets, 4× Scale)

**Prior comparison image:** `assets/final/character/T0218-game-scale-comparison.png` (1184×576, 4× pixel-art scale)
**Attached to card as:** `T0218-game-scale-comparison.png`

This places both full 3×3 sheets side-by-side at 4× nearest-exact scale to show all cells at once.

- **Left panel (synthetic):** Near-black background, 4 simple humanoid outlines (4 frames used, 5 cells spare/dark). Same camera angle across all cells — correct animation format.
- **Right panel (SDXL):** Grey-green background, 8 richly-detailed pixel-art armored soldiers from multiple viewing angles (front, rear ×2, three-quarter, side profile, partial views). Each cell is a distinct camera view — wrong output type for animation.

*Produced via ComfyUI compositing, prompt_id `f9e1f44c-01ff-4b5a-a9be-4d6d56c91bf7`. Workflow: `assets/src/character/comfyui_comparison_T0218.json`.*

---

## Baseline Comparison Table

| Metric | Synthetic (player_idle_sheet_v1.png) | SDXL stage-1 (player_idle_sheet_sdxl_T0218.png) |
|---|---|---|
| Size | 144×144 indexed PNG (mode P) | 144×144 RGB PNG |
| Cells | 3×3, 4 frames + 5 spare | 3×3, 8-9 multi-angle views |
| Figure | Geometric placeholder, ~10px head/40px body | Detailed pixel-art soldier, full equipment |
| Silhouette at 40px | Readable (simple humanoid) | Readable (detailed soldier) |
| Usable as idle animation | YES (correct format) | NO (wrong viewing angles) |
| Visual quality | Low (synthetic placeholder) | High (stylistically excellent) |
| Palette | Home palette (indexed) | Not quantized (area-downscale only) |

---

## Decision

**`generation_loses` — stage-1 conditions produce character reference sheets, not animation frames.**

Deterministic synthesis (`synth_sheet.py` / T-0200 pattern) remains the active approach.

**Quality signal is POSITIVE:** the LoRA style, the descent result at 40px, and the character silhouette quality are all correct and suitable. The failure is purely output-type/format. Stage-3 with ControlNet pose grid would very likely fix this and produce `generation_wins`.

---

## Prior Blocker History

| Attempt | Blocker |
|---|---|
| T-0198 (2026-08-18) | Python + ComfyUI unreachable from WSL |
| T-0212 (multiple) | WSL→ComfyUI HTTP access; ComfyUI tool path blocked |
| T-0218 runs 1–5 (2026-08-23) | `curl` and `node` denied in automated runner permission model |
| T-0218 (2026-08-24, **this run**) | agentCurl.js unblocked; ran; stage-3 blocked by missing ControlNet/IP-Adapter on ComfyUI host |

---

## How to Reach stage_wins

**Install on Windows host:**
1. ComfyUI-ControlNet extension → download an SDXL-compatible ControlNet OpenPose model to `F:\ComfyUI\models\controlnet\`
2. ComfyUI-IPAdapter-Plus extension → download IP-Adapter SDXL model

**Then re-trigger T-0218.** The recipe, prompts, and T-0209 concept reference (`player_character_concept_sheet_v1.png`, concept_hash `4f82e3c4...`) are all ready. Stage-3 conditions would be met and the 4-question evaluation should return `generation_wins` based on the quality signal from this stage-1 run.

---

## Structured Decision Log

Machine-checkable artifact: `assets/src/character/T-0218-spike-decision.json`
Tests: `assets/src/character/tests/test_idle_spike_T0218.py`
Generated output: `assets/final/character/player_idle_sheet_sdxl_T0218.png`
Provenance: `assets/final/character/player_idle_sheet_sdxl_T0218.provenance.json`
Comparison image: `assets/final/character/T0218-game-scale-comparison.png` (4× side-by-side, attached to card)
Comparison workflow: `assets/src/character/comfyui_comparison_T0218.json`
