# GPU submission audit (T-0371, WIP gate T-E)

Every path in this repo that can put work on the GPU box today, and whether a shared lease at
the board's own launch boundary (`tools/board/src/runner/cardLaunch.js`) can actually govern it.
Companion to `docs/wip-gate-admission.md` (T-0370, token/window admission) -- GPU is audited and
leased separately because it is a different currency (spec §8: exclusive hardware, not a
divisible USD budget).

## The constrained resource is the physical GPU box, not any one network port

`docs/comfyui-setup.md` / `docs/stable-audio-setup.md` / MEMORY.md agree: this repo has exactly
**one** physical GPU host today -- a single RTX 3070 Ti Laptop GPU on the Windows machine at
`172.18.192.1` (reachable from WSL) / `127.0.0.1` (from the Windows host itself). Three different
processes on that one box compete for it:

- **ComfyUI**, port 8188 (SDXL image generation -- `tools/comfy-client`).
- **ACE-Step / Stable Audio**, port 8002 (`tools/audio-agent`, `docs/ace-step-setup.md` /
  `docs/stable-audio-setup.md`).
- **LoRA training**, no HTTP server at all -- a long-running `accelerate` process
  (`assets/src/lora/setup-training-env.sh`) that saturates the same card directly.

These are three different logical servers but ONE constrained resource: running any two of them
concurrently contends for the same VRAM/compute, exactly the failure mode the board's existing
human-enforced "one GPU card at a time" rule exists to prevent. `gpuLease.js`'s
`GPU_SERVER_ID` therefore keys the lease to this one physical box, not to a `host:port` pair --
splitting the lease per port would let a ComfyUI job and an ACE-Step job "both" hold their own,
separate lease while still fighting over the same card, which is exactly the bug this card exists
to close.

## Paths audited

### A. Board-launched `assets`/`audio` agent cards -- CAN be brought under a lease (this card does)

`launchAdvisory.js`'s `AGENT_TO_COST_TYPE` already classifies `assets` and `audio` cards as
`"asset-GPU"` (T-0370) -- these are the only two agent types whose implementer run does GPU work.
When the board launches one of these cards (`cardLaunch.js`'s `launchCardRun`, the one path both
the Run button and the auto-launch poller launch through -- `docs/wip-gate-admission.md`), the
spawned `claude` process's own Bash tool calls are what eventually reach ComfyUI/ACE-Step/
`accelerate` -- see the `assets`/`audio` agent Bash grants.

The board does not see or intercept those individual in-process HTTP calls or subprocess spawns --
it only ever sees "this card's implementer run started" and "this card's implementer run ended".
**That is the granularity a board-side lease can actually enforce: one lease per in-flight
GPU-agent card, not per ComfyUI submission.** This is not a weaker version of the rule the board
already relies on informally -- it is the same granularity a human enforces today by not clicking
"Run" on a second GPU card while one is in progress. This card's `gpuLease.js` formalizes exactly
that, acquired atomically alongside T-0370's admission/reservation at the same launch boundary,
owned by `(cardId, executionId, invocationId)`, released on completion/failure/cancel, and
reconciled after a crash or board restart (see `docs/gpu-lease.md`).

### B. `tools/comfy-client`'s own CLI and scripts, run directly -- UNCONTROLLED

`tools/comfy-client/src/comfy_client/cli.py` and every script under `tools/comfy-client/scripts/`
(`live_smoke.py`, `e2e_wall_tile.py`, `material_sheet_sweep.py`, `generate_material_template.py`,
`backfill_model_hash.py`, `resave_transparent.py`) talk to ComfyUI directly over HTTP
(`comfyui_client.py`). Nothing stops a human, or an agent's own Bash tool call, from invoking one
of these **outside** a board-launched card -- e.g. manually debugging a stuck generation from a
terminal. No board process is in the loop at all for that invocation, so there is no point for a
board-owned lease file to intercept it. **Uncontrolled**, not silently assumed exclusive.

### C. Per-card generator scripts run from inside an already-launched agent process

`assets/src/character/gen_*.py`, `assets/src/concept/_gen_*.py` /
`_run_sdxl_generation.py`, and similar per-card scripts under `assets/src/**` call into
`comfy_client`/`gen_client_base` themselves. When invoked as a Bash tool call from *within* a
board-launched `assets` card's own implementer run, path (A)'s card-level lease already covers the
whole run these calls happen inside, so no further interception is needed. **If the same script is
invoked by hand outside a board-launched run** (a human re-running a generator to reproduce a
finding, for instance -- this repo's own evidence logs, e.g. T-0356/T-0394, show this happening
routinely), it is exactly case (B): uncontrolled.

### D. `tools/audio-agent` / `assets/src/audio` -- ACE-Step / Stable Audio -- same story as (A)/(B)

Same shape as image generation: covered by (A)'s card-level lease when launched through the board
as an `audio` card (same `GPU_SERVER_ID` -- see above, this is the same physical box as ComfyUI,
not a separate lease), uncontrolled when a script under `tools/audio-agent/scripts/` or
`assets/src/audio/**` is invoked directly.

### E. LoRA training (`assets/src/lora/**`, `assets/src/lora_handshake/**`) -- same story, heaviest consumer

`assets/src/lora/setup-training-env.sh` and the `accelerate` invocations MEMORY.md and the
`assets` agent's own tool grants describe (`~/dev/lora-train-venv/bin/accelerate`) are the single
heaviest, longest-running GPU consumer in the repo (MEMORY.md: walk-cycle sheet generation cited
alongside multi-hour training runs). Covered by (A) when launched via a board `assets` card
exactly like every other GPU workload on this box; uncontrolled when a human or an agent kicks off
training directly, outside a board-launched run.

### F. Manual ComfyUI/Stable-Audio web UI usage on the Windows host -- always UNCONTROLLED

A human queueing a prompt directly in ComfyUI's own browser UI, or hitting the ACE-Step server by
hand, never goes through this repo's code at all. No lease implemented here -- or anywhere in this
codebase -- can ever intercept that. Always uncontrolled; this is a fundamental limit of a
board-side lease, not a gap this card can close.

### G. `tools/gen-client-base` -- not itself a submission path

Shared `submit -> wait_for_completion -> fetch_output` base class + license allowlist that
`comfy_client.ComfyUIClient` and `audio_agent.AudioClient` both implement against. It does not
itself talk to any server -- it is infrastructure the two real clients above (A/B/D) depend on,
not a distinct path.

## Summary table

| Path | Reaches ComfyUI/ACE-Step/training via | Board can see it launch? | Brought under the lease? |
|---|---|---|---|
| A. Board-launched `assets`/`audio` card | in-process Bash calls inside the agent run | Yes (`cardLaunch.js`) | **Yes -- this card** |
| B. `tools/comfy-client` CLI/scripts, run by hand | direct HTTP | No | No -- uncontrolled |
| C. `assets/src/**` generator scripts, run by hand | direct HTTP via comfy_client | No | No -- uncontrolled (covered by A only when run inside a launched card) |
| D. `tools/audio-agent` / `assets/src/audio`, run by hand | direct HTTP | No | No -- uncontrolled (covered by A only when run inside a launched card) |
| E. LoRA training, run by hand | `accelerate` subprocess | No | No -- uncontrolled (covered by A only when run inside a launched card) |
| F. Manual ComfyUI/Stable-Audio web UI | browser, direct to the server | No | No -- uncontrolled, and never can be |
| G. `tools/gen-client-base` | n/a -- shared library, not a caller | n/a | n/a |

## What this means for the lease this card ships

- One shared, exclusive lease per constrained GPU box (today: exactly one, `GPU_SERVER_ID` in
  `tools/board/src/runner/gpuLease.js`), acquired at the one launch boundary the board actually
  controls (`cardLaunch.js`), for `assets`/`audio` cards only.
- Everything else above (B, C, D, E, F run outside a board-launched card) remains exactly as
  exclusive -- or not -- as it is today: a human not launching two GPU things at once. This card
  does not claim to close that gap; it documents it so nobody mistakes "the board's lease is on"
  for "the GPU is now provably exclusive no matter how work reaches it".
- Default configuration: the lease is off (`GPU_LEASE_ENABLED`, unset/false by default -- see
  `docs/gpu-lease.md`). With it off, `cardLaunch.js` never acquires or checks a GPU lease, so no
  launch that happens today is refused by this card. Turning it on for the live board is a
  separate decision, left to Dennie, exactly like `WIP_GATE_ENFORCEMENT_ENABLED` (T-0370).
