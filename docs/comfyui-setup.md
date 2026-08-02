# ComfyUI Setup (T-0070)

**Author:** Claude (Sonnet 5)
**Date:** 2026-08-02
**Host:** Windows 11 (not WSL — ComfyUI needs direct GPU access), RTX 3070 Ti
Laptop GPU, 8 GB VRAM, driver 581.57 / CUDA 13.0.

Installed and launched ComfyUI so the art pipeline's AssetAgent can drive it
over HTTP. See `docs/env-inventory.md` for the original probe that flagged
"no GPU passthrough in WSL" and "tight VRAM headroom" — both still apply;
ComfyUI runs on the Windows host directly for that reason.

## Install

- Path: `F:\ComfyUI` (cloned from `https://github.com/comfyanonymous/ComfyUI`,
  commit `611f2a4e`).
- venv: `F:\ComfyUI\venv`, Python 3.12.1.
- PyTorch: `torch==2.5.1+cu121` (cu121 wheels; driver's CUDA 13.0 is
  backward-compatible). `torch.cuda.is_available()` → `True`, device
  `NVIDIA GeForce RTX 3070 Ti Laptop GPU`.
  - ComfyUI logs a warning that some fused/optimized CUDA kernels
    (`comfy_kitchen` backend) need cu130+ and fall back to eager — cosmetic,
    generation works fine on eager attention.
- `pip install -r requirements.txt` — clean, no errors.
- Checkpoint: `stabilityai/stable-diffusion-xl-base-1.0` →
  `models/checkpoints/sd_xl_base_1.0.safetensors`, 6,938,078,334 bytes,
  verified as a real safetensors file (binary header + JSON metadata, not an
  HTML error page). No login/license click-through was required for this
  repo.

## Launch

```
F:\ComfyUI\venv\Scripts\python.exe main.py --listen 0.0.0.0 --port 8188
```

Run from `F:\ComfyUI` as the working directory. Currently started via
`Start-Process` (PowerShell) detached, stdout/stderr logged to
`F:\ComfyUI\comfyui.log` / `comfyui.err.log`, PID recorded in
`F:\ComfyUI\comfyui.pid`. This does not survive a reboot — no service/task
was registered, since that would be a standing-configuration change outside
this task's scope. If persistence across reboots is wanted, wrap the above
command in a Scheduled Task or NSSM service as a follow-up.

## Reachability — BLOCKED for WSL, works locally

- From Windows itself: `curl http://127.0.0.1:8188/system_stats` → 200 JSON,
  confirms ComfyUI up, reports device `cuda:0 NVIDIA GeForce RTX 3070 Ti
  Laptop GPU`, `vram_total` 8589410304 bytes.
- From WSL (`Ubuntu-24.04`): **both** `http://localhost:8188` and the WSL
  gateway IP (`http://172.18.192.1:8188`, from `ip route show default`)
  **time out** — not "connection refused," a silent drop consistent with a
  firewall block rather than nothing listening.
- Root cause found: Windows Firewall has two pre-existing **Block** rules
  (`Get-NetFirewallRule -DisplayName python.exe`) — inbound TCP and UDP,
  Public profile, program
  `C:\users\denni\appdata\local\programs\python\python312\python.exe`, any
  remote address. The primary Ethernet adapter's network category is
  `Public`, so this blocks traffic arriving over the WSL vEthernet adapter
  even though Windows-local loopback (127.0.0.1) bypasses the firewall
  entirely and works fine.
- **This needs a firewall change, which I did not make** (modifying
  system/security settings is outside what I'll do unattended). To fix,
  run as admin on the Windows host:
  ```powershell
  # either allow the existing rule pair, or scope a new one to the WSL subnet:
  Set-NetFirewallRule -DisplayName "python.exe" -Action Allow
  # more targeted alternative (recommended): allow just the ComfyUI port from WSL's subnet
  New-NetFirewallRule -DisplayName "ComfyUI 8188 (WSL)" -Direction Inbound -Protocol TCP -LocalPort 8188 -RemoteAddress 172.18.192.0/20 -Action Allow
  ```
  After that, re-verify with:
  `wsl -d Ubuntu-24.04 -u dennieseth -- bash -lc "curl -s http://172.18.192.1:8188/system_stats"`
  (the gateway IP, not `localhost` — this host is NAT-mode WSL networking,
  not mirrored, so `localhost` doesn't cross the boundary. Re-check the IP
  with `ip route show default` inside WSL if the network is ever
  reconfigured, since NAT-mode gateway IPs can change across WSL restarts.)
- **AssetAgent base URL:** until the firewall is fixed, use
  `http://127.0.0.1:8188` only from processes running on the Windows host.
  From WSL it will need `http://172.18.192.1:8188` (or whatever the current
  gateway IP is) once the rule above is applied.

## VRAM baseline

- Idle (server up, checkpoint loaded, no generation yet): not separately
  captured — the file below is with checkpoint loaded but a completed
  generation, since the model is loaded lazily on first run.
- After one test generation (loaded + resident): `vram_total` 8589 MB,
  `vram_free` 5294 MB → **~3.3 GB used**, ~5.3 GB headroom. No `--lowvram`
  or `--medvram` needed for single SDXL 1024×1024 generations; plenty of
  room left for a LoRA (T-0072) on top, tight if running an audio model
  concurrently — matches the "VRAM headroom is tight" flag already in
  `docs/env-inventory.md` for that combined case.
- Test generation: minimal SDXL txt2img graph via the `/prompt` API
  (`CheckpointLoaderSimple` → `CLIPTextEncode` ×2 → `EmptyLatentImage`
  1024×1024 → `KSampler` 8 steps, euler/normal → `VAEDecode` → `SaveImage`),
  completed successfully in ~13.2s, wrote a 1.7 MB PNG to `F:\ComfyUI\output\`.
  No errors, no OOM.

## Bottom line for AssetAgent (T-0070 acceptance)

ComfyUI is installed, running, and generation-verified on the Windows host.
It is **not yet reachable from WSL** — the AssetAgent (which the task says
"lives in WSL") cannot drive it over HTTP until the firewall rule above is
applied by hand. Everything else (install, checkpoint, launch, local
generation) is done and verified.
