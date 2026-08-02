# comfy-client

ComfyUI HTTP client + recipe-\>workflow layer driving the `AssetAgent`
(**T-0071**, `tasks/T-0071.md`) per `docs/design/13-asset-pipeline.md` §1:

```
kanban card (agent: assets)
  -> recipe          workflow JSON + prompt + seed + model hash   [recipe.py, workflow.py]
  -> generate         ComfyUI /prompt -> poll /history -> fetch /view   [comfyui_client.py, pipeline.py]
  -> descend          to native format (§3.1)                     [descend.py -- STUB, T-0073]
  -> validate         machine-checkable gate (§2)                 [tools/asset-gate -- T-0102, already built]
  -> provenance       ASSET_PROVENANCE.md row                     [provenance.py -- seam, T-0075]
  -> art/* branch     -> review -> human accepts -> done
```

## Location + language

`tools/comfy-client/` (Python), sibling to `tools/asset-gate/` -- same role
(versioned tool package outside `assets/`, which per `.claude/rules/assets.md`
is reserved for generation *content*: `assets/src/` recipes and
`assets/final/` curated output). This package is HTTP/orchestration
tooling with no generation content of its own.

## Why ComfyUI isn't reachable yet

ComfyUI (T-0070) runs on the **Windows host** (`F:\ComfyUI`, port 8188,
`sd_xl_base_1.0` checkpoint) — it needs direct GPU access, so it can't run
inside WSL. As of this writing WSL cannot reach it: Windows Firewall has
pre-existing Block rules for `python.exe` that silently drop traffic from
the WSL vEthernet adapter. See `docs/comfyui-setup.md` for the full
diagnosis and the exact `New-NetFirewallRule`/`Set-NetFirewallRule` fix
(a system-setting change, done by hand, not by an agent).

**Consequence for this package:** everything is built and unit-tested
against a **mocked** ComfyUI HTTP server (`responses` lib) — no live call
happens in `tests/` or in CI (`.github/workflows/ci-comfy-client.yml`).
The live path is fully wired and configurable; see "Manual live smoke"
below for how to actually exercise it once the firewall is open.

## Base-URL resolution (`base_url.py`)

The WSL NAT gateway IP is **never hardcoded** — it changes across WSL
restarts. Resolution order, in `resolve_base_url()`:

1. `COMFYUI_BASE_URL` env var, used verbatim (trailing slash stripped).
   This is also the override you set to point at the live instance.
2. Otherwise: the current default-route gateway IP, read fresh via
   `ip route show default`, combined with `COMFYUI_PORT` (default `8188`).

```sh
# fixed override, e.g. once the firewall rule is applied and the gateway
# IP is known to be stable for this session:
export COMFYUI_BASE_URL=http://172.18.192.1:8188

# or just override the port and let the gateway IP resolve live:
export COMFYUI_PORT=8188
```

## License allowlist (`license_allowlist.py`)

T-0071 acceptance: *"refuses to run a workflow whose checkpoint isn't on
the approved-license allowlist (Apache-2.0/OpenRAIL/CC0-derived) — encoded
as an enforced check, not just a convention."* `pipeline.generate()` calls
`assert_checkpoint_allowed()` **before** rendering a workflow or
constructing a client, so a disallowed checkpoint never reaches ComfyUI
regardless of caller. The allowlist lives in
`config/checkpoint_allowlist.json`; `sd_xl_base_1.0.safetensors`
(CreativeML Open RAIL++-M, OpenRAIL family) is the one seeded entry.

## Install

```sh
cd tools/comfy-client
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Test / lint

```sh
.venv/bin/pytest -q
.venv/bin/ruff check .
```

CI: `.github/workflows/ci-comfy-client.yml` runs both on every push/PR
touching `tools/comfy-client/**`. All HTTP is mocked (`responses`); no live
ComfyUI call is ever made in CI.

## CLI

```sh
comfy-client generate --recipe path/to/recipe.json [--out-dir assets/out] [--timeout 300] [--poll-interval 1.0]
```

Prints `{"path", "prompt_id", "provenance"}` as JSON on stdout on success;
prints `error: ...` to stderr and exits `1` on a license rejection or any
ComfyUI-side failure (`comfy_client.errors.ComfyClientError`).

A recipe JSON file matches `recipe.Recipe`'s fields (only `prompt` and
`seed` are required):

```json
{
  "prompt": "a derelict Soviet brutalist signal tower, overgrown, concrete",
  "negative_prompt": "blurry, low quality, text, watermark",
  "seed": 12345,
  "steps": 20,
  "cfg": 7.0,
  "width": 1024,
  "height": 1024,
  "name": "signal_tower"
}
```

## Manual live smoke (not run by this agent -- WSL can't reach ComfyUI yet)

Once the firewall rule in `docs/comfyui-setup.md` is applied by hand and
re-verified reachable, run **one** real generation end to end:

```sh
cd tools/comfy-client
.venv/bin/python scripts/live_smoke.py
# or, to pin the base URL explicitly:
COMFYUI_BASE_URL=http://172.18.192.1:8188 .venv/bin/python scripts/live_smoke.py
```

This submits a real SDXL txt2img workflow, polls to completion, fetches
the PNG, and writes it to `assets/out/live_smoke_<prompt_id>.png`
(gitignored). It is a plain script, not a test — nothing in `tests/`
depends on it, and it is not wired into CI.

## Architecture notes (DRY with the future AudioAgent, T-0082)

- `client.GenerationClient` is a small ABC (`submit` / `wait_for_completion`
  / `fetch_output` + a concrete `generate()`) that `comfyui_client.ComfyUIClient`
  implements. `docs/PLAN.md` Phase 7 wants `AudioAgent` to share this base
  rather than reimplementing submit/poll/fetch/timeout/backoff for its own
  backend (Stable Audio Open / ACE-Step) — subclass `GenerationClient`,
  keep `pipeline.py`'s shape (license gate -\> generate -\> save -\> descend
  seam -\> provenance) as the pattern to mirror.
- `errors.py`'s three failure modes (`SubmitError`, `ExecutionError`,
  `PollTimeoutError`) plus `FetchError` are generic enough to reuse
  as-is; only the HTTP-shape details live in `comfyui_client.py`.

## What's stubbed, pending other tasks

- **`descend.descend_stub()`** is an identity passthrough. T-0073 (box
  downscale, Oklab/CIELAB palette quantize, cleanup) replaces its body
  once V-5 (home palette hex set) unblocks the quantizer. `pipeline.generate()`
  already calls through this seam, so wiring doesn't change when T-0073 lands.
- **Validation gate hand-off**: `tools/asset-gate` (T-0102) already
  implements the machine-checkable gate; this package doesn't call it yet
  because there's nothing descended to validate until T-0073 exists. The
  natural integration point is right after `descend_stub()` in
  `pipeline.generate()`.
- **`ASSET_PROVENANCE.md` writer** (T-0075) isn't built. `provenance.build_provenance_record()`
  captures everything the writer will need (model + license + prompt +
  seed + workflow hash + prompt_id) so nothing has to be reconstructed
  after the fact.
- **`Recipe.model_hash`** is `None` by default — the checkpoint
  `.safetensors` lives on the Windows host, not reachable from WSL for
  hashing; populate it once a hashing step exists on that side.
