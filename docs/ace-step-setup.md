# ACE-Step Setup (T-0080)

**Author:** Claude (Sonnet 5)
**Date:** 2026-08-02
**Host:** Windows 11 (not WSL — needs direct GPU access), RTX 3070 Ti Laptop
GPU, 8 GB VRAM, driver 581.57 / CUDA 13.0.

Installed ACE-Step (music generation foundation model) so the AudioAgent
(T-0082) can drive it. Same host-placement rationale as
`docs/comfyui-setup.md` (T-0070) — WSL has no GPU passthrough here.

## Install

- Path: `F:\ACE-Step` (cloned from `https://github.com/ace-step/ACE-Step.git`).
- License: **Apache 2.0** (confirmed from repo `LICENSE` file and
  `ace_step` package metadata). Ungated on Hugging Face — no login or
  license click-through was needed at any point (verified `HfApi().model_info(...).gated == False`
  before downloading).
- venv: `F:\ACE-Step\venv`, Python 3.12.1.
- PyTorch: `torch==2.5.1+cu121` (same wheel as the ComfyUI install —
  driver's CUDA 13.0 is backward-compatible). `torch.cuda.is_available()` →
  `True`, device `NVIDIA GeForce RTX 3070 Ti Laptop GPU`.
- `pip install -e .` (repo's own `setup.py`) — clean, no errors. Installs
  the `acestep` console script (`acestep.gui:main`, a Gradio app) plus the
  `acestep` Python package (`ACEStepPipeline` etc.).
- `torch_compile` was **not** enabled/tested — it requires `triton-windows`
  on Windows, which was not installed for this pass (not needed to fit
  8 GB; see VRAM results below). Follow-up if speed becomes a concern.

## Weights

- Model: `ACE-Step/ACE-Step-v1-3.5B` on Hugging Face, auto-downloaded via
  `huggingface_hub.snapshot_download` (the same mechanism `ACEStepPipeline`
  uses internally) to `F:\ACE-Step\checkpoints`.
- Verified as real weights, not HTML error pages — every `.safetensors`
  file's first bytes are a valid safetensors header (`{"__metadata...`),
  not `<html`.
- Total size: **7.8 GB**, four components:
  - `ace_step_transformer/diffusion_pytorch_model.safetensors` — 6.61 GB
    (the 3.5B-param DiT)
  - `umt5-base/model.safetensors` — 1.13 GB (text encoder)
  - `music_dcae_f8c8/diffusion_pytorch_model.safetensors` — 314 MB
  - `music_vocoder/diffusion_pytorch_model.safetensors` — 206 MB
- Download took ~6.5 min over this connection, no login/auth prompt at
  any point.

## Test generation — fits in 8 GB, but tight

Ran an 8-second instrumental clip via the repo's own inference path
(`ACEStepPipeline.__call__`, the same call `infer.py`/the Gradio app use),
scripted directly against the Python API rather than the GUI, with the
repo's documented low-VRAM flags:

```python
ACEStepPipeline(
    checkpoint_dir="F:/ACE-Step/checkpoints",
    dtype="bfloat16",
    torch_compile=False,
    cpu_offload=True,
    overlapped_decode=True,
)
```
27 inference steps, euler scheduler, apg cfg — the repo's documented
"reduced to 8GB VRAM" combo minus `torch_compile` (skipped, see above).

**Result: succeeds, no OOM, real audio written** —
`RIFF/WAVE, IEEE Float, stereo, 48000 Hz`, 3.07 MB for 8 s.

- **Generation time:** ~37–40 s wall time (includes ~11 s one-time model
  load; the 27-step diffusion loop itself is ~17–20 s on this GPU).
- **VRAM — idle before this process starts:** ~2.5 GB already in use by
  an unrelated pre-existing process on this machine (not ACE-Step, not
  ComfyUI — a separate `python.exe`, PID present at session start). This
  is host-specific background noise, not an ACE-Step cost, but it eats
  into the 8 GB budget any real deployment will also compete with.
- **VRAM — peak during generation, measured two ways:**
  - `torch.cuda.max_memory_reserved()` for the ACE-Step process alone:
    **6.70 GB**.
  - System-wide peak via `nvidia-smi` polled at 1 Hz throughout the run
    (the number that actually matters for OOM risk): **7949 MiB / 8192 MiB
    total — only ~243 MB of headroom left.**
- **Bottom line: it fits, but just barely.** With the pre-existing ~2.5 GB
  background process also on this GPU, there was well under 250 MB of
  slack at peak. Any additional concurrent GPU consumer (a second
  generation, ComfyUI running at the same time, a heavier prompt/longer
  duration, more inference steps) would very plausibly OOM. `cpu_offload`
  + `overlapped_decode` (both enabled above) are doing real work here —
  without them this would not fit an 8 GB card at all — but there is no
  extra margin to give up. If T-0082 needs headroom, the next lever
  documented by the repo is `torch_compile` (speed, not VRAM) or reducing
  `infer_step`/duration further; there is no lower-VRAM flag left unused.

Output written to `F:\ACE-Step\test_output.wav` (test artifact); one copy
also placed at `F:\PetProjects\ace_step_sample.wav` for review outside the
repo (not committed — binary sample, not project source).

## Integration surface for AudioAgent (T-0082)

ACE-Step exposes three interfaces, all in the installed repo:

1. **Gradio server (the repo's primary UX):** `acestep` console script →
   `acestep.gui:main`. Launch:
   ```
   F:\ACE-Step\venv\Scripts\acestep.exe --server_name 0.0.0.0 --port 7865 --cpu_offload true --overlapped_decode true
   ```
   Default port **7865**, default `--server_name` is `127.0.0.1` (must
   override to `0.0.0.0` for any non-localhost reachability, same as
   ComfyUI's `--listen`). The UI wires its buttons
   (`text2music_bnt.click(...)`, `acestep/ui/components.py`) **without an
   explicit `api_name`**, so Gradio auto-derives the HTTP API endpoint —
   usable via `gradio_client`, but the exact endpoint needs to be
   discovered with `Client(url).view_api()` rather than assumed; it is not
   a stable, hand-authored contract the way ComfyUI's `/prompt` is.
2. **FastAPI template already in the repo:** `infer-api.py` — `POST
   /generate` on port 8000. As shipped this re-instantiates
   `ACEStepPipeline` (and reloads the full checkpoint, ~11 s) on **every
   request** — fine as a reference/scaffold, not as-is for repeated
   AudioAgent calls. A persistent-pipeline variant (load once at startup,
   reuse across requests — a small, mechanical change) would give a
   clean, versioned JSON-in/file-out contract much closer to
   `tools/comfy-client`'s `/prompt`→poll→`/view` shape.
3. **Direct Python API:** `from acestep.pipeline_ace_step import
   ACEStepPipeline` — construct once, call `pipeline(...)` repeatedly (this
   is exactly what `test_gen.py`, `infer.py`, and the Gradio app all do
   under the hood). No HTTP hop, no separate process; only viable if
   AudioAgent's own process runs on the Windows host directly (mirrors how
   ComfyUI needed Windows-host placement for GPU access).

**Recommendation for T-0082:** if AudioAgent runs in WSL like AssetAgent
does, driving ACE-Step over HTTP needs *some* persistent-process server on
the Windows host — either the Gradio app (accept the undocumented-endpoint
tradeoff) or a small patched `infer-api.py` (recommended: mirrors the
existing `comfy-client` pattern most closely). That decision and the
wrapper itself are T-0082's scope, not built here.

**Firewall (flagged, not changed):** whichever port is chosen (7865 for
Gradio, or a custom port for a patched FastAPI service), WSL will not be
able to reach it until a Windows Firewall allow-rule scoped to the WSL
subnet is added — identical to the `New-NetFirewallRule -DisplayName
"ComfyUI 8188 (WSL)" ...` rule already applied for T-0070 (see
`docs/comfyui-setup.md`). This is a system/security-setting change; per
task scope, it was **not** made here. The user needs to run the
equivalent rule for whichever port T-0082 settles on, e.g.:
```powershell
New-NetFirewallRule -DisplayName "ACE-Step 7865 (WSL)" -Direction Inbound -Protocol TCP -LocalPort 7865 -RemoteAddress <wsl-subnet> -Action Allow
```

## Bottom line for T-0080 acceptance

ACE-Step is installed, weights downloaded and verified (Apache-2.0,
ungated, no credentials used), and a real generation confirmed working on
this 8 GB card with `cpu_offload` + `overlapped_decode` — but **at close
to zero VRAM headroom** (~243 MB peak slack against the full 8192 MB, with
a pre-existing ~2.5 GB background process also on the GPU). That headroom
number is the single most important input for T-0082's design: it should
assume ACE-Step gets exclusive/near-exclusive use of this GPU while
generating, not concurrent use alongside ComfyUI or anything else
GPU-heavy.
