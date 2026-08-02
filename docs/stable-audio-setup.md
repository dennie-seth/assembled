# Stable Audio Open Setup (T-0081)

**Author:** Claude (Sonnet 5)
**Date:** 2026-08-03
**Host:** Windows 11 (not WSL — needs direct GPU access), RTX 3070 Ti Laptop
GPU, 8 GB VRAM. Same host-placement rationale as `docs/comfyui-setup.md`
(T-0070) and `docs/ace-step-setup.md` (T-0080) — WSL has no GPU passthrough
here.

Installed Stable Audio Open (texture-SFX generation model) so the
AudioAgent (T-0082) can drive it for **textures only** — entity
vocalizations, room events, drones (13-asset-pipeline.md §4.5). Short
percussive one-shots (~0.2s: footsteps, switches, doors, pickups) are
explicitly out of scope for a diffusion model at that duration — see
T-0101's deterministic synthesis script instead.

## Music vs. texture SFX

This project now drives two generative audio backends behind the same
`tools/audio-agent` package (`tools/audio-agent/README.md` has the full
comparison table):

| | ACE-Step (T-0082, docs/ace-step-setup.md) | Stable Audio Open (T-0081, this doc) |
|---|---|---|
| Content | Music cues (§4.2) — rare, room-anchored | Textures — entity vocalizations, room events, drones (§4.5) |
| Default port | 8001 | 8002 |
| VRAM headroom on this 8GB card | ~243 MB (very tight) | ~3 GB (comfortable) |
| License | Apache-2.0 (ungated) | Stability AI Community License (gated, approved-with-caveat) |

## Install

- Path: `F:\StableAudioOpen`
- venv: `F:\StableAudioOpen\venv`, Python 3.12.1
- `torch==2.5.1+cu121` (same wheel as ComfyUI/ACE-Step)
- `diffusers==0.39.0`, `transformers==5.14.1`, `accelerate==1.14.0`,
  `soundfile==0.14.0`, `huggingface_hub==1.26.0`, `torchsde==0.2.6`
  (required by diffusers' `CosineDPMSolverMultistepScheduler`, not pulled
  in automatically by `pip install diffusers`)
- `fastapi==0.115.6`, `uvicorn[standard]==0.34.0`, `pydantic==2.10.4`
  (added for the persistent-pipeline wrapper below, not needed for the
  bare pipeline)
- Confirmed `torch.cuda.is_available()` `True` on the RTX 3070 Ti Laptop
  GPU
- HF weight cache redirected via
  `HF_HUB_CACHE=F:\StableAudioOpen\hf_cache\hub` — **not** `HF_HOME`.
  Overriding `HF_HOME` also moves where `huggingface_hub` looks for the
  login token, which breaks auth even though the token is valid (first
  attempt failed with `GatedRepoError` 401 for exactly this reason — looked
  like a license/access problem, wasn't one). `HF_HUB_CACHE` redirects only
  the model cache and leaves the token discoverable at its default location.
- Symlink warning on Windows (no Developer Mode / not admin) is cosmetic —
  cache still works, just stores full copies instead of symlinks. Silenced
  with `HF_HUB_DISABLE_SYMLINKS_WARNING=1`.

## Weights and license

- Model: `stabilityai/stable-audio-open-1.0` on Hugging Face, **gated** —
  pulled via the user's existing `huggingface-cli login` token. Confirmed
  as real gated weights, not an auth stub: the first attempt (with
  `HF_HOME` mistakenly overridden) correctly failed with `GatedRepoError`
  (401); the corrected attempt (only `HF_HUB_CACHE` set) downloaded all 15
  files successfully.
- Size on disk: **9.45 GB** (`F:\StableAudioOpen\hf_cache\hub`)
- **License: Stability AI Community License** (`license: other`,
  `license_name: stable-audio-community` in the HF model card). This is
  **not** one of the plain Apache-2.0 / OpenRAIL / CC0 tier
  `.claude/rules/assets.md` names — it is an **approved-with-caveat**
  fourth tier:
  - Free for organizations under **$1M annual revenue**.
  - If the project's revenue model ever changes, **Stability
    registration/commercial licensing may be required** for continued use.
  - No CC-BY-NC weights are used anywhere in this project regardless (that
    exclusion is unconditional at any revenue level; Stability Community
    License is a different, narrower carve-out).
  - Enforced in code: `tools/gen-client-base/config/checkpoint_allowlist.json`
    carries an entry for `stabilityai/stable-audio-open-1.0` with
    `license_family: "Stability-Community"`, and
    `tools/gen-client-base/src/gen_client_base/license_allowlist.py`'s
    `APPROVED_LICENSE_FAMILIES` includes that family with the same $1M
    caveat documented inline. `audio_agent.pipeline.generate_texture()`
    calls `assert_checkpoint_allowed()` before ever rendering a request,
    same as the ACE-Step and ComfyUI paths.

## Load command (bare pipeline, no HTTP)

```python
import torch
from diffusers import StableAudioPipeline

pipe = StableAudioPipeline.from_pretrained(
    "stabilityai/stable-audio-open-1.0",
    torch_dtype=torch.float16,
)
pipe.enable_model_cpu_offload()
```

Set `HF_HUB_CACHE=F:\StableAudioOpen\hf_cache\hub` in the environment
first so it reuses the already-downloaded weights instead of re-pulling to
the default `~/.cache/huggingface`.

## Test generation — comfortable fit, unlike ACE-Step

Ran a 6-second texture clip via `F:\StableAudioOpen\test_generate.py`
(diffusers' own inference path, fp16 + `enable_model_cpu_offload()`, 100
inference steps):

- Prompt: `"low mechanical drone, distant ventilation hum, concrete room
  tone, abandoned brutalist bunker ambience, subtle metallic resonance"`
  (negative prompt: `"music, melody, singing, low quality"`)
- **Pipeline load: 2.5s** (weights already cached)
- **Generation time: 31.3s** for 6s of audio (100 steps)
- **VRAM: idle 394 MiB baseline (desktop/compositor) → peak 3441.7 MB
  allocated / 5177.9 MB reserved (torch counters) during generation**,
  back to 394 MiB idle afterward. Well under the 8192 MiB card total —
  **~3 GB of headroom remaining**, vs. ACE-Step's ~243 MB headroom
  (docs/ace-step-setup.md). Stable Audio Open is comfortably the easier of
  the two backends to run on this card.
- Output: real 6.000s stereo WAV, 44100 Hz, PCM 16-bit — verified via
  `soundfile.info()`, not a stub file.
- **This fits 8GB with room to spare** — no further low-VRAM tricks (e.g.
  `enable_sequential_cpu_offload`, which is slower) were needed.

## GPU contention

Only one model fits on this 8GB card at a time — the same constraint
`docs/ace-step-setup.md` documents for ACE-Step vs. ComfyUI. Verified
clean before/after each test run in this doc: GPU was at the 394 MiB idle
baseline before starting, back to 394 MiB after stopping the wrapper.
`tools/audio-agent`'s `gpu_lock.py` (`/tmp/assembled-gpu.lock` by default)
is the shared advisory lock `pipeline.generate()` (ACE-Step) and
`pipeline.generate_texture()` (Stable Audio Open) both acquire around
their generation call, so the two backends serialize against each other —
see `tools/audio-agent/README.md`'s "GPU serialization guard" section.

## Persistent server: `F:\StableAudioOpen\infer-api.py`

Unlike ComfyUI (ships `/prompt` + poll) and ACE-Step (ships a stock
`infer-api.py` template to patch), **diffusers has no built-in HTTP
server** — `StableAudioPipeline` is a bare Python object. This wrapper is
therefore written from scratch rather than patched, but follows the
*identical* pattern to ACE-Step's `F:\ACE-Step\infer-api-persistent.py`
(docs/ace-step-setup.md, "Persistent server"):

1. **Pipeline loaded once at import time** (`StableAudioPipeline.from_pretrained`
   + `enable_model_cpu_offload()`, fp16), reused across every
   `POST /generate` instead of a fresh ~2.5s reload per call.
2. **`POST /generate` blocks server-side** for the whole diffusion run and
   returns the result inline — no separate poll endpoint, matching
   ACE-Step's shape so `tools/audio-agent`'s `StableAudioClient` (game
   repo) reuses the exact same submit/wait/fetch split as `AudioClient`.
3. **`GET /output/{filename}`** serves the WAV bytes back over HTTP.
   `filename` is reduced to its basename on both write and read, so a
   client can't escape `OUTPUT_DIR` via `../` segments (same guard as
   ACE-Step's wrapper).

Lives **outside the game repo**, machine-local, same as ACE-Step's patch —
`F:\StableAudioOpen\infer-api.py` is not committed to `~/dev/assembled`.

Request/response shape (`POST /generate`):

```json
{
  "prompt": "low mechanical drone, distant ventilation hum, concrete room tone",
  "negative_prompt": "music, melody, singing, low quality",
  "seconds": 6.0,
  "steps": 100,
  "cfg": 7.0,
  "seed": 42,
  "output_path": "vent_room_tone_a1b2c3.wav"
}
```

`{"status": "success", "output_path": "F:/StableAudioOpen/outputs/vent_room_tone_a1b2c3.wav", "message": "..."}`
on success; `HTTP 500` with a `detail` message on any pipeline failure
(mirrors ACE-Step's wrapper).

Environment variables (all optional):

| Var | Default |
|---|---|
| `STABLE_AUDIO_MODEL_ID` | `stabilityai/stable-audio-open-1.0` |
| `STABLE_AUDIO_OUTPUT_DIR` | `F:/StableAudioOpen/outputs` |
| `STABLE_AUDIO_HF_HUB_CACHE` | `F:/StableAudioOpen/hf_cache/hub` (set as `HF_HUB_CACHE`, not `HF_HOME` — see the gotcha above) |
| `STABLE_AUDIO_PORT` | `8002` (ComfyUI=8188, ACE-Step's infer-api=8001, next free port in that sequence) |

### Launch (detached, logging to a file)

```powershell
$proc = Start-Process -FilePath 'F:\StableAudioOpen\venv\Scripts\python.exe' `
  -ArgumentList 'F:\StableAudioOpen\infer-api.py' `
  -WorkingDirectory 'F:\StableAudioOpen' `
  -RedirectStandardOutput 'F:\StableAudioOpen\infer-api.log' `
  -RedirectStandardError 'F:\StableAudioOpen\infer-api.err.log' `
  -PassThru -WindowStyle Hidden
$proc.Id | Out-File -FilePath 'F:\StableAudioOpen\infer-api.pid' -Encoding ascii
```

Verify from Windows (loopback works regardless of the firewall rule
below):

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8002/health' -UseBasicParsing
```

Stop it when done (it holds ~1GB VRAM idle-loaded, ~3.4GB at generation
peak — don't leave it running unattended if the card is needed elsewhere):

```powershell
$procId = Get-Content 'F:\StableAudioOpen\infer-api.pid'
Stop-Process -Id $procId -Force
```

**Status as of this writing: verified, then stopped.** A local
(loopback-only, no WSL involved) end-to-end smoke test was run directly
against this instance during this task:

- `GET /health` → `{"status":"healthy"}`
- `POST /generate` (prompt above, seed 42, 6s, 100 steps, cfg 7.0) →
  `{"status":"success", ...}` in well under the 120s client timeout
- `GET /output/smoke_test.wav` → fetched bytes byte-identical to the
  server-side file (1,058,444 bytes)
- Verified via `soundfile.info()`: 44100 Hz, 2 channels, 6.000s, PCM 16-bit
  — a real WAV, not a stub
- VRAM: 394 MiB idle before → 1005 MiB idle-with-model-loaded during → 394
  MiB after `Stop-Process` (confirms the process released the GPU cleanly)
- Process was then **stopped** (`Stop-Process`) — not left running, per
  task scope. The smoke-test WAVs were deleted afterward (not committed —
  binary output, not project source).
- This validates the wrapper's own correctness on this machine, not the
  WSL → Windows path `tools/audio-agent` will use — that's the "Manual
  live smoke" section below, blocked on the firewall rule.

### Firewall (flagged, not changed — same as T-0070/T-0080)

Same shape as the `ComfyUI 8188 (WSL)` / `ACE-Step 8001 (WSL)` rules in
`docs/comfyui-setup.md` / `docs/ace-step-setup.md`, for this server's port
instead. **This is a system/security-setting change — not run by this
agent.** The user needs to run, by hand:

```powershell
New-NetFirewallRule -DisplayName "Stable Audio Open 8002 (WSL)" -Direction Inbound -Protocol TCP -LocalPort 8002 -RemoteAddress 172.18.192.0/20 -Action Allow
```

(`172.18.192.0/20` is this host's current WSL NAT subnet, re-derived via
`ip route show default` inside WSL at the time of writing — same value
`docs/comfyui-setup.md` and `docs/ace-step-setup.md` used; re-derive again
if it ever changes across a WSL restart.) Re-verify after applying with:

```sh
wsl -d Ubuntu-24.04 -u dennieseth -- bash -lc "curl -s http://172.18.192.1:8002/health"
```

### Manual live smoke (not run by this agent — WSL can't reach this port yet)

Once the firewall rule above is applied and the persistent server (launch
command above) is running, run **one** real generation from the WSL side,
through `tools/audio-agent`, exactly as the AudioAgent will:

```sh
cd tools/audio-agent   # in the game repo
.venv/bin/python scripts/live_smoke_texture.py
# or pin the base URL explicitly:
STABLE_AUDIO_BASE_URL=http://172.18.192.1:8002 .venv/bin/python scripts/live_smoke_texture.py
```

This is the first real exercise of the WSL → Windows path end to end for
Stable Audio Open (everything up to this point — the package's own test
suite and this doc's local loopback smoke test — deliberately avoids it).
Writes `assets/out/audio/live_smoke_texture_<job_id>.wav` (gitignored).
See `tools/audio-agent/README.md`'s "Manual live smoke, texture SFX"
section for what it does.

## Integration surface: `tools/audio-agent` (game repo, T-0081/T-0082)

Full detail in `tools/audio-agent/README.md`. Summary:

- `texture_recipe.TextureRecipe` — prompt/seed + `seconds`/`steps`/`cfg`/
  `negative_prompt`, mirrors `recipe.MusicRecipe`'s role for ACE-Step.
- `stable_audio_client.StableAudioClient` — subclasses the same
  `gen_client_base.client.GenerationClient` ABC as `AudioClient`
  (ComfyUI's client also shares it), same synchronous submit/wait/fetch
  split, same `errors.py` exception hierarchy.
- `stable_audio_base_url.resolve_base_url()` — `STABLE_AUDIO_BASE_URL` env
  wins, else the live WSL→Windows gateway IP (`ip route show default`) +
  `STABLE_AUDIO_PORT` (default 8002). Never hardcodes the gateway IP — it
  changes across WSL restarts.
- `pipeline.generate_texture()` — license gate → generate (under the
  **same** `gpu_lock` ACE-Step uses, so the two backends serialize against
  each other) → save to `assets/out/audio` → descend stub (T-0083) →
  provenance (`build_texture_provenance_record`, reuses the same
  `ProvenanceRecord` shape as ACE-Step's).
- `audio-agent generate-texture --recipe <recipe.json>` CLI subcommand.
- Bus default `Bus.WORLD_SFX`; override to `Bus.GAMEPLAY_SFX` for entity
  vocalizations that are gameplay telegraph (never ducked, P-5) or
  `Bus.AMBIENCE` for drones/room-tone beds (duckable) — §4.1.
- All mock-tested (`responses` for HTTP); no live Stable Audio Open call
  anywhere in the test suite or CI.

## Bottom line for T-0081 acceptance

Stable Audio Open is installed, gated weights downloaded and verified
(Stability AI Community License, approved-with-caveat and now enforced in
the shared allowlist), and real generation confirmed working on this 8 GB
card with **~3 GB of headroom** — comfortably more than ACE-Step's ~243 MB.
The persistent-pipeline FastAPI wrapper (`infer-api.py`) mirrors ACE-Step's
proven pattern and was verified end-to-end over loopback (health, generate,
fetch, real WAV, clean VRAM release on stop). `tools/audio-agent` now
drives it through the same `GenerationClient`/license-allowlist/GPU-lock
scaffolding as ACE-Step and ComfyUI, mock-tested with no live calls in CI.
The one remaining step — the WSL-subnet firewall rule — is a
system-setting change intentionally left for the user; the exact command
and the manual live-smoke script are documented above.
