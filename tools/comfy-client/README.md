# comfy-client

ComfyUI HTTP client + recipe-\>workflow layer driving the `AssetAgent`
(**T-0071**, `tasks/T-0071.md`) per `docs/design/13-asset-pipeline.md` §1,
plus the concept-art path (**T-0104**, §6) that now precedes it per
archetype:

```
[per archetype, once] concept -> human approves direction   [concept.py -- T-0104, see below]

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

## License allowlist (`gen_client_base.license_allowlist`)

T-0071 acceptance: *"refuses to run a workflow whose checkpoint isn't on
the approved-license allowlist (Apache-2.0/OpenRAIL/CC0-derived) — encoded
as an enforced check, not just a convention."* `pipeline.generate()` calls
`assert_checkpoint_allowed()` **before** rendering a workflow or
constructing a client, so a disallowed checkpoint never reaches ComfyUI
regardless of caller. As of the T-0082 refactor this lives in the shared
`tools/gen-client-base` package (see "Shared foundation" below), reading
`tools/gen-client-base/config/checkpoint_allowlist.json` --
`sd_xl_base_1.0.safetensors` (CreativeML Open RAIL++-M, OpenRAIL family)
is this package's entry; the same file also carries audio-agent's
ACE-Step entry.

## Install

```sh
cd tools/comfy-client
python3 -m venv .venv
.venv/bin/pip install -e ../gen-client-base -e ".[dev]"
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
comfy-client concept  --recipe path/to/recipe.json [--out-dir assets/src/concept] [--timeout 300] [--poll-interval 1.0]
```

Both print `{"path", "prompt_id", "provenance"}` as JSON on stdout on
success; both print `error: ...` to stderr and exit `1` on a license
rejection or any ComfyUI-side failure (`comfy_client.errors.ComfyClientError`).

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

## Concept path (`concept.py`, T-0104)

`docs/design/13-asset-pipeline.md` §6: the home palette (V-5) is now
*extracted* from an approved concept sheet rather than chosen ahead of
it, so art generation for an archetype starts with a concept step before
any recipe exists. `concept.generate_concept()` reuses the same
`ComfyUIClient` / `render_workflow` / license-gate plumbing as
`pipeline.py`, but is a **narrower** arrow than `generate()`:

```
recipe -> generate -> commit          (concept.py, T-0104)
recipe -> generate -> descend -> ...  (pipeline.py, full T-0071 chain)
```

No `descend_stub()` call — concept art is full-colour, full-res, and
**never** downscaled or palette-quantized (there is no palette yet to
quantize against; extracting one *from* an approved sheet is T-0105).
Output goes to `assets/src/concept/` by default, which — unlike
`assets/out/` — **is committed**: concept art is a source, not a
regenerable intermediate (P-1/P-3 inverted for it, per §6). Because it's
committed rather than gitignored-and-discarded, `generate_concept()`
writes a `<name>.provenance.json` sidecar directly next to the image
(model + license + prompt + seed + workflow_hash + **`concept_hash`**,
the sha256 of the approved sheet) instead of waiting on the not-yet-built
`ASSET_PROVENANCE.md` writer (T-0075) the way `pipeline.generate()`
still does.

`concept_hash` is what T-0106's archetype-first coherence guard will key
conditioning on, once a second or third concept sheet for the same
archetype needs to stay visually consistent with the first approved one.

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

## Shared foundation (DRY with AudioAgent, T-0082)

`tools/gen-client-base` is a small sibling package holding the two pieces
that used to live here and are now genuinely shared with
`tools/audio-agent`:

- **`gen_client_base.client.GenerationClient`** -- the ABC (`submit` /
  `wait_for_completion` / `fetch_output` + a concrete `generate()`) that
  `comfyui_client.ComfyUIClient` implements here and
  `audio_agent.audio_client.AudioClient` implements for ACE-Step. Moved
  out of this package (was `comfy_client.client`) when T-0082 needed it
  too, rather than T-0082 reimplementing submit/poll/fetch/timeout or
  depending on this package directly.
- **`gen_client_base.license_allowlist`** -- see "License allowlist"
  above.

`errors.py`'s failure modes (`SubmitError`, `ExecutionError`,
`PollTimeoutError`, `FetchError`) stayed here rather than moving --
they're generic in shape but the class *names* are ComfyUI-flavored, and
`audio-agent` defines its own equivalents rather than sharing this
module. `pipeline.py`'s shape (license gate -\> generate -\> save ->
descend seam -\> provenance) is the pattern `audio-agent` mirrors, not
shared code.

## What's stubbed, pending other tasks

- **`descend.descend_stub()`** is an identity passthrough. T-0073 (box
  downscale, Oklab/CIELAB palette quantize, cleanup) replaces its body
  once T-0105 (palette extraction from an approved concept sheet, per
  the "Concept path" section above) unblocks the quantizer for an
  archetype. `pipeline.generate()` already calls through this seam, so
  wiring doesn't change when T-0073 lands.
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
