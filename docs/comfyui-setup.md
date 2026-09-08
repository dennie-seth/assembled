# ComfyUI Setup (T-0070)

**Author:** Claude (Sonnet 5)
**Date:** 2026-08-02
**Host:** Windows 11 (not WSL — ComfyUI needs direct GPU access), RTX 3070 Ti
Laptop GPU, 8 GB VRAM, driver 581.57 / CUDA 13.0.

Installed and launched ComfyUI so the art pipeline's AssetAgent can drive it
over HTTP. See `docs/env-inventory.md` for the original probe that flagged
"no GPU passthrough in WSL" and "tight VRAM headroom" — both still apply;
ComfyUI runs on the Windows host directly for that reason.

**Update 2026-08-12 — WSL GPU passthrough now confirmed working.** The
"no GPU passthrough in WSL" premise above was re-checked for T-0072's LoRA
training work and no longer holds: `nvidia-smi` inside WSL (Ubuntu-24.04)
sees the RTX 3070 Ti directly, and `torch.cuda.is_available()` is `True`
in a WSL-native venv (see `assets/src/lora/setup-training-env.sh` and
`docs/lora-training-env.md`). This doesn't move ComfyUI itself off the
Windows host — no reason to disturb a working generation setup — but it
does mean the **training** half of the pipeline (T-0072's `sdxl_train_network.py`
run) no longer needs a manual Windows step: it runs natively inside WSL,
reading the checkpoint from `/mnt/f/ComfyUI/models/checkpoints/` and
writing the trained LoRA back to the repo's `assets/final/lora/`. VRAM
headroom is still genuinely tight (see `docs/lora-training-env.md`'s smoke
test — training peaked at ~8.0/8.19 GB) — that part of the original flag
stands.

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

## Determinism

### The incident

Before 2026-09-07, ComfyUI ran with no determinism flags at all
(`argv: ["main.py", "--listen", "0.0.0.0", "--port", "8188"]`). Without them,
ComfyUI 0.29.0 / PyTorch 2.5.1 fix cuDNN algorithm selection and global RNG
state **once per server process lifetime**, not per request — a workflow's
`seed` field pins output *within* one continuous ComfyUI server session, but
**not across a restart**. T-0317 round 9 proved this directly: two runs of
an identical recipe, one before and one after a `POST /free`, were
byte-identical within a session; T-0317 round 7 had already shown the same
recipe diverging across separate implementer sessions. See
[`docs/assets/evidence/T-0272/README.md`](assets/evidence/T-0272/README.md)
(rounds 7-9) for the full isolation. T-0272 and T-0317 together spent four
rounds on this before finding the real cause — round 6's attempt 39
produced the single best result either card ever got from the §24-e
dual-IPAdapter + ControlNet profile graph, and it could never be
reproduced, because the server session that produced it was gone.

### The fix is not "always turn determinism on"

The obvious fix — launch ComfyUI with `--deterministic` and
`CUBLAS_WORKSPACE_CONFIG=:4096:8` permanently — was tried and **made things
worse for the one real graph it was tested against**
(`docs/assets/evidence/T-0272/README.md` rounds 10-12):

| Regime | Reproducible across a restart? | Ever produced a coherent §24-e frame? |
|---|---|---|
| `--deterministic` + `CUBLAS_WORKSPACE_CONFIG` (round 10) | yes (verified via a forced non-cached recompute) | no — 0/6 fresh seeds, horizontal-banding failure |
| `CUBLAS_WORKSPACE_CONFIG` only (round 11) | yes | no — 0/8 fresh seeds, circuit-abstraction failure |
| baseline, neither flag (rounds 1-8, and round 12's reroll) | no | attempt 39 only, once, in round 6 — round 12's own fresh 8-seed reroll under this exact regime found 0/8 |

Round 12's conclusion: four regimes sampled, and none of them reliably
reproduces a coherent frame from this particular graph — attempt 39 reads
as a rare draw from an inherently fragile graph (dual IP-Adapter +
ControlNet + two stacked LoRAs), not evidence that any one regime is
"correct." Forcing determinism did not just fail to help; it actively
destroyed the only regime that has ever produced a usable frame at all.

**The live regime is therefore not fixed** — it is whatever a human most
recently, deliberately decided, recorded in
[`tools/board/ops/comfyui-regime.json`](../tools/board/ops/comfyui-regime.json)
with the reasoning behind that decision. As of 2026-09-07 that is
**baseline** (neither flag), restored specifically so a coherent frame can
still be caught if the graph produces one again — see round 11's own
recommendation to "treat coherent output as something to catch and bank
when it appears... rather than something to reproduce on demand."

### Launch paths (enumerated, with a caveat)

- **`tools/board/ops/comfyui/start-comfyui.bat`** — the only known launch
  path, version-controlled here per this card. It is a **reconstruction**,
  not a byte-exact mirror of the real `F:\ComfyUI\start-comfyui.bat`: no
  agent working this card has had filesystem or shell access to the
  Windows host, only ComfyUI's own HTTP API (`GET /system_stats`). The
  card's own "Do not" section names a duplicate-instance guard that must
  not be removed from the real file — its contents were never quoted
  anywhere reachable from this repo, so this reconstruction does not
  attempt to reproduce it. The next time a human or an agent with host
  access touches the real file, its actual full contents should be pasted
  back into this repo copy so it stops being a reconstruction.
- **No other launch path is recorded anywhere in this repo** — not in this
  doc's own history, not in `docs/env-inventory.md`, not in any prior
  card's evidence. A Scheduled Task, Startup-folder shortcut, or service
  wrapper may still exist on the host; ruling that out needs an interactive
  check on the Windows host itself (Task Scheduler, `shell:startup`,
  `services.msc`), which is outside what any WSL-side or HTTP-only agent
  can do. **This is an open gap, not a closed item** — flagging it here
  rather than asserting completeness that hasn't been verified.

### Making drift checkable

`tools/board/scripts/checkComfyUiRegime.js` (`npm run check:comfyui-regime`,
from `tools/board`) fetches the live server's `GET /system_stats` and
compares its `argv`'s `--deterministic` presence against
`tools/board/ops/comfyui-regime.json`. It deliberately does **not**
hardcode "`--deterministic` must be present" — per the table above, that
would be actively wrong whenever baseline is the correct, deliberately
chosen regime. It fails loudly on drift in **either** direction: someone
bare-relaunching back to baseline when determinism was wanted, or
`--deterministic` staying on for a graph (like §24-e) that needs baseline.
Confirmed live and reachable from this WSL box during T-0322 (`GET
http://172.18.192.1:8188/system_stats` returns 200; the WSL gateway IP may
differ — see "Reachability" above).

**Known gap: `CUBLAS_WORKSPACE_CONFIG` is not checkable this way at all.**
It is a launch-time environment variable, not a CLI argument, and never
appears anywhere in `/system_stats`'s response. Whoever changes the live
regime must update `comfyui-regime.json`'s `deterministic` field *and* the
launcher's env var by hand — the checker only proves `--deterministic`
stayed where it was declared to be, not `CUBLAS_WORKSPACE_CONFIG`. The only
way to indirectly confirm `CUBLAS_WORKSPACE_CONFIG` is actually live is the
reproducibility test below (a fixed-workspace-config regime is
reproducible; a non-fixed one usually isn't, though round 11/12 show that
signal is noisy on a fragile graph).

To wire this into an asset-generation preflight (refuse to render if the
live regime has drifted from what a card's own recipe expects), a
generator script can either shell out to this command and check its exit
code, or `import { evaluateRegime } from
"../../board/src/lib/comfyuiRegime.js"` directly and call it with its own
already-fetched `/system_stats` payload.

An hourly standing check also now exists as version-controlled ops config:
`tools/board/ops/check-comfyui-regime.sh` (a `flock`-guarded wrapper for
`npm run check:comfyui-regime`, logging to
`~/.local/state/check-comfyui-regime/check.log`) plus
`tools/board/ops/systemd/check-comfyui-regime.{service,timer}`, mirroring
`board-integrity-check.{py,timer}`'s existing pattern (see
`tools/board/ops/README.md`). **Not yet deployed** — like the reconstructed
launcher above, wiring the unit files into the live WSL box's
`~/.local/bin` / `~/.config/systemd/user` and `systemctl --user enable --now`
needs shell access this card's agents have not had; until that step happens
the only live check is running `npm run check:comfyui-regime` by hand.

### Cross-restart reproducibility — the actual guarantee, still untested

T-0317 round 10 proved *within-session* reproducibility under
`--deterministic` (a non-cached recompute matched byte-for-byte) but named
its own gap explicitly: *"A cross-restart check remains untested and
belongs to a determinism-infra card, not this one."* This is that card, and
the check still has not been run, because it requires restarting the live
ComfyUI service — something T-0322's own "Do not" section forbids doing
casually ("do not restart ComfyUI while an asset card is generating"), and
something no agent working this card has host shell access to do outside
the HTTP API anyway. The procedure, ready for whoever next has both GPU
time and permission to restart the service:

1. Confirm the board is idle (no card mid-generation).
2. Pick a **baseline-regime-safe** recipe — not the §24-e profile graph,
   which the table above shows never reliably reproduces regardless of
   regime; a simpler txt2img recipe (e.g. this doc's own T-0070 smoke test)
   isolates the determinism question from that graph's separate coherence
   problem.
3. Render once, record the seed, recipe, and output sha256.
4. Restart the ComfyUI service (whichever regime is currently declared in
   `comfyui-regime.json`).
5. Run `npm run check:comfyui-regime` (from `tools/board`) to confirm the
   restart landed in the expected regime, not a silent drift.
6. Re-render the identical recipe/seed and compare sha256.
7. Record the result here (or in a new dated subsection) either way — a
   negative result is as valuable as a positive one, per this card's own
   evidence trail.

### Throughput cost

Not independently benchmarked (no controlled apples-to-apples run exists in
this repo), but two data points from `docs/assets/evidence/T-0272/README.md`
give a rough sense of the order of magnitude: round 9's baseline
non-cached recompute (attempt 54) ran in `gpu_seconds` 54.1; round 10's
`--deterministic` non-cached recompute (attempt 68) ran in `gpu_seconds`
60.1 — roughly **+11%**, on different seeds and not a controlled A/B, so
treat this as a rough signal rather than a measured cost. If this number
ever needs to be load-bearing for a decision, it should be re-measured with
the same seed/recipe under both regimes back-to-back.
