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

## Persistent server (T-0082)

`tools/audio-agent` (T-0082, in the game repo) needs a long-lived HTTP
endpoint instead of the per-request `initialize_pipeline()` stock
`infer-api.py` does. The patch lives **outside the game repo**, as a
sibling file in this ACE-Step clone rather than an in-place edit, so the
clone stays a clean upstream checkout: **`F:\ACE-Step\infer-api-persistent.py`**.

Two changes from stock `infer-api.py`:

1. **Pipeline loaded once at import time** with the verified `cpu_offload=True,
   overlapped_decode=True, bf16` combo from this doc's VRAM section, reused
   across every `POST /generate` instead of a fresh ~11s reload per call.
2. **Added `GET /output/{filename}`** so a caller can fetch the WAV bytes
   `/generate` wrote server-side — stock `infer-api.py` returns only a
   server-local path, with no way to retrieve the file over HTTP.
   `filename` is reduced to its basename on both write and read, so a
   client can't escape `ACE_STEP_OUTPUT_DIR` via `../` segments.

**A real integration bug was caught and fixed while building this, not
just a mechanical "load once" change:** stock `infer-api.py` calls
`ACEStepPipeline.__call__` **positionally**, but the version of `acestep`
installed on this machine has drifted from the parameter order that
positional call assumes — it gained a leading `format` parameter and
renamed `actual_seeds` to `manual_seeds` (now a real list, not a
`", ".join`-ed string), which silently shifted every later positional
argument by one slot and broke generation (`object of type 'int' has no
len()`, since the joined-seeds string was landing in an int-typed
parameter and vice versa elsewhere). Confirmed via
`inspect.signature(ACEStepPipeline.__call__)` and fixed by calling with
**keyword arguments** matching the actual installed signature instead of
mirroring the stock script's positional call.

Environment variables (all optional):

| Var | Default |
|---|---|
| `ACE_STEP_CHECKPOINT_DIR` | `F:/ACE-Step/checkpoints` |
| `ACE_STEP_OUTPUT_DIR` | `F:/ACE-Step/outputs` |
| `ACE_STEP_DEVICE_ID` | `0` |
| `ACE_STEP_BF16` | `true` |
| `ACE_STEP_PORT` | `8001` (not ACE-Step's stock 8000 — picked to avoid colliding with anything else that might claim 8000 on this host) |

### Launch (detached, logging to a file)

```powershell
$proc = Start-Process -FilePath 'F:\ACE-Step\venv\Scripts\python.exe' `
  -ArgumentList 'F:\ACE-Step\infer-api-persistent.py' `
  -WorkingDirectory 'F:\ACE-Step' `
  -RedirectStandardOutput 'F:\ACE-Step\infer-api-persistent.log' `
  -RedirectStandardError 'F:\ACE-Step\infer-api-persistent.err.log' `
  -PassThru -WindowStyle Hidden
$proc.Id | Out-File -FilePath 'F:\ACE-Step\infer-api-persistent.pid' -Encoding ascii
```

Verify from Windows (loopback works regardless of the firewall rule
below):

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8001/health' -UseBasicParsing
```

**Status as of this writing: running.** PID recorded in
`F:\ACE-Step\infer-api-persistent.pid`, logs in the two files above.
A local (loopback-only, no WSL involved) end-to-end smoke test — real
`POST /generate` for a 6s clip, then `GET /output/{filename}` — was run
directly against this instance and confirmed a valid RIFF/WAVE file
round-trips correctly. That is a different, narrower check than the
"live smoke" below: it validates this patch's own correctness on this
machine, not the WSL → Windows path `tools/audio-agent` will use.

### Firewall (flagged, not changed — same as T-0070)

Same shape as the `ComfyUI 8188 (WSL)` rule in `docs/comfyui-setup.md`,
for this server's port instead. **This is a system/security-setting
change — not run by this agent.** The user needs to run, by hand:

```powershell
New-NetFirewallRule -DisplayName "ACE-Step 8001 (WSL)" -Direction Inbound -Protocol TCP -LocalPort 8001 -RemoteAddress 172.18.192.0/20 -Action Allow
```

(`172.18.192.0/20` is this host's current WSL NAT subnet, same one
`docs/comfyui-setup.md` used — re-derive with `ip route show default`
inside WSL if it ever changes.) Re-verify after applying with:

```sh
wsl -d Ubuntu-24.04 -u dennieseth -- bash -lc "curl -s http://172.18.192.1:8001/health"
```

### Manual live smoke (not run by this agent — WSL can't reach this port yet)

Once the firewall rule above is applied, run **one** real generation from
the WSL side, through `tools/audio-agent`, exactly as the AudioAgent will:

```sh
cd tools/audio-agent   # in the game repo
.venv/bin/python scripts/live_smoke.py
# or pin the base URL explicitly:
ACESTEP_BASE_URL=http://172.18.192.1:8001 .venv/bin/python scripts/live_smoke.py
```

This is the first real exercise of the WSL → Windows path end to end
(everything up to this point — the package's own test suite and this
doc's local loopback smoke test — deliberately avoids it). See
`tools/audio-agent/README.md`'s "Manual live smoke" section for what it
does and where it writes output.

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
