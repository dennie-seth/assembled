# T-0218 Idle Spike Report — Method Spike: Player Idle Sheet at Game Scale

**Date:** 2026-08-23
**Status:** NOT_RUN — ComfyUI unreachable from automated agent environment
**Card:** T-0218 (HANDOFF §22.2)

---

## Hard Prerequisite Check

| Item | Result |
|---|---|
| WSL2 → ComfyUI reachability (172.18.192.1:8188) | **BLOCKED** |
| Tool used | `curl -s --max-time 5 http://172.18.192.1:8188/system_stats` |
| Denial reason | Requires user approval; not granted in this automated runner session |
| Fallback (agentCurl.js via node) | Also blocked — node execution denied in this session |

**Per the card's hard prerequisite:** "If it's broken, this card must report that fact as `NOT_RUN` with reason — it must NOT fall back to a placeholder and report a result."

---

## Outcome: NOT_RUN

The spike did not run. The prerequisite check (WSL→ComfyUI reachability) could not be verified because both HTTP tool paths are blocked in this session. No generation was attempted, and no comparison was produced.

This is the third recorded occurrence of this exact blocker:
1. **T-0198 (2026-08-18):** SPIKE_REPORT.md — "Python execution not approved; ComfyUI not reachable from WSL"
2. **T-0212 (prior attempts):** Multiple recipe `_note` fields name WSL→ComfyUI access as recurring blocker
3. **T-0218 (2026-08-23):** curl tool call denied by runner permission model

---

## Baseline (Synthetic Sheet — T-0198)

The existing `assets/final/character/player_idle_sheet_v1.png` is a **synthetic placeholder**, not an SDXL-generated output:

- **Generator:** `assets/src/character/src/char_gen/synth_sheet.py`
- **Layout:** 144×144, mode P (indexed), 3×3 grid, 4-frame idle animation, 40px humanoid silhouette
- **Palette indices used:** BG=0 (dark background) / LEG=4 / BODY=6 / HEAD=10 (home palette)
- **Animation:** 1px vertical head-bob between adjacent frames
- **Gate status:** Passes all 5 automated checks (palette membership, index semantics, cell fit, orphan pixels, frame consistency)

At 40px game scale, the synthetic sheet is readable — the silhouette shape is distinct and the head-bob is detectable. **This is the bar the SDXL-generated output must clear to justify the per-character LoRA path.**

---

## Generation Recipe (Ready — Not Executed)

| Parameter | Value |
|---|---|
| Checkpoint | `sd_xl_base_1.0.safetensors` |
| LoRA | `soviet_brutalism_style_v1.safetensors` weight 0.70 |
| Seed | 31415 |
| Resolution | 1152×1152 (×8 from 144×144 native; fallback 1008 if 8 GB strains) |
| Steps / CFG | 30 / 7.0 |
| Conditioning | T-0209 concept sheet as IP-Adapter reference (concept_hash=`4f82e3c4...`) |
| ControlNet | Pose grid — mandatory; without it, SDXL returns frontal concept-art studies, not animation frames |
| Descent | Box-average 1152→144, quantize to home_palette.json (Oklab, dithering OFF) |

Full recipe: `assets/src/character/player_idle_sheet_v1.recipe.json`
Manual generation guide: `assets/src/character/MANUAL_GENERATION.md`

---

## The Four Evaluation Questions (Not Answered — Spike Did Not Run)

These are the questions this spike was designed to answer. They remain open.

1. **Silhouette readable at 40px?**
   Does the figure read as a distinct human shape when the 1152px output is box-averaged to 144px and displayed at 40px figure height? The squint test: cover 90% of the sheet; does the remainder still read?

2. **Identity holds across adjacent frames?**
   Do cells (0,0)→(0,1)→(0,2)→(1,0) show the same character? 1px head-drift between adjacent idle frames is the documented failure threshold players notice.

3. **Beats the synthetic sheet at game scale?**
   Side-by-side in a 384×216 game room at 40px, does the SDXL-descended output offer visible improvement over the synthetic? If not, the synthetic path is cheaper, reproducible, and already proven.

4. **Failure mode if it fails?**
   - (a) Wrong subject: model generated a different character → corpus / IP-Adapter conditioning problem
   - (b) Mush at 40px: reads at 1152px but destroyed by descent → §6.13 escalation path (retrain LoRA on quantized data)
   - (c) Identity drift: frame geometry shifts → more ControlNet weight or per-frame img2img seeding

---

## Decision

**NOT_RUN → defaults to deterministic synthesis (the script).**

Per the card's own rule: "ambiguous ⇒ default to the script." NOT_RUN is treated as ambiguous because generation quality was never evaluated. `synth_sheet.py` / `synth_entities.py` remains the active approach for character sheets — it is cheaper, reproducible, proven (T-0200, T-0214), and already passing all automated gate checks.

This decision is **provisional**. If WSL→ComfyUI access is unblocked and a real run produces a sheet that passes the four questions above, it supersedes this report and the decision should be updated to `generation_wins`.

---

## How to Unblock

**Option A — approve tool access in runner:**
Grant `curl` or `node` execution in the automated runner's permission model for this worktree, then re-trigger T-0218. All recipe inputs are ready.

**Option B — manual Windows-side run:**
Follow `assets/src/character/MANUAL_GENERATION.md` on the Windows host. Descend the output (box-average → palette-quantize). Attach the result to this card. A human with the 1152px sheet and the 40px game-scale render can answer the four questions directly.

---

## Structured Decision Log

Machine-checkable artifact: `assets/src/character/T-0218-spike-decision.json`
Tests: `assets/src/character/tests/test_idle_spike_T0218.py`
