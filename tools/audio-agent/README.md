# audio-agent

ACE-Step HTTP client + recipe-\>request layer driving the `AudioAgent`
(**T-0082**, `tasks/T-0082.md`) per `docs/design/13-asset-pipeline.md` §1,
§4.2 -- the audio sibling of `tools/comfy-client`'s `AssetAgent` (T-0071),
sharing its base class per `docs/HANDOFF.md` §2 (D-20) and
`docs/PLAN.md` Phase 7's DRY note:

```
kanban card (agent: audio)
  -> recipe          prompt/tags + seed + ACE-Step params    [recipe.py]
  -> generate         ACE-Step POST /generate (blocking) -> GET /output   [audio_client.py, pipeline.py]
  -> descend          to native format (§4.7)                [descend.py -- STUB, T-0083]
  -> validate         machine-checkable gate (§4.8)           [tools/asset-gate -- T-0102, already built]
  -> provenance       ASSET_PROVENANCE.md row + bus (D-20)    [provenance.py -- seam, T-0075 pattern]
  -> art/* branch     -> review -> human accepts -> done
```

## Location + language

`tools/audio-agent/` (Python), sibling to `tools/comfy-client/` and
`tools/asset-gate/` -- same role (versioned tool package outside `assets/`,
which per `.claude/rules/assets.md` is reserved for generation *content*).
This package is HTTP/orchestration tooling with no generation content of
its own.

## Shared foundation (`tools/gen-client-base`)

This package subclasses `gen_client_base.client.GenerationClient` (the
same ABC `comfy_client.comfyui_client.ComfyUIClient` implements) and calls
`gen_client_base.license_allowlist.assert_checkpoint_allowed()` against
the *same* `config/checkpoint_allowlist.json` comfy-client uses -- see
`tools/gen-client-base/README.md` for what's shared and why it's a
separate package rather than one tool depending on the other.

## Why ACE-Step's HTTP shape needed a different submit/wait split

ACE-Step's patched `/generate` (see "Machine-side: ACE-Step server" below)
is a single **synchronous** call that blocks server-side for the whole
generation and returns the result inline -- there's no separate
`/history`-style poll endpoint like ComfyUI's. `AudioClient.submit()` just
stashes the rendered request; the actual blocking `POST /generate` happens
in `wait_for_completion()`, which is the method that receives the caller's
`timeout`. See `audio_client.py`'s module docstring for the full reasoning.

## Base-URL resolution (`base_url.py`)

Identical resolution order to `comfy_client.base_url`, with audio-specific
env var names and default port:

1. `ACESTEP_BASE_URL` env var, used verbatim (trailing slash stripped).
2. Otherwise: the current default-route gateway IP, read fresh via
   `ip route show default`, combined with `ACESTEP_PORT` (default `8001`).

```sh
export ACESTEP_BASE_URL=http://172.18.192.1:8001
# or just override the port and let the gateway IP resolve live:
export ACESTEP_PORT=8001
```

## Bus assignment (`bus.py`, D-20)

Every generated asset carries a `Bus` (`Ambience` / `Music` / `World SFX`
/ `Gameplay SFX`) so client-side routing (T-0103) can enforce **P-5:
Gameplay SFX are never ducked**. `MusicRecipe.bus` defaults to `Bus.MUSIC`
since this package drives ACE-Step for music specifically
(13-asset-pipeline.md §4.2); the other three values are here for when a
future texture/SFX generator (Stable Audio Open, T-0081) reuses this
pattern.

## GPU serialization guard (`gpu_lock.py`)

docs/ace-step-setup.md: an 8-second ACE-Step generation peaked at
**7949 / 8192 MiB** VRAM on this project's 8GB card -- ComfyUI and
ACE-Step cannot run at the same time on it. `pipeline.generate()` wraps
every `AudioClient.generate()` call in an advisory file lock
(`/tmp/assembled-gpu.lock` by default, `ASSEMBLED_GPU_LOCK_PATH`
overridable). This is a **documented seam, not a distributed lock** --
see `gpu_lock.py`'s module docstring for exactly what it does and doesn't
guarantee, and what the board orchestration would need to do to make
AssetAgent respect the same lock.

## Install

```sh
cd tools/audio-agent
python3 -m venv .venv
.venv/bin/pip install -e ../gen-client-base -e ".[dev]"
```

## Test / lint

```sh
.venv/bin/pytest -q
.venv/bin/ruff check .
```

CI: `.github/workflows/ci-audio-agent.yml` runs both on every push/PR
touching `tools/audio-agent/**`. All HTTP is mocked (`responses`); no live
ACE-Step call is ever made in CI.

## CLI

```sh
audio-agent generate --recipe path/to/recipe.json [--out-dir assets/out/audio] [--timeout 300] [--poll-interval 1.0] [--lock-timeout N]
```

Prints `{"path", "job_id", "provenance"}` as JSON on stdout on success;
prints `error: ...` to stderr and exits `1` on a license rejection or any
ACE-Step-side failure (`audio_agent.errors.AudioClientError`).

A recipe JSON file matches `recipe.MusicRecipe`'s fields (only `prompt`
and `seed` are required):

```json
{
  "prompt": "somber ambient drone, brutalist concrete hallway, collapsing signal",
  "seed": 12345,
  "duration": 30.0,
  "name": "collapse_stage_2"
}
```

## Machine-side: ACE-Step server (Windows host, F:\ACE-Step)

Not part of this package -- see `docs/ace-step-setup.md`'s "Persistent
server" section for:

- The minimal, documented patch to `infer-api.py` that loads the pipeline
  once at startup (instead of per-request) and adds a `GET
  /output/{filename}` download endpoint this client's `fetch_output()`
  needs.
- The exact command to launch it detached, logging to a file, on port
  8001.
- The one Windows Firewall command the user needs to run by hand (not run
  by this agent) before WSL can reach it.

## Manual live smoke (not run by this agent -- WSL can't reach ACE-Step yet)

Once the firewall rule in `docs/ace-step-setup.md` is applied by hand and
the persistent server is running, run **one** real generation end to end:

```sh
cd tools/audio-agent
.venv/bin/python scripts/live_smoke.py
# or, to pin the base URL explicitly:
ACESTEP_BASE_URL=http://172.18.192.1:8001 .venv/bin/python scripts/live_smoke.py
```

This submits a real ACE-Step generation, waits for it to complete, fetches
the WAV, and writes it to `assets/out/audio/live_smoke_<job_id>.wav`
(gitignored). It is a plain script, not a test -- nothing in `tests/`
depends on it, and it is not wired into CI.

## What's stubbed, pending other tasks

- **`descend.descend_stub()`** is an identity passthrough. T-0083 (trim
  silence, remove DC offset, loop-fold crossfade, EBU R128 loudness
  normalize, encode) replaces its body. `pipeline.generate()` already
  calls through this seam, so wiring doesn't change when T-0083 lands.
- **Validation gate hand-off**: `tools/asset-gate` (T-0102) already
  implements the machine-checkable audio gate; this package doesn't call
  it yet because there's nothing descended/encoded to validate until
  T-0083 exists.
- **`ASSET_PROVENANCE.md` writer** (T-0075 pattern) isn't built.
  `provenance.build_provenance_record()` captures everything the writer
  will need, including the D-20 bus field, so nothing has to be
  reconstructed after the fact.
- **`MusicRecipe.model_hash`** is `None` by default -- the checkpoint
  directory lives on the Windows host, not reachable from WSL for
  hashing; populate it once a hashing step exists on that side.
- **GPU lock is a local seam, not wired to comfy-client.** See
  `gpu_lock.py`'s docstring -- making `comfy_client.pipeline.generate()`
  acquire the same lock is board-orchestration scope, not built here.
