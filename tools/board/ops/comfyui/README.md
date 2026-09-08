# ComfyUI host ops — `start-comfyui.bat`

`start-comfyui.bat` in this directory is a **byte-exact mirror** of the live launcher on the
Windows host, `F:\ComfyUI\start-comfyui.bat`.

```
sha256  ad10755ed76c037ed95c68c0c174f827c5a545cc23ad9b45647bd2ba8eb11053
size    627 bytes
LF line endings (the host file itself is LF-only; 0 CR bytes)
captured 2026-09-08 from the Windows host
```

Because it is a mirror, **it carries no comments of its own** — anything explanatory lives in this
file instead, so the two copies can be compared with `sha256sum` rather than by eye.

Until 2026-09-08 the committed copy was an honestly-labelled **reconstruction**: T-0322's
implementer had no shell on the Windows host, only ComfyUI's HTTP API, and correctly refused to
invent the duplicate-instance guard the card's *"Do not"* section names but never quotes. The
reconstruction was therefore missing the guard, the `cd /d`, and the startup logging. It has now
been replaced with the real bytes, read from the host.

## The one and only launch path

Verified by enumerating every autostart mechanism on the host on 2026-09-08:

| Mechanism | Present? |
|---|---|
| **Scheduled Task `\ComfyUI Server`** | **yes — this is it** |
| Startup-folder shortcuts (user + all-users) | none |
| Windows service | none |
| `Run` / `RunOnce` registry keys (HKLM + HKCU) | none |

The task's action is `F:\ComfyUI\start-comfyui.bat`, working directory `F:\ComfyUI`, on a **logon**
trigger as user `denni` (LogonType Interactive, RunLevel Limited).

There is no second launcher and no competing definition — which is what makes a single mirrored
file a sufficient record. If a future change adds one, this table is what to update.

## Regime: BASELINE, deliberately

The live launcher passes **no determinism flags** — no `--deterministic`, no
`CUBLAS_WORKSPACE_CONFIG`. The machine-readable source of truth is
`tools/board/ops/comfyui-regime.json`, which `tools/board/scripts/checkComfyUiRegime.js` checks the
live server against; it fails loudly on drift in either direction, so **do not change the launcher
without updating that file to match.**

Baseline is a deliberate choice, not an oversight. T-0272/T-0317 rounds 10–12 found that forcing
determinism on the §24-e dual-IPAdapter + ControlNet profile graph **reproducibly destroys
coherence**:

| Regime | Reproducible? | Coherent output? |
|---|---|---|
| `--deterministic` + `CUBLAS_WORKSPACE_CONFIG` | yes (66/67/68 byte-identical) | **no** — 0/6 fresh seeds |
| `CUBLAS_WORKSPACE_CONFIG` only | yes (69 == 70) | **no** — 0/6 fresh seeds |
| **baseline** (neither) | see below | **no** — 0/8 fresh seeds |

To switch regimes deliberately, add `set CUBLAS_WORKSPACE_CONFIG=:4096:8` before the python line
and `--deterministic` after `--port 8188`, and set `comfyui-regime.json`'s `deterministic` field to
`true` in the same change.

## Cross-restart reproducibility is **not** the problem — measured 2026-09-08

The determinism investigation assumed baseline ComfyUI could not reproduce a render across server
restarts. **Measured on the live host, that assumption is false.**

A minimal txt2img probe (SDXL base, 512×512, seed 424242, 8 steps, cfg 7.0, euler/normal, fixed
prompt) was run twice on the **baseline** launcher above, with ComfyUI killed and relaunched
through the Scheduled Task's bat in between, so the two runs are separate process lifetimes:

| Run | Server lifetime | prompt_id | Output bytes | SHA256 |
|---|---|---|---|---|
| 1 | A | `f51dd4f2…` | 194455 | `abe9f2e7a83c7261849ef7e7a9354e5b67200d54c524fe44211bf6e4c13822a4` |
| 2 | B (after restart) | `e750e5d9…` | 194455 | `abe9f2e7…22a4` — **identical** |

**Baseline ComfyUI is byte-reproducible across restarts for a simple graph, with no flags.**

The consequence matters for scoping: the nondeterminism T-0272/T-0317 spent twelve rounds chasing
is **a property of the §24-e graph, not of the server**. That is why the determinism flags bought
reproducibility only by flattening the sampler into incoherence — they were treating the wrong
layer. The remaining instability belongs to the dual-IPAdapter + ControlNet + two-stacked-LoRA
composition, which is exactly what **T-0327** is scoped to redesign.

The probe is deliberately not committed as a test: it needs a live GPU host, takes ~30 s per run
plus a server restart, and asserts on a specific checkpoint's weights. Re-derive it from this
table's parameters if it ever needs repeating.
