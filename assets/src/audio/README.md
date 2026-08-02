# sfx-synth

Deterministic one-shot SFX synthesis. Implements **T-0101**
(`tasks/T-0101.md`) per `docs/design/13-asset-pipeline.md` §4.5 (short
one-shots) and §4.7-4.8 (descent chain, audio gate).

## Why this lives in `assets/src/audio`, not `tools/`

Per `docs/PLAN.md` §1 and `.claude/rules/assets.md`, `assets/src/` holds
generation *content* -- recipes, prompts, seeds -- versioned as the
source of truth. Unlike `tools/asset-gate` (generic file-analysis
tooling with no generation content of its own), this package's code
*is* the content: a `Recipe` (parameters + seed) is the complete,
reproducible description of a sound, and P-1/P-3 require that source be
committed. `.claude/rules/python.md` scopes the shared Python
conventions to `tools/asset-gate/**` and `assets/src/**` for exactly
this reason.

## Why deterministic synthesis instead of a generative model

`13-asset-pipeline.md` §4.5: diffusion models (Stable Audio Open, T-0081)
are weak at very short percussive one-shots -- a 0.2s footstep is harder
for a model than a 30s pad. Short one-shots (footsteps, switches, doors,
item pickups) are instead a **seeded script rendering WAVs offline**:
noise burst -> resonant filter -> envelope, physically-inspired rather
than sfxr/Bfxr-style chiptune (no oscillators anywhere in this package).
This keeps one-shots inside P-1/P-3 for free: the recipe is the script
plus its parameters, fully reproducible, no model, no license question.

## Layout

```
assets/src/audio/
  pyproject.toml
  src/sfx_synth/
    dsp.py         # noise generators, resonant bandpass, envelope
    recipe.py       # Layer / Recipe dataclasses (the reproducible unit)
    synth.py        # Recipe -> raw samples (the determinism boundary)
    descent.py      # trim silence, DC offset, loudness normalize, encode
    pipeline.py      # synth -> descent -> encode, one code path
    bus_targets.py   # per-bus LUFS targets (mirrors asset-gate's placeholder)
    provenance.py    # provenance record (T-0075 seam, no model/license)
    recipes.py       # the four concrete one-shots
    cli.py           # `sfx-synth render[/-all]`
  tests/
```

## Install

```sh
cd assets/src/audio
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

The gate-integration test (`tests/test_gate_integration.py`) dogfoods
the real `tools/asset-gate` checks and needs that package importable
too:

```sh
.venv/bin/pip install -e ../../../tools/asset-gate
```

It skips cleanly (`pytest.importorskip`) if `asset-gate` isn't
installed, so it's optional for a quick local loop but required for the
suite CI runs.

## Test / lint

```sh
.venv/bin/pytest -q
.venv/bin/ruff check .
```

CI: `.github/workflows/ci-sfx-synth.yml`, on every push/PR touching
`assets/src/audio/**` or `tools/asset-gate/**`.

## CLI

```sh
sfx-synth render footstep_concrete --out-dir assets/out/audio
sfx-synth render-all --out-dir assets/out/audio
```

Each writes `<name>.wav` plus a `<name>.provenance.json` sidecar
(recipe identity, seed, bus, target LUFS, output hash) and prints the
same as JSON on stdout. `assets/out/` is gitignored at every depth
(fixed alongside this package -- see the root `.gitignore` changelog);
nothing under it is ever committed.

## The sounds

| Name | Bus | Layers | Length |
|---|---|---|---|
| `footstep_concrete` | `gameplay_sfx` | low thud + high scuff | ~0.06s |
| `switch_click` | `world_sfx` | press + release | ~0.06s |
| `door` | `world_sfx` | 4-step creak sweep + closing thud | ~0.5s |
| `item_pickup` | `world_sfx` | 3 rising filtered bursts | ~0.14s |

**Bus assignment (D-20).** `13-asset-pipeline.md` §4.0 names player-noise
feedback explicitly as the fairness channel P-5 says must never be
ducked -- so `footstep_concrete` is `gameplay_sfx`. The other three are
environment/interaction feedback, not that fairness channel, so they're
`world_sfx` (lightly duckable). This is a reasonable default for
T-0082/T-0103 to build on, not a resolved design call: **AU-3** (does
audio carry anything beyond threat/state?) is still open.

## Determinism

The headline acceptance criterion (T-0101: "same seed produces a
byte-identical WAV output"). One `np.random.default_rng(recipe.seed)`,
constructed once in `synth.render_recipe_raw` and consumed exactly once
per layer in `Recipe.layers` order -- fixed order because `layers` is a
tuple, not a set. Tested at both the raw-samples level
(`tests/test_synth.py`) and the actual shippable-WAV-bytes level
(`tests/test_pipeline.py`, `tests/test_recipes_catalog.py`), and
dogfooded against the real gate's own determinism check
(`tests/test_gate_integration.py`).

## Descent chain -- and what's deliberately skipped

```
synthesize (this package)
  -> trim silence, remove DC offset
  -> loudness normalize (EBU R128, per bus target, peak-limited)
  -> encode (WAV PCM_16, 44.1kHz)
```

**No loop-fold.** `13-asset-pipeline.md` §4.7 scopes loop-fold to
looping content closing a seam at its boundary -- a one-shot plays once
and stops; it has no seam to fold. Skipped, not stubbed.

## Gate dogfooding

`tests/test_gate_integration.py` decodes each rendered one-shot's actual
WAV bytes and runs them through the real `asset_gate.audio` checks
(loudness against the real placeholder config, true peak, format,
length bounds, silence trim, DC offset, determinism) -- all four pass
with margin. **No loop-seam check**: `check_loop_seam` is the audio
analog of tile seamlessness and is N/A for something that isn't meant to
loop, for the same reason loop-fold is skipped above.

Getting there surfaced two real, minimal fixes to `tools/asset-gate`
itself (both landed as separate commits on this branch, with their own
regression tests): pyloudnorm's default 400ms gating block rejects
every one-shot outright (all four land under 400ms), and the initial fix
for that had its own floating-point round-trip bug at the exact
boundary. No change was needed to the gate's public shape or its
existing tests -- both fixes are internal to `check_integrated_loudness`.

## Known deviations from `tasks/T-0101.md`'s acceptance checklist

- Its "passes the loop-fold/seam ... checks from T-0102" bullet predates
  the doc reconciliation that scoped loop-fold/loop-seam to looping
  content only (`13-asset-pipeline.md` §4.7, current text). This package
  intentionally does not implement or check either for one-shots -- see
  above.

## Open / deferred

- **AU-2** (per-bus LUFS targets) is still a placeholder, shared with
  `tools/asset-gate`'s config. `bus_targets.py` duplicates rather than
  imports the two relevant entries (`world_sfx`, `gameplay_sfx`) since
  the two packages are independent tools -- keep them in sync until AU-2
  resolves both at once.
- **AU-3** (does audio carry puzzle information, or only threat/state?)
  bears on whether `item_pickup`'s bus assignment is actually right;
  flagged above, not resolved here.
- A shared `ASSET_PROVENANCE.md` writer (T-0075) doesn't exist yet --
  `provenance.py` only builds the record; nothing appends it anywhere.
