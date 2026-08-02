# gen-client-base

Shared foundation for every generation-agent HTTP client in this repo:
the backend-agnostic `submit -> wait_for_completion -> fetch_output` ABC
and the checkpoint/model license allowlist. Extracted out of
`tools/comfy-client` (T-0071) when `tools/audio-agent` (T-0082) needed the
same scaffolding for ACE-Step instead of reimplementing it -- see
`docs/design/13-asset-pipeline.md` §1: `AudioAgent` and `AssetAgent`
"share the base class" (`docs/PLAN.md` Phase 7 DRY note).

## What's here

- **`client.GenerationClient`** -- an ABC with three abstract methods
  (`submit`, `wait_for_completion`, `fetch_output`) and one concrete method
  (`generate`, which calls the three in order). `comfy_client.comfyui_client.ComfyUIClient`
  and `audio_agent.audio_client.AudioClient` each implement it against their
  own backend's HTTP shape.
- **`license_allowlist`** -- `assert_checkpoint_allowed()` / `load_allowlist()`,
  reading `config/checkpoint_allowlist.json` in this package. One allowlist,
  shared: it holds both the ComfyUI SDXL checkpoint entry and the ACE-Step
  model entry, so both pipelines enforce `.claude/rules/assets.md`'s
  "Apache-2.0 / OpenRAIL / CC0-derived only" rule from the same source of
  truth.

## Why a separate package instead of one importing the other

Neither `comfy-client` nor `audio-agent` is a natural dependency of the
other -- they're sibling backends of the same pattern, not a chain. A third,
tiny, dependency-free package that both install (`pip install -e ../gen-client-base`)
avoids an arbitrary "audio depends on comfy" (or vice versa) coupling.

## Install / test / lint

```sh
cd tools/gen-client-base
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest -q
.venv/bin/ruff check .
```

CI: `.github/workflows/ci-gen-client-base.yml`.

## Consumers

- `tools/comfy-client` -- `pip install -e ../gen-client-base -e ".[dev]"`
- `tools/audio-agent` -- `pip install -e ../gen-client-base -e ".[dev]"`

Neither declares this as a PEP 508 dependency in `pyproject.toml` (a
relative `file:` URL there is fragile across different install contexts);
both their `README.md` and CI workflows install it explicitly as a first
step instead.
